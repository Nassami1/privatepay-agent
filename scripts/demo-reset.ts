#!/usr/bin/env tsx
/**
 * Owner-only reset so the two-minute demo can be replayed without waiting for
 * UTC midnight. Uses the owner key from `.keys/owner.json`; the agent's Function
 * Call Key cannot call any of these methods.
 */

import { MICRO_PER_USDC, formatUsdc } from '../agent/amount.js';
import { loadConfig, loadDotEnv } from '../agent/config.js';
import { connectOwner, readPolicy, txHashOf } from './lib/owner.js';

const GAS = 100_000_000_000_000n;

try {
  loadDotEnv();
  const config = loadConfig();
  const { account, policyId } = await connectOwner(config);
  const cap = BigInt(config.demo.dailyCapUsdc) * MICRO_PER_USDC;

  const capTx = await account.functionCall({
    contractId: policyId,
    methodName: 'set_daily_cap',
    args: { cap_micro_usdc: cap.toString() },
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(`[reset] cap=${formatUsdc(cap)} USDC tx=${txHashOf(capTx)}`);

  const whitelistTx = await account.functionCall({
    contractId: policyId,
    methodName: 'add_to_whitelist',
    args: { account_id: config.demo.whitelistRecipient },
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(
    `[reset] whitelist += ${config.demo.whitelistRecipient} tx=${txHashOf(whitelistTx)}`,
  );

  const resetTx = await account.functionCall({
    contractId: policyId,
    methodName: 'reset_spent',
    args: {},
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(`[reset] spent_today=0, invoice idempotency cleared tx=${txHashOf(resetTx)}`);

  // The read node can lag one block behind the reset; wait for the counter.
  let policy = await readPolicy(policyId);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (policy !== null && policy.spentTodayMicroUsdc === 0n) break;
    await sleep(400);
    policy = await readPolicy(policyId);
  }
  if (policy !== null) {
    console.log(
      `[reset] policy cap=${formatUsdc(policy.capMicroUsdc)} ` +
        `spent=${formatUsdc(policy.spentTodayMicroUsdc)} ` +
        `whitelist=[${policy.whitelist.join(', ')}]`,
    );
  }
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
