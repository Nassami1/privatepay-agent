/** Policy enforced by the deployed testnet contract with real tUSDC settlement. */

import { connect, keyStores, KeyPair, type Account } from 'near-api-js';
import { hasLivePolicy, type Config } from '../config.js';
import type {
  BlockReason,
  LogResult,
  PayOutcome,
  PayRequest,
  PolicyClient,
  PolicyLogEntry,
  PolicyState,
} from '../types.js';
import { viewFunction } from '../near/rpc.js';

const TRY_PAY_GAS = 100_000_000_000_000n; // 100 TGas

interface RawPolicy {
  owner: string;
  agent_id: string;
  token_id: string;
  cap_micro_usdc: string;
  spent_today_micro_usdc: string;
  whitelist: string[];
  paid_invoices: number;
}

interface RawLogEntry {
  invoice_ref: string;
  to: string;
  amount_micro_usdc: string;
  result: LogResult;
  ts: string;
}

interface TryPayResponse {
  ok: boolean;
  tx?: string;
  reason?: BlockReason;
}

const BLOCK_REASONS: ReadonlySet<string> = new Set([
  'OVER_LIMIT',
  'NOT_WHITELISTED',
  'DUPLICATE_INVOICE',
  'ZERO_AMOUNT',
  'INVALID_INVOICE_REF',
]);

export class TestnetPolicy implements PolicyClient {
  readonly mode = 'testnet' as const;
  readonly contractId: string;

  private constructor(
    readonly accountId: string,
    contractId: string,
    private readonly account: Account,
  ) {
    this.contractId = contractId;
  }

  static async create(config: Config): Promise<TestnetPolicy> {
    if (!hasLivePolicy(config)) {
      throw new Error('TestnetPolicy requires NEAR_ACCOUNT_ID, NEAR_AGENT_KEY and POLICY_CONTRACT_ID');
    }
    const accountId = config.near.accountId as string;
    const agentKey = config.near.agentKey as string;
    const contractId = config.near.policyContractId as string;

    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(config.near.network, accountId, KeyPair.fromString(agentKey));

    // near-api-js 5.1.1 ships a ConnectConfig type whose NearConfig base is not
    // resolvable through its own re-export chain. The runtime shape is the
    // documented one, so the cast is limited to this call.
    const near = await connect({
      networkId: config.near.network,
      nodeUrl: config.near.rpcUrl,
      keyStore,
      logger: false,
    } as unknown as Parameters<typeof connect>[0]);
    const account = await near.account(accountId);
    return new TestnetPolicy(accountId, contractId, account);
  }

  private async callView<T>(methodName: string, args: Record<string, unknown>): Promise<T> {
    return viewFunction<T>(this.contractId, methodName, args);
  }

  async getPolicy(): Promise<PolicyState> {
    const raw = await this.callView<RawPolicy>('get_policy', {});
    return {
      ownerId: raw.owner,
      agentId: raw.agent_id,
      tokenId: raw.token_id,
      capMicroUsdc: BigInt(raw.cap_micro_usdc),
      spentTodayMicroUsdc: BigInt(raw.spent_today_micro_usdc),
      whitelist: raw.whitelist,
      paidInvoices: Number(raw.paid_invoices),
      mode: 'testnet',
      contractId: this.contractId,
    };
  }

  async getLog(limit: number): Promise<PolicyLogEntry[]> {
    const raw = await this.callView<RawLogEntry[]>('get_log', { limit });
    return raw.map((entry) => ({
      invoiceRef: entry.invoice_ref,
      to: entry.to,
      amountMicroUsdc: BigInt(entry.amount_micro_usdc),
      result: entry.result,
      ts: entry.ts,
    }));
  }

  async tryPay(request: PayRequest): Promise<PayOutcome> {
    const outcome = await this.account.functionCall({
      contractId: this.contractId,
      methodName: 'try_pay',
      args: {
        to: request.to,
        amount_micro_usdc: request.amountMicroUsdc.toString(),
        invoice_ref: request.invoiceRef,
      },
      gas: TRY_PAY_GAS,
      attachedDeposit: 0n,
    });

    assertNoReceiptFailure(outcome);

    const chainTx = outcome.transaction_outcome.id;
    const successValue = extractSuccessValue(outcome.status);
    if (successValue === null) {
      throw new Error(`try_pay failed on-chain: ${JSON.stringify(outcome.status).slice(0, 400)}`);
    }

    const parsed = JSON.parse(successValue) as TryPayResponse;
    if (parsed.ok) {
      return { ok: true, tx: parsed.tx ?? 'policy:unknown', chainTx };
    }
    if (parsed.reason !== undefined && BLOCK_REASONS.has(parsed.reason)) {
      return { ok: false, reason: parsed.reason };
    }
    throw new Error(`Unexpected try_pay response: ${successValue}`);
  }
}

function extractSuccessValue(status: unknown): string | null {
  if (typeof status !== 'object' || status === null) return null;
  if (!('SuccessValue' in status)) return null;
  const value = (status as { SuccessValue?: unknown }).SuccessValue;
  if (typeof value !== 'string') return null;
  return Buffer.from(value, 'base64').toString('utf8');
}

/**
 * A cross-contract `ft_transfer` failure is reported in a receipt outcome, not
 * in the top-level status. Treat any failed receipt as a settlement failure.
 */
function assertNoReceiptFailure(outcome: {
  receipts_outcome?: Array<{ outcome?: { status?: unknown } }>;
}): void {
  for (const receipt of outcome.receipts_outcome ?? []) {
    const status = receipt.outcome?.status;
    if (typeof status === 'object' && status !== null && 'Failure' in status) {
      throw new Error(
        `settlement receipt failed: ${JSON.stringify((status as { Failure?: unknown }).Failure).slice(0, 400)}`,
      );
    }
  }
}
