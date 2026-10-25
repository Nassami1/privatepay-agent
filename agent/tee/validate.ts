/**
 * Independent validation of the model's answer.
 *
 * The model is allowed to extract, not to invent. Both the recipient and the
 * amount must actually appear in the invoice text the agent already holds.
 * A mismatch stops the payment before the contract is called.
 */

import { formatUsdc, microToCanonical } from '../amount.js';
import type { TeeDecision } from '../types.js';

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DecisionValidation {
  ok: boolean;
  checks: ValidationCheck[];
}

export function validateDecision(
  decision: TeeDecision,
  invoiceText: string,
): DecisionValidation {
  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  add(
    'amount_positive',
    decision.amountMicroUsdc > 0n,
    decision.amountMicroUsdc > 0n
      ? `amount is ${formatUsdc(decision.amountMicroUsdc)} USDC`
      : 'amount is zero',
  );

  add(
    'recipient_present',
    decision.recipient !== '' &&
      invoiceText.toLowerCase().includes(decision.recipient.toLowerCase()),
    decision.recipient !== ''
      ? `${decision.recipient} appears in the invoice text`
      : 'recipient is empty',
  );

  const amountFound = amountAppearsInText(decision.amountMicroUsdc, invoiceText);
  add(
    'amount_present',
    amountFound,
    amountFound
      ? `${formatUsdc(decision.amountMicroUsdc)} appears in the invoice text`
      : `${formatUsdc(decision.amountMicroUsdc)} was not found in the invoice text`,
  );

  return { ok: checks.every((check) => check.ok), checks };
}

export function amountAppearsInText(micro: bigint, invoiceText: string): boolean {
  if (micro <= 0n) return false;
  const normalized = invoiceText.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1');
  for (const text of [invoiceText, normalized]) {
    for (const variant of amountVariants(micro)) {
      if (variant.endsWith('.')) continue;
      const [whole = '', fraction] = variant.split('.');
      const escapedWhole = escapeRegExp(whole);
      const pattern =
        fraction === undefined
          ? new RegExp(`(?<![\\d.,])${escapedWhole}(?:[.,]0+)?(?![\\d])`, 'u')
          : new RegExp(
              `(?<![\\d.,])${escapedWhole}[.,]${escapeRegExp(fraction)}(?:0+)?(?![\\d])`,
              'u',
            );
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

function amountVariants(micro: bigint): string[] {
  const canonical = microToCanonical(micro); // "3", "10.4", "0.5"
  const fixed = formatUsdc(micro); // "3.00", "10.40"
  const variants = new Set([canonical, fixed]);
  if (!canonical.includes('.')) variants.add(`${canonical}.00`);
  return [...variants];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
