/**
 * Owner-side helpers for testnet maintenance scripts.
 *
 * The owner key is a full-access testnet key kept outside the repository in
 * `.keys/` (gitignored). It is never read by the agent runtime, and the agent's
 * own Function Call Key cannot call any of the methods these scripts use.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, keyStores, KeyPair, type Account } from 'near-api-js';
import type { Config } from '../../agent/config.js';

export interface DeployerKeyFile {
  accountId: string;
  secretKey: string;
  publicKey?: string;
}

export interface OwnerContext {
  account: Account;
  accountId: string;
  contractId: string;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

export function loadDeployerKey(rootDir: string): DeployerKeyFile {
  const explicit = arg('--key');
  const candidates = explicit
    ? [resolve(explicit)]
    : ['.keys/deployer.json', '.keys/dev-account.json', '.keys/testnet.json'].map((path) =>
        join(rootDir, path),
      );
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeployerKeyFile>;
    if (typeof parsed.accountId === 'string' && typeof parsed.secretKey === 'string') {
      return { accountId: parsed.accountId, secretKey: parsed.secretKey, publicKey: parsed.publicKey };
    }
  }
  throw new Error(
    `No owner key found. Expected .keys/deployer.json with {accountId, secretKey}. Tried: ${candidates.join(', ')}`,
  );
}

export async function connectOwner(config: Config): Promise<OwnerContext> {
  const keyFile = loadDeployerKey(config.rootDir);
  const accountId = config.near.accountId ?? keyFile.accountId;
  const contractId = config.near.policyContractId ?? accountId;
  if (accountId !== keyFile.accountId) {
    throw new Error(
      `NEAR_ACCOUNT_ID (${accountId}) does not match the owner key account (${keyFile.accountId}).`,
    );
  }
  if (contractId !== accountId) {
    throw new Error(
      `This prototype owns the policy on the account that holds the key. Set POLICY_CONTRACT_ID=${accountId}.`,
    );
  }

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(config.near.network, accountId, KeyPair.fromString(keyFile.secretKey));
  const near = await connect({
    networkId: config.near.network,
    nodeUrl: config.near.rpcUrl,
    keyStore,
    logger: false,
  } as unknown as Parameters<typeof connect>[0]);
  const account = await near.account(accountId);
  return { account, accountId, contractId };
}

export function txHashOf(outcome: { transaction_outcome?: { id?: string } }): string {
  return outcome.transaction_outcome?.id ?? 'unknown';
}
