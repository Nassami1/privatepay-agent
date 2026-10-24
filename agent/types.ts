/** Shared domain types for the PrivatePay Agent. */

export type PolicyMode = 'testnet' | 'local';

export interface PolicyState {
  capUsdc: number;
  spentTodayUsdc: number;
  whitelist: string[];
  mode: PolicyMode;
  /** Contract account id, or `null` in local simulation mode. */
  contractId: string | null;
}

export type BlockReason = 'OVER_LIMIT' | 'NOT_WHITELISTED';

export type PayOutcome =
  | { ok: true; tx: string; chainTx?: string }
  | { ok: false; reason: BlockReason };

export interface PayRequest {
  to: string;
  amountUsdc: number;
  invoiceRef: string;
}

export type LogResult = 'SUCCESS' | 'BLOCKED_OVER_LIMIT' | 'BLOCKED_NOT_WHITELISTED';

export interface PolicyLogEntry {
  invoiceRef: string;
  to: string;
  amountUsdc: number;
  result: LogResult;
  ts: string;
}

export interface PolicyClient {
  readonly mode: PolicyMode;
  readonly contractId: string | null;
  getPolicy(): Promise<PolicyState>;
  tryPay(request: PayRequest): Promise<PayOutcome>;
  getLog(limit: number): Promise<PolicyLogEntry[]>;
}

export interface TeeDecision {
  amountUsdc: number;
  recipient: string;
  invoiceRef: string;
  purpose: string;
  riskFlags: string[];
}

export interface AttestationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AttestationEvidence {
  mode: 'real' | 'simulated';
  model: string;
  createdAt: string;
  digest: string;
  verificationUrl: string;
  disclaimer: string;
  checks: AttestationCheck[];
  /** Field categories removed before any text left the process. */
  redactedFields: string[];
  reason?: string;
  /** snake_case mirrors required by the brief's SIMULATED_ATTESTATION schema. */
  redacted_fields?: string[];
  verification_url?: string;
  /** Non-sensitive identifying details of the attested environment. */
  environment?: {
    gatewayAppId?: string;
    gatewayInstanceId?: string;
    gatewaySigningAddress?: string;
    modelSigningAddress?: string;
    quoteBytes?: number;
    eventLogEntries?: number;
  };
}

export interface RedactionResult {
  redactedText: string;
  redactedFields: string[];
  replacements: number;
}

export interface TeeRun {
  mode: 'real' | 'simulated';
  model: string;
  latencyMs: number;
  decision: TeeDecision;
  attestation: AttestationEvidence;
  redaction: RedactionResult;
  fallbackReason?: string;
  /** Full attestation report for real runs; archived as an artifact, never printed. */
  rawReport?: unknown;
}

export interface KeyGuardCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface KeyGuardResult {
  checked: boolean;
  ok: boolean;
  accountId?: string;
  publicKey?: string;
  contractId?: string;
  checks: KeyGuardCheck[];
}

export interface Settlement {
  mode: 'live' | 'simulated';
  txId: string;
  amountOut?: string;
  quoteId?: string;
  reason?: string;
  quoted?: boolean;
}

export interface PaymentAttemptRecord {
  invoiceRef: string;
  to: string;
  amountUsdc: number;
  result: LogResult;
  policyTx: string | null;
  onChainTx: string | null;
  settlement: Settlement | null;
  riskFlags: string[];
  /** Provenance of the decision that produced this attempt. */
  teeMode: 'real' | 'simulated';
  attestationMode: 'real' | 'simulated';
  teeModel: string;
  attestationDigest: string | null;
  redactedFields: string[];
}

export interface DemoRunRecord {
  runId: string;
  demo: 'success' | 'blocked';
  startedAt: string;
  finishedAt: string;
  network: 'testnet';
  policy: {
    mode: PolicyMode;
    contractId: string | null;
    before: PolicyState | null;
    after: PolicyState | null;
    log: PolicyLogEntry[];
  };
  tee: {
    mode: 'real' | 'simulated';
    model: string;
    attestation: AttestationEvidence;
    redactedFields: string[];
    latencyMs: number;
    fallbackReason?: string;
  };
  attempts: PaymentAttemptRecord[];
  notes: string[];
  keyGuard?: KeyGuardResult;
}
