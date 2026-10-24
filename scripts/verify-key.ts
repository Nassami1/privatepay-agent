#!/usr/bin/env tsx
/**
 * Print the Function Call Key guard report.
 *
 * Exits non-zero only when a key is configured but is not least-privilege.
 * With no key configured it explains how to enable live mode and exits 0, so a
 * fresh clone can run every script without credentials.
 */

import { hasLivePolicy, loadConfig, loadDotEnv } from '../agent/config.js';
import { checkAgentKey } from '../agent/keyGuard.js';

try {
  loadDotEnv();
  const config = loadConfig();
  if (!hasLivePolicy(config)) {
    console.log('[key] guard=SKIPPED no live policy configured');
    console.log(
      '[key] set NEAR_ACCOUNT_ID, NEAR_AGENT_KEY and POLICY_CONTRACT_ID to check a real Function Call Key',
    );
    process.exitCode = 0;
  } else {
    const guard = await checkAgentKey(config);
    console.log(
      `[key] account=${guard.accountId ?? 'unknown'} key=${guard.publicKey ?? 'unknown'} ` +
        `receiver=${guard.contractId ?? 'unknown'}`,
    );
    for (const check of guard.checks) {
      console.log(`[key] ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    }
    console.log(`[key] result=${guard.ok ? 'PASS' : 'FAIL'}`);
    process.exitCode = guard.ok ? 0 : 1;
  }
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
