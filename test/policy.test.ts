import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPolicy } from '../agent/policy/local.js';

const CAP = 10_000_000n;
const THREE = 3_000_000n;
const now = (): Date => new Date('2026-10-25T12:00:00Z');

function policy(): LocalPolicy {
  return new LocalPolicy({ capMicroUsdc: CAP, whitelist: ['alice.samimmi.testnet'], now });
}

test('allows a whitelisted micro-USDC payment under the cap', async () => {
  const subject = policy();
  const result = await subject.tryPay({
    to: 'alice.samimmi.testnet',
    amountMicroUsdc: THREE,
    invoiceRef: 'INV-1',
  });
  assert.equal(result.ok, true);
  const state = await subject.getPolicy();
  assert.equal(state.capMicroUsdc, CAP);
  assert.equal(state.spentTodayMicroUsdc, THREE);
  const log = await subject.getLog(10);
  assert.equal(log[0]?.result, 'SUCCESS');
  assert.equal(log[0]?.amountMicroUsdc, THREE);
});

test('blocks over-cap and does not move the spent counter', async () => {
  const subject = policy();
  await subject.tryPay({ to: 'alice.samimmi.testnet', amountMicroUsdc: 8_000_000n, invoiceRef: 'A' });
  const blocked = await subject.tryPay({
    to: 'alice.samimmi.testnet',
    amountMicroUsdc: 3_000_000n,
    invoiceRef: 'B',
  });
  assert.deepEqual(blocked, { ok: false, reason: 'OVER_LIMIT' });
  assert.equal((await subject.getPolicy()).spentTodayMicroUsdc, 8_000_000n);
});

test('checks the whitelist before the cap', async () => {
  const blocked = await policy().tryPay({
    to: 'eve.samimmi.testnet',
    amountMicroUsdc: 50_000_000n,
    invoiceRef: 'INV-3',
  });
  assert.deepEqual(blocked, { ok: false, reason: 'NOT_WHITELISTED' });
});

test('rejects a duplicate invoice reference', async () => {
  const subject = policy();
  const request = { to: 'alice.samimmi.testnet', amountMicroUsdc: 1_000_000n, invoiceRef: 'DUP' };
  assert.equal((await subject.tryPay(request)).ok, true);
  assert.deepEqual(await subject.tryPay(request), {
    ok: false,
    reason: 'DUPLICATE_INVOICE',
  });
});

test('rejects zero amount and too-long invoice references', async () => {
  const subject = policy();
  assert.deepEqual(
    await subject.tryPay({ to: 'alice.samimmi.testnet', amountMicroUsdc: 0n, invoiceRef: 'Z' }),
    { ok: false, reason: 'ZERO_AMOUNT' },
  );
  assert.deepEqual(
    await subject.tryPay({
      to: 'alice.samimmi.testnet',
      amountMicroUsdc: 1_000_000n,
      invoiceRef: 'x'.repeat(65),
    }),
    { ok: false, reason: 'INVALID_INVOICE_REF' },
  );
});

test('resetSpent clears the counter, idempotency and log', async () => {
  const subject = policy();
  await subject.tryPay({ to: 'alice.samimmi.testnet', amountMicroUsdc: 9_000_000n, invoiceRef: 'A' });
  subject.resetSpent();
  assert.equal((await subject.getPolicy()).spentTodayMicroUsdc, 0n);
  assert.equal((await subject.getLog(10)).length, 0);
  const again = await subject.tryPay({
    to: 'alice.samimmi.testnet',
    amountMicroUsdc: 9_000_000n,
    invoiceRef: 'A',
  });
  assert.equal(again.ok, true);
});
