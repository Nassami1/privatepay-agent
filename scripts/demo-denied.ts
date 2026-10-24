#!/usr/bin/env tsx
/**
 * The key-denied demo.
 *
 * Proves the least-privilege claim with the network instead of a diagram: the
 * agent's Function Call Key is used to attempt an owner-only policy change.
 * NEAR must reject the transaction before the contract runs.
 */

import { connect, keyStores, KeyPair } from 'near-api-js';
import { hasLivePolicy, loadConfig, loadDotEnv } from '../agent/config.js';

try {
  loadDotEnv();
  const config = loadConfig();
  if (!hasLivePolicy(config)) {
    console.log('[denied] SKIPPED no live policy configured');
    console.log('[denied] set NEAR_ACCOUNT_ID, NEAR_AGENT_KEY, POLICY_CONTRACT_ID to run this proof');
    process.exitCode = 0;
  } else {
    const accountId = config.near.accountId as string;
    const contractId = config.near.policyContractId as string;
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      config.near.network,
      accountId,
      KeyPair.fromString(config.near.agentKey as string),
    );
    const near = await connect({
      networkId: config.near.network,
      nodeUrl: config.near.rpcUrl,
      keyStore,
      logger: false,
    } as unknown as Parameters<typeof connect>[0]);
    const account = await near.account(accountId);

    console.log(`[denied] agent key ${accountId} tries set_daily_cap(cap_usdc=9999)`);
    try {
      await account.functionCall({
        contractId,
        methodName: 'set_daily_cap',
        args: { cap_usdc: 9999 },
        gas: 30_000_000_000_000n,
        attachedDeposit: 0n,
      });
      console.error('[denied] FAIL the Function Call Key was able to change the policy');
      process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const firstLine = message.split('\n')[0] ?? message;
      const permissionDenied = /isn't allowed by the access key|not allowed by the access key/i.test(
        message,
      );
      if (!permissionDenied) {
        console.error(`[denied] INCONCLUSIVE: ${firstLine}`);
        console.error('[denied] the network did not authoritatively reject the call; not claiming a security result');
        process.exitCode = 1;
      } else {
        console.log(`[denied] rejected before execution: ${firstLine}`);
        console.log('[denied] result=DENIED — the agent cannot raise its own cap');
        process.exitCode = 0;
      }
    }
  }
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
