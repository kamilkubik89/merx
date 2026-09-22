# Merx launch kit

Ready-to-edit drafts for the maintainer. These have not been posted. Share where project showcases are welcome, disclose your involvement and respond to technical feedback. Use the current README and release notes as the source of truth.

## Short description

Merx is an open-source TypeScript store engine for AI agents: signed product feeds, intent matching, policy-based negotiation and mandate-bound orders over MCP, A2A and REST.

## Short social post

What would a store look like if its customers were AI agents?

I built Merx: structured product facts, explainable matching, policy-based negotiation and signed purchase receipts. MCP, A2A and REST adapters are included. The demo runs locally with Node.js, without API keys or a model subscription.

It is an early reference implementation with in-memory storage. I would love feedback from people building commerce agents and protocol adapters.

Try it: https://github.com/kamilkubik89/merx

## Technical community / Show HN draft

Title: Show HN: Merx – a store engine for AI agents, with signed feeds and receipts

I built Merx to explore the merchant side of agent commerce. Instead of a storefront, it exposes structured facts, constraints, negotiation rules and a mandate-bound checkout flow.

The included buyer demo discovers a coffee store, verifies its feed, finds products, negotiates a grinder, obtains a quote and submits an order with a signed spending mandate. It then verifies the receipt and demonstrates rejection of a reused mandate.

The engine is TypeScript with zero runtime dependencies. MCP, A2A and REST share the same operation definitions. Matching is lexical and negotiation is deterministic; the example buyer is scripted, so you do not need an LLM account to try it.

This is a reference implementation, not a production payment system: state is in memory, the payment provider returns bank-transfer instructions, and wallet identity trust needs deployment-specific work. AP2, ACP, UCP and x402 integrations are roadmap items.

Repository: https://github.com/kamilkubik89/merx

I would particularly appreciate feedback on the catalog format, adapter interface and what an agent needs to verify before placing an order.

## Demo recording outline

1. Show the README and run `npm run demo`.
2. Highlight feed signature verification and the reasons for product matches.
3. Show the negotiation and the quote total.
4. Highlight the verified receipt and rejected mandate replay.
5. Finish with the repository URL and invite people to try their own catalog.

Record the actual command output. Do not present the scripted buyer as an autonomous LLM or the sample payment instructions as a settled payment.

## Distribution checklist

- Record a short demo and share it from your own accounts.
- Post the technical write-up to one relevant community at a time; follow its showcase rules.
- Ask for specific feedback instead of sending unsolicited requests for stars.
- Respond to reproducible bugs and onboarding questions; turn useful feedback into scoped issues.
- Submit to relevant directories only after checking their current inclusion criteria.
- Review GitHub traffic and referring sites after the launch. Compare visits, clones, useful feedback and contributions as well as stars.

## Sharing assets

- [Repository banner](assets/banner.svg)
- [Social preview PNG, 1280 x 640](assets/social-preview.png) — upload under repository Settings > General > Social preview.
- [Project overview](OVERVIEW.md)
- [Latest release](https://github.com/kamilkubik89/merx/releases/latest)
- [First contributions](../CONTRIBUTING.md#first-contributions)
