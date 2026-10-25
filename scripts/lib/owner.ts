/**
 * Owner-side helpers for testnet maintenance scripts.
 *
 * The owner is the human wallet (`samimmi.testnet`), not the agent account.
 * Its full-access key lives in `.keys/owner.json` (gitignored) and is never read
 * by the agent runtime. The agent's Function Call Key cannot call any of the
 * methods these scripts use.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, keyStores, KeyPair, type Account } from 'near-api-js';
import type { Config } from '../../agent/config.js';
import { viewFunction } from '../../agent/near/rpc.js';
import type { PolicyState } from '../../agent/types.js';

export interface OwnerKeyFile {
  accountId: string;
  publicKey: string;
  secretKey: string;
}

export interface OwnerContext {
  account: Account;
  accountId: string;
  policyId: string;
}

export function loadOwnerKey(rootDir: string): OwnerKeyFile {
  const path = join(rootDir, '.keys', 'owner.json');
  if (!existsSync(path)) {
    throw new Error(
      'Missing .keys/owner.json. Create it from the owner seed phrase; it must contain {accountId, publicKey, secretKey}.',
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerKeyFile>;
  if (
    typeof parsed.accountId !== 'string' ||
    typeof parsed.publicKey !== 'string' ||
    typeof parsed.secretKey !== 'string'
  ) {
    throw new Error('.keys/owner.json is missing accountId, publicKey or secretKey');
  }
  return { accountId: parsed.accountId, publicKey: parsed.publicKey, secretKey: parsed.secretKey };
}

export async function connectOwner(config: Config): Promise<OwnerContext> {
  const keyFile = loadOwnerKey(config.rootDir);
  const policyId = config.near.policyContractId;
  if (policyId === null) {
    throw new Error('POLICY_CONTRACT_ID is not set');
  }

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    config.near.network,
    keyFile.accountId,
    KeyPair.fromString(keyFile.secretKey),
  );
  const near = await connect({
    networkId: config.near.network,
    nodeUrl: config.near.rpcUrl,
    keyStore,
    logger: false,
  } as unknown as Parameters<typeof connect>[0]);
  const account = await near.account(keyFile.accountId);
  return { account, accountId: keyFile.accountId, policyId };
}

export async function readPolicy(policyId: string): Promise<PolicyState | null> {
  try {
    const raw = await viewFunction<{
      owner: string;
      agent_id: string;
      token_id: string;
      cap_micro_usdc: string;
      spent_today_micro_usdc: string;
      whitelist: string[];
      paid_invoices: number;
    }>(policyId, 'get_policy');
    return {
      ownerId: raw.owner,
      agentId: raw.agent_id,
      tokenId: raw.token_id,
      capMicroUsdc: BigInt(raw.cap_micro_usdc),
      spentTodayMicroUsdc: BigInt(raw.spent_today_micro_usdc),
      whitelist: raw.whitelist,
      paidInvoices: Number(raw.paid_invoices),
      mode: 'testnet',
      contractId: policyId,
    };
  } catch {
    return null;
  }
}

export function txHashOf(outcome: { transaction_outcome?: { id?: string } }): string {
  return outcome.transaction_outcome?.id ?? 'unknown';
}
