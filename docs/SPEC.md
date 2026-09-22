# Merx specification 0.1 (draft)

This document describes what a Merx store exposes to agents, independent of the wire protocol. The reference implementation lives in `src/core`. Key words MUST, SHOULD and MAY are used in the RFC 2119 sense.

## 1. Conventions

Money is always an integer in minor units (`1290` = 12.90 EUR) together with an ISO 4217 currency. Floats MUST NOT be used for money. Countries are ISO 3166-1 alpha-2. Timestamps are ISO 8601 in UTC. Attribute keys are `snake_case`.

Everything Merx signs is serialised with **canonical JSON**: object keys sorted lexicographically, no insignificant whitespace, `undefined` members dropped. Signatures are Ed25519 over the UTF-8 bytes of that serialisation, base64-encoded.

## 2. Discovery

A store MUST serve `GET /.well-known/merx.json`:

```json
{
  "merx": "0.1",
  "store": { "id": "tatra-coffee", "name": "…", "currency": "EUR", "legal": { "company": "…", "country": "SK" } },
  "public_key": { "alg": "Ed25519", "key_id": "ed25519:3b7a…", "spki_der_b64": "MCow…" },
  "capabilities": ["feed", "feed.delta", "intent", "negotiate", "quote.hold", "order.mandate", "receipt.signed"],
  "protocols": [
    { "protocol": "merx-rest/0.1", "endpoint": "https://…/v1" },
    { "protocol": "mcp/2025-06-18", "endpoint": "https://…/mcp" },
    { "protocol": "a2a/0.3", "endpoint": "https://…/a2a" }
  ],
  "lint_score": 82
}
```

Agents SHOULD pin `public_key` per store (trust on first use) and treat a key change as a reason to re-verify. A store SHOULD also serve `/llms.txt` with a plain-language summary of how to buy.

## 3. Feed

`GET /feed` returns the signed catalog. Optional query parameters: `since` (ISO timestamp, returns only items whose `updated_at` is later, for delta sync) and `category`.

Top level: `merx`, `store`, `policies`, `negotiation`, `generated_at`, `ttl_seconds`, `items[]`, `signature`. The signature covers the whole object without the `signature` member.

### 3.1 Item

| Field | Req. | Meaning |
|---|---|---|
| `id` | MUST | Stable store-local id |
| `gtin` | SHOULD | GTIN/EAN, lets agents cross-check elsewhere |
| `group_id` | MAY | Shared by variants |
| `title` | MUST | Factual name incl. key variant (size, weight) |
| `summary` | MUST | ≤ 280 chars, factual, no superlatives |
| `category` | MUST | Path, most general first |
| `attributes[]` | MUST | Structured facts, see 3.2 |
| `claims[]` | MAY | Evidenced statements, see 3.3 |
| `best_for[]` | SHOULD | Uses/needs the product fits |
| `not_for[]` | SHOULD | Uses/needs it does NOT fit |
| `media[]` | MAY | `{type, url, alt}` |
| `offer` | MUST | See 3.4 |
| `content_hash` | MUST | Hash of the item excluding `valid_until`; changes only on real change |
| `updated_at` | MUST | Last real change |

### 3.2 Attributes

`{ key, value, unit?, source, note? }`. `value` is a string, number, boolean or string array. Numeric values SHOULD have a `unit`. `source` is one of:

- `declared`: the merchant says so
- `measured`: measured by the merchant (weight, dimensions)
- `lab_test`: measured by a laboratory
- `certified`: covered by a certification
- `third_party`: supplied by an importer, manufacturer or other party

Agents SHOULD weight facts by source.

### 3.3 Claims

`{ id, statement, evidence? }` where `evidence` is `{ type: certificate | lab_report | audit | self_declared, issuer?, ref?, url? }`. A claim without evidence, or with `self_declared` evidence, MUST NOT satisfy a `must_have_claims` constraint.

### 3.4 Offer

```json
{
  "price": { "amount": 1490, "currency": "EUR" },
  "compare_basis": { "per": "kg", "amount": 5960 },
  "availability": { "in_stock": true, "quantity": 64, "lead_time_days": 1 },
  "negotiable": true,
  "valid_until": "…"
}
```

