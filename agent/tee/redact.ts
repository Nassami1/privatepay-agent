/**
 * Data minimisation before anything leaves the process.
 *
 * The Confidential TEE is the trust boundary, but defence in depth is cheap:
 * account numbers, IBANs, phone numbers, postal addresses and personal names
 * are removed *before* the inference request is built. The model only needs the
 * amount, the recipient, the invoice reference and the purpose, so it is sent
 * only that.
 *
 * Redaction is deterministic and unit-tested. It never needs the network.
 */

import type { RedactionResult } from '../types.js';

const TOKEN = (label: string): string => `[REDACTED:${label}]`;

type Rule = {
  label: string;
  pattern: RegExp;
  /** 0 replaces the whole match; otherwise only that capture group is replaced. */
  group?: number;
};

const RULES: Rule[] = [
  {
    label: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    label: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g,
  },
  {
    label: 'CARD_NUMBER',
    pattern: /\b(?:\d{4}[ -]?){3}\d{1,7}\b/g,
  },
  {
    label: 'SWIFT_BIC',
    pattern:
      /\b(?:SWIFT|BIC)(?:\s*\/?\s*(?:code))?\s*[:#]?\s*([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/gi,
    group: 1,
  },
  {
    label: 'BANK_ACCOUNT',
    pattern: /\b(?:account(?:\s*(?:no\.?|number|#))?|acct\.?|a\/c)\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{5,32})/gi,
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
    pattern: /(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?|\b0\d{2,4}[\s.-]?)\d{2,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?\b/g,
  },
  {
    label: 'POSTAL_ADDRESS',
    pattern:
      /\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?|Square|Sq\.?)\b\.?/gi,
  },
  {
    label: 'PERSON_NAME',
    pattern:
      /^(\s*(?:Bill(?:ed)?\s*to|Customer|Client|Contact|Attn|Name)\s*:\s*)([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s*$/gm,
    group: 2,
  },
];

export function redactInvoice(text: string): RedactionResult {
  let redacted = text;
  const fields: string[] = [];
  let replacements = 0;

  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let count = 0;
    if (rule.group === undefined) {
      redacted = redacted.replace(pattern, () => {
        count += 1;
        return TOKEN(rule.label);
      });
    } else {
      const group = rule.group;
      redacted = redacted.replace(pattern, (...args: unknown[]) => {
        const match = args[0] as string;
        const captured = args[group] as string | undefined;
        if (captured === undefined) return match;
        count += 1;
        const start = match.lastIndexOf(captured);
        if (start < 0) return match;
        return `${match.slice(0, start)}${TOKEN(rule.label)}${match.slice(start + captured.length)}`;
      });
    }
    if (count > 0) {
      fields.push(rule.label);
      replacements += count;
    }
  }

  return { redactedText: redacted, redactedFields: fields, replacements };
}

/**
 * The subset of the redacted text actually sent to the model. Keeping this
 * explicit makes the data boundary reviewable in one screen.
 */
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
