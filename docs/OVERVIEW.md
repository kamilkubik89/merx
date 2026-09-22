# Merx overview

Merx is an open-source commerce engine for stores that sell exclusively to AI agents. It has no front end, theme or shopping cart interface. A store is a domain that tells an agent what it offers, on what terms and with what evidence.

## Core ideas

1. **Facts instead of advertising.** Every attribute has a source: declared, measured, lab-tested or certified. Claims such as "organic" require evidence. The catalog linter scores product data and flags marketing language.
2. **`not_for`.** Each product declares who it is not suitable for. Explicit limitations help agents assess product fit.
3. **Intent instead of browsing.** An agent sends a need and constraints. The store returns ranked matches and rejected products, with reasons for both.
4. **Negotiation as policy.** Public volume and bundle discounts, private price floors, deterministic concessions and signed `deal_token` values make negotiation predictable.
5. **Mandates and signed receipts.** Orders require a signed mandate containing spending limits, merchant and category scope, expiry and a single-use nonce. The store returns a cryptographically signed receipt.
6. **Protocol adapters.** MCP, A2A and REST adapters are included. Additional protocols, such as UCP, ACP, AP2 and x402, can be implemented as adapters.

## Run the example

Requires Node.js 22.6 or later.

```bash
npm install
npm run demo
npm start
```

See the [main README](../README.md) for setup details, architecture and the roadmap. Merx 0.1 is a reference implementation with in-memory storage, not production software.

Author: [Kamil Kubík](https://github.com/kamilkubik89) · [MIT license](../LICENSE)