`quantity` is stock minus active holds. Until `valid_until`, the price in a signed feed is a commitment: a quote created before that time MUST NOT exceed it (volume rules may lower it). Private merchant data (floor prices, supplier cost) MUST NOT appear in the feed.

### 3.5 Policies

```json
{
  "returns": { "window_days": 14, "condition": "…", "refund": "full", "return_shipping_paid_by": "buyer" },
  "shipping": [{ "id": "packeta-sk", "carrier": "Packeta", "regions": ["SK"], "price": 290, "free_over": 3500, "days": [1, 2] }],
  "warranty_months": 24,
  "payment_methods": ["bank_transfer"],
  "tax_included": true
}
```

## 4. Intent

`find_products` input: `{ need, quantity?, limit?, constraints? }`. Constraints: `max_unit_price`, `currency`, `category[]`, `must_have_claims[]`, `attributes[]` (`{key, op: eq|gte|lte|in|contains, value}`), `ship_to`, `deliver_within_days`.

Output: `matches[]` (`item_id, title, score 0..1, unit_price, reasons[], warnings[]`) and `rejected[]` (`item_id, reasons[]`). A store MUST report hard-constraint failures in `rejected` rather than silently omitting items. When a product's `not_for` overlaps the need, the store MUST add a warning.

## 5. Negotiation

Public rules live in `feed.negotiation.public_rules`: `volume {min_qty, discount_pct}` and `bundle {min_distinct_items, discount_pct}`. The store keeps a private floor per negotiable item.

Request: `{ item_id, quantity, proposed_unit_price, session_id? }`. Response: `{ session_id, status: accepted | counter | rejected, unit_price, rounds_left, deal_token?, message }`.

The reference policy: the opening ask is list price minus applicable volume discount. Each round the ask moves toward the proposal by `concession` (default 0.35) and never below the floor. A proposal at or above the ask is accepted at the ask. When rounds are exhausted the store issues a final offer with a `deal_token`.

A `deal_token` is `base64url(canonical payload) "." base64url(signature)` with payload `{ typ: "deal", store, item_id, quantity, unit_price, exp, sid }`. It is single-use and valid only for quantity ≥ `quantity`.

## 6. Quote

`create_quote { lines: [{ item_id, quantity, deal_token? }], ship_to, shipping_method? }` returns a signed quote with lines, shipping, subtotal, total, `expires_at`. Stock for all lines is held until `expires_at`.

## 7. Mandate (`merx-mandate/1`)

```json
{
  "payload": {
    "v": 1,
    "principal_key": "<base64 SPKI DER Ed25519 public key of the human or wallet>",
    "agent_id": "demo-buyer-agent/1.0",
    "max_total": { "amount": 15000, "currency": "EUR" },
    "merchants": ["tatra-coffee"],
    "categories": ["coffee", "equipment"],
    "expires_at": "…",
    "nonce": "uuid"
  },
  "signature": "<Ed25519 over canonical payload, base64>"
}
```

A store MUST reject an order when the signature is invalid, the mandate has expired, `agent_id` differs from the calling agent, the store is not in `merchants` (unless `"*"`), the currency differs, the total exceeds `max_total`, a line's top-level category is not in `categories` (when present), or the nonce was used before.

Binding `principal_key` to a real person (bank, wallet provider, `did`) is outside the scope of 0.1. A production deployment SHOULD accept only keys issued by trusted wallets, for example through an AP2 adapter.

## 8. Order and receipt

`place_order { quote_id, mandate, buyer }` returns the order with `payment` instructions and a receipt:

```json
{
  "payload": {
    "typ": "merx-receipt/1", "order_id": "…", "store_id": "…", "quote_hash": "…",
    "total": { "amount": 11190, "currency": "EUR" },
    "lines": [{ "item_id": "…", "quantity": 1, "unit_price": 3290 }],
    "agent_id": "…", "mandate_nonce": "…", "issued_at": "…"
  },
  "signature": { "alg": "Ed25519", "key_id": "…", "value": "…" }
}
```

Receipts are portable proofs of purchase. A future version will define how agents publish outcome attestations (delivered on time, matched description) referencing a receipt, forming a verifiable reputation layer.

## 9. Errors

Adapters map engine errors to their protocol. REST uses `{ "error": { "code", "message" } }` with codes `invalid` (400), `unauthorized` (403), `not_found` (404), `conflict` (409), `expired` (410).
