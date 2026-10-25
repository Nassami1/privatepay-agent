/**
 * TEE attestation evidence.
 *
 * Two modes, never conflated:
 *
 *   real       — a report fetched from NEAR AI Cloud. We check the structural
 *                bindings a client can check without a DCAP verifier (nonce
 *                echo, quote presence, model identity, signing address) and
 *                archive the exact report bytes. The SHA-256 digest is computed
 *                over the archived string, so `sha256sum` reproduces it.
 *   simulated  — no TEE call happened. The object says so in `mode`, in
 *                `disclaimer`, and in every log line that prints it.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { AttestationCheck, AttestationEvidence, RedactionResult } from '../types.js';

export const NEAR_AI_VERIFICATION_URL = 'https://cloud.near.ai/verify';
export const NEAR_AI_VERIFICATION_DOCS = 'https://docs.near.ai/cloud/verification/';

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomNonceHex(): string {
  return randomBytes(32).toString('hex');
}

export function simulatedAttestation(input: {
  model: string;
  redaction: RedactionResult;
  reason: string;
}): AttestationEvidence {
  const evidence: AttestationEvidence = {
    mode: 'simulated',
    model: input.model,
    createdAt: new Date().toISOString(),
    digest: '',
    verificationUrl: NEAR_AI_VERIFICATION_DOCS,
    disclaimer:
      'SIMULATED_ATTESTATION — this is not a real TEE attestation. No confidential inference call was made.',
    checks: [
      {
        name: 'tee_inference',
        ok: false,
        detail: 'No NEAR AI Cloud API key/model configured; inference ran locally.',
      },
    ],
    redactedFields: input.redaction.redactedFields,
    redacted_fields: input.redaction.redactedFields,
    reason: input.reason,
    verification_url: NEAR_AI_VERIFICATION_DOCS,
  };
  evidence.digest = sha256Hex(stableEvidenceJson(evidence));
  return evidence;
}

/** Deterministic JSON for digesting: sorted keys, no digest field. */
export function stableEvidenceJson(evidence: AttestationEvidence): string {
  const clone = { ...evidence, digest: '' };
  return JSON.stringify(sortKeys(clone));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

interface RawReportShape {
  gateway_attestation?: Record<string, unknown>;
  model_attestations?: Array<Record<string, unknown>>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Structural verification. `reportJson` must be the exact text that is archived;
 * the digest is over those bytes.
 */
export function verifyAttestationReport(input: {
  report: unknown;
  reportJson: string;
  nonce: string;
  model: string;
  redaction: RedactionResult;
  fetchedAt?: string;
}): AttestationEvidence {
  const raw = input.report as RawReportShape;
  const gateway = raw.gateway_attestation;
  const modelAttestations = raw.model_attestations ?? [];
  const modelReport = modelAttestations[0];

  const checks: AttestationCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  add(
    'gateway_report_present',
    gateway !== undefined && typeof gateway === 'object',
    gateway ? 'gateway_attestation object returned' : 'gateway_attestation missing',
  );

  const quote = gateway ? asString(gateway.intel_quote) : undefined;
  add(
    'intel_tdx_quote_present',
    quote !== undefined && quote.length > 1000,
    quote ? `Intel TDX quote present (${quote.length} base64 chars)` : 'Intel TDX quote missing',
  );

  const gatewayNonce = gateway ? asString(gateway.request_nonce) : undefined;
  const modelNonce = modelReport ? asString(modelReport.request_nonce) : undefined;
  add(
    'nonce_bound_to_request',
    gatewayNonce === input.nonce && (modelReport === undefined || modelNonce === input.nonce),
    gatewayNonce === input.nonce
      ? 'report echoes the 32-byte client nonce'
      : 'report nonce does not match the client nonce',
  );

  const eventLogEntries = countEventLogEntries(gateway?.event_log);
  add(
    'event_log_present',
    eventLogEntries > 0,
    eventLogEntries > 0 ? `event log has ${eventLogEntries} entries` : 'event log missing',
  );

  add(
    'model_attestation_present',
    modelAttestations.length > 0,
    modelAttestations.length > 0
      ? `${modelAttestations.length} NEAR model attestation candidate(s)`
      : 'no model_attestations returned for provider=near',
  );

  const modelName = modelReport ? asString(modelReport.model_name) : undefined;
  add(
    'model_identity_matches',
    modelName === input.model,
    modelName === input.model
      ? `attested model is ${modelName}`
      : `attested model ${modelName ?? '(none)'} does not match requested ${input.model}`,
  );

  const gatewaySigner = gateway ? asString(gateway.signing_address) : undefined;
  const modelSigner = modelReport ? asString(modelReport.signing_address) : undefined;
  add(
    'signing_identities_present',
    gatewaySigner !== undefined && modelSigner !== undefined,
    gatewaySigner && modelSigner
      ? 'gateway and model signing addresses present'
      : 'missing gateway or model signing address',
  );

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(
      `attestation structural checks failed: ${failed.map((check) => check.name).join(', ')}`,
    );
  }

  const gatewayInfo = (gateway?.info ?? {}) as Record<string, unknown>;
  const evidence: AttestationEvidence = {
    mode: 'real',
    model: input.model,
    createdAt: input.fetchedAt ?? new Date().toISOString(),
    digest: sha256Hex(input.reportJson),
    verificationUrl: NEAR_AI_VERIFICATION_URL,
    disclaimer:
      'Real NEAR AI Cloud attestation report. Structural bindings were checked client-side; full Intel TDX/NVIDIA quote verification is delegated to the official verifier and the archived report digest.',
    checks,
    redactedFields: input.redaction.redactedFields,
    environment: {
      gatewayAppId: asString(gatewayInfo.app_id),
      gatewayInstanceId: asString(gatewayInfo.instance_id),
      gatewaySigningAddress: gatewaySigner,
      modelSigningAddress: modelSigner,
      quoteBytes: quote ? quote.length : 0,
      eventLogEntries,
    },
  };
  return evidence;
}

export function attestationSummary(evidence: AttestationEvidence): string {
  if (evidence.mode === 'simulated') {
    return `SIMULATED reason="${evidence.reason ?? 'unknown'}"`;
  }
  const passed = evidence.checks.filter((check) => check.ok).length;
  return `real checks=${passed}/${evidence.checks.length} digest=sha256:${evidence.digest.slice(0, 16)}`;
}

/**
 * The gateway returns `event_log` as a JSON-encoded string while the model
 * report returns an array. Accept both; a missing log means we cannot replay
 * RTMR3 and the report is not accepted.
 */
function countEventLogEntries(eventLog: unknown): number {
  if (Array.isArray(eventLog)) return eventLog.length;
  if (typeof eventLog === 'string' && eventLog.length > 0) {
    try {
      const parsed = JSON.parse(eventLog) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}
