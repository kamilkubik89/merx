# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/kamilkubik89/merx/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kamilkubik89/merx/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kamilkubik89/merx/releases/tag/v0.1.0
