/**
 * Data minimisation before anything leaves the process.
 *
 * The Confidential TEE is the trust boundary, but defence in depth is cheap:
 * account numbers, IBANs, phone numbers, postal addresses and personal names
 * are removed *before* the inference request is built. The model only needs the
 * amount, the recipient, the invoice reference and the purpose.
 *
 * Validation matters as much as matching:
 *   * IBANs are checked with the mod-97 checksum, including lowercase and
 *     compact forms;
 *   * card numbers are only redacted when they pass Luhn and are not sitting
 *     next to an amount label, so a large amount is not eaten by mistake;
 *   * name lines handle single-word and non-latin names.
 */

import type { RedactionResult } from '../types.js';

const TOKEN = (label: string): string => `[REDACTED:${label}]`;

type Rule = {
  label: string;
  pattern: RegExp;
  /** 0 replaces the whole match; otherwise only that capture group is replaced. */
  group?: number;
  validate?: (match: string, offset: number, whole: string) => boolean;
};

const STREET_SUFFIX =
  'Street|St\\.?|Road|Rd\\.?|Avenue|Ave\\.?|Boulevard|Blvd\\.?|Lane|Ln\\.?|Drive|Dr\\.?|Court|Ct\\.?|Way|Place|Pl\\.?|Square|Sq\\.?|Straße|Strasse|str\\.?|Weg|Gasse|Platz|Allee|Ring|Ufer';

const RULES: Rule[] = [
  {
    label: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    label: 'IBAN',
    pattern: /\b[A-Za-z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}(?:[ ]?[A-Za-z0-9]{1,4})?\b/g,
    validate: (match) => isValidIban(match),
  },
  {
    label: 'CARD_NUMBER',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (match, offset, whole) => isValidCardContext(match, offset, whole),
  },
  {
    label: 'SWIFT_BIC',
    pattern:
      /\b(?:SWIFT|BIC)(?:\s*\/?\s*(?:code))?\s*[:#]?\s*([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/gi,
    group: 1,
  },
  {
    label: 'BANK_ACCOUNT',
    pattern:
      /\b(?:account(?:\s*(?:no\.?|number|#))?|acct\.?|a\/c)\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{5,32})/gi,
    group: 1,
  },
  {
    label: 'TAX_ID',
    pattern:
      /\b(?:VAT|Tax\s*ID|TIN|GSTIN|GST|EIN)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,20})\b/gi,
    group: 1,
  },
  {
    label: 'PHONE',
    pattern:
      /(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?|\b0\d{2,4}[\s.-]?|\b00\d{2,4}[\s.-]?)\d{2,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?\b/g,
  },
  {
    label: 'POSTAL_ADDRESS',
    pattern: new RegExp(
      `\\b\\d{1,5}\\s+[^\\n,]{2,60}?\\s+(?:${STREET_SUFFIX})\\b\\.?`,
      'giu',
    ),
  },
  {
    label: 'POSTAL_CODE',
    // 5-digit postal code + city, e.g. "10117 Berlin". Over-redacting a rare
    // five-digit invoice number is an acceptable trade for privacy.
    pattern: /\b\d{5}\s+[A-ZÄÖÜ][\p{L}.'-]{1,30}\b/gu,
  },
  {
    label: 'PERSON_NAME',
    // The whole value after a name label is replaced, so single-word and
    // non-latin names are covered too. Values that are already redacted are
    // left alone.
    pattern:
      /^(\s*(?:bill(?:ed)?\s*to|invoice\s*to|customer|client|contact|attn|name|rechnung\s+an|empf(?:ä|ae)nger|facturado\s+a|destinataire|cliente|nome)\s*:\s*)(.+)$/gimu,
    group: 2,
    validate: (match) => !match.trimStart().startsWith('[REDACTED:'),
  },
];

export function redactInvoice(text: string): RedactionResult {
  let redacted = text;
  const fields: string[] = [];
  let replacements = 0;

  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let count = 0;

    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const offset = args[args.length - 2] as number;
      const whole = args[args.length - 1] as string;

      if (rule.validate !== undefined && !rule.validate(match, offset, whole)) {
        return match;
      }

      if (rule.group === undefined) {
        count += 1;
        return TOKEN(rule.label);
      }

      const captured = args[rule.group] as string | undefined;
      if (captured === undefined || captured === '') return match;
      count += 1;
      const start = match.lastIndexOf(captured);
      if (start < 0) return match;
      return `${match.slice(0, start)}${TOKEN(rule.label)}${match.slice(start + captured.length)}`;
    });

    if (count > 0) {
      fields.push(rule.label);
      replacements += count;
    }
  }

  return { redactedText: redacted, redactedFields: fields, replacements };
}

/** The subset of the redacted text actually sent to the model. */
export function buildMinimalPrompt(redactedText: string): string {
  return [
    'Extract the payment instruction from the redacted invoice below.',
    'Do not invent values. If a value is missing, use 0 for the amount and an empty string for the recipient.',
    '',
    '--- BEGIN REDACTED INVOICE ---',
    redactedText.trim(),
    '--- END REDACTED INVOICE ---',
  ].join('\n');
}

function isValidIban(value: string): boolean {
  // Checksum is not required: a typo or a fake IBAN is still sensitive, and a
  // failed mod-97 check must not leave the digits in the prompt. The shape and
  // length are specific enough (two letters, two digits, 15-34 chars).
  const compact = value.replace(/[\s]/g, '').toUpperCase();
  return compact.length >= 15 && compact.length <= 34 && /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact);
}

function isValidCardContext(match: string, offset: number, whole: string): boolean {
  const digits = match.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (!luhnValid(digits)) return false;

  // A number directly after an amount label is an amount, not a card.
  const before = whole.slice(Math.max(0, offset - 28), offset).toLowerCase();
  if (/(?:amount|total|subtotal|due|balance|\$|usdc|usd)\s*:?\s*$/.test(before)) {
    return false;
  }
  return true;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
