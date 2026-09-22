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

The store signing key identifies your store to agents. Keep it out of the repository (`.merx/` and `*.pem` are git-ignored), pass it via `MERX_PRIVATE_KEY` or a mounted secret file, and back it up. In 0.1, mandate principal keys are not bound to a real identity; production deployments should only accept keys from trusted wallets.
