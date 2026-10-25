/**
 * Runtime configuration.
 *
 * The project deliberately reads a fixed set of environment variable names
 * (see `.env.example`). No extra configuration variables are introduced:
 * the mode of every integration is inferred from whether its credentials are
 * present, which keeps "missing key" honest instead of silently mocked.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type NetworkId = 'testnet';

export interface NearConfig {
  network: NetworkId;
  rpcUrl: string;
  accountId: string | null;
  agentKey: string | null;
  policyContractId: string | null;
}

export interface NearAiConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string | null;
}

export interface DemoConfig {
  dailyCapUsdc: number;
  whitelistRecipient: string;
}

export interface Config {
  near: NearConfig;
  nearAi: NearAiConfig;
  demo: DemoConfig;
  /** Absolute path of the repository root used for artifacts. */
  rootDir: string;
}

const TESTNET_RPC = 'https://rpc.testnet.fastnear.com';
const DEFAULT_NEAR_AI_BASE = 'https://cloud-api.near.ai';

/**
 * `.env` is loaded by hand so the project keeps a single runtime dependency
 * (`near-api-js`). Values already present in the real environment win.
 */
export function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The public NEAR AI site is `cloud.near.ai`; the OpenAI-compatible gateway is
 * `cloud-api.near.ai`. Both spellings appear in the docs, so accept either and
 * normalise to the API host.
 */
export function normalizeNearAiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return DEFAULT_NEAR_AI_BASE;
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'cloud.near.ai') {
      return `${url.protocol}//cloud-api.near.ai`;
    }
    return trimmed.replace(/\/v1$/, '');
  } catch {
    return DEFAULT_NEAR_AI_BASE;
  }
}

export function loadConfig(): Config {
  const network = (env('NEAR_NETWORK') ?? 'testnet').toLowerCase();
  if (network !== 'testnet') {
    throw new Error(
      `NEAR_NETWORK must be "testnet" for this build (got "${network}"). This project never targets mainnet.`,
    );
  }

  return {
    near: {
      network: 'testnet',
      rpcUrl: TESTNET_RPC,
      accountId: env('NEAR_ACCOUNT_ID'),
      agentKey: env('NEAR_AGENT_KEY'),
      policyContractId: env('POLICY_CONTRACT_ID'),
    },
    nearAi: {
      apiKey: env('NEAR_AI_CLOUD_API_KEY'),
      baseUrl: normalizeNearAiBase(env('NEAR_AI_CLOUD_BASE_URL') ?? DEFAULT_NEAR_AI_BASE),
      model: env('NEAR_AI_CLOUD_MODEL'),
    },
    demo: {
      dailyCapUsdc: intEnv('DAILY_CAP_USDC', 10),
      whitelistRecipient: env('WHITELIST_RECIPIENT') ?? 'alice.samimmi.testnet',
    },
    rootDir: process.cwd(),
  };
}

/** True when the agent can talk to a real deployed policy contract. */
export function hasLivePolicy(config: Config): boolean {
  return (
    config.near.accountId !== null &&
    config.near.agentKey !== null &&
    config.near.policyContractId !== null
  );
}

/** True when real Confidential-TEE inference is configured. */
export function hasLiveTee(config: Config): boolean {
  return config.nearAi.apiKey !== null && config.nearAi.model !== null;
}

/** Never print a credential, only its presence and length class. */
export function secretStatus(secret: string | null): string {
  if (secret === null) return 'missing';
  return `set(${secret.length} chars)`;
}
