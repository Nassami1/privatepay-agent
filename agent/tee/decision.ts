/**
 * Local, deterministic invoice extractor.
 *
 * This is the *simulated* decision path, used only when no NEAR AI Cloud key is
 * configured. It runs in-process, never touches the network, and is labelled
 * SIMULATED. It mirrors the shape of the real model's JSON output so the rest
 * of the pipeline is identical in both modes.
 */

import type { TeeDecision } from '../types.js';

const RECIPIENT_PATTERN = /\b([a-z0-9][a-z0-9._-]*\.(?:testnet|near))\b/i;
const INVOICE_REF_PATTERN = /\b(INV[-_ ]?\d[A-Z0-9-]{1,20})\b/i;
const AMOUNT_USDC_PATTERN = /\b(\d+(?:\.\d{1,2})?)\s*(?:USDC|USD|USDT)\b/i;
const AMOUNT_DOLLAR_PATTERN = /\$\s*(\d+(?:\.\d{1,2})?)/;
const PURPOSE_LABEL_PATTERN = /\bpurpose\s*:\s*([^.\n;]{3,80})/i;
const PURPOSE_PATTERN = /\bfor\s+([^.\n;]{3,80})/i;

const RISK_PATTERNS: Array<{ pattern: RegExp; flag: string }> = [
  { pattern: /\burgent\b/i, flag: 'URGENT_REQUEST' },
  { pattern: /\bwire\s+transfer\b/i, flag: 'WIRE_TRANSFER_REQUESTED' },
  { pattern: /\boffshore\b/i, flag: 'OFFSHORE_ACCOUNT' },
  { pattern: /\bnew\s+(?:account|bank\s+details)\b/i, flag: 'NEW_BANK_DETAILS' },
  { pattern: /\bgift\s*card\b/i, flag: 'GIFT_CARD_REQUEST' },
  { pattern: /\bcrypto(?:currency)?\b/i, flag: 'CRYPTO_SETTLEMENT' },
  { pattern: /\bconfidential\b/i, flag: 'CONFIDENTIALITY_MARKED' },
];

export interface InvoiceHint {
  invoiceRef?: string;
  amountUsdc?: number;
  recipient?: string;
}

export function extractLocally(text: string, hint: InvoiceHint = {}): TeeDecision {
  const amountMatch = AMOUNT_USDC_PATTERN.exec(text) ?? AMOUNT_DOLLAR_PATTERN.exec(text);
  const parsedAmount = amountMatch?.[1] !== undefined ? Number.parseFloat(amountMatch[1]) : Number.NaN;

  const amountUsdc = Number.isFinite(parsedAmount)
    ? Math.round(parsedAmount * 100) / 100
    : (hint.amountUsdc ?? 0);

  const recipient = RECIPIENT_PATTERN.exec(text)?.[1] ?? hint.recipient ?? '';
  const invoiceRef = INVOICE_REF_PATTERN.exec(text)?.[1]?.replace(/\s+/g, '-').toUpperCase()
    ?? hint.invoiceRef
    ?? 'INV-UNKNOWN';
  const purpose =
    PURPOSE_LABEL_PATTERN.exec(text)?.[1]?.trim() ??
    PURPOSE_PATTERN.exec(text)?.[1]?.trim() ??
    'unspecified';

  const riskFlags = RISK_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ flag }) => flag,
  );
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    riskFlags.push('MISSING_AMOUNT');
  }
  if (recipient === '') {
    riskFlags.push('MISSING_RECIPIENT');
  }

  return { amountUsdc, recipient, invoiceRef, purpose, riskFlags };
}

/** Whole demo units only, matching the contract's `u32` amounts. */
export function toWholeUsdc(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount);
}
