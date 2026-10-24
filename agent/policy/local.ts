/**
 * Deterministic, in-process mirror of the policy contract.
 *
 * Used only when no testnet contract is configured. It exists so a judge can
 * clone the repository and see the whole flow with zero credentials, and it is
 * labelled `local` everywhere in output and in the dashboard. It is *not* a
 * substitute for the contract: the contract is the authority, and the two
 * implementations deliberately share one rule order (whitelist, then cap).
 */

import type {
  LogResult,
  PayOutcome,
  PayRequest,
  PolicyClient,
  PolicyLogEntry,
  PolicyState,
} from '../types.js';

export interface LocalPolicyOptions {
  capUsdc: number;
  whitelist: string[];
  /** Injectable clock for tests. */
  now?: () => Date;
}

export class LocalPolicy implements PolicyClient {
  readonly mode = 'local' as const;
  readonly contractId = null;

  private capUsdc: number;
  private spentTodayUsdc = 0;
  private readonly whitelist: string[];
  private readonly log: PolicyLogEntry[] = [];
  private readonly now: () => Date;

  constructor(options: LocalPolicyOptions) {
    this.capUsdc = options.capUsdc;
    this.whitelist = [...options.whitelist];
    this.now = options.now ?? (() => new Date());
  }

  async getPolicy(): Promise<PolicyState> {
    return {
      capUsdc: this.capUsdc,
      spentTodayUsdc: this.spentTodayUsdc,
      whitelist: [...this.whitelist],
      mode: 'local',
      contractId: null,
    };
  }

  async getLog(limit: number): Promise<PolicyLogEntry[]> {
    const safeLimit = Math.max(0, Math.min(limit, 100));
    return this.log.slice(Math.max(0, this.log.length - safeLimit)).map((entry) => ({ ...entry }));
  }

  async tryPay(request: PayRequest): Promise<PayOutcome> {
    const recipient = request.to;
    if (!this.whitelist.includes(recipient)) {
      this.record(request, 'BLOCKED_NOT_WHITELISTED');
      return { ok: false, reason: 'NOT_WHITELISTED' };
    }
    if (this.spentTodayUsdc + request.amountUsdc > this.capUsdc) {
      this.record(request, 'BLOCKED_OVER_LIMIT');
      return { ok: false, reason: 'OVER_LIMIT' };
    }
    this.spentTodayUsdc += request.amountUsdc;
    this.record(request, 'SUCCESS');
    return { ok: true, tx: `policy:${this.receiptId(request)}` };
  }

  /** Test/ops helper mirroring the owner-only contract method. */
  resetSpent(): void {
    this.spentTodayUsdc = 0;
  }

  private record(request: PayRequest, result: LogResult): void {
    this.log.push({
      invoiceRef: request.invoiceRef,
      to: request.to,
      amountUsdc: request.amountUsdc,
      result,
      ts: this.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    if (this.log.length > 200) this.log.shift();
  }

  private receiptId(request: PayRequest): string {
    let hash = 0x811c9dc5;
    const material = `${request.to}|${request.amountUsdc}|${request.invoiceRef}|${this.log.length}`;
    for (let i = 0; i < material.length; i += 1) {
      hash ^= material.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
}
