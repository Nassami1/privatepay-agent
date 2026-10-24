import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { settlePayment } from '../agent/intents/settlement.js';
import type { Config } from '../agent/config.js';

function configWith(apiUrl: string | null): Config {
  return {
    near: {
      network: 'testnet',
      rpcUrl: 'http://127.0.0.1:1',
      accountId: null,
      agentKey: null,
      policyContractId: null,
    },
    nearAi: { apiKey: null, baseUrl: 'https://cloud-api.near.ai', model: null },
    intents: { apiUrl, usdcAsset: apiUrl === null ? null : 'nep141:test-usdc' },
    demo: { dailyCapUsdc: 10, whitelistRecipient: 'alice.testnet' },
    rootDir: process.cwd(),
  };
}

test('without an Intents endpoint the settlement is explicitly simulated', async () => {
  const settlement = await settlePayment(configWith(null), {
    to: 'alice.testnet',
    amountUsdc: 3,
    invoiceRef: 'INV-1',
  });
  assert.equal(settlement.mode, 'simulated');
  assert.match(settlement.txId, /^SIMULATED_TX_[0-9a-f]{16}$/);
  assert.equal(settlement.quoted, undefined);
  assert.match(settlement.reason ?? '', /no testnet Intents settlement service/);
});

test('a configured endpoint receives a dry 6-decimal quote request', async () => {
  let received: Record<string, unknown> | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ quoteId: 'q-1', quote: { amountOutFormatted: '3.0' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const apiUrl = `http://127.0.0.1:${address.port}`;

  try {
    const settlement = await settlePayment(configWith(apiUrl), {
      to: 'alice.testnet',
      amountUsdc: 3,
      invoiceRef: 'INV-1',
    });

    assert.ok(received !== null);
    const body = received as Record<string, unknown>;
    assert.equal(body.dry, true);
    assert.equal(body.swapType, 'EXACT_INPUT');
    assert.equal(body.amount, '3000000');
    assert.equal(body.depositType, 'INTENTS');
    assert.equal(body.recipientType, 'INTENTS');
    assert.equal(body.refundType, 'INTENTS');
    assert.equal(body.recipient, 'alice.testnet');
    assert.equal(typeof body.deadline, 'string');

    assert.equal(settlement.mode, 'simulated');
    assert.equal(settlement.quoted, true);
    assert.equal(settlement.quoteId, 'q-1');
    assert.equal(settlement.amountOut, '3.0');
    assert.match(settlement.txId, /^SIMULATED_TX_/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
