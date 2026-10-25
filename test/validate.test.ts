import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../agent/tee/validate.js';
import type { TeeDecision } from '../agent/types.js';

function decision(amountMicroUsdc: bigint, recipient = 'alice.samimmi.testnet'): TeeDecision {
  return { amountMicroUsdc, recipient, invoiceRef: 'INV-1', purpose: '', riskFlags: [] };
}

test('accepts 10.40 when the invoice says 10.40', () => {
  const result = validateDecision(
    decision(10_400_000n),
    'Total due: 10.40 USDC\nPay to: alice.samimmi.testnet',
  );
  assert.equal(result.ok, true);
  assert.ok(result.checks.every((check) => check.ok));
});

test('accepts a trailing-zero-free amount', () => {
  assert.equal(
    validateDecision(decision(10_400_000n), 'Amount: 10.4 USDC alice.samimmi.testnet').ok,
    true,
  );
});

test('rejects 10.40 when the invoice only says 10', () => {
  const result = validateDecision(
    decision(10_400_000n),
    'Amount: 10 USDC\nPay to: alice.samimmi.testnet',
  );
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === 'amount_present')?.ok, false);
});

test('rejects a recipient that is not in the invoice text', () => {
  const result = validateDecision(
    decision(3_000_000n, 'mallory.samimmi.testnet'),
    'Amount: 3 USDC\nPay to: alice.samimmi.testnet',
  );
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === 'recipient_present')?.ok, false);
});

test('rejects a zero amount', () => {
  assert.equal(validateDecision(decision(0n), 'Amount: 0 USDC').ok, false);
});
