/**
 * Shared implementation for `npm run demo:success` and `npm run demo:blocked`.
 *
 * Output contract (kept stable for judges and for the acceptance tests):
 *   [policy] cap=... USDC spent=... whitelist=[...]
 *   [tee]    model=... attestation=OK|SIMULATED ref=...
 *   [pay]    to=... amount=... USDC -> SUCCESS|BLOCKED_* tx=...
 *   [log]    sensitive invoice text NOT printed; only invoice_ref shown
 */

import { randomUUID } from 'node:crypto';
import { loadConfig, loadDotEnv, type Config } from '../../agent/config.js';
import { createPolicy } from '../../agent/policy/index.js';
import { attemptPayment, type AttemptResult } from '../../agent/agent.js';
import { checkAgentKey } from '../../agent/keyGuard.js';
import { INVOICES, type DemoInvoice } from '../../agent/fixtures.js';
import { writeDemoArtifacts } from '../../agent/artifacts.js';
import type {
  DemoRunRecord,
  KeyGuardResult,
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
    printPay(result);
  }

  const after = await policy.getPolicy();
  const log = await policy.getLog(20);

  console.log('[log] sensitive invoice text NOT printed; only invoice_ref shown');

  const firstTee = results[0]?.tee;
  if (firstTee === undefined) {
    throw new Error('no invoice was processed');
  }

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
    tee: {
      mode: firstTee.mode,
      model: firstTee.model,
      attestation: firstTee.attestation,
      redactedFields: firstTee.redaction.redactedFields,
      latencyMs: firstTee.latencyMs,
      ...(firstTee.fallbackReason !== undefined
        ? { fallbackReason: firstTee.fallbackReason }
        : {}),
    },
    attempts: results.map((result) => result.record),
    notes: buildNotes(config, results),
    ...(keyGuard !== undefined ? { keyGuard } : {}),
  };

  // Archive the raw real report when available; when the run is simulated,
  // archive the labelled SIMULATED_ATTESTATION object instead so the evidence
  // can be inspected without the terminal output.
  const archivedEvidence =
    firstTee.rawReport ??
    (firstTee.attestation.mode === 'simulated' ? firstTee.attestation : undefined);
  const paths = await writeDemoArtifacts(config.rootDir, run, archivedEvidence);
  console.log('[dashboard] frontend/data/dashboard.json');
  if (paths.attestation !== null) {
    console.log(`[artifact] attestation report archived at ${relativePath(paths.attestation, config)}`);
  }

  return 0;
}

function printPolicy(state: PolicyState): void {
  const source = state.mode === 'testnet' ? `testnet:${state.contractId}` : 'local-simulation';
  console.log(
    `[policy] cap=${state.capUsdc} USDC spent=${state.spentTodayUsdc} ` +
      `whitelist=[${state.whitelist.join(', ')}] source=${source}`,
  );
}

function printKeyGuard(guard: KeyGuardResult): void {
  if (!guard.checked) {
    console.log(`[key] guard=SKIPPED ${guard.checks[0]?.detail ?? ''}`);
    return;
  }
  const allowance =
    guard.checks.find((check) => check.name === 'has_gas_allowance')?.detail ?? 'allowance=unknown';
  if (guard.ok) {
    console.log(
      `[key] guard=PASS account=${guard.accountId} receiver=${guard.contractId} ` +
        `methods=[try_pay] ${allowance}`,
    );
    return;
  }
  const failures = guard.checks.filter((check) => !check.ok);
  console.log(`[key] guard=FAIL ${failures.map((check) => `${check.name}: ${check.detail}`).join('; ')}`);
}

function printTee(tee: TeeRun): void {
  const ref =
    tee.attestation.mode === 'real'
      ? tee.attestation.verificationUrl
      : tee.attestation.verificationUrl;
  const status = tee.attestation.mode === 'real' ? 'OK' : 'SIMULATED';
  console.log(
    `[tee] model=${tee.model} attestation=${status} ref=${ref} latency=${(tee.latencyMs / 1000).toFixed(1)}s`,
  );
  console.log(
    `[tee] privacy=redacted fields=[${tee.redaction.redactedFields.join(',')}] ` +
      `replacements=${tee.redaction.replacements}`,
  );
  if (tee.attestation.mode === 'real') {
    const passed = tee.attestation.checks.filter((check) => check.ok).length;
    const total = tee.attestation.checks.length;
    console.log(
      `[attestation] mode=real checks=${passed}/${total} verification=structural ` +
        `digest=sha256:${tee.attestation.digest.slice(0, 16)}`,
    );
    console.log(
      '[attestation] note=full Intel TDX/NVIDIA quote verification is delegated to the official verifier (see README)',
    );
  } else {
    console.log('[attestation] mode=simulated — NOT a real TEE attestation');
    console.log(`[attestation] reason=${JSON.stringify(tee.attestation.reason ?? 'unknown')}`);
  }
}

function printPay(result: AttemptResult): void {
  const { record } = result;
  if (record.result === 'SUCCESS') {
    const parts = [
      `[pay] to=${record.to} amount=${record.amountUsdc} USDC -> SUCCESS tx=${record.settlement?.txId ?? 'unknown'}`,
    ];
    if (record.policyTx !== null) parts.push(`policy_ref=${record.policyTx}`);
    if (record.onChainTx !== null) parts.push(`chain_tx=${record.onChainTx}`);
    console.log(parts.join(' '));
    if (record.settlement !== null) {
      const quote = record.settlement.quoted === true ? ' quote=live' : '';
      const amountOut =
        record.settlement.amountOut !== undefined ? ` amount_out=${record.settlement.amountOut}` : '';
      console.log(
        `[settle] mode=${record.settlement.mode.toUpperCase()}${quote}${amountOut} ` +
          `tx=${record.settlement.txId} reason=${JSON.stringify(record.settlement.reason ?? '')}`,
      );
    }
    return;
  }
  console.log(`[pay] to=${record.to} amount=${record.amountUsdc} USDC -> ${record.result}`);
}

function buildNotes(config: Config, results: AttemptResult[]): string[] {
  const notes: string[] = [];
  const simulatedSettlements = results.filter(
    (result) => result.record.settlement?.mode === 'simulated',
  );
  if (simulatedSettlements.length > 0) {
    notes.push(
      'Settlement is simulated (no testnet NEAR Intents settlement service); policy enforcement is real.',
    );
  }
  const simulatedTee = results.filter((result) => result.tee.mode === 'simulated');
  if (simulatedTee.length > 0) {
    notes.push('Confidential inference is SIMULATED for at least one attempt; see attestation evidence.');
  }
  if (results.some((result) => result.record.result.startsWith('BLOCKED'))) {
    notes.push('Blocked attempts were refused by the policy layer before settlement.');
  }
  if (config.intents.apiUrl === null) {
    notes.push('INTENTS_API_URL is empty: no external Intents quote was requested.');
  }
  return notes;
}

function relativePath(absolute: string, config: Config): string {
  const prefix = `${config.rootDir}/`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
}
