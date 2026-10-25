# Demo — shot list

Recorded by the human, posted on X with the line that the project was built at
NEAR HACKATHON. This file is the plan; the video itself is not committed.

The demo now uses a real NEP-141 token: the policy contract calls `ft_transfer`
and the recipient balance changes on testnet. Nothing is labelled simulated in
the live path.

## Before recording

```sh
npm install
npm run build
npm run demo:reset        # owner key required
npm run dev               # leave running at http://127.0.0.1:4173
```

Terminal at 18–20 pt, dark background, repository root. Browser at 1440 px wide.
The dashboard polls every five seconds.

## Timeline

| Time | On screen | Say |
| --- | --- | --- |
| 0:00–0:08 | Dashboard, policy card | "An AI agent that pays invoices. It has a 10 USDC daily cap and one whitelisted recipient, enforced by a contract that holds the tokens." |
| 0:08–0:18 | `npm run demo:success` | "This invoice contains a name, e-mail, IBAN, phone and address." |
| 0:18–0:35 | `[tee] … attestation=OK`, `[sig] provider_tee verified` | "Only the redacted text is sent. The report is bound to a nonce, and the response is signed by the TEE; both are verified before payment." |
| 0:35–0:45 | `[pay] … SUCCESS`, `ft_balance=3.00`, `[ft] policy 999997` | "The contract authorised 3 USDC and called ft_transfer itself. This is the real transaction hash and the recipient's token balance." |
| 0:45–1:00 | `npm run demo:blocked` | "A 50 USDC invoice is refused over the cap. One USDC to an unknown account is refused by the whitelist. No token moves." |
| 1:00–1:10 | `npm run demo:denied` | "The owner tries to call try_pay: the contract refuses. The agent tries to raise the cap: NEAR rejects the key before execution." |
| 1:10–1:20 | Dashboard ledger, evidence, chain log | "The dashboard shows redaction categories, the attestation digest, the response signer, the transaction and the on-chain log." |

## If recording without credentials

The same commands run the local policy mirror and a labelled simulated TEE. Say
plainly that the local fallback is running; do not narrate it as a real TEE call.

## Do not

* Show `.env`, `.keys/` or a command that echoes a secret.
* Show the raw invoice fixture longer than needed; the point is what does not
  leave the process.
* Edit the repository after recording without re-running the demo.
