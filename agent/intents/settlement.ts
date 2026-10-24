/**
 * Settlement through NEAR Intents.
 *
 * Reality check, documented in the README: the public NEAR Intents 1-Click
 * service is mainnet-only, and this build is testnet-only by instruction. So:
 *
 *   * if `INTENTS_API_URL` + `INTENTS_ASSET_USDC_TESTNET` are configured, the
 *     agent obtains a real, signed 1-Click quote for the exact payment and
 *     records it (read-only; no deposit, no funds move);
 *   * execution is always labelled SIMULATED in this prototype, because there
 *     is no testnet Intents settlement service to move testnet USDC through.
 *
 * The settlement object is the only place a "tx" can be simulated, and its id
 * is prefixed `SIMULATED_TX_` so it can never be mistaken for a chain hash.
 */

import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Settlement } from '../types.js';

const QUOTE_TIMEOUT_MS = 15_000;
const USDC_DECIMALS = 6;

export interface SettlementRequest {
  to: string;
  amountUsdc: number;
  invoiceRef: string;
}

export async function settlePayment(
  config: Config,
  request: SettlementRequest,
): Promise<Settlement> {
  const simulatedId = simulatedTxId(request);
  const { apiUrl, usdcAsset } = config.intents;

  if (apiUrl === null || usdcAsset === null) {
    return {
      mode: 'simulated',
      txId: simulatedId,
      reason:
        'INTENTS_API_URL / INTENTS_ASSET_USDC_TESTNET not configured; no testnet Intents settlement service exists, so settlement is simulated.',
    };
  }

  try {
    const quote = await requestQuote(apiUrl, usdcAsset, request);
    return {
      mode: 'simulated',
      txId: simulatedId,
      quoteId: quote.quoteId,
      amountOut: quote.amountOut,
      quoted: true,
      reason:
        'Live 1-Click quote obtained; execution is simulated because this prototype does not hold an Intents deposit and exposes no mainnet path.',
    };
  } catch (error) {
    return {
      mode: 'simulated',
      txId: simulatedId,
      reason: `Intents quote failed (${errorMessage(error)}); settlement simulated.`,
    };
  }
}

interface QuoteResult {
  quoteId?: string;
  amountOut?: string;
}

async function requestQuote(
  apiUrl: string,
  asset: string,
  request: SettlementRequest,
): Promise<QuoteResult> {
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const body = {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: asset,
    destinationAsset: asset,
    amount: String(BigInt(Math.round(request.amountUsdc)) * 10n ** BigInt(USDC_DECIMALS)),
    depositType: 'INTENTS',
    recipientType: 'INTENTS',
    refundType: 'INTENTS',
    recipient: request.to,
    refundTo: request.to,
    deadline,
  };

  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  const payload = (await response.json()) as {
    quoteId?: string;
    quote?: { amountOutFormatted?: string; amountOut?: string };
  };
  return {
    ...(typeof payload.quoteId === 'string' ? { quoteId: payload.quoteId } : {}),
    amountOut: payload.quote?.amountOutFormatted ?? payload.quote?.amountOut,
  };
}

function simulatedTxId(request: SettlementRequest): string {
  const digest = createHash('sha256')
    .update(`${request.invoiceRef}|${request.to}|${request.amountUsdc}|${Date.now()}`)
    .digest('hex');
  return `SIMULATED_TX_${digest.slice(0, 16)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
