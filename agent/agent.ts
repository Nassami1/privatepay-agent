/**
 * Orchestrates one invoice: private decision → independent validation → policy
 * gate → real FT settlement inside the contract.
 *
 * The agent never calls the token contract. The only money path is
 * `PolicyContract.try_pay`, which checks the agent, the cap, the whitelist and
 * idempotency before it makes the `ft_transfer`. A rejected attempt therefore
 * cannot reach settlement by construction, and `attemptPayment` only reads the
 * post-transfer balance as proof.
 */

import { MICRO_PER_USDC } from './amount.js';
import type { Config } from './config.js';
import type {
  AttemptOutcome,
  LogResult,
  PaymentAttemptRecord,
  PolicyClient,
  TeeRun,
} from './types.js';
import { processInvoicePrivately } from './tee/nearAiCloud.js';
import { detectLocalRiskFlags } from './tee/decision.js';
import { validateDecision } from './tee/validate.js';
import { getFtBalance } from './near/ft.js';
import type { DemoInvoice } from './fixtures.js';

/** Amounts above this require an explicit human approval flag. */
export const HUMAN_APPROVAL_THRESHOLD_MICRO = 100n * MICRO_PER_USDC;

/** Model/local risk flags that stop an otherwise-valid payment. */
export const BLOCKING_RISK_FLAGS: ReadonlySet<string> = new Set([
  'MISSING_AMOUNT',
  'MISSING_RECIPIENT',
  'GIFT_CARD_REQUEST',
  'NEW_BANK_DETAILS',
  'OFFSHORE_ACCOUNT',
]);

const REASON_TO_RESULT: Record<string, LogResult> = {
  OVER_LIMIT: 'BLOCKED_OVER_LIMIT',
  NOT_WHITELISTED: 'BLOCKED_NOT_WHITELISTED',
  DUPLICATE_INVOICE: 'BLOCKED_DUPLICATE_INVOICE',
  ZERO_AMOUNT: 'BLOCKED_ZERO_AMOUNT',
  INVALID_INVOICE_REF: 'BLOCKED_INVALID_INVOICE_REF',
};

export interface AttemptOptions {
  humanApproved?: boolean;
}

export interface AgentDependencies {
  processTee: (config: Config, invoice: DemoInvoice) => Promise<TeeRun>;
  readFtBalance: (tokenId: string, accountId: string) => Promise<bigint>;
}

const DEFAULT_DEPS: AgentDependencies = {
  processTee: processInvoicePrivately,
  readFtBalance: getFtBalance,
};

export interface AttemptResult {
  record: PaymentAttemptRecord;
  tee: TeeRun | null;
}

export async function attemptPayment(
  config: Config,
  policy: PolicyClient,
  invoice: DemoInvoice,
  options: AttemptOptions = {},
  deps: AgentDependencies = DEFAULT_DEPS,
): Promise<AttemptResult> {
  let tee: TeeRun;
  try {
    tee = await deps.processTee(config, invoice);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      tee: null,
      record: localRecord(invoice, 'BLOCKED_TEE_UNAVAILABLE', null, detail),
    };
  }

  const mergedRisks = unique([
    ...tee.decision.riskFlags,
    ...detectLocalRiskFlags(invoice.text),
  ]);
  const decision = { ...tee.decision, riskFlags: mergedRisks };
  tee = { ...tee, decision };

  const validation = validateDecision(decision, invoice.text);
  if (!validation.ok) {
    const failed = validation.checks.filter((check) => !check.ok);
    return {
      tee,
      record: localRecord(
        invoice,
        'BLOCKED_UNVERIFIED_OUTPUT',
        tee,
        failed.map((check) => check.detail).join('; '),
      ),
    };
  }

  if (mergedRisks.some((flag) => BLOCKING_RISK_FLAGS.has(flag))) {
    return {
      tee,
      record: localRecord(
        invoice,
        'HELD_FOR_REVIEW',
        tee,
        `blocking risk flags: ${mergedRisks.filter((flag) => BLOCKING_RISK_FLAGS.has(flag)).join(', ')}`,
      ),
    };
  }

  if (
    decision.amountMicroUsdc > HUMAN_APPROVAL_THRESHOLD_MICRO &&
    options.humanApproved !== true
  ) {
    return {
      tee,
      record: localRecord(
        invoice,
        'BLOCKED_HUMAN_APPROVAL_REQUIRED',
        tee,
        'amount exceeds the human-approval threshold',
      ),
    };
  }

  const outcome = await policy.tryPay({
    to: decision.recipient,
    amountMicroUsdc: decision.amountMicroUsdc,
    invoiceRef: invoice.invoiceRef,
  });

  if (!outcome.ok) {
    return {
      tee,
      record: {
        ...baseRecord(invoice, tee),
        result: REASON_TO_RESULT[outcome.reason] ?? 'BLOCKED_OVER_LIMIT',
        detail: outcome.reason,
      },
    };
  }

  let ftBalanceAfterMicro: bigint | undefined;
  const state = await policy.getPolicy();
  if (state.tokenId !== null) {
    // The FT transfer is a second receipt; give the view node a moment to
    // reflect it before recording the balance proof.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const balance = await deps.readFtBalance(state.tokenId, decision.recipient);
        if (balance >= decision.amountMicroUsdc) {
          ftBalanceAfterMicro = balance;
          break;
        }
        ftBalanceAfterMicro = balance;
      } catch {
        ftBalanceAfterMicro = undefined;
      }
      await sleep(300);
    }
  }

  return {
    tee,
    record: {
      ...baseRecord(invoice, tee),
      result: 'SUCCESS',
      policyTx: outcome.tx,
      onChainTx: outcome.chainTx ?? null,
      ftBalanceAfterMicro,
    },
  };
}

function baseRecord(invoice: DemoInvoice, tee: TeeRun): PaymentAttemptRecord {
  return {
    invoiceRef: invoice.invoiceRef,
    to: tee.decision.recipient,
    amountMicroUsdc: tee.decision.amountMicroUsdc,
    result: 'SUCCESS',
    policyTx: null,
    onChainTx: null,
    riskFlags: tee.decision.riskFlags,
    teeMode: tee.mode,
    attestationMode: tee.attestation.mode,
    teeModel: tee.model,
    attestationDigest: tee.attestation.mode === 'real' ? tee.attestation.digest : null,
    redactedFields: tee.redaction.redactedFields,
    signatureKind: tee.signature?.kind ?? null,
    signatureVerified: tee.signature?.verified ?? false,
  };
}

function localRecord(
  invoice: DemoInvoice,
  result: AttemptOutcome,
  tee: TeeRun | null,
  detail: string,
): PaymentAttemptRecord {
  if (tee === null) {
    return {
      invoiceRef: invoice.invoiceRef,
      to: '',
      amountMicroUsdc: 0n,
      result,
      policyTx: null,
      onChainTx: null,
      riskFlags: [],
      teeMode: 'simulated',
      attestationMode: 'simulated',
      teeModel: 'unavailable',
      attestationDigest: null,
      redactedFields: [],
      signatureKind: null,
      signatureVerified: false,
      detail,
    };
  }
  return {
    ...baseRecord(invoice, tee),
    result,
    detail,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
