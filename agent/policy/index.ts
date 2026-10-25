/** Chooses the enforcement backend: deployed testnet contract or local mirror. */

import { MICRO_PER_USDC } from '../amount.js';
import { hasLivePolicy, type Config } from '../config.js';
import type { PolicyClient } from '../types.js';
import { LocalPolicy } from './local.js';
import { TestnetPolicy } from './testnet.js';

export async function createPolicy(config: Config): Promise<PolicyClient> {
  if (hasLivePolicy(config)) {
    return TestnetPolicy.create(config);
  }
  return new LocalPolicy({
    capMicroUsdc: BigInt(config.demo.dailyCapUsdc) * MICRO_PER_USDC,
    whitelist: [config.demo.whitelistRecipient],
  });
}

export { LocalPolicy } from './local.js';
export { TestnetPolicy } from './testnet.js';
