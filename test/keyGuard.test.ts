import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAccessKey } from '../agent/keyGuard.js';
import type { AccessKeyPermissionView } from '../agent/near/rpc.js';

const POLICY = 'policy.samimmi.testnet';

function functionCall(
  receiver_id: string,
  method_names: string[],
  allowance: string | null = '500000000000000000000000',
): AccessKeyPermissionView {
  return { FunctionCall: { receiver_id, method_names, allowance } };
}

test('accepts a key scoped to the policy and try_pay', () => {
  const checks = assessAccessKey(functionCall(POLICY, ['try_pay']), POLICY);
  assert.ok(checks.every((check) => check.ok));
});

test('rejects a full-access key', () => {
  const checks = assessAccessKey('FullAccess', POLICY);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.ok, false);
});

test('rejects a key scoped to another contract', () => {
  const checks = assessAccessKey(functionCall('other.testnet', ['try_pay']), POLICY);
  assert.equal(checks.find((check) => check.name === 'receiver_scoped')?.ok, false);
});

test('rejects a key that can call a mutator', () => {
  const checks = assessAccessKey(functionCall(POLICY, ['try_pay', 'set_daily_cap']), POLICY);
  assert.equal(checks.find((check) => check.name === 'only_try_pay')?.ok, false);
  assert.equal(checks.find((check) => check.name === 'no_policy_mutators')?.ok, false);
});

test('rejects a key with no gas allowance', () => {
  const checks = assessAccessKey(functionCall(POLICY, ['try_pay'], null), POLICY);
  assert.equal(checks.find((check) => check.name === 'has_gas_allowance')?.ok, false);
});
