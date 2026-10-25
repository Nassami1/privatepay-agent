#!/usr/bin/env tsx
/**
 * One-time testnet bootstrap for the real-FT demo.
 *
 * Owner:    samimmi.testnet            (human wallet; key in .keys/owner.json)
 * Agent:    agent.samimmi.testnet      (Function Call Key, try_pay only)
 * Policy:   policy.samimmi.testnet     (holds the tUSDC and enforces the cap)
 * Token:    usdc.samimmi.testnet       (minimal NEP-141 test token, 6 decimals)
 * Payees:   alice.samimmi.testnet, eve.samimmi.testnet
 *
 * The owner key is never committed. The script writes `.env` for the agent
 * runtime and `deployments/testnet.json` for public addresses only.
 *
 *   npm run bootstrap:testnet
 *
 * The script is intended for a fresh set of accounts. Existing accounts and
 * initialized contracts are detected and left alone, but adding the agent key
 * requires the temporary admin key that this script creates with the account.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, keyStores, KeyPair, transactions, type Account } from 'near-api-js';
import { loadConfig, loadDotEnv, type Config } from '../agent/config.js';
import { viewAccount, viewFunction } from '../agent/near/rpc.js';

const GAS = 100_000_000_000_000n; // 100 TGas
const KEY_ALLOWANCE = 500_000_000_000_000_000_000_000n; // 0.5 NEAR
const MICRO = 1_000_000n;

const OWNER = 'samimmi.testnet';
const POLICY = 'policy.samimmi.testnet';
const AGENT = 'agent.samimmi.testnet';
const TOKEN = 'usdc.samimmi.testnet';
const ALICE = 'alice.samimmi.testnet';
const EVE = 'eve.samimmi.testnet';

interface KeyFile {
  accountId?: string;
  publicKey: string;
  secretKey: string;
}

function log(message: string): void {
  console.log(`[bootstrap] ${message}`);
}

function txHashOf(outcome: { transaction_outcome?: { id?: string } }): string {
  return outcome.transaction_outcome?.id ?? 'unknown';
}

function readKey(path: string): KeyFile | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<KeyFile>;
  if (typeof parsed.secretKey !== 'string' || typeof parsed.publicKey !== 'string') return null;
  return { accountId: parsed.accountId, publicKey: parsed.publicKey, secretKey: parsed.secretKey };
}

function writeKey(path: string, accountId: string, keyPair: KeyPair): KeyFile {
  const file: KeyFile = {
    accountId,
    publicKey: keyPair.getPublicKey().toString(),
    secretKey: keyPair.toString(),
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function loadOrCreateKey(path: string, accountId: string): KeyFile {
  const existing = readKey(path);
  if (existing !== null) return existing;
  const created = writeKey(path, accountId, KeyPair.fromRandom('ed25519'));
  log(`generated key for ${accountId}`);
  return created;
}

async function connectAs(config: Config, accountId: string, secretKey: string): Promise<Account> {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(config.near.network, accountId, KeyPair.fromString(secretKey));
  const near = await connect({
    networkId: config.near.network,
    nodeUrl: config.near.rpcUrl,
    keyStore,
    logger: false,
  } as unknown as Parameters<typeof connect>[0]);
  return near.account(accountId);
}

async function ensureAccount(
  config: Config,
  owner: Account,
  accountId: string,
  publicKey: string,
  amountNear: number,
): Promise<boolean> {
  if ((await viewAccount(accountId)) !== null) {
    log(`${accountId} exists (skipped creation)`);
    return false;
  }
  const outcome = await owner.createAccount(
    accountId,
    publicKey,
    BigInt(Math.round(amountNear * 1e24)),
  );
  log(`${accountId} created with ${amountNear} NEAR tx=${txHashOf(outcome)}`);
  return true;
}

async function deployWasm(account: Account, wasmPath: string): Promise<void> {
  const state = await viewAccount(account.accountId);
  if (state !== null && state.code_hash !== '11111111111111111111111111111111') {
    log(`${account.accountId} already has code (deploy skipped)`);
    return;
  }
  const wasm = readFileSync(wasmPath);
  const outcome = await account.signAndSendTransaction({
    receiverId: account.accountId,
    actions: [transactions.deployContract(wasm)],
  });
  log(`${account.accountId} deployed ${wasm.length} bytes tx=${txHashOf(outcome)}`);
}

async function call(
  account: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
): Promise<{ transaction_outcome: { id: string } }> {
  return account.functionCall({
    contractId,
    methodName,
    args,
    gas: GAS,
    attachedDeposit: 0n,
  }) as Promise<{ transaction_outcome: { id: string } }>;
}

async function view<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T | null> {
  try {
    return await viewFunction<T>(contractId, methodName, args);
  } catch {
    return null;
  }
}

function updateEnv(config: Config, values: Record<string, string>): void {
  const path = join(config.rootDir, '.env');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const key = line.split('=')[0]?.trim();
    if (key !== undefined && key in values) {
      seen.add(key);
      return `${key}=${values[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }
  writeFileSync(path, `${output.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const keysDir = join(config.rootDir, '.keys');

  const ownerKey = readKey(join(keysDir, 'owner.json'));
  if (ownerKey === null) {
    throw new Error(
      'Missing .keys/owner.json. Create it from the owner seed phrase; it must contain {accountId, publicKey, secretKey}.',
    );
  }
  if (ownerKey.accountId !== OWNER) {
    throw new Error(`.keys/owner.json is for ${ownerKey.accountId}, expected ${OWNER}`);
  }

  for (const wasm of [
    join(config.rootDir, 'contracts', 'policy', 'build', 'privatepay_policy.wasm'),
    join(config.rootDir, 'contracts', 'test-ft', 'build', 'privatepay_test_ft.wasm'),
  ]) {
    if (!existsSync(wasm)) {
      throw new Error(`Missing ${wasm}. Run "npm run contract:build" first.`);
    }
  }

  const policyKey = loadOrCreateKey(join(keysDir, 'policy.json'), POLICY);
  const tokenKey = loadOrCreateKey(join(keysDir, 'usdc.json'), TOKEN);
  const agentAdminKey = loadOrCreateKey(join(keysDir, 'agent-admin.json'), AGENT);
  const agentKey = loadOrCreateKey(join(keysDir, 'agent.json'), AGENT);
  const recipients = loadOrCreateKey(join(keysDir, 'recipients.json'), ALICE);

  const owner = await connectAs(config, OWNER, ownerKey.secretKey);
  const ownerState = await viewAccount(OWNER);
  if (ownerState === null) throw new Error(`${OWNER} does not exist`);
  log(`owner ${OWNER} balance ${(Number(ownerState.amount) / 1e24).toFixed(2)} NEAR`);

  // 1. accounts
  await ensureAccount(config, owner, POLICY, policyKey.publicKey, 5);
  await ensureAccount(config, owner, AGENT, agentAdminKey.publicKey, 3);
  await ensureAccount(config, owner, TOKEN, tokenKey.publicKey, 3);
  await ensureAccount(config, owner, ALICE, recipients.publicKey, 0.2);
  await ensureAccount(config, owner, EVE, recipients.publicKey, 0.2);

  // 2. contracts
  await deployWasm(
    await connectAs(config, POLICY, policyKey.secretKey),
    join(config.rootDir, 'contracts', 'policy', 'build', 'privatepay_policy.wasm'),
  );
  await deployWasm(
    await connectAs(config, TOKEN, tokenKey.secretKey),
    join(config.rootDir, 'contracts', 'test-ft', 'build', 'privatepay_test_ft.wasm'),
  );

  // 3. token init + mint to the policy contract
  if ((await view(TOKEN, 'ft_metadata')) === null) {
    const init = await call(await connectAs(config, TOKEN, tokenKey.secretKey), TOKEN, 'new', {
      owner: OWNER,
      initial_supply: '0',
    });
    log(`token initialized tx=${txHashOf(init)}`);
  }
  const policyBalance = await view<string>(TOKEN, 'ft_balance_of', { account_id: POLICY });
  const current = policyBalance !== null ? BigInt(policyBalance) : 0n;
  if (current < 1_000_000n * MICRO) {
    const mint = await call(owner, TOKEN, 'mint', {
      account_id: POLICY,
      amount: (1_000_000n * MICRO).toString(),
    });
    log(`minted 1,000,000 tUSDC to ${POLICY} tx=${txHashOf(mint)}`);
  } else {
    log(`policy token balance already ${current.toString()} micro`);
  }

  // 4. policy init + whitelist
  if ((await view(POLICY, 'get_policy')) === null) {
    const init = await call(await connectAs(config, POLICY, policyKey.secretKey), POLICY, 'new', {
      owner: OWNER,
      agent_id: AGENT,
      token_id: TOKEN,
      cap_micro_usdc: (BigInt(config.demo.dailyCapUsdc) * MICRO).toString(),
    });
    log(`policy initialized tx=${txHashOf(init)}`);
  }
  const whitelist = await call(owner, POLICY, 'add_to_whitelist', { account_id: ALICE });
  log(`whitelisted ${ALICE} tx=${txHashOf(whitelist)}`);

  // 5. agent Function Call Key, then remove the temporary admin key
  const agentAccount = await connectAs(config, AGENT, agentAdminKey.secretKey);
  const fcPublic = agentKey.publicKey;
  const already = await viewAccount(AGENT);
  if (already === null) throw new Error(`${AGENT} missing`);
  try {
    const add = await agentAccount.addKey(fcPublic, POLICY, ['try_pay'], KEY_ALLOWANCE);
    log(`agent Function Call Key installed tx=${txHashOf(add)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already used|already exists/i.test(message)) throw error;
    log('agent Function Call Key already exists');
  }
  try {
    const deleted = await agentAccount.deleteKey(agentAdminKey.publicKey);
    log(`temporary agent admin key removed tx=${txHashOf(deleted)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/does not exist/i.test(message)) throw error;
  }

  // 6. write public deployment manifest + agent env
  const manifest = {
    network: 'testnet',
    owner: OWNER,
    agent: AGENT,
    policy: POLICY,
    token: TOKEN,
    recipients: { alice: ALICE, eve: EVE },
    capMicroUsdc: (BigInt(config.demo.dailyCapUsdc) * MICRO).toString(),
    tokenDecimals: 6,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(join(config.rootDir, 'deployments'), { recursive: true });
  writeFileSync(join(config.rootDir, 'deployments', 'testnet.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  updateEnv(config, {
    NEAR_NETWORK: 'testnet',
    NEAR_ACCOUNT_ID: AGENT,
    NEAR_AGENT_KEY: agentKey.secretKey,
    POLICY_CONTRACT_ID: POLICY,
    WHITELIST_RECIPIENT: ALICE,
    DAILY_CAP_USDC: String(config.demo.dailyCapUsdc),
  });

  const policy = await view<Record<string, unknown>>(POLICY, 'get_policy');
  const tokenBalance = await view<string>(TOKEN, 'ft_balance_of', { account_id: POLICY });
  console.log('[bootstrap] done');
  console.log(`[bootstrap] policy=${POLICY} agent=${AGENT} token=${TOKEN}`);
  console.log(`[bootstrap] policy state=${JSON.stringify(policy)}`);
  console.log(`[bootstrap] policy token balance=${JSON.stringify(tokenBalance)} micro`);
  console.log('[bootstrap] .env updated for the agent runtime (owner key stays in .keys/)');
}

try {
  await main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
