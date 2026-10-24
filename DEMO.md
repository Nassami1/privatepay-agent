# 90-second demo — shot list

Recorded by the human, posted on X with the line that the project was built at
NEAR HACKATHON. This file is the plan; the video itself is not committed.

## Before recording

```sh
npm install
npm run build
npm run demo:reset        # live mode only; owner key required
npm run dev               # leave running at http://127.0.0.1:4173
```

Open a terminal at 18–20 pt with a dark background and the repository root as the
working directory. Open the dashboard in a browser at 1440 px wide. It polls every five
seconds, so it will update during recording without a manual reload.

## Timeline

| Time | On screen | Say (or caption) |
| --- | --- | --- |
| 0:00–0:08 | The dashboard, policy card | "An AI agent that pays invoices. It has a 10 USDC daily cap and one whitelisted recipient — enforced by a contract, not by a prompt." |
| 0:08–0:18 | `npm run demo:success` | "This invoice contains a name, an e-mail, an IBAN, a phone number and an address." |
| 0:18–0:35 | `[tee] model=z-ai/glm-5.3-flash attestation=OK` | "Only the redacted text went to the Confidential TEE model. The report is bound to a fresh nonce; seven structural checks pass; the full report is archived and linked to NEAR AI's verifier." |
| 0:35–0:45 | `[pay] … -> SUCCESS` and `chain_tx` | "The contract authorised 3 USDC. This is the real testnet transaction." |
| 0:45–0:50 | `[settle] mode=SIMULATED` | "Settlement is simulated in this build — NEAR Intents' public service is mainnet-only and this build is testnet-only. The label is on the line, not buried in the README." |
| 0:50–1:05 | `npm run demo:blocked` | "Now a 50 USDC invoice: refused over the cap. And 1 USDC to an unknown account: refused by the whitelist." |
| 1:05–1:15 | `npm run demo:denied` | "The agent tries to raise its own cap. NEAR rejects it before execution: the key cannot call that method." |
| 1:15–1:25 | Dashboard ledger / stamps / chain log | "The dashboard reads the evidence: redaction categories, attestation digest, policy receipts and the on-chain log." |
| 1:25–1:30 | Footer | "Invoice text is never stored. Only references." |

## If recording without credentials

Run the same commands with an empty `.env`. The flow is identical and every simulated
value says `SIMULATED` in the output and on the dashboard. Do not narrate it as a real
TEE call; say plainly that the local fallback is running.

## Do not

* Do not show `.env`, `.keys/` or any terminal command that echoes a secret.
* Do not show the raw invoice fixture on screen longer than needed; the demo is about
  what does *not* leave the process.
* Do not edit the repository after recording without re-running the demo, so the video
  and the commit match.
