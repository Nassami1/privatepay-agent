/**
 * Confidential inference on NEAR AI Cloud, fail-closed.
 *
 * Real mode:
 *   1. redact the invoice locally;
 *   2. obtain a TEE attestation report (cached for five minutes, so a second
 *      invoice in the same run does not re-fetch a 300 KB report);
 *   3. send only the redacted text to the Confidential model;
 *   4. fetch the per-response signature and verify it against the exact request
 *      and response bytes and the preflight attestation signer;
 *   5. return the decision, attestation and signature evidence.
 *
 * Any failure throws. There is no "fall back to the local regex extractor and
 * pay anyway" path in live mode. The local extractor is used only when no TEE
 * is configured at all, and its run is labelled SIMULATED.
 */

import type { Config } from '../config.js';
import { hasLiveTee } from '../config.js';
import type { AttestationEvidence, SignatureEvidence, TeeDecision, TeeRun } from '../types.js';
import { buildMinimalPrompt, redactInvoice } from './redact.js';
import { extractLocally, parseModelDecision } from './decision.js';
import {
  randomNonceHex,
  simulatedAttestation,
  verifyAttestationReport,
} from './attestation.js';
import {
  expectedSignatureText,
  fetchResponseSignature,
  verifyResponseSignature,
} from './signature.js';

const MAX_ATTEMPTS = 3;
const ATTESTATION_TIMEOUT_MS = 45_000;
const INFERENCE_TIMEOUT_MS = 60_000;
const ATTESTATION_TTL_MS = 5 * 60_000;

const SYSTEM_PROMPT = [
  'You are the confidential payment-extraction model for PrivatePay Agent.',
  'You run inside a NEAR AI Cloud Trusted Execution Environment.',
  'Read the redacted invoice and return ONLY a JSON object with exactly these keys:',
  '  "amount_usdc": number, the total amount to pay in USDC (up to 6 decimals)',
  '  "recipient": string, the NEAR account id that must be paid',
  '  "invoice_ref": string, the invoice reference found in the text',
  '  "purpose": string, at most 80 characters',
  '  "risk_flags": array of short UPPER_SNAKE_CASE strings',
  'Redacted markers like [REDACTED:EMAIL] are intentional. Do not invent values',
  'that are not present; use 0 for a missing amount and "" for a missing recipient.',
].join('\n');

export class TeeUnavailableError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'TeeUnavailableError';
    this.detail = detail;
  }
}

export interface PrivateInvoiceInput {
  invoiceRef: string;
  /** Raw invoice text. It stays in this process; never logged, never sent as-is. */
  text: string;
}

interface CachedAttestation {
  evidence: AttestationEvidence;
  reportJson: string;
  fetchedAt: number;
}

export interface FetchedAttestation {
  report: unknown;
  reportJson: string;
  nonce: string;
}

const attestationCache = new Map<string, CachedAttestation>();

export function clearAttestationCache(): void {
  attestationCache.clear();
}

export async function processInvoicePrivately(
  config: Config,
  invoice: PrivateInvoiceInput,
): Promise<TeeRun> {
  const redaction = redactInvoice(invoice.text);
  const startedAt = performance.now();

  if (!hasLiveTee(config)) {
    return simulatedRun(invoice, redaction, startedAt);
  }

  const model = config.nearAi.model as string;
  const apiKey = config.nearAi.apiKey as string;
  const baseUrl = config.nearAi.baseUrl;
  let lastError = 'unknown error';
  let lastDetail = 'unknown error';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const attestation = await getAttestation(config, model, apiKey, redaction);
      const { decision, signature } = await inferAndVerify(
        baseUrl,
        apiKey,
        model,
        redaction.redactedText,
        invoice.invoiceRef,
        attestation.evidence,
      );
      return {
        mode: 'real',
        model,
        latencyMs: Math.round(performance.now() - startedAt),
        decision,
        attestation: attestation.evidence,
        redaction,
        attestationCached: attestation.cached,
        signature,
        rawReportJson: attestation.reportJson,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastDetail = lastError;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * (attempt + 1));
      }
    }
  }

  throw new TeeUnavailableError(
    `confidential inference failed after ${MAX_ATTEMPTS} attempts; payment refused`,
    lastDetail,
  );
}

