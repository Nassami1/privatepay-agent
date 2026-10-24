#!/usr/bin/env tsx
/**
 * Owner-only reset so the two-minute demo can be replayed without waiting for
 * UTC midnight. Uses the full-access owner key from `.keys/`, never the agent's
 * Function Call Key (which cannot call these methods at all).
 */

import { loadConfig, loadDotEnv } from '../agent/config.js';
import { viewFunction } from '../agent/near/rpc.js';
import { connectOwner, txHashOf } from './lib/owner.js';

const GAS = 100_000_000_000_000n;

try {
  loadDotEnv();
  const config = loadConfig();
  const { account, contractId } = await connectOwner(config);

  const cap = await account.functionCall({
    contractId,
    methodName: 'set_daily_cap',
    args: { cap_usdc: config.demo.dailyCapUsdc },
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(`[reset] cap=${config.demo.dailyCapUsdc} tx=${txHashOf(cap)}`);

  const whitelist = await account.functionCall({
    contractId,
    methodName: 'add_to_whitelist',
    args: { account_id: config.demo.whitelistRecipient },
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(`[reset] whitelist += ${config.demo.whitelistRecipient} tx=${txHashOf(whitelist)}`);

  const spent = await account.functionCall({
    contractId,
    methodName: 'reset_spent',
    args: {},
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(`[reset] spent_today_usdc=0 tx=${txHashOf(spent)}`);

  const policy = await viewFunction<{
    cap_usdc: number;
    spent_today_usdc: number;
    whitelist: string[];
  }>(contractId, 'get_policy');
  console.log(
    `[reset] policy cap=${policy.cap_usdc} spent=${policy.spent_today_usdc} ` +
      `whitelist=[${policy.whitelist.join(', ')}]`,
  );
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
