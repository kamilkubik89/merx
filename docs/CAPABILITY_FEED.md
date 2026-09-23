# Merx Capability Feed: product data that answers a buying decision

**Status: experimental Merx format `merx-capability/0.1`, with a working reference implementation.** This is a proposal for agent-facing discovery, not an established industry standard or a claim to replace existing channels overnight.

## Do agents need product feeds?

Agents need product data: identity, comparable attributes, evidence, availability, price and purchase conditions. A bulk feed is useful for indexing and offline comparison. But an agent deciding what to buy also needs a fresh answer to a particular request.

Changing XML to JSON alone does not solve that problem. XML can represent rich data; the proposed change is the interaction model: **request → decision evidence → fresh quote → authorized order**.

Merx keeps its signed `/feed` snapshot for indexing and adds an intent-specific capability packet for decisions. The two work together.

## The design

| Layer | What it answers | Caching and trust |
|---|---|---|
| Product facts | What is it, what is known, and who supplied the claim? | Stable full SHA-256 revision; reuse previously verified facts |
| Decision | Why does it fit this request, and what conflicts remain? | Signed packet binds the exact request hash, including constraints |
| Offer snapshot | What is the current observed price and available quantity? | Short refresh interval; indicative, not a stock reservation |
| Action | What must the agent provide to negotiate or request a quote? | Named operations and arguments shared by MCP, A2A and REST |
| Commitment | What may actually be purchased on agreed terms? | Separate signed quote, held stock and spending mandate |

A cache hit never means "reuse the old price." Stable facts can be omitted while the packet still returns the current availability and offer. Agents should treat product strings as data, never as instructions to override their own policies.

## Try the implementation

```bash
npm run demo:feed
```

The local example produces a packet, verifies its signature, then repeats the request with known fact hashes. No API key, model or external payment service is needed.

With `npm start` running:

```bash
curl -X POST http://localhost:3000/v1/discover \
  -H 'Content-Type: application/json' \
  -d '{"intent":{"need":"coffee for espresso, low acidity","constraints":{"category":["beans"],"ship_to":"SK"},"limit":2}}'
```

PowerShell:

```powershell
$body = @{ intent = @{ need = "coffee for espresso, low acidity"; constraints = @{ category = @("beans"); ship_to = "SK" }; limit = 2 } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://localhost:3000/v1/discover -Method Post -ContentType application/json -Body $body
```

MCP tool: `discover_offers`. A2A operation: `discover_offers`. Both accept the same request as REST.

## Packet contract

- `request_hash`: SHA-256 of the exact request using Merx canonical JSON. Check it against your original request.
- `generated_at` and `refresh_after`: observation time and suggested refresh deadline. Neither reserves stock nor guarantees price acceptance.
- `cards`: up to `intent.limit` ranked candidates (default 10, maximum 50).
- `facts_revision`: full SHA-256 of the canonical public product facts, excluding volatile offer and timestamps.
- `facts`: omitted only when the caller supplies an identical hash in `known_facts[item_id]`. Keep the verified cached facts under the merchant identity, item ID and revision.
- `decision`: lexical score, reasons and explicit suitability warnings. Scores are not probabilities or certifications.
- `evidence`: claim IDs with references versus unverified/self-declared claims. References are **not independently checked** by Merx.
- `offer`: current observed offer, including availability after active holds. `binding` is `indicative_requires_quote`.
- `missing_context`: missing destination or unavailable configured payment methods.
- `actions`: operation names, suggested arguments and remaining inputs; the agent still decides whether and when to call them.
- `policies` and `policy_revision`: machine-readable conditions and their canonical hash.
- `payment_methods`: configured provider descriptors filtered by destination and store currency.
- `rejected`: reasons for exclusion, capped at 100; `rejections_truncated` reports whether some were omitted.
- `signature`: Ed25519 signature over every top-level field except `signature`, using the existing Merx canonicalization.

For a refresh, repeat the original intent with a `known_facts` object containing the returned hashes. The packet explicitly states that absence is not a deletion. It is a query result, not a full-catalog synchronization protocol.

## Verification sequence

1. Discover the merchant key, establish trust and pin it according to your policy. A key advertised by an unknown merchant is not proof of their identity.
2. Verify the packet signature and exact request hash.
3. Check the timestamp and refresh when stale.
4. Verify new fact hashes; resolve omitted facts only from your own previously verified cache.
5. Evaluate claims and external evidence with your own trust policy. A signature proves who signed a statement, not that the statement is true.
6. Request a fresh quote with destination, quantity and selected payment method. Verify it and obtain authorization before ordering.

## What could come next

These are design directions, **not implemented features**:

- A revision stream with signed cursors, tombstones and cache invalidation for large catalogs.
- Typed compatibility and substitution relationships, so an agent can reason about bundles and replacements.
- Evidence expiration, revocation and independently verifiable attestations.
- Privacy-preserving constraint disclosure and selective proofs instead of sending a complete buyer profile.
- Cross-store identifiers and comparison that preserves the source of every assertion.
- Negotiated service terms, lifecycle cost and post-purchase capabilities such as returns or repair.

## Migration from XML

Keep existing XML exports for channels that require them. Map catalog identity and attributes into Merx, retain original provenance, then add evidence and explicit limitations. Missing facts should remain unknown rather than invented by an LLM. The prototype reads Merx catalog JSON; a general XML importer is not bundled.

This lets merchants add a decision interface alongside existing distribution, rather than forcing every channel to migrate at once.

## Build it with us

We invite catalog engineers, commerce developers, payment integrators and agent builders to challenge the format with real requirements. Start with a fictional, reproducible catalog and a buying constraint that today's packet cannot express. Discuss it in [Merx Discussions](https://github.com/kamilkubik89/merx/discussions) before proposing a schema extension.

## Related work

- [Google Merchant product data specification](https://support.google.com/merchants/answer/7052112): existing channel requirements for product data.
- [UCP](https://ucp.dev/): commerce interoperability.
- [AP2 specification](https://ap2-protocol.org/ap2/specification/): authorization responsibilities, separate from catalog discovery.

The combination here is a Merx design proposal. It builds on structured catalogs, content hashes, signatures and intent matching rather than claiming those underlying ideas are new.
