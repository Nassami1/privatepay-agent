/**
 * Confidential inference on NEAR AI Cloud.
 *
 * Flow (real mode):
 *   1. redact the invoice locally (data minimisation)
 *   2. preflight: request a TEE attestation report bound to a fresh 32-byte nonce
 *   3. verify the structural bindings we can check without a DCAP verifier
 *   4. only then send the redacted text to the Confidential model
 *
 * If any step fails after two retries the run falls back to the in-process
 * deterministic extractor and is labelled SIMULATED. It never claims a mock is
 * a real TEE attestation.
 */

import type { Config } from '../config.js';
import { hasLiveTee } from '../config.js';
import type { AttestationEvidence, TeeDecision, TeeRun } from '../types.js';
import { buildMinimalPrompt, redactInvoice } from './redact.js';
import { extractLocally } from './decision.js';
import {
  randomNonceHex,
  simulatedAttestation,
  verifyAttestationReport,
} from './attestation.js';

const MAX_RETRIES = 2;
const ATTEMPT_TIMEOUT_MS = 60_000;
const ATTESTATION_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = [
  'You are the confidential payment-extraction model for PrivatePay Agent.',
  'You run inside a NEAR AI Cloud Trusted Execution Environment.',
  'Read the redacted invoice and return ONLY a JSON object with exactly these keys:',
  '  "amount_usdc": number, whole USDC to pay',
  '  "recipient": string, the NEAR account id that must be paid (usually ends in .testnet or .near)',
  '  "invoice_ref": string, the invoice reference found in the text',
  '  "purpose": string, at most 80 characters',
  '  "risk_flags": array of short UPPER_SNAKE_CASE strings',
  'Redacted markers like [REDACTED:EMAIL] are intentional. Do not invent values that',
  'are not present; use 0 for a missing amount and "" for a missing recipient.',
].join('\n');

export interface PrivateInvoiceInput {
  invoiceRef: string;
  /** Raw invoice text. It stays in this process; never logged, never sent as-is. */
  text: string;
}

export async function processInvoicePrivately(
  config: Config,
  invoice: PrivateInvoiceInput,
): Promise<TeeRun> {
  const redaction = redactInvoice(invoice.text);
  const startedAt = performance.now();

  if (!hasLiveTee(config)) {
    return simulatedRun(config, invoice, redaction, startedAt, {
      reason: 'NEAR_AI_CLOUD_API_KEY and NEAR_AI_CLOUD_MODEL are not both configured',
    });
  }

  const model = config.nearAi.model as string;
  const apiKey = config.nearAi.apiKey as string;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const { report, nonce } = await fetchAttestationReport(
        config.nearAi.baseUrl,
        apiKey,
        model,
      );
      const attestation = verifyAttestationReport({
        report,
        nonce,
        model,
        redaction,
      });
      const decision = await extractWithModel(
        config.nearAi.baseUrl,
        apiKey,
        model,
        redaction.redactedText,
        invoice.invoiceRef,
      );
      return {
        mode: 'real',
        model,
        latencyMs: Math.round(performance.now() - startedAt),
        decision,
        attestation,
        redaction,
        rawReport: report,
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await sleep(500 * (attempt + 1));
      }
    }
  }

  return simulatedRun(config, invoice, redaction, startedAt, {
    reason: `real TEE call failed after ${MAX_RETRIES} retries: ${errorMessage(lastError)}`,
    model,
  });
}

function simulatedRun(
  config: Config,
  invoice: PrivateInvoiceInput,
  redaction: ReturnType<typeof redactInvoice>,
  startedAt: number,
  options: { reason: string; model?: string },
): TeeRun {
  const model = options.model ?? 'local-deterministic-extractor';
  const decision = extractLocally(redaction.redactedText, {
    invoiceRef: invoice.invoiceRef,
  });
  const attestation: AttestationEvidence = simulatedAttestation({
    model,
    redaction,
    reason: options.reason,
  });
  return {
    mode: 'simulated',
    model,
    latencyMs: Math.round(performance.now() - startedAt),
    decision,
    attestation,
    redaction,
    fallbackReason: options.reason,
  };
}

export async function fetchAttestationReport(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ report: unknown; nonce: string }> {
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
  return { report: (await response.json()) as unknown, nonce };
}

async function extractWithModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  redactedText: string,
  invoiceRef: string,
): Promise<TeeDecision> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildMinimalPrompt(redactedText) },
      ],
      temperature: 0,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      // GLM models reason by default, which triples latency for a structured
      // extraction task. This documented knob turns that off (near.ai docs,
      // "Reasoning Models", fetched 2026-10-24). Unknown knobs are ignored by
      // the gateway, so the call still works for models without the template.
      chat_template_kwargs: { enable_thinking: false },
      stream: false,
    }),
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`inference HTTP ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null };
    }>;
  };
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(
      `model returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'})`,
    );
  }
  return parseDecision(content, invoiceRef);
}

function parseDecision(content: string, invoiceRef: string): TeeDecision {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('model output was not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('model output was not a JSON object');
  }
  const record = parsed as Record<string, unknown>;

  const rawAmount = record.amount_usdc;
  const amount = typeof rawAmount === 'number' ? rawAmount : Number.parseFloat(String(rawAmount));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('model output has an invalid amount_usdc');
  }

  const recipient = typeof record.recipient === 'string' ? record.recipient.trim() : '';
  if (!/^[a-z0-9][a-z0-9._-]*\.(testnet|near)$/i.test(recipient)) {
    throw new Error(`model output has an invalid recipient: "${recipient.slice(0, 40)}"`);
  }

  const purpose = typeof record.purpose === 'string' ? record.purpose.slice(0, 120) : '';
  const riskFlags = Array.isArray(record.risk_flags)
    ? record.risk_flags
        .filter((flag): flag is string => typeof flag === 'string')
        .map((flag) => flag.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40))
        .slice(0, 12)
    : [];

  return {
    amountUsdc: Math.round(amount),
    recipient: recipient.toLowerCase(),
    invoiceRef,
    purpose,
    riskFlags,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
