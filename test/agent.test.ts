import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptPayment, type AgentDependencies } from '../agent/agent.js';
import { extractLocally } from '../agent/tee/decision.js';
import { simulatedAttestation } from '../agent/tee/attestation.js';
import { INVOICES, type DemoInvoice } from '../agent/fixtures.js';
import type { Config } from '../agent/config.js';
import type {
  PayOutcome,
  PolicyClient,
  PolicyLogEntry,
  PolicyState,
  TeeDecision,
  TeeRun,
} from '../agent/types.js';

const CONFIG: Config = {
  near: {
    network: 'testnet',
    rpcUrl: 'http://127.0.0.1:1',
    accountId: null,
    agentKey: null,
    policyContractId: null,
  },
  nearAi: { apiKey: null, baseUrl: 'https://cloud-api.near.ai', model: null },
  demo: { dailyCapUsdc: 10, whitelistRecipient: 'alice.samimmi.testnet' },
  rootDir: process.cwd(),
};

function makeTee(decision: TeeDecision, invoice: DemoInvoice): TeeRun {
  const redaction = {
    redactedText: invoice.text,
    redactedFields: ['EMAIL', 'PERSON_NAME'],
    replacements: 2,
  };
  return {
    mode: 'simulated',
    model: 'test-extractor',
    latencyMs: 1,
    decision,
    attestation: simulatedAttestation({ model: 'test-extractor', redaction, reason: 'test' }),
    redaction,
    attestationCached: false,
    signature: null,
  };
}

class FakePolicy implements PolicyClient {
  readonly mode = 'local' as const;
  readonly contractId = null;
  calls = 0;

  constructor(
    private readonly outcome: PayOutcome,
    private readonly tokenId: string | null = null,
  ) {}

  async getPolicy(): Promise<PolicyState> {
    return {
      ownerId: 'owner.test',
      agentId: 'agent.test',
      tokenId: this.tokenId,
      capMicroUsdc: 10_000_000n,
      spentTodayMicroUsdc: 0n,
      whitelist: ['alice.samimmi.testnet'],
      paidInvoices: 0,
      mode: 'local',
      contractId: null,
    };
  }

  async tryPay(): Promise<PayOutcome> {
    this.calls += 1;
    return this.outcome;
  }

  async getLog(): Promise<PolicyLogEntry[]> {
    return [];
  }
}

const OK: PayOutcome = { ok: true, tx: 'policy:1', chainTx: 'chain-1' };

test('a rejected payment never reaches the FT balance read', async () => {
  const policy = new FakePolicy({ ok: false, reason: 'OVER_LIMIT' });
  let balanceReads = 0;
  const deps: AgentDependencies = {
    processTee: async () => makeTee(extractLocally(INVOICES.success.text), INVOICES.success),
    readFtBalance: async () => {
      balanceReads += 1;
      return 0n;
    },
  };
  const result = await attemptPayment(CONFIG, policy, INVOICES.success, {}, deps);
  assert.equal(result.record.result, 'BLOCKED_OVER_LIMIT');
  assert.equal(policy.calls, 1);
  assert.equal(balanceReads, 0);
});

test('a successful contract call is followed by a balance proof', async () => {
  const policy = new FakePolicy(OK, 'usdc.samimmi.testnet');
  let balanceReads = 0;
  const deps: AgentDependencies = {
    processTee: async () => makeTee(extractLocally(INVOICES.success.text), INVOICES.success),
    readFtBalance: async () => {
      balanceReads += 1;
      return 3_000_000n;
    },
  };
  const result = await attemptPayment(CONFIG, policy, INVOICES.success, {}, deps);
  assert.equal(result.record.result, 'SUCCESS');
  assert.equal(result.record.ftBalanceAfterMicro, 3_000_000n);
  assert.equal(policy.calls, 1);
  assert.equal(balanceReads, 1);
});

test('a model answer not present in the invoice is rejected before the contract', async () => {
  const policy = new FakePolicy(OK);
  const decision = {
    ...extractLocally(INVOICES.success.text),
    recipient: 'mallory.samimmi.testnet',
  };
  const deps: AgentDependencies = {
    processTee: async () => makeTee(decision, INVOICES.success),
    readFtBalance: async () => 0n,
  };
  const result = await attemptPayment(CONFIG, policy, INVOICES.success, {}, deps);
  assert.equal(result.record.result, 'BLOCKED_UNVERIFIED_OUTPUT');
  assert.equal(policy.calls, 0);
});

test('a blocking risk flag holds the invoice before the contract', async () => {
  const policy = new FakePolicy(OK);
  const deps: AgentDependencies = {
    processTee: async () => makeTee(extractLocally(INVOICES.risky.text), INVOICES.risky),
    readFtBalance: async () => 0n,
  };
  const result = await attemptPayment(CONFIG, policy, INVOICES.risky, {}, deps);
  assert.equal(result.record.result, 'HELD_FOR_REVIEW');
  assert.equal(policy.calls, 0);
});

test('a TEE failure is fail-closed and never calls the contract', async () => {
  const policy = new FakePolicy(OK);
  const deps: AgentDependencies = {
    processTee: async () => {
      throw new Error('TEE unavailable');
    },
    readFtBalance: async () => 0n,
  };
  const result = await attemptPayment(CONFIG, policy, INVOICES.success, {}, deps);
  assert.equal(result.record.result, 'BLOCKED_TEE_UNAVAILABLE');
  assert.equal(policy.calls, 0);
});

test('an amount over the human threshold is held unless approved', async () => {
  const invoice: DemoInvoice = {
    invoiceRef: 'INV-HUMAN',
    text: 'Total due: 150 USDC\nPay to: alice.samimmi.testnet',
  };
  const decision = extractLocally(invoice.text, { invoiceRef: invoice.invoiceRef });
  const deps: AgentDependencies = {
    processTee: async () => makeTee(decision, invoice),
    readFtBalance: async () => 0n,
  };

  const held = await attemptPayment(CONFIG, new FakePolicy(OK), invoice, {}, deps);
  assert.equal(held.record.result, 'BLOCKED_HUMAN_APPROVAL_REQUIRED');

  const approvedPolicy = new FakePolicy(OK);
  const approved = await attemptPayment(
    CONFIG,
    approvedPolicy,
    invoice,
    { humanApproved: true },
    deps,
  );
  assert.equal(approved.record.result, 'SUCCESS');
  assert.equal(approvedPolicy.calls, 1);
});
