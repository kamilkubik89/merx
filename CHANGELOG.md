# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-22

### Added
- Merx engine: signed feed with delta sync, intent matching with reasons and rejections, policy-based negotiation with signed deal tokens, quotes with stock holds, mandate-bound orders, signed receipts.
- Agent-readiness linter (`merx lint`).
- Protocol adapters: REST + OpenAPI, MCP (Streamable HTTP), A2A (`message/send`), adapter template.
- Discovery via `/.well-known/merx.json` and `/llms.txt`.
- Example store (Tatra Coffee Roasters) and scripted buyer agent.
- Draft specification `docs/SPEC.md`.

[Unreleased]: https://github.com/kamilkubik89/merx/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kamilkubik89/merx/releases/tag/v0.1.0
