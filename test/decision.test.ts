import test from 'node:test';
import assert from 'node:assert/strict';
import { INVOICES } from '../agent/fixtures.js';
import { extractLocally, parseModelDecision } from '../agent/tee/decision.js';

test('the local extractor prefers Total due over Subtotal', () => {
  const decision = extractLocally(INVOICES.overLimit.text);
  assert.equal(decision.amountMicroUsdc, 50_000_000n);
  assert.equal(decision.recipient, 'alice.samimmi.testnet');
});

test('parses a model amount without rounding 10.40 to 10', () => {
  const decision = parseModelDecision(
    JSON.stringify({
      amount_usdc: 10.4,
      recipient: 'alice.samimmi.testnet',
      invoice_ref: 'INV-1',
      purpose: 'test',
      risk_flags: [],
    }),
    'INV-1',
  );
  assert.equal(decision.amountMicroUsdc, 10_400_000n);
});

test('rejects a model output with an invalid recipient', () => {
  assert.throws(
    () =>
      parseModelDecision(
        JSON.stringify({ amount_usdc: 3, recipient: 'not-an-account', risk_flags: [] }),
        'INV-1',
      ),
    /invalid recipient/,
  );
});

test('rejects a model amount with more than six decimals', () => {
  assert.throws(
    () =>
      parseModelDecision(
        JSON.stringify({ amount_usdc: '10.4000001', recipient: 'alice.samimmi.testnet' }),
        'INV-1',
      ),
    /at most 6 decimals/,
  );
});

test('local risk detection catches gift cards and new bank details', () => {
  const gift = extractLocally(INVOICES.risky.text);
  assert.ok(gift.riskFlags.includes('GIFT_CARD_REQUEST'));
  const bank = extractLocally('New bank details: pay to alice.samimmi.testnet 4 USDC');
  assert.ok(bank.riskFlags.includes('NEW_BANK_DETAILS'));
});
