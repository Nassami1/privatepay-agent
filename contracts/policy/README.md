# Policy contract

On-chain spending policy with real FT settlement. Rust + `near-sdk` 5.29.1,
deployed to NEAR **testnet** only.

The contract holds the test tUSDC, checks that the caller is the configured
agent, enforces the daily cap and the recipient whitelist, refuses duplicate
invoice references, and performs the `ft_transfer` itself. The agent has no
token balance and no key that can reach the token contract.

Nothing sensitive is stored: `invoice_ref` is an opaque reference. Invoice text
never reaches the chain.

## State

| Field | Meaning |
| --- | --- |
| `owner` | Human account; only it can change policy. |
| `agent_id` | The only account allowed to call `try_pay`. Must differ from `owner`. |
| `token_id` | NEP-141 test token contract. |
| `daily_cap_micro_usdc` | Daily cap in micro-USDC (`u128`, 6 decimals). |
| `spent_today_micro_usdc` | Rolling spend for the current UTC day. |
| `day` | Days since the Unix epoch. |
| `whitelist` | `IterableSet<AccountId>` of allowed recipients. |
| `paid_invoices` | `IterableSet<String>` of invoice refs already paid once. |
| `log` | `Vector<Attempt>` with the bounded view of the audit trail. |

## Interface

| Method | Type | Input | Output |
| --- | --- | --- | --- |
| `new` | init | `{"owner":"samimmi.testnet","agent_id":"agent.samimmi.testnet","token_id":"usdc.samimmi.testnet","cap_micro_usdc":"10000000"}` | state |
| `set_daily_cap` | call | `{"cap_micro_usdc":"10000000"}` | `{"ok":true,"cap_micro_usdc":"10000000"}` |
| `add_to_whitelist` | call | `{"account_id":"alice.samimmi.testnet"}` | `{"ok":true}` |
| `remove_from_whitelist` | call | `{"account_id":"alice.samimmi.testnet"}` | `{"ok":true}` |
| `try_pay` | call | `{"to":"alice.samimmi.testnet","amount_micro_usdc":"3000000","invoice_ref":"INV-001"}` | `{"ok":true,"tx":"policy:<hex>"}` or `{"ok":false,"reason":"..."}` |
| `get_policy` | view | `{}` | owner, agent, token, cap, spent, whitelist, paid count |
| `get_log` | view | `{"limit":20}` | newest-last attempts |
| `reset_spent` | call | `{}` | `{"ok":true}` |

Refusal reasons: `OVER_LIMIT`, `NOT_WHITELISTED`, `DUPLICATE_INVOICE`,
`ZERO_AMOUNT`, `INVALID_INVOICE_REF`.

## Rules and ordering

1. `try_pay` requires `predecessor_account_id == agent_id`; any other caller
   panics. The owner cannot call it directly.
2. Zero amounts and invoice references longer than 64 bytes are refused.
3. A reference in `paid_invoices` is refused before any balance moves; a retry
   after a timeout cannot pay twice.
4. The whitelist is checked before the cap.
5. The daily counter rolls at UTC midnight.
6. On approval the contract records the attempt, marks the reference paid, and
   calls `ft_transfer(receiver_id = to, amount, memo = invoice_ref)` on the token
   contract with exactly 1 yoctoNEAR and 40 TGas.
7. A blocked attempt is logged and emits a NEP-297 event, but moves no tokens.

The contract is a gate **and** the payer: it is the only account with a token
balance, and the agent's key is scoped to `try_pay` on this contract. Bypassing
`try_pay` therefore does not expose a payment path.

### Async note

`try_pay` returns after scheduling the FT transfer. The transaction hash covers
the transfer receipt; the agent reads the recipient balance after the
transaction and treats a failed receipt as a settlement failure. Marking the
reference paid before the transfer is the conservative choice: a failed transfer
cannot be replayed silently, and the log records the approval for
reconciliation.

## Access control

* `owner` is checked on every mutator.
* The deployed instance uses `samimmi.testnet` as owner and
  `agent.samimmi.testnet` as agent.
* The agent key is a Function Call Key restricted to `try_pay` on this contract
  with a 0.5 NEAR gas allowance.
* `npm run demo:denied` proves both directions against the live network: the
  owner's `try_pay` transaction fails, and the agent's `set_daily_cap` call is
  rejected by the access key before execution.

## Build

```sh
npm run contract:build
```

Requires Rust with `wasm32-unknown-unknown` (built with `rustc 1.99.1`;
`near-sdk 5.29.1` declares MSRV 1.95). The output is written to
`build/privatepay_policy.wasm` and is intentionally not committed; run the build
before `bootstrap:testnet`.

## Test

```sh
cd contracts/policy
cargo test
```

Covers the agent-only check, owner-only mutators, cap, whitelist ordering,
duplicate references, zero amount, invalid reference, daily rollover, reset, log
ordering and the UTC formatter.

## Deploy

The reproducible setup is `npm run bootstrap:testnet`; see the top-level README.
It creates the accounts, deploys both contracts, mints tUSDC to the policy
contract, whitelists the recipient and installs the agent key.

Owner operations:

```sh
npm run demo:reset   # cap, whitelist, spent=0, idempotency/log cleared
```
