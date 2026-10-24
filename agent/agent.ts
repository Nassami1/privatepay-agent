/** Orchestrates one invoice: private decision → policy gate → settlement. */

import type { Config } from './config.js';
import type {
  LogResult,
  PaymentAttemptRecord,
  PolicyClient,
  TeeRun,
} from './types.js';
import { processInvoicePrivately } from './tee/nearAiCloud.js';
import { settlePayment } from './intents/settlement.js';
import type { DemoInvoice } from './fixtures.js';

export interface AttemptResult {
  record: PaymentAttemptRecord;
  tee: TeeRun;
}

/**
 * The policy contract is called *before* settlement. If the contract refuses,
 * no settlement is attempted, so a blocked invoice never moves value even in
 * this prototype.
 */
export async function attemptPayment(
  config: Config,
  policy: PolicyClient,
  invoice: DemoInvoice,
): Promise<AttemptResult> {
  const tee = await processInvoicePrivately(config, invoice);
  const { recipient, amountUsdc, riskFlags } = tee.decision;

  if (recipient === '' || amountUsdc <= 0) {
    throw new Error(
      `Privacy model did not return a payable instruction for ${invoice.invoiceRef} ` +
        `(recipient="${recipient}", amount=${amountUsdc}). Policy not called.`,
    );
  }

  const outcome = await policy.tryPay({
    to: recipient,
    amountUsdc,
    invoiceRef: invoice.invoiceRef,
  });

  if (!outcome.ok) {
    return {
      tee,
      record: {
        invoiceRef: invoice.invoiceRef,
        to: recipient,
        amountUsdc,
        result: toLogResult(outcome.reason),
        policyTx: null,
        onChainTx: null,
        settlement: null,
        riskFlags,
        teeMode: tee.mode,
        attestationMode: tee.attestation.mode,
        teeModel: tee.model,
        attestationDigest:
          tee.attestation.mode === 'real' ? tee.attestation.digest : null,
        redactedFields: tee.redaction.redactedFields,
      },
    };
  }

  const settlement = await settlePayment(config, {
    to: recipient,
    amountUsdc,
    invoiceRef: invoice.invoiceRef,
  });

  return {
    tee,
    record: {
      invoiceRef: invoice.invoiceRef,
      to: recipient,
      amountUsdc,
      result: 'SUCCESS',
      policyTx: outcome.tx,
      onChainTx: outcome.chainTx ?? null,
      settlement,
      riskFlags,
      teeMode: tee.mode,
      attestationMode: tee.attestation.mode,
      teeModel: tee.model,
      attestationDigest:
        tee.attestation.mode === 'real' ? tee.attestation.digest : null,
      redactedFields: tee.redaction.redactedFields,
    },
  };
}

function toLogResult(reason: 'OVER_LIMIT' | 'NOT_WHITELISTED'): LogResult {
  return reason === 'OVER_LIMIT' ? 'BLOCKED_OVER_LIMIT' : 'BLOCKED_NOT_WHITELISTED';
}
