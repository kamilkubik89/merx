# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-21

### Added
- **Payment state machine** on `order.payment.status` (`unpaid`, `requires_action`, `payment_pending`, `paid`, `payment_failed`, `canceled`, `partially_refunded`, `refunded`, `disputed`), separate from fulfillment, with an enforced transition table.
- **Signed payment confirmation** (`merx-payment-confirmation/1`), issued only after a verified provider event or reconciliation. The receipt keeps its meaning: order accepted, not paid.
- **Optional Stripe Checkout adapter** (`src/payments/stripe.ts`): hosted sessions from server-side totals, provider idempotency keys, `Stripe-Signature` verification over the raw body with timestamp tolerance, livemode and Connect account checks, status lookup, refunds and session expiry. Live keys are refused unless explicitly allowed.
- **Optional GoPay adapter** (`src/payments/gopay.ts`): OAuth2 client credentials, payment creation, notifications verified by server-to-server status lookup, refunds; sandbox by default.
- Optional provider capabilities on `PaymentProvider`: `initiatePayment`, `getPaymentStatus`, `verifyWebhook`, `refund`, `cancelPayment`. Discovery advertises `verifies_settlement` and `capabilities`.
- **Durable storage** abstraction `MerxStore` with `MemoryStore` (default) and `SqliteStore` on built-in `node:sqlite` (versioned migrations, WAL, atomic order commit, unique constraints on order ID, mandate nonce, deal, idempotency key, provider reference and webhook event).
- Payment attempts with retry semantics, reconciliation (`reconcilePayment`, `reconcileOpenPayments`), administrative refunds and order cancellation with stock release.
- Webhook endpoint `/v1/webhooks/payments/:provider` with raw-body routing; replay protection and amount/currency/order checks for every provider.
- Agent operations `payment_status` and `payment_confirmation` over REST, MCP and A2A, protected by a one-time order access token returned by `place_order` (only its hash is stored).
- Admin API `/admin/v1/*` (reconcile, retry, refund, cancel) enabled only with `MERX_ADMIN_TOKEN`.
- Environment configuration for stores and providers, `.env.example`, periodic reconciliation, graceful shutdown.
- Money helpers (ISO 4217 exponents, integer-only validation and formatting).
- Engine events `payment.updated`, `order.paid`, `order.cancelled`, `payment.anomaly`; append-only audit trail.
- `npm run demo:payments`: offline verified-checkout walkthrough. ADR 0001 with state machine, trust boundaries and threat model.

### Changed
- `order.status` is now derived from payment state for compatibility and may also be `refunded`.
- The bundled bank-transfer instructions are explicitly labeled as fictional and unsettled (`demo: true`, `settlement: "not_verified"`).
- Payment provider failures are reported as `503 unavailable` without provider details. New error codes `unauthenticated` (401) and `unavailable` (503).
- MCP and A2A report the implementation version from a single `MERX_RELEASE` constant.

### Security
- Consumed mandate nonces and redeemed deal tokens persist across restarts when a durable store is configured.
- Order payment data is no longer readable by order ID alone through the new payment endpoints; `get_order` verifies a supplied access token and can require it (`requireOrderAccessToken` / `MERX_REQUIRE_ORDER_TOKEN=1`, planned default in 0.4).

### Compatibility
- No breaking API changes. Providers implementing only `createPayment` keep working and are reported as `verifies_settlement: false`. The first payment attempt keeps the 0.2 idempotency key (the order ID).
- `SqliteStore` requires Node.js 22.13+; the rest of Merx still runs on 22.6+.

## [0.2.0] - 2026-09-23

### Added
- Experimental signed Capability Feed with intent-bound packets, fact revisions, cache-aware refresh, evidence summaries and next-action hints over REST, MCP and A2A.
- Multiple payment providers, currency/country discovery, quote-bound provider selection, stable idempotency context and a hosted-checkout adapter factory.
- Server-side payment-setup recovery that retains accepted orders after provider failure and shares concurrent retries.
- English community and future-product-feed articles, integration documentation and a runnable Capability Feed demo.
- Public project website with engine-generated matching examples, FAQ, social metadata, sitemap and GitHub Pages deployment.
- Quick demo walkthrough, repository banner, dev container, first-contribution guide and English launch kit.

### Fixed
- Complete regular-expression escaping in the catalog linter's marketing phrase matcher.

## [0.1.0] - 2026-09-22

### Added
- Merx engine: signed feed with delta sync, intent matching with reasons and rejections, policy-based negotiation with signed deal tokens, quotes with stock holds, mandate-bound orders, signed receipts.
- Agent-readiness linter (`merx lint`).
- Protocol adapters: REST + OpenAPI, MCP (Streamable HTTP), A2A (`message/send`), adapter template.
- Discovery via `/.well-known/merx.json` and `/llms.txt`.
- Example store (Tatra Coffee Roasters) and scripted buyer agent.
- Draft specification `docs/SPEC.md`.

[Unreleased]: https://github.com/kamilkubik89/merx/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kamilkubik89/merx/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kamilkubik89/merx/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kamilkubik89/merx/releases/tag/v0.1.0
