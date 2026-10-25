import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_LEAK_CANARIES, INVOICES } from '../agent/fixtures.js';
import { redactInvoice } from '../agent/tee/redact.js';

test('redacts every sensitive category in the demo invoice', () => {
  const result = redactInvoice(INVOICES.success.text);
  for (const category of ['EMAIL', 'IBAN', 'PHONE', 'POSTAL_ADDRESS', 'PERSON_NAME']) {
    assert.ok(result.redactedFields.includes(category), `missing ${category}`);
  }
});

test('no sensitive marker survives redaction', () => {
  const result = redactInvoice(INVOICES.success.text);
  for (const marker of DEMO_LEAK_CANARIES) {
    assert.ok(!result.redactedText.includes(marker), `still contains "${marker}"`);
  }
  assert.ok(!result.redactedText.includes('7731'), 'still contains canary digits');
});

test('redaction preserves the payment instruction and the amount', () => {
  const result = redactInvoice(INVOICES.success.text);
  assert.match(result.redactedText, /3 USDC/);
  assert.match(result.redactedText, /alice\.samimmi\.testnet/);
  assert.match(result.redactedText, /INV-2026-1042/);
});

test('redacts lowercase and compact IBANs', () => {
  for (const text of [
    'IBAN: de89 3704 0044 0532 0130 7731',
    'IBAN: DE89370400440532013000',
  ]) {
    const result = redactInvoice(text);
    assert.ok(result.redactedFields.includes('IBAN'), `missed ${text}`);
    assert.ok(!/de89|DE89/i.test(result.redactedText));
  }
});

test('redacts single-word and non-latin names after a label', () => {
  for (const text of ['Bill to: Mara', 'Name: Иван Петров', 'Customer: 李']) {
    const result = redactInvoice(text);
    assert.ok(result.redactedFields.includes('PERSON_NAME'), `missed ${text}`);
    assert.match(result.redactedText, /\[REDACTED:PERSON_NAME\]/);
  }
});

test('redacts an EU address without Street or Road', () => {
  const result = redactInvoice('Unter den Linden 77, 10117 Berlin');
  assert.ok(
    result.redactedFields.includes('POSTAL_ADDRESS') ||
      result.redactedFields.includes('POSTAL_CODE'),
    'address was not redacted',
  );
  assert.ok(!result.redactedText.includes('10117 Berlin'));
});

test('does not treat a large amount as a card number', () => {
  const result = redactInvoice('Amount: 10000000 USDC');
  assert.ok(!result.redactedFields.includes('CARD_NUMBER'));
  assert.match(result.redactedText, /10000000/);
});

test('redacts a Luhn-valid card number away from an amount label', () => {
  const result = redactInvoice('Card number: 4111 1111 1111 1111');
  assert.ok(result.redactedFields.includes('CARD_NUMBER'));
  assert.ok(!result.redactedText.includes('4111'));
});
