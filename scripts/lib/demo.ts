/**
 * Shared implementation for `npm run demo:success` and `npm run demo:blocked`.
 *
 * Output contract (kept stable for judges and for the acceptance checks):
 *   [policy] cap=... USDC spent=... whitelist=[...]
 *   [tee]    model=... attestation=OK|SIMULATED ref=...
 *   [pay]    to=... amount=... USDC -> SUCCESS|BLOCKED_* ...
 *   [log]    sensitive invoice text NOT printed; only invoice_ref shown
 */

import { randomUUID } from 'node:crypto';
import { formatUsdc } from '../../agent/amount.js';
import { loadConfig, loadDotEnv, type Config } from '../../agent/config.js';
import { createPolicy } from '../../agent/policy/index.js';
import { attemptPayment, type AttemptResult } from '../../agent/agent.js';
import { checkAgentKey } from '../../agent/keyGuard.js';
import { INVOICES, type DemoInvoice } from '../../agent/fixtures.js';
import { writeDemoArtifacts } from '../../agent/artifacts.js';
import { getFtBalance } from '../../agent/near/ft.js';
import { simulatedAttestation } from '../../agent/tee/attestation.js';
import type {
  DemoRunRecord,
  KeyGuardResult,
  PaymentAttemptRecord,
  PolicyState,
  TeeRun,
} from '../../agent/types.js';

export type DemoName = 'success' | 'blocked';

export async function runDemo(demo: DemoName): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const policy = await createPolicy(config);

  const before = await policy.getPolicy();
  printPolicy(before);

  let keyGuard: KeyGuardResult | undefined;
  if (policy.mode === 'testnet') {
    const guard = await checkAgentKey(config);
    keyGuard = guard;
    printKeyGuard(guard);
    if (!guard.ok) {
      console.error('[error] refusing to run: the agent key is not a least-privilege key.');
      return 1;
    }
  }

  const invoices: DemoInvoice[] =
    demo === 'success'
      ? [INVOICES.success]
      : [INVOICES.overLimit, INVOICES.notWhitelisted];

  const startedAt = new Date().toISOString();
  const results: AttemptResult[] = [];
  for (const invoice of invoices) {
    const result = await attemptPayment(config, policy, invoice);
    results.push(result);
    printTee(result.tee);
    printPay(result.record);
  }

  const after = await policy.getPolicy();
  let log = await policy.getLog(20);
  // The read node can lag one block behind the last try_pay; wait until every
  // invoice from this run appears in the snapshot before writing the artifact.
  const expectedRefs = new Set(results.map((result) => result.record.invoiceRef));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ([...expectedRefs].every((ref) => log.some((entry) => entry.invoiceRef === ref))) break;
    await sleep(300);
    log = await policy.getLog(20);
  }
  const tokenId = after.tokenId ?? before.tokenId;
  const policyBalanceMicro =
    tokenId !== null && policy.contractId !== null
      ? await getFtBalance(tokenId, policy.contractId).catch(() => 0n)
      : 0n;
  const aliceBalanceMicro =
    tokenId !== null
      ? await getFtBalance(tokenId, config.demo.whitelistRecipient).catch(() => 0n)
      : 0n;

  if (tokenId !== null) {
    console.log(
      `[ft] token=${tokenId} policy_balance=${formatUsdc(policyBalanceMicro)} USDC ` +
        `recipient_balance=${formatUsdc(aliceBalanceMicro)} USDC`,
    );
  }

  console.log('[log] sensitive invoice text NOT printed; only invoice_ref shown');

  const firstTee = results.find((result) => result.tee !== null)?.tee ?? unavailableTee();
  const run: DemoRunRecord = {
    runId: randomUUID(),
    demo,
    startedAt,
    finishedAt: new Date().toISOString(),
    network: 'testnet',
    policy: {
      mode: policy.mode,
      contractId: policy.contractId,
      before,
      after,
      log,
    },
    ft: {
      tokenId,
      policyBalanceMicro,
      aliceBalanceMicro,
    },
    tee: {
      mode: firstTee.mode,
      model: firstTee.model,
      attestation: firstTee.attestation,
      redactedFields: firstTee.redaction.redactedFields,
      latencyMs: firstTee.latencyMs,
      cached: firstTee.attestationCached,
      signature: firstTee.signature,
      ...(firstTee.fallbackReason !== undefined
        ? { fallbackReason: firstTee.fallbackReason }
        : {}),
    },
    attempts: results.map((result) => result.record),
    notes: buildNotes(policy.mode, results, tokenId !== null),
    ...(keyGuard !== undefined ? { keyGuard } : {}),
  };

  const archivedEvidence =
    firstTee.rawReportJson ??
    `${JSON.stringify(firstTee.attestation, null, 2)}\n`;
  const paths = await writeDemoArtifacts(config.rootDir, run, archivedEvidence);
  console.log('[dashboard] frontend/data/dashboard.json');
  if (paths.attestation !== null) {
    console.log(`[artifact] evidence archived at ${relativePath(paths.attestation, config)}`);
  }

  return 0;
}

function printPolicy(state: PolicyState): void {
  const source = state.mode === 'testnet' ? `testnet:${state.contractId}` : 'local-simulation';
  console.log(
    `[policy] cap=${formatUsdc(state.capMicroUsdc)} USDC ` +
      `spent=${formatUsdc(state.spentTodayMicroUsdc)} ` +
      `whitelist=[${state.whitelist.join(', ')}] source=${source}` +
      (state.tokenId !== null ? ` token=${state.tokenId}` : ''),
  );
}

