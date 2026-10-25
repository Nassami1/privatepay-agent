/**
 * Demo artifacts.
 *
 * The static dashboard reads `frontend/data/dashboard.json`; the same document
 * is copied to `artifacts/dashboard.json` so a judge can inspect it without a
 * server. BigInt values are serialized as decimal strings so JSON stays exact.
 *
 * Raw attestation reports are archived separately and written verbatim: the
 * SHA-256 digest in the evidence is over exactly those bytes, so `sha256sum`
 * reproduces it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DemoRunRecord, PolicyState } from './types.js';

const DASHBOARD_RUN_LIMIT = 12;

export interface DashboardFile {
  generatedAt: string;
  network: 'testnet';
  policyMode: 'testnet' | 'local';
  contractId: string | null;
  latestPolicy: PolicyState | null;
  runs: DemoRunRecord[];
}

export interface ArtifactPaths {
  dashboard: string;
  run: string;
  attestation: string | null;
}

export async function writeDemoArtifacts(
  rootDir: string,
  run: DemoRunRecord,
  rawEvidenceJson?: string,
): Promise<ArtifactPaths> {
  const artifactsDir = join(rootDir, 'artifacts');
  const dashboardDir = join(rootDir, 'frontend', 'data');
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(dashboardDir, { recursive: true });

  const dashboardPath = join(dashboardDir, 'dashboard.json');
  const existing = await readDashboard(dashboardPath);

  const dashboard: DashboardFile = {
    generatedAt: new Date().toISOString(),
    network: 'testnet',
    policyMode: run.policy.mode,
    contractId: run.policy.contractId,
    latestPolicy: run.policy.after ?? run.policy.before,
    runs: [run, ...existing.runs].slice(0, DASHBOARD_RUN_LIMIT),
  };

  const dashboardJson = jsonStringify(dashboard);
  await writeFile(dashboardPath, dashboardJson, 'utf8');
  await writeFile(join(artifactsDir, 'dashboard.json'), dashboardJson, 'utf8');

  const runPath = join(artifactsDir, `run-${run.runId}.json`);
  await writeFile(runPath, jsonStringify(run), 'utf8');

  let attestationPath: string | null = null;
  if (rawEvidenceJson !== undefined) {
    attestationPath = join(artifactsDir, `attestation-${run.runId}.json`);
    await writeFile(attestationPath, rawEvidenceJson, 'utf8');
  }

  return { dashboard: dashboardPath, run: runPath, attestation: attestationPath };
}

/** BigInt-aware, 2-space JSON with a trailing newline. */
export function jsonStringify(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry),
    2,
  )}\n`;
}

async function readDashboard(path: string): Promise<DashboardFile> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as Partial<DashboardFile>;
    return {
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      network: 'testnet',
      policyMode: parsed.policyMode ?? 'local',
      contractId: parsed.contractId ?? null,
      latestPolicy: parsed.latestPolicy ?? null,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      network: 'testnet',
      policyMode: 'local',
      contractId: null,
      latestPolicy: null,
      runs: [],
    };
  }
}
