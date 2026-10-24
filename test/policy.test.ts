import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPolicy } from '../agent/policy/local.js';

const now = (): Date => new Date('2026-10-24T12:00:00Z');

test('allows a whitelisted payment under the cap and records it', async () => {
  const policy = new LocalPolicy({ capUsdc: 10, whitelist: ['alice.testnet'], now });
  const result = await policy.tryPay({ to: 'alice.testnet', amountUsdc: 3, invoiceRef: 'INV-1' });
  assert.equal(result.ok, true);
  const state = await policy.getPolicy();
  assert.equal(state.capUsdc, 10);
  assert.equal(state.spentTodayUsdc, 3);
  assert.equal(state.mode, 'local');
  const log = await policy.getLog(10);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.result, 'SUCCESS');
  assert.equal(log[0]?.invoiceRef, 'INV-1');
});

test('blocks an over-cap payment and does not move the spent counter', async () => {
  const policy = new LocalPolicy({ capUsdc: 10, whitelist: ['alice.testnet'], now });
  await policy.tryPay({ to: 'alice.testnet', amountUsdc: 8, invoiceRef: 'INV-1' });
  const blocked = await policy.tryPay({ to: 'alice.testnet', amountUsdc: 3, invoiceRef: 'INV-2' });
  assert.deepEqual(blocked, { ok: false, reason: 'OVER_LIMIT' });
  assert.equal((await policy.getPolicy()).spentTodayUsdc, 8);
});

test('checks the whitelist before the cap, matching the contract', async () => {
  const policy = new LocalPolicy({ capUsdc: 10, whitelist: ['alice.testnet'], now });
  const blocked = await policy.tryPay({ to: 'eve.testnet', amountUsdc: 50, invoiceRef: 'INV-3' });
  assert.deepEqual(blocked, { ok: false, reason: 'NOT_WHITELISTED' });
  const log = await policy.getLog(10);
  assert.equal(log[0]?.result, 'BLOCKED_NOT_WHITELISTED');
});

test('does not let a blocked attempt consume the cap', async () => {
  const policy = new LocalPolicy({ capUsdc: 10, whitelist: ['alice.testnet'], now });
  await policy.tryPay({ to: 'alice.testnet', amountUsdc: 50, invoiceRef: 'INV-1' });
  const allowed = await policy.tryPay({ to: 'alice.testnet', amountUsdc: 10, invoiceRef: 'INV-2' });
  assert.equal(allowed.ok, true);
});

test('returns the newest log entries last and honours the limit', async () => {
  const policy = new LocalPolicy({ capUsdc: 10, whitelist: ['alice.testnet'], now });
  for (const ref of ['A', 'B', 'C']) {
    await policy.tryPay({ to: 'alice.testnet', amountUsdc: 0, invoiceRef: ref });
  }
  const log = await policy.getLog(2);
  assert.deepEqual(log.map((entry) => entry.invoiceRef), ['B', 'C']);
});

test('resetSpent clears the counter for demo replay', async () => {
  const policy = new LocalPolicy({ capUsdc: 10, whitelist: ['alice.testnet'], now });
  await policy.tryPay({ to: 'alice.testnet', amountUsdc: 9, invoiceRef: 'INV-1' });
  policy.resetSpent();
  assert.equal((await policy.getPolicy()).spentTodayUsdc, 0);
  const allowed = await policy.tryPay({ to: 'alice.testnet', amountUsdc: 9, invoiceRef: 'INV-2' });
  assert.equal(allowed.ok, true);
});
