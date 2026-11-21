# Writing a protocol adapter

Merx has no opinion about which agent protocol wins. The engine speaks a small set of operations; adapters translate wire protocols into them. Three ship in the box (REST, MCP, A2A). Anything else is one file.

## The interface

```ts
export interface Adapter {
  name: string;
  describe(baseUrl: string): { protocol: string; endpoint: string; notes?: string };
  mount(router: Router, engine: MerxEngine): void;
}
```

`describe` is published in `/.well-known/merx.json`, so agents know which protocols this store speaks. `mount` registers routes on the built-in router.

## Operations

Operations are defined once in `src/adapters/operations.ts` with a name, description, JSON Schema input and a `run(engine, args, agentId)` function:

`store_info`, `find_products`, `discover_offers`, `payment_methods`, `get_product`, `negotiate`, `create_quote`, `place_order`, `get_order`, `payment_status`, `payment_confirmation`.

`discover_offers` returns the experimental [Capability Feed](CAPABILITY_FEED.md). `payment_status` and `payment_confirmation` require the order `access_token` returned once by `place_order`; pass it through as an argument and never log it.

The simplest adapter maps a protocol message to an operation name and input, calls `run`, and maps the result back. The MCP adapter is about 60 lines; read it as a reference.

## Steps

1. Copy `src/adapters/_template.ts` to `src/adapters/<protocol>.ts`.
2. Implement `mount`: parse the protocol's request, call `findOp(name).run(engine, input, agentId)`.
3. Catch `MerxError` and map `code` (`invalid`, `unauthorized`, `unauthenticated`, `not_found`, `conflict`, `expired`, `unavailable`) to the protocol's error model.
4. Register it in `createMerx({ adapters: [...defaultAdapters, myAdapter] })`.
5. Add a test that runs a full purchase through your adapter.

## Payment adapters

Payment providers are a second, independent extension point: a `PaymentProvider` executes payments, while protocol adapters carry agent messages. A payment adapter needs only `createPayment`; implementing `initiatePayment`, `getPaymentStatus`, `verifyWebhook` and `refund` makes settlement verifiable. The engine then handles deduplication, amount checks, the state machine and signed confirmations for you. Reference implementations: [`src/payments/stripe.ts`](../src/payments/stripe.ts) and [`src/payments/gopay.ts`](../src/payments/gopay.ts); guide: [PAYMENTS.md](PAYMENTS.md#writing-a-payment-adapter).

Community payment adapters are welcome. Keep them dependency-free or isolate optional SDKs outside core, test them against mocked HTTP, and use vendor-neutral wording: an adapter is not an endorsement or a compliance claim.

## Storage adapters

`MerxStore` (`src/core/storage.ts`) persists orders, consumed nonces, redeemed deals, stock deductions, payment attempts and webhook events. Its methods may be sync or async. `commitOrder` and `cancelOrder` must be atomic, and the uniqueness rules on each method are mandatory: the engine relies on them across instances. Bundled: `MemoryStore`, `SqliteStore`. A PostgreSQL store is a wanted contribution.

## Wanted adapters

- **UCP**: serve `/.well-known/ucp`, map catalog search and checkout sessions onto `find_products` / `create_quote` / `place_order`.
- **ACP**: checkout session endpoints and delegated payment tokens as a `PaymentProvider`.
- **AP2**: accept AP2 mandates alongside `merx-mandate/1`, with conformance test vectors. The existing Merx mandate must not be described as AP2-compliant.
- **x402**: per-request pricing for premium operations (e.g. real-time price feeds) paid by the agent.

When implementing an external spec, link the exact version you followed in the file header and in `describe().protocol`.
