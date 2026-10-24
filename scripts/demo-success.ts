#!/usr/bin/env tsx
/** `npm run demo:success` — 3 USDC invoice, under cap, whitelisted recipient. */

import { runDemo } from './lib/demo.js';

try {
  process.exitCode = await runDemo('success');
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
