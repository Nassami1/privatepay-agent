import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatUsdc,
  microToCanonical,
  parseUsdcToMicro,
} from '../agent/amount.js';

test('10.40 is 10_400_000 micro, never 10', () => {
  assert.equal(parseUsdcToMicro('10.40'), 10_400_000n);
  assert.equal(parseUsdcToMicro('10.4'), 10_400_000n);
  assert.equal(parseUsdcToMicro(10.4), 10_400_000n);
});

test('other decimal shapes are exact', () => {
  assert.equal(parseUsdcToMicro('10.5'), 10_500_000n);
  assert.equal(parseUsdcToMicro('0.4'), 400_000n);
  assert.equal(parseUsdcToMicro('$1,234.56'), 1_234_560_000n);
  assert.equal(parseUsdcToMicro('3 USDC'), 3_000_000n);
  assert.equal(parseUsdcToMicro('0.000001'), 1n);
});

test('more than six decimals is rejected, not rounded', () => {
  assert.throws(() => parseUsdcToMicro('10.4000001'), /at most 6 decimals/);
  assert.throws(() => parseUsdcToMicro('-1'), /non-negative decimal/);
  assert.throws(() => parseUsdcToMicro('abc'), /non-negative decimal/);
});

test('display keeps two decimals and canonical trims zeros', () => {
  assert.equal(formatUsdc(3_000_000n), '3.00');
  assert.equal(formatUsdc(10_400_000n), '10.40');
  assert.equal(formatUsdc(1n), '0.000001');
  assert.equal(microToCanonical(3_000_000n), '3');
  assert.equal(microToCanonical(10_400_000n), '10.4');
  assert.equal(microToCanonical(400_000n), '0.4');
});
