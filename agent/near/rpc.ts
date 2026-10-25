/**
 * Minimal JSON-RPC client for NEAR testnet.
 *
 * Read paths use raw JSON-RPC rather than the full near-api-js account object:
 * a view call needs no key, and keeping reads independent of signing makes the
 * "the dashboard can verify the chain itself" story simple.
 */

/**
 * The long-standing public endpoint `rpc.testnet.near.org` began returning 429
 * with a deprecation notice during this build (2026-10-24), so FastNEAR's free
 * testnet RPC is the primary and the old endpoint is kept as a fallback.
 */
export const TESTNET_RPC_URL = 'https://rpc.testnet.fastnear.com';
const FALLBACK_RPC_URL = 'https://rpc.testnet.near.org';

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: RpcErrorBody;
}

export interface ContractCallResult {
  result: number[];
  logs: string[];
  block_height: number;
  block_hash: string;
  /** NEAR returns view failures inside `result.error` with HTTP 200. */
  error?: string;
}

export interface FunctionCallPermissionView {
  receiver_id: string;
  method_names: string[];
  allowance: string | null;
}

export type AccessKeyPermissionView = 'FullAccess' | { FunctionCall: FunctionCallPermissionView };

export interface AccessKeyView {
  nonce: number | string;
  permission: AccessKeyPermissionView;
}

export interface AccountView {
  amount: string;
  code_hash: string;
  storage_usage: number;
}

export interface NetworkStatus {
  chainId: string;
  protocolVersion: number;
  blockHeight: number;
}

async function rpc<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
  let lastError: unknown = null;
  for (const endpoint of [TESTNET_RPC_URL, FALLBACK_RPC_URL]) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'privatepay-agent', method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`NEAR RPC HTTP ${response.status} from ${endpoint}`);
      }
      if (!response.ok) {
        throw new Error(`NEAR RPC HTTP ${response.status} for ${method}`);
      }
      const envelope = (await response.json()) as RpcEnvelope<T>;
      if (envelope.error !== undefined) {
        throw new Error(`NEAR RPC ${method} failed: ${envelope.error.message}`);
      }
      if (envelope.result === undefined) {
        throw new Error(`NEAR RPC ${method} returned no result`);
      }
      return envelope.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `NEAR RPC ${method} failed on every endpoint: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/** Call a view method and JSON-decode its return value. */
export async function viewFunction<T>(
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await rpc<ContractCallResult>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
  });
  if (response.error !== undefined) {
    throw new Error(`view ${contractId}.${methodName} failed: ${response.error}`);
  }
  const text = Buffer.from(Uint8Array.from(response.result)).toString('utf8');
  if (text.trim() === '') return null as T;
  return JSON.parse(text) as T;
}

export async function viewAccount(accountId: string): Promise<AccountView | null> {
  try {
    return await rpc<AccountView>('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
  } catch {
    return null;
  }
}

export async function viewAccessKey(
  accountId: string,
  publicKey: string,
): Promise<AccessKeyView> {
  const response = await rpc<AccessKeyView & { error?: string }>('query', {
    request_type: 'view_access_key',
    finality: 'final',
    account_id: accountId,
    public_key: publicKey,
  });
  if (response.error !== undefined) {
    throw new Error(`access key ${publicKey} not found on ${accountId}: ${response.error}`);
  }
  return response;
}

export async function getNetworkStatus(): Promise<NetworkStatus> {
  const status = await rpc<{
    chain_id: string;
    latest_protocol_version: number;
    sync_info: { latest_block_height: number };
  }>('status', []);
  return {
    chainId: status.chain_id,
    protocolVersion: status.latest_protocol_version,
    blockHeight: status.sync_info.latest_block_height,
  };
}

export function isFunctionCallPermission(
  permission: AccessKeyPermissionView,
): permission is { FunctionCall: FunctionCallPermissionView } {
  return typeof permission === 'object' && permission !== null && 'FunctionCall' in permission;
}
