#!/usr/bin/env tsx
/**
 * Deploy the policy contract to NEAR testnet and install the agent's
 * least-privilege Function Call Key.
 *
 * Owner actions use a full-access key kept outside the repository
 * (`.keys/deployer.json`, gitignored). The agent key never has full access.
 *
 *   npm run contract:deploy            # deploy if needed, then set demo policy
 *   npm run contract:deploy -- --force # replace the wasm (storage is preserved)
 *
 * Deploying code to an existing account does not clear its storage. Use
 * `npm run demo:reset` to reset the spending counter; the audit log is designed
 * to be append-only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair, transactions } from 'near-api-js';
import { loadConfig, loadDotEnv } from '../agent/config.js';
import { isFunctionCallPermission, viewAccessKey, viewFunction } from '../agent/near/rpc.js';
import { connectOwner, txHashOf } from './lib/owner.js';

const GAS = 100_000_000_000_000n;
const KEY_ALLOWANCE = 500_000_000_000_000_000_000_000n; // 0.5 NEAR of gas

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const { account, accountId, contractId } = await connectOwner(config);

  const wasmPath = join(config.rootDir, 'contracts', 'policy', 'build', 'privatepay_policy.wasm');
  if (!existsSync(wasmPath)) {
    throw new Error(
      `Wasm not found at ${wasmPath}. Build it with "npm run contract:build" (Rust toolchain required).`,
    );
  }
  const wasm = readFileSync(wasmPath);

  const state = await account.state();
  console.log(
    `[deploy] account=${accountId} balance=${(Number(state.amount) / 1e24).toFixed(2)} NEAR wasm=${wasm.length} bytes`,
  );

  const deployed = state.code_hash !== '11111111111111111111111111111111';
  if (deployed && !process.argv.includes('--force')) {
    console.log('[deploy] contract already deployed; keeping code and storage (use --force to replace the wasm)');
  } else {
    const outcome = await account.signAndSendTransaction({
      receiverId: contractId,
      actions: [transactions.deployContract(wasm)],
    });
    console.log(`[deploy] wasm deployed tx=${txHashOf(outcome)}`);
  }

  const existing = await viewFunctionOrNull(contractId, 'get_policy');
  if (existing === null) {
    const initOutcome = await account.functionCall({
      contractId,
      methodName: 'new',
      args: { owner: contractId, cap_usdc: config.demo.dailyCapUsdc },
      gas: GAS,
      attachedDeposit: 0n,
    });
    console.log(
      `[init] owner=${contractId} cap=${config.demo.dailyCapUsdc} USDC tx=${txHashOf(initOutcome)}`,
    );
  } else {
    console.log('[init] contract already initialised; leaving state as-is');
  }

  const setCap = await account.functionCall({
    contractId,
    methodName: 'set_daily_cap',
    args: { cap_usdc: config.demo.dailyCapUsdc },
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(`[policy] cap=${config.demo.dailyCapUsdc} USDC tx=${txHashOf(setCap)}`);

  const whitelistOutcome = await account.functionCall({
    contractId,
    methodName: 'add_to_whitelist',
    args: { account_id: config.demo.whitelistRecipient },
    gas: GAS,
    attachedDeposit: 0n,
  });
  console.log(
    `[policy] whitelist += ${config.demo.whitelistRecipient} tx=${txHashOf(whitelistOutcome)}`,
  );

  if (config.near.agentKey === null) {
    throw new Error(
      'NEAR_AGENT_KEY is empty. Generate a Function Call Key first (see README "Live testnet setup").',
    );
  }
  const agentPublicKey = KeyPair.fromString(config.near.agentKey).getPublicKey().toString();
  const existingKey = await viewAccessKey(accountId, agentPublicKey).catch(() => null);
  const alreadyScoped =
    existingKey !== null &&
    isFunctionCallPermission(existingKey.permission) &&
    existingKey.permission.FunctionCall.receiver_id === contractId &&
    existingKey.permission.FunctionCall.method_names.length === 1 &&
    existingKey.permission.FunctionCall.method_names[0] === 'try_pay';

  if (alreadyScoped) {
    console.log(
      `[key] function-call key ${agentPublicKey} already scoped to ${contractId} + try_pay; unchanged`,
    );
  } else {
    if (existingKey !== null) {
      await account.deleteKey(agentPublicKey);
      console.log('[key] removed the existing key with different permissions');
    }
    const addKeyOutcome = await account.addKey(
      agentPublicKey,
      contractId,
      ['try_pay'],
      KEY_ALLOWANCE,
    );
    console.log(
      `[key] function-call key ${agentPublicKey} receiver=${contractId} methods=[try_pay] ` +
        `allowance=0.50 NEAR tx=${txHashOf(addKeyOutcome)}`,
    );
  }

  const finalPolicy = await viewFunction<{
    cap_usdc: number;
    spent_today_usdc: number;
    whitelist: string[];
  }>(contractId, 'get_policy');
  console.log(
    `[done] policy cap=${finalPolicy.cap_usdc} spent=${finalPolicy.spent_today_usdc} ` +
      `whitelist=[${finalPolicy.whitelist.join(', ')}]`,
  );
  console.log(`[done] explorer https://testnet.nearblocks.io/address/${contractId}`);
  console.log(
    '[done] .env for live mode:\n' +
      `  NEAR_ACCOUNT_ID=${accountId}\n  POLICY_CONTRACT_ID=${contractId}\n  NEAR_AGENT_KEY=<function-call key>`,
  );
}

async function viewFunctionOrNull(contractId: string, methodName: string): Promise<unknown> {
  try {
    return await viewFunction(contractId, methodName, {});
  } catch {
    return null;
  }
}

try {
  await main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
