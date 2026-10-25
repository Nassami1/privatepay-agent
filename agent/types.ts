/** Shared domain types for the PrivatePay Agent. */

export type PolicyMode = 'testnet' | 'local';

export interface PolicyState {
  ownerId: string | null;
  agentId: string | null;
  tokenId: string | null;
  capMicroUsdc: bigint;
  spentTodayMicroUsdc: bigint;
  whitelist: string[];
  paidInvoices: number;
  mode: PolicyMode;
  /** Contract account id, or `null` in local simulation mode. */
  contractId: string | null;
}

export type BlockReason =
  | 'OVER_LIMIT'
  | 'NOT_WHITELISTED'
  | 'DUPLICATE_INVOICE'
  | 'ZERO_AMOUNT'
  | 'INVALID_INVOICE_REF';

export type PayOutcome =
  | { ok: true; tx: string; chainTx?: string }
  | { ok: false; reason: BlockReason };

export interface PayRequest {
  to: string;
  amountMicroUsdc: bigint;
  invoiceRef: string;
}

export type LogResult =
  | 'SUCCESS'
  | 'BLOCKED_OVER_LIMIT'
  | 'BLOCKED_NOT_WHITELISTED'
  | 'BLOCKED_DUPLICATE_INVOICE'
  | 'BLOCKED_ZERO_AMOUNT'
  | 'BLOCKED_INVALID_INVOICE_REF';

export interface PolicyLogEntry {
  invoiceRef: string;
  to: string;
  amountMicroUsdc: bigint;
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
  amountMicroUsdc: bigint;
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

export interface SignatureEvidence {
  kind: 'provider_tee' | 'gateway';
  signer: string;
  algorithm: 'ecdsa' | 'ed25519';
  text: string;
  verified: boolean;
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
  attestationCached: boolean;
  signature: SignatureEvidence | null;
  fallbackReason?: string;
  /** Pretty-printed report; the digest is over exactly this string. */
  rawReportJson?: string;
}

export type AttemptOutcome =
  | LogResult
  | 'HELD_FOR_REVIEW'
  | 'BLOCKED_TEE_UNAVAILABLE'
  | 'BLOCKED_UNVERIFIED_OUTPUT'
  | 'BLOCKED_HUMAN_APPROVAL_REQUIRED';

export interface PaymentAttemptRecord {
  invoiceRef: string;
  to: string;
  amountMicroUsdc: bigint;
  result: AttemptOutcome;
  policyTx: string | null;
  onChainTx: string | null;
  riskFlags: string[];
  /** Provenance of the decision that produced this attempt. */
  teeMode: 'real' | 'simulated';
  attestationMode: 'real' | 'simulated';
  teeModel: string;
  attestationDigest: string | null;
  redactedFields: string[];
  signatureKind: 'provider_tee' | 'gateway' | null;
  signatureVerified: boolean;
  ftBalanceAfterMicro?: bigint;
  /** Local reason for a hold or a validation failure; never sensitive. */
  detail?: string;
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
  ft: {
    tokenId: string | null;
    policyBalanceMicro: bigint;
    aliceBalanceMicro: bigint;
  };
  tee: {
    mode: 'real' | 'simulated';
    model: string;
    attestation: AttestationEvidence;
    redactedFields: string[];
    latencyMs: number;
    cached: boolean;
    signature: SignatureEvidence | null;
    fallbackReason?: string;
  };
  attempts: PaymentAttemptRecord[];
  notes: string[];
  keyGuard?: KeyGuardResult;
}
