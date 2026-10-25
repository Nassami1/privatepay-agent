# Test FT token (tUSDC)

A deliberately small NEP-141 token used to make settlement real on testnet.
Symbol `tUSDC`, name `Test USD`, 6 decimals.

This is **not** production token code:

* no storage-registration flow (`storage_deposit`, `storage_balance_of` are not
  implemented); balances are a `LookupMap`;
* only the owner can mint;
* no upgrade or pause mechanism;
* not audited.

## Interface

| Method | Type | Notes |
| --- | --- | --- |
| `new` | init | `{"owner":"samimmi.testnet","initial_supply":"0"}` |
| `mint` | call | Owner only. `{"account_id":"policy.samimmi.testnet","amount":"1000000000000"}` |
| `ft_transfer` | call | Requires exactly 1 yoctoNEAR. `{"receiver_id":"alice.samimmi.testnet","amount":"3000000","memo":"INV-2026-1042"}` |
| `ft_balance_of` | view | `{"account_id":"..."}` → `U128` |
| `ft_total_supply` | view | `{}` → `U128` |
| `ft_metadata` | view | spec, name, symbol, decimals |
| `get_owner` | view | owner account |

The policy contract calls `ft_transfer`; the agent never calls this contract.

## Build / test

```sh
npm run contract:build
cd contracts/test-ft && cargo test
```

Deployed at `usdc.samimmi.testnet`; the policy contract holds 1,000,000 tUSDC.
