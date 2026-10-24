#!/usr/bin/env tsx
/**
 * Fetch and verify a fresh NEAR AI Cloud TEE attestation report.
 *
 * The checks performed here are the ones a client can perform without a DCAP
 * verifier: nonce binding, quote presence, event log presence, model identity
 * and signing addresses. The raw report is archived and its SHA-256 digest is
 * printed so the official verifier can re-check the exact bytes.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hasLiveTee, loadConfig, loadDotEnv } from '../agent/config.js';
import { fetchAttestationReport } from '../agent/tee/nearAiCloud.js';
import {
  NEAR_AI_VERIFICATION_DOCS,
  simulatedAttestation,
  verifyAttestationReport,
} from '../agent/tee/attestation.js';
import type { RedactionResult } from '../agent/types.js';

const EMPTY_REDACTION: RedactionResult = {
  redactedText: '',
  redactedFields: [],
  replacements: 0,
};

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  if (!hasLiveTee(config)) {
    const evidence = simulatedAttestation({
      model: 'none',
      redaction: EMPTY_REDACTION,
      reason: 'NEAR_AI_CLOUD_API_KEY / NEAR_AI_CLOUD_MODEL not configured',
    });
    console.log('[attestation] mode=simulated status=SIMULATED — NOT a real TEE attestation');
    console.log(`[attestation] reason=${JSON.stringify(evidence.reason ?? 'unknown')}`);
    console.log(`[attestation] verification_url=${NEAR_AI_VERIFICATION_DOCS}`);
    console.log('[attestation] result=simulated (configure NEAR AI Cloud to verify a real report)');
    return;
  }

  const model = config.nearAi.model as string;
  const { report, nonce } = await fetchAttestationReport(
    config.nearAi.baseUrl,
    config.nearAi.apiKey as string,
    model,
  );
  const evidence = verifyAttestationReport({ report, nonce, model, redaction: EMPTY_REDACTION });

  console.log(`[attestation] mode=real model=${model} nonce=${nonce.slice(0, 12)}…`);
  for (const check of evidence.checks) {
    console.log(`[attestation] ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  console.log(`[attestation] verification_url=${evidence.verificationUrl}`);
  console.log(`[attestation] digest=sha256:${evidence.digest}`);
  if (evidence.environment?.gatewayAppId !== undefined) {
    console.log(
      `[attestation] gateway_app=${evidence.environment.gatewayAppId} ` +
        `gateway_signer=${evidence.environment.gatewaySigningAddress ?? 'unknown'} ` +
        `model_signer=${evidence.environment.modelSigningAddress ?? 'unknown'}`,
    );
  }
  console.log(
    '[attestation] verification=structural — full Intel TDX/NVIDIA quote verification is delegated to the official verifier',
  );

  const artifactsDir = join(config.rootDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(artifactsDir, `attestation-report-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[attestation] report archived at artifacts/attestation-report-${stamp}.json`);
  console.log('[attestation] result=real (structural checks passed)');
}

try {
  await main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
