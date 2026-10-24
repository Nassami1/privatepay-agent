#!/usr/bin/env tsx
/** `npm run demo:blocked` — over-cap and non-whitelisted invoices are refused. */

import { runDemo } from './lib/demo.js';

try {
  process.exitCode = await runDemo('blocked');
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
