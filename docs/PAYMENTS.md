# Extensible payments for agentic commerce

Merx separates commerce transports, spending authorization and payment execution. A new payment integration should not require changing the catalog, intent matcher or MCP/A2A/REST adapters.

## Implemented now

- Register multiple `PaymentProvider` implementations at startup.
- Discover configured providers, protocol identifiers, flow types, currencies and destination countries.
- Choose `payment_method` when creating a quote; the selected provider ID is included in its signature.
- Send the provider an order ID, quote ID/hash, amount, currency, destination country and stable idempotency key.
- Preserve an order when payment setup fails. A server-side retry uses the same provider and key; concurrent retries in one engine instance share one attempt.

The only bundled payment provider is an **example bank transfer** with fictional instructions. It does not settle payments. The hosted-checkout factory below is integration scaffolding, not an implemented Stripe, PayPal or other network integration.

## Register providers

```ts
import { MerxEngine, manualTransfer } from "../src/core/engine.ts";
import { hostedCheckoutProvider } from "../examples/payments/custom-provider.ts";

// catalog, privateKeyPem and gateway are supplied by your application.
const checkout = hostedCheckoutProvider({
  id: "my_gateway",
  label: "My hosted checkout",
  protocols: ["my-gateway-checkout/1"],
  currencies: ["EUR"],
  countries: ["SK", "CZ", "DE"],
  createSession: async (request) => {
    // Adapt these arguments to your gateway's official SDK.
    // The gateway MUST honor this idempotency key across retries.
    return gateway.createSession({
      amount: request.total,
      currency: request.currency,
      reference: request.order_id,
      idempotencyKey: request.idempotency_key,
    });
  },
});

const engine = new MerxEngine({
  catalog,
  privateKeyPem,
  payments: [manualTransfer, checkout],
  defaultPaymentMethod: "my_gateway",
});
```

`createMerx` accepts the same engine options. Existing integrations using a single `payment` provider remain supported; do not pass both `payment` and `payments`.

`currencies` and `countries` are optional allowlists. Omitting them advertises unrestricted support; an empty list supports none. Country means shipping destination, not payment-instrument issuing country. The default provider must support the selected destination/currency; Merx rejects an unsupported selection rather than silently switching providers.

## Agent flow

1. Read `GET /v1/payment-methods?currency=EUR&country=SK` or call the `payment_methods` operation over MCP/A2A.
2. Include the selected ID as `payment_method` in `create_quote`.
3. Verify the quote signature and authorize the order using the existing Merx mandate.
4. Place the order. Follow provider-specific payment instructions only after checking the merchant, amount and destination.

The manifest retains the original `payment_methods` ID array and adds detailed `payment_handlers`. Returned instructions are defined by the trusted provider adapter; core code does not interpret arbitrary payment URLs or execute an agent-supplied provider.

## Extension map — not bundled support

| Integration family | Where it belongs | Additional work required |
|---|---|---|
| Hosted checkout / PSP SDK (for example Stripe, Adyen, GoPay or PayPal) | `PaymentProvider` or the hosted-checkout factory | Credentials, exact API mapping, idempotency, verified webhooks, reconciliation and refunds |
| Bank transfer / local rails | `PaymentProvider` | Real account instructions, unique references and settlement reconciliation |
| Wallet / on-chain payment | `PaymentProvider` | Network and asset validation, explicit minor-unit conversion, finality and duplicate-payment handling |
| x402 | Protocol adapter plus `PaymentProvider` | Payment-required challenge, proof verification and settlement with the appropriate facilitator |
| UCP payment handlers | Commerce adapter plus provider mapping | UCP handler schemas and exact version negotiation |
| AP2 | Authorization adapter plus provider mapping | AP2 credential, mandate, checkout binding and receipt verification; the Merx mandate is not AP2 |
| ACP | Commerce/checkout adapter plus provider mapping | Checkout lifecycle and payment-token handling per its specification |

Provider IDs and protocol labels are open strings so integrations are not limited to a hard-coded vendor list. A label is a declaration, not proof of compliance.

## Failure and safety boundaries

The order moves through `payment_pending` to `awaiting_payment`, or to `payment_setup_failed`. Provider exception text is not returned to buyers. A failed setup retains the order, stock deduction and consumed mandate; do not create a second order to retry it. A trusted backend can call `engine.retryPayment(orderId)`.

Retries are safe only if the provider honors the supplied idempotency key. The in-memory registry is not durable recovery, a distributed lock or exactly-once settlement. Do not automatically fail over to a different provider after a timeout: the original session may already exist. Provider SDK timeouts and durable storage are deployment responsibilities.

The receipt acknowledges order acceptance, **not settlement**. No public endpoint marks an order paid. Verified provider events, persistence, refund/capture flows, authenticated buyer identity, trusted-wallet authorization, rate limits and audit storage are still required before production use. The existing `Merx-Agent-Id` header is identification, not authentication. Never place raw card details, secrets or private wallet keys into catalog data, discovery metadata or returned instructions.

## Reference specifications

- [AP2 specification](https://ap2-protocol.org/ap2/specification/): authorization and payment mandates.
- [UCP](https://ucp.dev/): commerce interoperability and payment handlers.
- [x402](https://www.x402.org/): payment over HTTP.
- [Agentic Commerce Protocol](https://www.agenticcommerce.dev/): checkout interoperability.

These protocols serve different layers. Review their current specifications and official SDKs when writing an adapter.
