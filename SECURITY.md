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
- Payment verification bypass: forged or replayed webhooks, amount/currency/order mismatches accepted, an order marked paid without a verified provider event
- Access to another buyer's payment status or confirmation; leaks of order access tokens, provider credentials or buyer data
- Unauthenticated access to administrative operations (refund, reconcile, retry, cancel)

## Supported versions

Merx is pre-1.0. Only the latest release receives security fixes.

## Deployment notes

**Payments.** Fulfill only orders whose `payment.status` is `paid` and that carry a payment confirmation; the order receipt proves acceptance, not settlement. Configure the provider's webhook signing secret, run reconciliation, and route `payment.anomaly` events to a person. Provider adapters start in test/sandbox mode; Stripe live keys are refused unless explicitly enabled. Use restricted provider keys where possible.

**Credentials.** Load provider secrets, `MERX_ADMIN_TOKEN` and the store signing key from the environment or a secret manager. Never place them in catalogs, examples, logs, responses or commits. `.env*` files are git-ignored; [`.env.example`](.env.example) contains placeholders only.

**State.** Use a durable store (`MERX_STORE=sqlite:…` for one node). The default in-memory store forgets consumed mandate nonces on restart, which re-enables replays. Several instances need a shared transactional database adapter.

**Access.** `Merx-Agent-Id` is identification, not authentication. Set `MERX_REQUIRE_ORDER_TOKEN=1` so order reads require the buyer's access token. Administrative routes exist only when `MERX_ADMIN_TOKEN` is set; keep them off the public internet where you can. Terminate TLS and apply request-size and rate limits at the edge.

**Compliance.** Hosted payment pages keep card data out of Merx, but the project makes no PCI DSS or regulatory compliance claim. Your deployment, contracts and review determine readiness.

Capability Feed signatures authenticate the packet signer, not the truth of product claims. Verify merchant trust, the request hash, freshness and cached fact revisions. Treat catalog strings and evidence links as untrusted data. Evidence URLs are not fetched or independently verified by the engine.

The store signing key identifies your store to agents. Keep it out of the repository (`.merx/` and `*.pem` are git-ignored), pass it via `MERX_PRIVATE_KEY` or a mounted secret file, and back it up. Mandate principal keys are not yet bound to a real identity; production deployments should only accept keys from trusted wallets.