async function getAttestation(
  config: Config,
  model: string,
  apiKey: string,
  redaction: ReturnType<typeof redactInvoice>,
): Promise<{ evidence: AttestationEvidence; reportJson: string; cached: boolean }> {
  const key = `${config.nearAi.baseUrl}|${model}`;
  const cached = attestationCache.get(key);
  if (cached !== undefined && Date.now() - cached.fetchedAt < ATTESTATION_TTL_MS) {
    // The report describes the environment, not the invoice; refresh only the
    // per-run redaction metadata before returning the cached evidence.
    const evidence: AttestationEvidence = {
      ...cached.evidence,
      redactedFields: redaction.redactedFields,
      environment: cached.evidence.environment,
    };
    return { evidence, reportJson: cached.reportJson, cached: true };
  }

  const { report, reportJson, nonce } = await fetchAttestationReport(
    config.nearAi.baseUrl,
    apiKey,
    model,
  );
  const evidence = verifyAttestationReport({
    report,
    reportJson,
    nonce,
    model,
    redaction,
  });
  attestationCache.set(key, { evidence, reportJson, fetchedAt: Date.now() });
  return { evidence, reportJson, cached: false };
}

export async function fetchAttestationReport(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<FetchedAttestation> {
  const nonce = randomNonceHex();
  const url = new URL(`${baseUrl}/v1/attestation/report`);
  url.searchParams.set('model', model);
  url.searchParams.set('provider', 'near');
  url.searchParams.set('include_tls_fingerprint', 'false');
  url.searchParams.set('signing_algo', 'ecdsa');
  url.searchParams.set('nonce', nonce);

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'x-no-aliasing': 'true',
    },
    signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`attestation endpoint HTTP ${response.status}: ${body}`);
  }
  const report = (await response.json()) as unknown;
  // The digest is over exactly these bytes, which are also what we archive.
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  return { report, reportJson, nonce };
}

async function inferAndVerify(
  baseUrl: string,
  apiKey: string,
  model: string,
  redactedText: string,
  invoiceRef: string,
  attestation: AttestationEvidence,
): Promise<{ decision: TeeDecision; signature: SignatureEvidence }> {
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildMinimalPrompt(redactedText) },
    ],
    temperature: 0,
    max_tokens: 600,
    response_format: { type: 'json_object' },
    chat_template_kwargs: { enable_thinking: false },
    stream: false,
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'x-no-aliasing': 'true',
      'accept-encoding': 'identity',
    },
    body,
    signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    throw new Error(`inference HTTP ${response.status}: ${text}`);
  }

  // Hash the exact response bytes before parsing.
  const responseText = await response.text();
  const payload = JSON.parse(responseText) as {
    id?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null };
    }>;
  };
  if (typeof payload.id !== 'string' || payload.id === '') {
    throw new Error('inference response has no completion id');
  }
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(
      `model returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'})`,
    );
  }
  const decision = parseModelDecision(content, invoiceRef);

  const rawSignature = await fetchResponseSignature(baseUrl, apiKey, payload.id, 'ecdsa');
  const kind = rawSignature.signature_kind;
  if (kind !== 'provider_tee' && kind !== 'gateway') {
    throw new Error(`unexpected signature kind: ${kind}`);
  }
  const expectedSigner =
    kind === 'provider_tee'
      ? attestation.environment?.modelSigningAddress
      : attestation.environment?.gatewaySigningAddress;
  if (expectedSigner === undefined) {
    throw new Error(`no attestation signer available for ${kind}`);
  }

  const signature = verifyResponseSignature(rawSignature, {
    expectedText: expectedSignatureText(model, body, responseText),
    expectedSigner,
    expectedKind: kind,
  });

  return { decision, signature };
}

function simulatedRun(
  invoice: PrivateInvoiceInput,
  redaction: ReturnType<typeof redactInvoice>,
  startedAt: number,
): TeeRun {
  const decision = extractLocally(redaction.redactedText, {
    invoiceRef: invoice.invoiceRef,
  });
  return {
    mode: 'simulated',
    model: 'local-deterministic-extractor',
    latencyMs: Math.round(performance.now() - startedAt),
    decision,
    attestation: simulatedAttestation({
      model: 'local-deterministic-extractor',
      redaction,
      reason: 'NEAR_AI_CLOUD_API_KEY and NEAR_AI_CLOUD_MODEL are not both configured',
    }),
    redaction,
    attestationCached: false,
    signature: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
