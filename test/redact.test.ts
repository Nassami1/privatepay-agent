import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_LEAK_CANARIES, INVOICES } from '../agent/fixtures.js';
import { redactInvoice } from '../agent/tee/redact.js';
import { extractLocally } from '../agent/tee/decision.js';

test('redacts every sensitive category in the demo invoice', () => {
  const result = redactInvoice(INVOICES.success.text);
  for (const category of [
    'EMAIL',
    'IBAN',
    'PHONE',
    'POSTAL_ADDRESS',
    'PERSON_NAME',
  ]) {
    assert.ok(result.redactedFields.includes(category), `missing ${category}`);
  }
  assert.ok(result.replacements >= 5, `expected >= 5 replacements, got ${result.replacements}`);
});

test('no sensitive marker survives redaction', () => {
  const result = redactInvoice(INVOICES.success.text);
  for (const marker of DEMO_LEAK_CANARIES) {
    assert.ok(
      !result.redactedText.includes(marker),
      `redacted text still contains "${marker}"`,
    );
  }
  assert.ok(!result.redactedText.includes('7731'), 'redacted text still contains canary digits');
});

test('redaction preserves the payment instruction', () => {
  const result = redactInvoice(INVOICES.success.text);
  assert.match(result.redactedText, /3 USDC/);
  assert.match(result.redactedText, /alice\.testnet/);
  assert.match(result.redactedText, /INV-2026-1042/);
});

test('redaction is deterministic', () => {
  const first = redactInvoice(INVOICES.success.text);
  const second = redactInvoice(INVOICES.success.text);
  assert.equal(first.redactedText, second.redactedText);
  assert.deepEqual(first.redactedFields, second.redactedFields);
});

test('local extractor reads the redacted invoice without network access', () => {
  const result = redactInvoice(INVOICES.success.text);
  const decision = extractLocally(result.redactedText, { invoiceRef: 'INV-2026-1042' });
  assert.equal(decision.amountUsdc, 3);
  assert.equal(decision.recipient, 'alice.testnet');
  assert.equal(decision.invoiceRef, 'INV-2026-1042');
  assert.equal(decision.purpose, 'design retainer for October');
});

test('local extractor flags an urgent wire request', () => {
  const result = redactInvoice(INVOICES.overLimit.text);
  const decision = extractLocally(result.redactedText);
  assert.equal(decision.amountUsdc, 50);
  assert.ok(decision.riskFlags.includes('URGENT_REQUEST'));
  assert.ok(decision.riskFlags.includes('WIRE_TRANSFER_REQUESTED'));
});
