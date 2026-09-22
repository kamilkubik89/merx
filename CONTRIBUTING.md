# Contributing to Merx

Thanks for helping build commerce for agents.

- Run `npm run check` before opening a PR. It is exactly what CI runs: typecheck, tests with a coverage gate (≥ 90 % lines) and the catalog lint.
- Keep the core dependency-free. Adapters and providers may add dependencies if they are optional.
- Money is integer minor units, everywhere.
- Spec changes go to `docs/SPEC.md` in the same PR as the code, with a short rationale.
- New protocol adapters: see `docs/ADAPTERS.md`.

Good first issues: catalog importers (Shopify, WooCommerce, Google Merchant XML), a SQLite storage layer, an embedding scorer, more linter rules.
