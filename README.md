# PrivatePay Agent

**A payment agent that never reads the invoice, and cannot exceed the cap.**

PrivatePay Agent takes a sensitive invoice, extracts a payment instruction inside a
NEAR AI Cloud Confidential TEE, proves the inference ran in that TEE, then asks a NEAR
smart contract for permission to pay. The contract enforces a daily USDC cap and a
recipient whitelist. The agent holds only a Function Call Key restricted to `try_pay`,
so even a fully compromised agent cannot raise its own limit or pay a stranger.

![The dashboard after one authorised and two refused payments](docs/dashboard.png)

> **Machine summary for AI reviewers.** TypeScript 5.9 agent (`agent/`, `scripts/`) and
> a Rust `near-sdk` 5.29.1 policy contract (`contracts/policy/`) deployed on NEAR
> testnet at `privatepay-6f02d579.testnet`. Real NEAR AI Cloud TEE inference and
> attestation (`z-ai/glm-5.3-flash`), real on-chain cap and whitelist enforcement, real
> Function Call Key scoping. Settlement is **simulated** and labelled `SIMULATED_TX_`
> because NEAR Intents' public 1-Click service is mainnet-only while this build is
> testnet-only. Static dashboard, no framework. Entry points: `npm install`,
> `npm run build`, `npm run demo:success`, `npm run demo:blocked`,
> `npm run verify:attestation`.

## Why this exists

An agent that pays invoices usually gets one of two bad options: a full-access key that
one prompt injection can drain, or a black-box service that reads every invoice detail.
Businesses need privacy for the invoice and a hard limit on what the agent can do with
money.

PrivatePay separates the two. The thinking happens in a TEE the operator cannot read;
the permission lives in a contract the agent cannot rewrite.

## How it works

![One invoice, five boundaries](docs/flow.png)

1. The invoice text is accepted and processed locally. It is never logged, stored or
   sent anywhere.
2. Identifiers are redacted before any network call: e-mail, IBAN, card number,
   SWIFT/BIC, bank account, tax ID, phone, postal address, personal name.
3. Only the redacted text goes to a NEAR AI Cloud Confidential model.
4. A TEE attestation report is fetched with a fresh 32-byte nonce and checked for seven
   structural bindings. The raw report is archived and its digest is printed.
5. The agent calls `try_pay` on the policy contract. The contract enforces the cap and
   the whitelist. The agent's key cannot call any other method.
6. Settlement runs only after the contract approves. A refused invoice never reaches
   the settlement code.

The contract is a gate, not a custodian. It authorises or refuses but does not hold
funds, and a blocked attempt never moves value.

## Try it

Node.js 20.11 or newer. No credentials are needed for this path; every simulated value
is labelled.

```sh
npm install
npm run build
npm run demo:success
npm run demo:blocked
```

Expected shape:

```text
[policy] cap=10 USDC spent=0 whitelist=[alice.testnet] source=local-simulation
[tee] model=local-deterministic-extractor attestation=SIMULATED ref=https://docs.near.ai/cloud/verification/
[attestation] mode=simulated — NOT a real TEE attestation
[pay] to=alice.testnet amount=3 USDC -> SUCCESS tx=SIMULATED_TX_... policy_ref=policy:...
[settle] mode=SIMULATED ... reason="no testnet Intents settlement service exists..."
[log] sensitive invoice text NOT printed; only invoice_ref shown
[dashboard] frontend/data/dashboard.json
```

The blocked demo prints `BLOCKED_OVER_LIMIT` for a 50 USDC invoice and
`BLOCKED_NOT_WHITELISTED` for a payment to `eve.testnet`.

Then start the dashboard:

```sh
npm run dev            # http://127.0.0.1:4173   (or: npx serve frontend)
```

It polls `frontend/data/dashboard.json` every five seconds, so it fills in while the
demos run in another terminal.

