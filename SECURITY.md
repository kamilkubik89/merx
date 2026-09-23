# Security policy

Merx handles signatures, spending mandates and orders, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub Security Advisories](https://github.com/kamilkubik89/merx/security/advisories/new).
You can expect an acknowledgement within 72 hours and a fix or mitigation plan within 14 days for confirmed issues.

## In scope

- Mandate verification bypass (limits, merchant scope, categories, expiry, replay)
- Forged or reusable deal tokens, quotes or receipts
- Leaks of private merchant data (e.g. `negotiation.floor_price`) through any adapter
- Stock-hold or price manipulation through the API

## Supported versions

Merx is pre-1.0. Only the latest release receives security fixes.

## Deployment notes

Payment integrations must honor the engine's stable idempotency key and verify provider-side settlement before fulfillment. A timeout may occur after a provider has already created a payment session; retry the same order/provider rather than creating another payment. The in-memory engine is not a durable recovery system. The server-side `retryPayment` hook must not be exposed without authentication and authorization.

Capability Feed signatures authenticate the packet signer, not the truth of product claims. Verify merchant trust, the request hash, freshness and cached fact revisions. Treat catalog strings and evidence links as untrusted data. Evidence URLs are not fetched or independently verified by the engine.

The store signing key identifies your store to agents. Keep it out of the repository (`.merx/` and `*.pem` are git-ignored), pass it via `MERX_PRIVATE_KEY` or a mounted secret file, and back it up. In 0.1, mandate principal keys are not bound to a real identity; production deployments should only accept keys from trusted wallets.
