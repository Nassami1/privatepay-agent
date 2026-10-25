/**
 * Micro-USDC amounts.
 *
 * The contract stores `u128` micro-USDC (6 decimals). The agent never rounds
 * through a floating-point integer: "10.40" is parsed as 10_400_000 micro, not
 * as 10. This module is the only place decimal USDC becomes an integer.
 */

export const USDC_DECIMALS = 6;
export const MICRO_PER_USDC = 1_000_000n;

export class AmountParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountParseError';
  }
}

/**
 * Parse a decimal USDC amount (`"10.40"`, `10.4`, `"$1,234.56"`) into micro.
 * More than six decimals is rejected rather than silently rounded.
 */
export function parseUsdcToMicro(value: string | number): bigint {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new AmountParseError('amount is not a finite number');
  }
  let text = typeof value === 'number' ? value.toString() : value.trim();
  text = text
    .replace(/^\$/, '')
    .replace(/\s*(?:USDC|USD|USDT)\s*$/i, '')
    .replace(/,/g, '')
    .trim();

  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (match === null) {
    throw new AmountParseError(
      `amount must be a non-negative decimal with at most 6 decimals, got "${text.slice(0, 32)}"`,
    );
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(USDC_DECIMALS, '0');
  return whole * MICRO_PER_USDC + BigInt(fraction === '' ? '0' : fraction);
}

/** Fixed two-decimal display used by the ledger: 3 -> "3.00", 10.4 -> "10.40". */
export function formatUsdc(micro: bigint): string {
  const sign = micro < 0n ? '-' : '';
  const absolute = micro < 0n ? -micro : micro;
  const whole = absolute / MICRO_PER_USDC;
  const fraction = absolute % MICRO_PER_USDC;
  if (fraction === 0n) return `${sign}${whole}.00`;
  if (fraction % 10_000n === 0n) {
    return `${sign}${whole}.${(fraction / 10_000n).toString().padStart(2, '0')}`;
  }
  const digits = fraction.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${sign}${whole}.${digits}`;
}

/** Canonical decimal without trailing zeros: 3 -> "3", 10.4 -> "10.4". */
export function microToCanonical(micro: bigint): string {
  if (micro === 0n) return '0';
  const whole = micro / MICRO_PER_USDC;
  const fraction = micro % MICRO_PER_USDC;
  if (fraction === 0n) return whole.toString();
  const digits = fraction.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${digits}`;
}

/** Six-decimal string, for logs that need an exact micro representation. */
export function microToFixed(micro: bigint): string {
  const whole = micro / MICRO_PER_USDC;
  const fraction = (micro % MICRO_PER_USDC).toString().padStart(USDC_DECIMALS, '0');
  return `${whole}.${fraction}`;
}

export function maxMicro(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