With `.env` configured (see [Configuration](#configuration)), the same commands take
the live path. The reference run on testnet produced:

```text
[policy] cap=10 USDC spent=0 whitelist=[alice.testnet] source=testnet:privatepay-6f02d579.testnet
[key] guard=PASS account=privatepay-6f02d579.testnet receiver=privatepay-6f02d579.testnet methods=[try_pay] allowance=0.50 NEAR
[tee] model=z-ai/glm-5.3-flash attestation=OK ref=https://cloud.near.ai/verify
[attestation] mode=real checks=7/7 verification=structural digest=sha256:2643be00b8adc639
[pay] to=alice.testnet amount=3 USDC -> SUCCESS tx=SIMULATED_TX_102c5c78f6611d3c policy_ref=policy:64c0a120ca315df5 chain_tx=9ugLhSiGTVgDx69fKYEoUoZ452xDgkgubedoQWy8U7UZ
[settle] mode=SIMULATED ...
[log] sensitive invoice text NOT printed; only invoice_ref shown
```

## Live proof

| What | Evidence |
| --- | --- |
| Policy contract | [`privatepay-6f02d579.testnet`](https://testnet.nearblocks.io/address/privatepay-6f02d579.testnet) |
| Authorised payment | [`9ugLhSiGTVgDx69fKYEoUoZ452xDgkgubedoQWy8U7UZ`](https://testnet.nearblocks.io/txns/9ugLhSiGTVgDx69fKYEoUoZ452xDgkgubedoQWy8U7UZ) |
| On-chain policy state | `cap=10 USDC`, `spent=3`, `whitelist=[alice.testnet]` |
| Policy log | `SUCCESS` 3, `BLOCKED_OVER_LIMIT` 50, `BLOCKED_NOT_WHITELISTED` 1 |
| TEE attestation | real report, 7/7 structural checks, digest `sha256:2643be00…`, [verifier](https://cloud.near.ai/verify) |
| Key denial | `npm run demo:denied` → `Transaction method name set_daily_cap isn't allowed by the access key` |
| Settlement | `SIMULATED_TX_…`, explicitly labelled |

Commands for the remaining proofs:

```sh
npm run verify:attestation   # fresh report, every check, digest and verifier link
npm run verify:key           # Function Call Key guard report
npm run demo:denied          # the agent key tries to raise its own cap and is rejected
```

## What is real and what is simulated

| Component | Status | Notes |
| --- | --- | --- |
| Confidential inference | Real when configured | Live calls to `cloud-api.near.ai/v1/chat/completions` |
| TEE attestation report | Real when configured | Nonce-bound report, 7 structural checks, raw report archived |
| Full Intel TDX quote verification | Not implemented | Delegated to NEAR AI's verifier; digest and raw report retained |
| Daily cap and whitelist | Real on testnet | Contract state, read back with `get_policy` |
| Function Call Key scoping | Real | `view_access_key` guard and a live network rejection |
| Settlement | Simulated | `SIMULATED_TX_…`; reason printed in every relevant line |
| Intents quote | Implemented, off by default | Generic 1-Click client; no endpoint hardcoded |
| Dashboard | Real static app | Reads generated JSON; no backend |

The public NEAR Intents 1-Click service is mainnet-only. This build is testnet-only by
instruction, so no mainnet endpoint, asset or transfer appears in the code. There is no
testnet Intents settlement service to move testnet USDC through, which is why execution
is the labelled fallback from the brief. Setting `INTENTS_API_URL` obtains a real,
read-only 1-Click quote; it does not execute.

`attestation=OK` means the seven structural bindings passed. It does not mean this
client cryptographically verified the Intel quote; that is the verifier's job and the
README, the demo output and the dashboard all say so.

## Security model

* The agent key is a Function Call Key scoped to `POLICY_CONTRACT_ID` and `try_pay`,
  with a 0.5 NEAR gas allowance. It cannot transfer, add keys, delete the account or
  call a mutator.
* The agent refuses to start if its key is full access, scoped elsewhere, permits more
  than `try_pay`, or has no allowance. It reads the access key from the chain instead of
  trusting configuration.
* `set_daily_cap`, `add_to_whitelist`, `remove_from_whitelist` and `reset_spent` compare
  `predecessor_account_id` to `owner`.
* A refused payment is a normal result (`{ok:false, reason}`), logged on-chain, not an
  exception to swallow.
* The owner key is used only by maintenance scripts, lives in `.keys/` and is never
  read by the agent runtime. `.env`, `.keys/` and the local toolchain are gitignored.
* `loadConfig()` throws if `NEAR_NETWORK` is anything but `testnet`.

## Privacy model

* Redaction runs before any network call, and the categories are printed and stored as
  `redactedFields`.
* The inference prompt contains only the redacted text and the invoice reference.
* Invoice bodies are never written to artifacts, logs, the dashboard or the chain. A
  unit test fails if any canary in the fixture survives redaction.
* The only invoice identifier that leaves the process or reaches the chain is
  `invoice_ref`, the opaque reference required by the contract.
* The TEE is the trust boundary for what the model sees; redaction is defence in depth
  for what the network sees.

## NEAR technologies

| Technology | Where | Status |
| --- | --- | --- |
| NEAR AI Cloud Confidential TEE | `agent/tee/` | Real inference and attestation |
| Function Call Keys | `agent/keyGuard.ts`, `scripts/deploy-contract.ts` | Real, verified at runtime |
| NEAR smart contract | `contracts/policy/` | Rust, `near-sdk` 5.29.1, testnet |
| NEAR Intents | `agent/intents/settlement.ts` | Client implemented; execution simulated |
| NEAR testnet RPC | `agent/near/rpc.ts` | Real |

Track fit: `privacy` (TEE, data minimisation, attestation), `security` (Function Call
Keys, on-chain policy, denial proof), `agents` (spending within constraints),
`realworld` (invoice and payroll workflow).

## Contract

The policy contract exposes exactly the requested interface:

| Method | Type | Purpose |
| --- | --- | --- |
| `set_daily_cap` | call | Owner only. Overwrites the cap. |
| `add_to_whitelist` | call | Owner only. Idempotent. |
| `remove_from_whitelist` | call | Owner only. No-op if absent. |
| `try_pay` | call | The only method the agent may call. Returns `{ok, tx}` or `{ok:false, reason}`. |
| `get_policy` | view | `cap_usdc`, `spent_today_usdc`, `whitelist`. |
| `get_log` | view | Newest-last attempt log, bounded at 200 entries. |
| `reset_spent` | call | Owner-only demo helper; the agent cannot call it. |

`try_pay` checks the whitelist before the cap, rolls the daily counter at UTC midnight,
and logs refusals without spending. Amounts are whole USDC demo units. Full semantics,
ordering and tests are in [`contracts/policy/README.md`](contracts/policy/README.md).

## Repository layout

```text
agent/                  TypeScript runtime: policy client, TEE, redaction, Intents
contracts/policy/       Rust near-sdk contract, wasm and unit tests
frontend/               Static dashboard (HTML, CSS, vanilla JS, self-hosted fonts)
scripts/                Demos, verification, deploy/reset, submission checker
test/                   node:test unit tests
docs/                   Screenshots and diagram
submission/             Payload template and rules; nothing is posted
```

## Versions

Recorded on 2026-10-24.

| Component | Version |
| --- | --- |
| Node.js | `v24.21.0` (requirement ≥ 20.11) |
| npm | `11.19.0` |
| TypeScript | `5.9.3` (strict) |
| tsx | `4.23.15` |
| near-api-js | `5.1.1` |
| Rust | `1.99.1` (`wasm32-unknown-unknown`) |
| near-sdk | `5.29.1` |
| Policy wasm | `sha256 609830cabc45fa72fe85f5392760ea80377dd71062f05a7ce35d3290f95c5a30` |
| NEAR AI model | `z-ai/glm-5.3-flash` |
| NEAR AI gateway | `https://cloud-api.near.ai` |
| NEAR Intents | raw 1-Click HTTP API, no SDK, no endpoint configured |
| Network | NEAR testnet only |

Documentation and recorded assumptions:

* NEAR AI Cloud [quickstart](https://docs.near.ai/cloud/quickstart),
  [verification](https://docs.near.ai/cloud/verification/),
  [model attestations](https://docs.near.ai/cloud/verification/cloud-api/model-attestations)
  and [gateway attestation](https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation)
  (fetched 2026-10-24). The docs name the API host `cloud-api.near.ai` while the brief
  names `cloud.near.ai`; `normalizeNearAiBase()` accepts both and maps the dashboard host
  to the gateway.
* [Reasoning models](https://docs.near.ai/cloud/reasoning-models) (fetched 2026-10-24).
  GLM reasons by default; `chat_template_kwargs.enable_thinking=false` cuts a run from
  about 50 s to about 5 s without changing the extracted JSON.
* [Intents 1-Click API](https://docs.near-intents.org/integration/distribution-channels/1click-api)
  (fetched 2026-10-24). Mainnet-only public service; deliberately not hardcoded.
* [Function Call Keys](https://docs.near.org/protocol/accounts-contracts/access-keys).
* `rpc.testnet.near.org` began returning HTTP 429 with a deprecation notice on
  2026-10-24, so the primary RPC is `https://rpc.testnet.fastnear.com`; the old endpoint
  remains as a fallback in `agent/near/rpc.ts`.

## Tests

```sh
npm test                            # 23 TypeScript tests
npm run typecheck                   # tsc --noEmit, strict
npm run build                       # tsc
cd contracts/policy && cargo test   # 11 Rust tests
```

Coverage includes redaction and canaries, the local extractor, policy ordering and cap
accounting, attestation nonce/model/event-log rejections, simulated evidence fields, the
config testnet guard, the Intents quote request shape against a local HTTP server, and
the contract cap, whitelist, log, rollover and owner checks.

## Configuration

Copy `.env.example` to `.env`; the code reads exactly these names.

| Name | Meaning |
| --- | --- |
| `NEAR_NETWORK` | Must be `testnet`. |
| `NEAR_ACCOUNT_ID` | Testnet account that holds the policy contract. |
| `NEAR_AGENT_KEY` | Function Call Key secret, scoped to `try_pay`. |
| `POLICY_CONTRACT_ID` | Contract account. |
| `NEAR_AI_CLOUD_API_KEY` | NEAR AI Cloud key. |
| `NEAR_AI_CLOUD_BASE_URL` | Gateway base; default `https://cloud-api.near.ai`. |
| `NEAR_AI_CLOUD_MODEL` | Confidential-tier model id. |
| `INTENTS_API_URL` | Optional 1-Click quote endpoint. Empty by default. |
| `INTENTS_ASSET_USDC_TESTNET` | Asset id used for a quote. Empty by default. |
| `DAILY_CAP_USDC` | Demo cap, default `10`. |
| `WHITELIST_RECIPIENT` | Demo recipient, default `alice.testnet`. |

Mode is inferred from what is present. Live policy needs `NEAR_ACCOUNT_ID`,
`NEAR_AGENT_KEY` and `POLICY_CONTRACT_ID`; real TEE needs the API key and model. Anything
missing switches that step to its labelled fallback.

### Live testnet setup

1. Create a testnet account; the agent never creates or invents one.
2. Put its full-access key in `.keys/deployer.json` as
   `{"accountId":"you.testnet","secretKey":"ed25519:..."}`. The file is gitignored and
   read only by `contract:deploy` and `demo:reset`.
3. Generate a Function Call Key and put the secret in `NEAR_AGENT_KEY`.
4. Fill the account, contract and NEAR AI Cloud values in `.env`.
5. Run:

```sh
npm run contract:deploy
npm run verify:key
npm run demo:success
npm run demo:blocked
npm run demo:denied
npm run demo:reset        # replay the demo: cap 10, whitelist alice, spent 0
```

## Limitations

* Settlement is simulated; the contract authorises but does not move funds.
* Attestation is structurally verified, not DCAP-verified.
* Amounts are whole USDC units (`u32`), not 6-decimal token amounts.
* One owner, no upgrade path, no storage-deposit handling. Not audited, not for mainnet.
* The daily counter follows the chain's UTC clock.
* The agent trusts the model's extracted amount and recipient; it is bounded by the
  whitelist and cap but does not re-parse the invoice to cross-check the model.
* The dashboard is static and cannot trigger payments.
* There is no mainnet code path.

## Submission

Nothing has been posted or submitted. `submission/payload.template.json` and
`npm run submission:check` validate the payload locally without sending it. The
submission API accepts payloads between 2026-11-01T00:00:00Z and
2026-11-14T23:59:00Z. The repository must be public by the deadline, and the demo post
must be published by the team.

Human-only tasks: create the payout NEAR account, confirm project name, lead, e-mail,
team size, tracks, repository URL and the X demo post, then confirm the exact JSON
before any `POST`.

## License

MIT. See [LICENSE](LICENSE).