function printKeyGuard(guard: KeyGuardResult): void {
  if (!guard.checked) {
    console.log(`[key] guard=SKIPPED ${guard.checks[0]?.detail ?? ''}`);
    return;
  }
  if (guard.ok) {
    const allowance =
      guard.checks.find((check) => check.name === 'has_gas_allowance')?.detail ?? '';
    console.log(
      `[key] guard=PASS account=${guard.accountId} receiver=${guard.contractId} ` +
        `methods=[try_pay] ${allowance}`,
    );
    return;
  }
  const failures = guard.checks.filter((check) => !check.ok);
  console.log(
    `[key] guard=FAIL ${failures.map((check) => `${check.name}: ${check.detail}`).join('; ')}`,
  );
}

function printTee(tee: TeeRun | null): void {
  if (tee === null) {
    console.log('[tee] mode=unavailable — payment refused (fail-closed)');
    return;
  }
  const status = tee.attestation.mode === 'real' ? 'OK' : 'SIMULATED';
  console.log(
    `[tee] model=${tee.model} attestation=${status} ref=${tee.attestation.verificationUrl} ` +
      `cached=${tee.attestationCached} signature=${tee.signature?.kind ?? 'none'} ` +
      `latency=${(tee.latencyMs / 1000).toFixed(1)}s`,
  );
  console.log(
    `[tee] privacy=redacted fields=[${tee.redaction.redactedFields.join(',')}] ` +
      `replacements=${tee.redaction.replacements}`,
  );
  if (tee.attestation.mode === 'real') {
    const passed = tee.attestation.checks.filter((check) => check.ok).length;
    console.log(
      `[attestation] mode=real checks=${passed}/${tee.attestation.checks.length} ` +
        `verification=structural digest=sha256:${tee.attestation.digest.slice(0, 16)}`,
    );
    if (tee.signature !== null) {
      console.log(
        `[sig] ${tee.signature.kind} verified signer=${tee.signature.signer} ` +
          `algorithm=${tee.signature.algorithm}`,
      );
    }
  } else {
    console.log('[attestation] mode=simulated — NOT a real TEE attestation');
    console.log(`[attestation] reason=${JSON.stringify(tee.attestation.reason ?? 'unknown')}`);
  }
}

function printPay(record: PaymentAttemptRecord): void {
  if (record.result === 'SUCCESS') {
    const tx = record.onChainTx ?? record.policyTx ?? 'unknown';
    const parts = [
      `[pay] to=${record.to} amount=${formatUsdc(record.amountMicroUsdc)} USDC -> SUCCESS tx=${tx}`,
    ];
    if (record.policyTx !== null) parts.push(`policy_ref=${record.policyTx}`);
    if (record.ftBalanceAfterMicro !== undefined) {
      parts.push(`ft_balance=${formatUsdc(record.ftBalanceAfterMicro)}`);
    }
    console.log(parts.join(' '));
    return;
  }

  if (record.to === '') {
    console.log(
      `[pay] invoice=${record.invoiceRef} -> ${record.result}` +
        (record.detail !== undefined ? ` detail=${JSON.stringify(record.detail)}` : ''),
    );
    return;
  }

  console.log(
    `[pay] to=${record.to} amount=${formatUsdc(record.amountMicroUsdc)} USDC -> ${record.result}` +
      (record.detail !== undefined ? ` detail=${JSON.stringify(record.detail)}` : ''),
  );
}

function buildNotes(
  mode: PolicyState['mode'],
  results: AttemptResult[],
  hasToken: boolean,
): string[] {
  const notes: string[] = [];
  if (mode === 'testnet') {
    notes.push(
      'Settlement is the policy contract\'s ft_transfer; the recipient balance is read after the transaction.',
    );
  } else {
    notes.push('Local policy mirror; no chain state and no FT transfer.');
  }
  if (results.some((result) => result.tee?.mode === 'simulated')) {
    notes.push('Confidential inference is SIMULATED; see the attestation evidence.');
  }
  if (results.some((result) => result.record.result.startsWith('BLOCKED'))) {
    notes.push('Blocked attempts never reached the FT transfer.');
  }
  if (results.some((result) => result.record.result === 'HELD_FOR_REVIEW')) {
    notes.push('A risk flag held an invoice before the contract call.');
  }
  if (mode === 'testnet' && hasToken) {
    notes.push('Policy enforcement happens in the money path: the contract holds the tokens.');
  }
  return notes;
}

function unavailableTee(): TeeRun {
  const redaction = { redactedText: '', redactedFields: [], replacements: 0 };
  return {
    mode: 'simulated',
    model: 'unavailable',
    latencyMs: 0,
    decision: {
      amountMicroUsdc: 0n,
      recipient: '',
      invoiceRef: 'UNKNOWN',
      purpose: '',
      riskFlags: [],
    },
    attestation: simulatedAttestation({
      model: 'unavailable',
      redaction,
      reason: 'TEE unavailable; payment refused',
    }),
    redaction,
    attestationCached: false,
    signature: null,
  };
}

function relativePath(absolute: string, config: Config): string {
  const prefix = `${config.rootDir}/`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
