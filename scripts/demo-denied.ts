#!/usr/bin/env tsx
/**
 * Two network-level separation proofs.
 *
 *   1. The owner calls `try_pay` directly. The contract must reject it because
 *      only the configured agent may call the payment method.
 *   2. The agent tries to call `set_daily_cap`. NEAR must reject the transaction
 *      before the contract runs because the Function Call Key does not allow it.
 *
 * Neither result is inferred from configuration; both are rejected by the chain.
 */

import { connect, keyStores, KeyPair, transactions } from 'near-api-js';
import { hasLivePolicy, loadConfig, loadDotEnv } from '../agent/config.js';
import { connectOwner } from './lib/owner.js';

const GAS = 100_000_000_000_000n;

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'unknown error';
}

function isFailure(status: unknown): boolean {
  return typeof status === 'object' && status !== null && 'Failure' in status;
}

try {
  loadDotEnv();
  const config = loadConfig();
  if (!hasLivePolicy(config)) {
    console.log('[denied] SKIPPED no live policy configured');
    process.exitCode = 0;
  } else {
    const owner = await connectOwner(config);
    const policyId = owner.policyId;

    console.log(
      `[denied] owner ${owner.accountId} tries try_pay(to=${config.demo.whitelistRecipient}, 1.00 USDC)`,
    );
    try {
      const outcome = await owner.account.signAndSendTransaction({
        receiverId: policyId,
        returnError: true,
        actions: [
          transactions.functionCall(
            'try_pay',
            {
              to: config.demo.whitelistRecipient,
              amount_micro_usdc: '1000000',
              invoice_ref: 'OWNER-DENIED',
            },
            GAS,
            0n,
          ),
        ],
      });
      const failed = isFailure(outcome.status);
      const logs = (outcome.receipts_outcome ?? []).flatMap(
        (receipt: { outcome?: { logs?: string[] } }) => receipt.outcome?.logs ?? [],
      );
      const panicLog = logs.find((line: string) => /only the agent may call try_pay/i.test(line));
      if (!failed) {
        console.error('[denied] FAIL the owner was able to call try_pay');
        process.exitCode = 1;
      } else {
        console.log(
          `[denied] rejected by the contract${
            panicLog !== undefined ? `: ${panicLog.slice(0, 160)}` : ' (status failure)'
          }`,
        );
        console.log(`[denied] owner transaction ${outcome.transaction_outcome.id}`);
        console.log('[denied] result=OWNER_DENIED');
      }
    } catch (error) {
      console.error(`[denied] INCONCLUSIVE owner call: ${firstLine(error)}`);
      process.exitCode = 1;
    }

    if (process.exitCode !== 1) {
      const accountId = config.near.accountId as string;
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
      const agent = await near.account(accountId);

      console.log(`[denied] agent ${accountId} tries set_daily_cap(cap_micro_usdc=9999000000)`);
      try {
        await agent.functionCall({
          contractId: policyId,
          methodName: 'set_daily_cap',
          args: { cap_micro_usdc: '9999000000' },
          gas: 30_000_000_000_000n,
          attachedDeposit: 0n,
        });
        console.error('[denied] FAIL the agent key was able to change the policy');
        process.exitCode = 1;
      } catch (error) {
        const message = firstLine(error);
        if (!/isn't allowed by the access key|not allowed by the access key/i.test(message)) {
          console.error(`[denied] INCONCLUSIVE agent call: ${message}`);
          process.exitCode = 1;
        } else {
          console.log(`[denied] rejected before execution: ${message}`);
          console.log('[denied] result=AGENT_KEY_DENIED');
        }
      }
    }

    if (process.exitCode !== 1) {
      console.log('[denied] owner != agent and the agent key cannot mutate policy');
    }
  }
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
