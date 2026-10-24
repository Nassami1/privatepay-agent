# Policy contract

On-chain spending policy for the PrivatePay Agent. Rust + `near-sdk` 5.29.1,
deployed to NEAR **testnet** only.

The contract is the authority for two facts an autonomous payment agent must
not control itself: the daily cap and the recipient whitelist. It also keeps a
bounded, append-only log of every attempt, allowed or refused.

Nothing sensitive is stored: `invoice_ref` is an opaque reference. Invoice text
never reaches the chain.

## Interface

| Method | Type | Input | Output | Rule |
| --- | --- | --- | --- | --- |
| `new` | init | `{"owner":"acct.testnet","cap_usdc":10}` | state | Called once at deploy. |
| `set_daily_cap` | call | `{"cap_usdc":10}` | `{"ok":true,"cap_usdc":10}` | Owner only. Overwrites the cap. |
| `add_to_whitelist` | call | `{"account_id":"alice.testnet"}` | `{"ok":true}` | Owner only. Idempotent. |
| `remove_from_whitelist` | call | `{"account_id":"alice.testnet"}` | `{"ok":true}` | Owner only. No-op if absent. |
| `try_pay` | call | `{"to":"alice.testnet","amount_usdc":3,"invoice_ref":"INV-001"}` | `{"ok":true,"tx":"policy:<hex>"}` or `{"ok":false,"reason":"OVER_LIMIT"\|"NOT_WHITELISTED"}` | The only method the agent key may call. Never throws on a policy decision. |
| `get_policy` | view | `{}` | `{"cap_usdc":10,"spent_today_usdc":3,"whitelist":["alice.testnet"]}` | — |
| `get_log` | view | `{"limit":20}` | `[{"invoice_ref":"INV-001","to":"alice.testnet","amount_usdc":3,"result":"SUCCESS","ts":"2026-10-24T15:11:12Z"}]` | Newest last. Bounded at 200 entries. |
| `reset_spent` | call | `{}` | `{"ok":true}` | Owner only, demo/ops helper. The agent key cannot call it. |

`result` is one of `SUCCESS`, `BLOCKED_OVER_LIMIT`, `BLOCKED_NOT_WHITELISTED`.

## Rules and ordering

1. The daily counter rolls at UTC midnight (`block_timestamp / 86,400,000`).
2. `try_pay` checks the whitelist **first**, then the cap. An unknown recipient
   asking for an over-cap amount is reported as `NOT_WHITELISTED`; the recipient
   boundary is the stronger one.
3. A blocked attempt changes no balances and does not consume the cap, but it is
   logged.
4. Amounts are whole USDC demo units (`u32`), as specified for the prototype.
5. `try_pay` is not `#[payable]`: attaching NEAR is rejected by the runtime.

## Access control

* `owner` is checked with `env::predecessor_account_id()` on every mutator.
* The deployed instance uses the contract account itself as owner.
* The agent runs with a Function Call Key restricted to
  `POLICY_CONTRACT_ID` + `try_pay` + a 0.5 NEAR gas allowance. It cannot call
  any mutator, and `npm run demo:denied` proves that against the live network.

## Build

```sh
npm run contract:build     # cargo build --target wasm32-unknown-unknown --release
```

Requires Rust with the `wasm32-unknown-unknown` target. This repository was
built with `rustc 1.99.1`; `near-sdk 5.29.1` declares an MSRV of 1.95.
The compiled artifact is committed at `build/privatepay_policy.wasm`
(`sha256` recorded in the top-level README), so running the demo does not
require Rust.

## Test

```sh
cd contracts/policy
cargo test
```

Covers the cap, whitelist ordering, no-spend-on-block, daily rollover, log
ordering and limits, owner-only access, and the UTC formatter.

## Deploy

```sh
npm run contract:deploy            # deploy if needed + set demo policy + add agent key
npm run contract:deploy -- --force # replace the wasm (storage is preserved)
npm run demo:reset                 # owner-only: cap/whitelist reset + spent=0
```

Owner scripts read a full-access testnet key from `.keys/deployer.json`
(gitignored; see the top-level README). The agent runtime never reads it.
