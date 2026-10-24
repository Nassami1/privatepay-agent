# Submission payload — preparation only

Nothing here sends anything. The submission API only accepts requests between
**2026-11-01T00:00:00Z** and **2026-11-14T23:59:00Z**, and only the human can confirm the
final values.

## Steps

1. Copy `payload.template.json` to `payload.json` (gitignored).
2. Fill only values the human has confirmed. Do not invent a project name, e-mail,
   NEAR account or demo URL.
3. Validate locally:

   ```sh
   npm run submission:check
   ```

   This prints the exact JSON, its byte size, and every field-level error. It performs no
   network request.
4. Show the JSON to the human. Only after an explicit "yes" and inside the window may it
   be POSTed to `https://nearhackathon.com/api/applications` with the same `requestId`.

## Rules the checker enforces

* `requestId` is a UUID v4 and stays stable across retries.
* `projectName` 2–80 chars, `leadName` 2–80, `email` ≤ 160 and valid.
* `size` is exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`.
* `tracks` are from the allowed list, no duplicates.
* `nearAddress` is lowercase and matches the organiser regex (mainnet payout account).
* `projectUrl` and `demoUrl` are http(s) URLs ≤ 300 chars.
* `idea` is 20–2000 chars.
* `consent` is `true` only after the verbatim contact notice was read.
* No extra fields; `website` is a spam trap and is rejected outright.
* The body stays under 12000 bytes.
