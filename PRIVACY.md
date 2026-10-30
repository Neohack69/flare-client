# Privacy — Flare desktop client

This document describes the data handled by the **desktop client** distributed
from this repository. The hosted Flare service has its own privacy policy on
[flyflare.ru](https://flyflare.ru).

## What the client sends

- **Flight data.** Recorded telemetry is processed locally into flight
  aggregates (timestamps, airport/aircraft identifiers, landing parameters,
  scoring inputs). Aggregates are uploaded to the pilot's Flare account on
  `api.flyflare.ru` so the flight appears in the journal, debrief, leaderboards
  and on other devices.
- **Account and device identity.** A device pairing/authorization token and a
  device identifier are stored locally (encrypted with the OS keystore via
  Electron `safeStorage`) and sent to the API to bind the device to the account.
- **Error reports (opt-in, off by default).** If the pilot enables error
  reporting in the client settings, sanitized diagnostics (error message,
  stack trace with tokens/URLs redacted, app version, OS version) may be sent
  to the configured error-reporting endpoint. This can be disabled at any time.

## What the client does not do

- It does **not** send raw telemetry streams continuously; uploads are flight
  aggregates.
- It does **not** contain or use LLM/AI provider keys. AI debriefs are produced
  by the server from server-built aggregates.
- It does **not** process payments and never sees card data. Payments are made
  on the payment provider's own page (YooKassa) outside the client.
- It does **not** include third-party analytics SDKs, advertising SDKs or
  crash-reporting SDKs that run without consent.

## Read-only guarantee

The client and agent only read simulator data (SimConnect / X-Plane Web API).
They never write simulator variables, never pause or change the simulator and
never interfere with an active flight.

## Storage and deletion

Local data (settings, tokens, buffered flights) lives in the per-user
application data directory and can be removed by uninstalling the client. To
delete account data held by the service, contact **support@flyflare.ru**.

## Contact

Privacy questions: **support@flyflare.ru**
