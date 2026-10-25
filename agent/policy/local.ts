/**
 * Deterministic, in-process mirror of the policy contract.
 *
 * Used only when no testnet contract is configured. It exists so a judge can
 * clone the repository and see the whole flow with zero credentials, and it is
 * labelled `local` everywhere in output and in the dashboard. It is *not* a
 * substitute for the contract: the contract is the authority, and both
 * implementations share one rule order.
 */

import type {
  BlockReason,
  LogResult,
  PayOutcome,
  PayRequest,
  PolicyClient,
  PolicyLogEntry,
  PolicyState,
} from '../types.js';

const MAX_REF_BYTES = 64;

export interface LocalPolicyOptions {
  capMicroUsdc: bigint;
  whitelist: string[];
  /** Injectable clock for tests. */
  now?: () => Date;
}

export class LocalPolicy implements PolicyClient {
  readonly mode = 'local' as const;
  readonly contractId = null;

  private readonly capMicroUsdc: bigint;
  private spentTodayMicroUsdc = 0n;
  private readonly whitelist: string[];
  private readonly paidInvoices = new Set<string>();
  private readonly log: PolicyLogEntry[] = [];
  private readonly now: () => Date;

  constructor(options: LocalPolicyOptions) {
    this.capMicroUsdc = options.capMicroUsdc;
    this.whitelist = [...options.whitelist];
    this.now = options.now ?? (() => new Date());
  }

  async getPolicy(): Promise<PolicyState> {
    return {
      ownerId: 'owner.local',
      agentId: 'agent.local',
      tokenId: null,
      capMicroUsdc: this.capMicroUsdc,
      spentTodayMicroUsdc: this.spentTodayMicroUsdc,
      whitelist: [...this.whitelist],
      paidInvoices: this.paidInvoices.size,
      mode: 'local',
      contractId: null,
    };
  }

  async getLog(limit: number): Promise<PolicyLogEntry[]> {
    const safeLimit = Math.max(0, Math.min(limit, 100));
    return this.log.slice(Math.max(0, this.log.length - safeLimit)).map((entry) => ({ ...entry }));
  }

  async tryPay(request: PayRequest): Promise<PayOutcome> {
    const block = (reason: BlockReason, result: LogResult): PayOutcome => {
      this.record(request, result);
      return { ok: false, reason };
    };

    if (request.amountMicroUsdc === 0n) return block('ZERO_AMOUNT', 'BLOCKED_ZERO_AMOUNT');
    if (
      request.invoiceRef.length === 0 ||
      Buffer.byteLength(request.invoiceRef, 'utf8') > MAX_REF_BYTES
    ) {
      return block('INVALID_INVOICE_REF', 'BLOCKED_INVALID_INVOICE_REF');
    }
    if (this.paidInvoices.has(request.invoiceRef)) {
      return block('DUPLICATE_INVOICE', 'BLOCKED_DUPLICATE_INVOICE');
    }
    if (!this.whitelist.includes(request.to)) {
      return block('NOT_WHITELISTED', 'BLOCKED_NOT_WHITELISTED');
    }
    if (this.spentTodayMicroUsdc + request.amountMicroUsdc > this.capMicroUsdc) {
      return block('OVER_LIMIT', 'BLOCKED_OVER_LIMIT');
    }

    this.spentTodayMicroUsdc += request.amountMicroUsdc;
    this.paidInvoices.add(request.invoiceRef);
    this.record(request, 'SUCCESS');
    return { ok: true, tx: `policy:${this.receiptId(request)}` };
  }

  /** Test/ops helper mirroring the owner-only contract method. */
  resetSpent(): void {
    this.spentTodayMicroUsdc = 0n;
    this.paidInvoices.clear();
    this.log.length = 0;
  }

  private record(request: PayRequest, result: LogResult): void {
    this.log.push({
      invoiceRef: request.invoiceRef,
      to: request.to,
      amountMicroUsdc: request.amountMicroUsdc,
      result,
      ts: this.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    if (this.log.length > 200) this.log.shift();
  }

  private receiptId(request: PayRequest): string {
    let hash = 0x811c9dc5;
    const material = `${request.to}|${request.amountMicroUsdc.toString()}|${request.invoiceRef}|${this.log.length}`;
    for (let index = 0; index < material.length; index += 1) {
      hash ^= material.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
}
