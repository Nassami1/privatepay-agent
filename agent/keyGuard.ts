/**
 * Function Call Key self-check.
 *
 * The agent refuses to run in live mode with a key that can do more than
 * `try_pay` on the policy contract. This is the difference between "an agent
 * with a wallet" and "an agent with a permission slip": even if the agent is
 * fully compromised, the key cannot move funds, change the cap, or touch any
 * other contract.
 */

import { KeyPair } from 'near-api-js';
import type { Config } from './config.js';
import type { KeyGuardCheck, KeyGuardResult } from './types.js';
import { isFunctionCallPermission, viewAccessKey } from './near/rpc.js';

const POLICY_MUTATORS = ['set_daily_cap', 'add_to_whitelist', 'remove_from_whitelist', 'reset_spent'];

export async function checkAgentKey(config: Config): Promise<KeyGuardResult> {
  const { accountId, agentKey, policyContractId } = config.near;
  if (accountId === null || agentKey === null || policyContractId === null) {
    return {
      checked: false,
      ok: false,
      checks: [
        {
          name: 'configured',
          ok: false,
          detail: 'NEAR_ACCOUNT_ID / NEAR_AGENT_KEY / POLICY_CONTRACT_ID not all set',
        },
      ],
    };
  }

  let publicKey: string;
  try {
    publicKey = KeyPair.fromString(agentKey).getPublicKey().toString();
  } catch {
    return {
      checked: true,
      ok: false,
      accountId,
      contractId: policyContractId,
      checks: [{ name: 'key_parses', ok: false, detail: 'NEAR_AGENT_KEY is not a valid NEAR key' }],
    };
  }

  try {
    const accessKey = await viewAccessKey(accountId, publicKey);
    const permission = accessKey.permission;
    const checks: KeyGuardCheck[] = [];

    const isFunctionCall = isFunctionCallPermission(permission);
    checks.push({
      name: 'not_full_access',
      ok: isFunctionCall,
      detail: isFunctionCall ? 'key is a Function Call Key' : 'key has FullAccess — refused',
    });

    if (!isFunctionCall) {
      return { checked: true, ok: false, accountId, publicKey, contractId: policyContractId, checks };
    }

    const scoped = permission.FunctionCall;
    checks.push({
      name: 'receiver_scoped',
      ok: scoped.receiver_id === policyContractId,
      detail: `receiver_id=${scoped.receiver_id} (required: ${policyContractId})`,
    });
    checks.push({
      name: 'only_try_pay',
      ok:
        scoped.method_names.length === 1 && scoped.method_names[0] === 'try_pay',
      detail: `method_names=[${scoped.method_names.join(', ')}] (required: [try_pay])`,
    });
    checks.push({
      name: 'no_policy_mutators',
      ok: scoped.method_names.every((method: string) => !POLICY_MUTATORS.includes(method)),
      detail: 'key cannot change cap, whitelist, or spent counter',
    });
    checks.push({
      name: 'has_gas_allowance',
      ok: scoped.allowance !== null && BigInt(scoped.allowance) > 0n,
      detail:
        scoped.allowance === null
          ? 'no allowance set (unlimited gas spending for this key)'
          : `allowance=${formatNear(scoped.allowance)} NEAR`,
    });

    return {
      checked: true,
      ok: checks.every((check) => check.ok),
      accountId,
      publicKey,
      contractId: policyContractId,
      checks,
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      accountId,
      publicKey,
      contractId: policyContractId,
      checks: [
        {
          name: 'key_lookup',
          ok: false,
          detail: `could not read access key: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

function formatNear(yocto: string): string {
  const value = Number(BigInt(yocto)) / 1e24;
  return value.toFixed(2);
}
