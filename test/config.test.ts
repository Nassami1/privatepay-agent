import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, normalizeNearAiBase } from '../agent/config.js';

test('accepts the dashboard hostname and normalises it to the API host', () => {
  assert.equal(normalizeNearAiBase('https://cloud.near.ai'), 'https://cloud-api.near.ai');
  assert.equal(normalizeNearAiBase('https://cloud.near.ai/'), 'https://cloud-api.near.ai');
  assert.equal(normalizeNearAiBase('https://cloud-api.near.ai/'), 'https://cloud-api.near.ai');
  assert.equal(normalizeNearAiBase('https://cloud-api.near.ai/v1'), 'https://cloud-api.near.ai');
});

test('defaults to testnet and the demo policy', () => {
  const saved = { ...process.env };
  try {
    delete process.env.NEAR_NETWORK;
    delete process.env.DAILY_CAP_USDC;
    delete process.env.WHITELIST_RECIPIENT;
    const config = loadConfig();
    assert.equal(config.near.network, 'testnet');
    assert.equal(config.demo.dailyCapUsdc, 10);
    assert.equal(config.demo.whitelistRecipient, 'alice.samimmi.testnet');
  } finally {
    process.env = saved;
  }
});

test('refuses any network other than testnet', () => {
  const saved = process.env.NEAR_NETWORK;
  process.env.NEAR_NETWORK = 'mainnet';
  try {
    assert.throws(() => loadConfig(), /must be "testnet"/);
  } finally {
    if (saved === undefined) delete process.env.NEAR_NETWORK;
    else process.env.NEAR_NETWORK = saved;
  }
});
