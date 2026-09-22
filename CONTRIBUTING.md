# Contributing to Merx

Thanks for helping build commerce for agents.

- Run `npm run check` before opening a PR. It is exactly what CI runs: typecheck, tests with a coverage gate (≥ 90 % lines) and the catalog lint.
- Keep the core dependency-free. Adapters and providers may add dependencies if they are optional.
- Money is integer minor units, everywhere.
- Spec changes go to `docs/SPEC.md` in the same PR as the code, with a short rationale.
- New protocol adapters: see `docs/ADAPTERS.md`.

## First contributions

Choose a small improvement with a clear result. Ask in [Discussions](https://github.com/kamilkubik89/merx/discussions) before starting a larger change.

| Area | Suggested contribution | Done when |
|---|---|---|
| Documentation | Add a tested PowerShell REST request example | Commands work against `npm start`, with the expected response explained |
| Catalogs | Add a second fictional example store | Catalog lint passes the existing threshold and no real personal data is included |
| Tests | Cover an untested catalog validation edge case | A focused test demonstrates the intended result without network access |
| Adapters | Document a mapping for a proposed protocol | The proposal links its specification and identifies supported operations and gaps |

Persistence, payment integrations and identity verification need design discussion and are larger projects.

## Development workflow

1. Fork the repository and create a branch for one change.
2. Use Node.js 22.6 or later, then run `npm ci` and `npm run demo`.
3. Make the change and run `npm run check`.
4. Open a pull request explaining the problem, the resulting behavior and how you checked it.

The repository includes a dev container for GitHub Codespaces and compatible local editors. Documentation, comments, examples and contribution discussions should be in English.
