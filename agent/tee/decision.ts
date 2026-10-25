/**
 * Invoice extraction.
 *
 * Two paths, never mixed:
 *   * `parseModelDecision` parses the Confidential TEE model output;
 *   * `extractLocally` is the deterministic fallback used only when no TEE is
 *     configured (local mode). In live mode a TEE failure is fatal and the
 *     agent does not pay; the local extractor's result is never sent to the
 *     real contract.
 *
 * Both return micro-USDC. No floating-point rounding is applied.
 */

import { parseUsdcToMicro } from '../amount.js';
import type { TeeDecision } from '../types.js';

const RECIPIENT_PATTERN = /\b([a-z0-9][a-z0-9._-]*\.(?:testnet|near))\b/i;
const INVOICE_REF_PATTERN = /\b(INV[-_ ]?\d[A-Z0-9-]{1,20})\b/i;
const PURPOSE_LABEL_PATTERN = /\bpurpose\s*:\s*([^.\n;]{3,80})/i;
const PURPOSE_FOR_PATTERN = /\bfor\s+([^.\n;]{3,80})/i;

const TOTAL_PATTERNS: RegExp[] = [
  /(?:total\s*due|amount\s*due|balance\s*due)\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,6})?)/i,
  /\btotal\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,6})?)/i,
  /\bamount\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,6})?)/i,
];
const CURRENCY_AMOUNT_PATTERN = /\$\s*([\d,]+(?:\.\d{1,6})?)/;
const CURRENCY_SUFFIX_PATTERN = /\b([\d,]+(?:\.\d{1,6})?)\s*(?:USDC|USD|USDT)\b/i;

const LOCAL_RISK_PATTERNS: Array<{ pattern: RegExp; flag: string }> = [
  { pattern: /\burgent\b/i, flag: 'URGENT_REQUEST' },
  { pattern: /\bwire\s+transfer\b/i, flag: 'WIRE_TRANSFER_REQUESTED' },
  { pattern: /\boffshore\b/i, flag: 'OFFSHORE_ACCOUNT' },
  { pattern: /\bnew\s+(?:bank\s+details|account)\b/i, flag: 'NEW_BANK_DETAILS' },
  { pattern: /\bgift\s*card\b/i, flag: 'GIFT_CARD_REQUEST' },
  { pattern: /\bconfidential\b/i, flag: 'CONFIDENTIALITY_MARKED' },
];

export interface InvoiceHint {
  invoiceRef?: string;
  amountMicroUsdc?: bigint;
  recipient?: string;
}

export function extractLocally(text: string, hint: InvoiceHint = {}): TeeDecision {
  let amountMicro = hint.amountMicroUsdc ?? 0n;
  const riskFlags: string[] = [];

  let amountMatch: RegExpExecArray | null = null;
  for (const pattern of TOTAL_PATTERNS) {
    amountMatch = pattern.exec(text);
    if (amountMatch !== null) break;
  }
  if (amountMatch === null) {
    amountMatch = CURRENCY_AMOUNT_PATTERN.exec(text) ?? CURRENCY_SUFFIX_PATTERN.exec(text);
  }
  if (amountMatch !== null && amountMatch[1] !== undefined) {
    try {
      amountMicro = parseUsdcToMicro(amountMatch[1]);
    } catch {
      riskFlags.push('MISSING_AMOUNT');
    }
  } else {
    riskFlags.push('MISSING_AMOUNT');
  }

  const recipient = RECIPIENT_PATTERN.exec(text)?.[1] ?? hint.recipient ?? '';
  if (recipient === '') riskFlags.push('MISSING_RECIPIENT');

  const invoiceRef =
    INVOICE_REF_PATTERN.exec(text)?.[1]?.replace(/\s+/g, '-').toUpperCase() ??
    hint.invoiceRef ??
    'INV-UNKNOWN';
  const purpose =
    PURPOSE_LABEL_PATTERN.exec(text)?.[1]?.trim() ??
    PURPOSE_FOR_PATTERN.exec(text)?.[1]?.trim() ??
    'unspecified';

  riskFlags.push(...detectLocalRiskFlags(text));
  return {
    amountMicroUsdc: amountMicro,
    recipient,
    invoiceRef,
    purpose,
    riskFlags: unique(riskFlags),
  };
}

export function detectLocalRiskFlags(text: string): string[] {
  return LOCAL_RISK_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ flag }) => flag,
  );
}

/**
 * Parse the TEE model's JSON. Throws on any shape that cannot be turned into a
 * payment instruction; the caller treats that as a TEE failure (fail closed).
 */
export function parseModelDecision(content: string, invoiceRef: string): TeeDecision {
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

  const rawAmount = record.amount_usdc ?? record.amount ?? record.amount_micro_usdc;
  if (rawAmount === undefined) throw new Error('model output has no amount');
  const amountMicroUsdc = parseUsdcToMicro(
    typeof rawAmount === 'number' ? rawAmount : String(rawAmount),
  );

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
    amountMicroUsdc,
    recipient: recipient.toLowerCase(),
    invoiceRef,
    purpose,
    riskFlags: unique(riskFlags),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
