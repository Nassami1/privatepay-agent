/** Read-only helpers for the test NEP-141 token. */

import { viewFunction } from './rpc.js';

export async function getFtBalance(tokenId: string, accountId: string): Promise<bigint> {
  const raw = await viewFunction<string>(tokenId, 'ft_balance_of', { account_id: accountId });
  return BigInt(raw);
}

export interface FtMetadata {
  spec: string;
  name: string;
  symbol: string;
  decimals: number;
}

export async function getFtMetadata(tokenId: string): Promise<FtMetadata> {
  return viewFunction<FtMetadata>(tokenId, 'ft_metadata', {});
}
