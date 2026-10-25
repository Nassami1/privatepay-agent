#!/usr/bin/env tsx
/**
 * Live contract acceptance checks, using the agent's own Function Call Key.
 *
 *   - a duplicate invoice reference is refused
 *   - a zero amount is refused
 *   - an over-cap payment is refused
 *   - a non-whitelisted recipient is refused
 *   - none of these changes the token balances
 *
 * Run this while the policy has already paid INV-2026-1042 once (demo:success).
 */

import { formatUsdc } from '../agent/amount.js';
import { loadConfig, loadDotEnv } from '../agent/config.js';
import { createPolicy } from '../agent/policy/index.js';
import { getFtBalance } from '../agent/near/ft.js';

interface Check {
  name: string;
  actual: string;
  expected: string;
}

try {
  loadDotEnv();
  const config = loadConfig();
  const policy = await createPolicy(config);
  if (policy.mode !== 'testnet') {
    console.log('[policy-check] SKIPPED no live contract configured');
    process.exitCode = 0;
  } else {
    const state = await policy.getPolicy();
    const tokenId = state.tokenId;
    if (tokenId === null) throw new Error('contract has no token_id');
    const policyAccount = policy.contractId as string;
    const before = {
      policy: await getFtBalance(tokenId, policyAccount),
      alice: await getFtBalance(tokenId, config.demo.whitelistRecipient),
    };

    const checks: Check[] = [];
    const run = async (
      name: string,
      expected: string,
      request: { to: string; amountMicroUsdc: bigint; invoiceRef: string },
    ): Promise<void> => {
      const outcome = await policy.tryPay(request);
      const actual = outcome.ok ? 'SUCCESS' : outcome.reason;
      checks.push({ name, actual, expected });
    };

    await run(
      'duplicate invoice_ref',
      'DUPLICATE_INVOICE',
      {
        to: config.demo.whitelistRecipient,
        amountMicroUsdc: 1_000_000n,
        invoiceRef: 'INV-2026-1042',
      },
    );
    await run('zero amount', 'ZERO_AMOUNT', {
      to: config.demo.whitelistRecipient,
      amountMicroUsdc: 0n,
      invoiceRef: 'ZERO-CHECK',
    });
    await run('over cap', 'OVER_LIMIT', {
      to: config.demo.whitelistRecipient,
      amountMicroUsdc: 50_000_000n,
      invoiceRef: 'OVER-CHECK',
    });
    await run('not whitelisted', 'NOT_WHITELISTED', {
      to: 'eve.samimmi.testnet',
      amountMicroUsdc: 1_000_000n,
      invoiceRef: 'EVE-CHECK',
    });

    const after = {
      policy: await getFtBalance(tokenId, policyAccount),
      alice: await getFtBalance(tokenId, config.demo.whitelistRecipient),
    };

    let failures = 0;
    for (const check of checks) {
      const ok = check.actual === check.expected;
      if (!ok) failures += 1;
      console.log(
        `[policy-check] ${ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.actual} (expected ${check.expected})`,
      );
    }

    const balancesHeld =
      before.policy === after.policy && before.alice === after.alice;
    console.log(
      `[policy-check] ${balancesHeld ? 'PASS' : 'FAIL'} token balances unchanged: ` +
        `policy=${formatUsdc(after.policy)} alice=${formatUsdc(after.alice)}`,
    );
    if (!balancesHeld) failures += 1;

    console.log(`[policy-check] result=${failures === 0 ? 'PASS' : 'FAIL'}`);
    process.exitCode = failures === 0 ? 0 : 1;
  }
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
