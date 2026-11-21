/**
 * Verified payment flow with the Stripe Checkout adapter — fully offline.
 * Run:  npm run demo:payments
 *
 * The Stripe API is replaced by a tiny local stand-in, and the webhook is
 * signed with a local test secret, so this needs no account, key or network.
 * To use real Stripe test mode instead, start the server with STRIPE_SECRET_KEY
 * and STRIPE_WEBHOOK_SECRET (see docs/PAYMENTS.md).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createMerx } from "../../src/server.ts";
import { generateKeys, loadKeyPair, publicKeyFromB64, signObject, verifyObject } from "../../src/core/crypto.ts";
import { stripeCheckout, signStripePayload } from "../../src/payments/stripe.ts";
import type { FetchLike } from "../../src/payments/http.ts";

const WEBHOOK_SECRET = "whsec_local_demo_only";
const AGENT = "demo-payments-agent/1.0";

// --- a minimal stand-in for the two Stripe endpoints used here -------------
const sessions = new Map<string, any>();
const stripeApi: FetchLike = async (url, init = {}) => {
  const path = new URL(url).pathname;
  const form = new URLSearchParams(init.body ?? "");
  let body: unknown;
  if (init.method === "POST" && path === "/v1/checkout/sessions") {
    const id = `cs_test_${randomUUID().replace(/-/g, "")}`;
    body = { id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid", livemode: false, amount_total: Number(form.get("line_items[0][price_data][unit_amount]")), currency: form.get("line_items[0][price_data][currency]"), client_reference_id: form.get("client_reference_id"), metadata: { merx_order_id: form.get("metadata[merx_order_id]") } };
    sessions.set(id, body);
  } else {
    body = sessions.get(path.split("/").pop()!);
  }
  return { ok: !!body, status: body ? 200 : 404, json: async () => body };
};

const catalog = JSON.parse(readFileSync(new URL("../stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
const { server } = createMerx({
  catalog,
  privateKeyPem: generateKeys().privatePem,
  payments: [stripeCheckout({ secretKey: "sk_test_localdemo", webhookSecret: WEBHOOK_SECRET, successUrl: "https://shop.example/return?session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://shop.example/cancel", fetch: stripeApi })],
});
await new Promise<void>((r) => server.listen(0, r));
const BASE = `http://localhost:${(server.address() as any).port}`;
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "merx-agent-id": AGENT, ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const json = await res.json() as any;
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
};
const step = (n: number, s: string) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);

try {
  step(1, "Discover payment methods");
  const methods = await call("GET", "/v1/payment-methods?currency=EUR&country=SK");
  for (const m of methods) console.log(`   ${m.id} — verifies settlement: ${m.verifies_settlement}, capabilities: ${m.capabilities.join(", ") || "none"}`);

  step(2, "Quote with Stripe Checkout and place the order under a signed mandate");
  const quote = await call("POST", "/v1/quotes", { ship_to: "SK", lines: [{ item_id: "beans-ethiopia-guji-250", quantity: 2 }], payment_method: "stripe_checkout" });
  const wallet = loadKeyPair(generateKeys().privatePem);
  const payload = { v: 1 as const, principal_key: wallet.publicKeyB64, agent_id: AGENT, max_total: { amount: 10000, currency: "EUR" }, merchants: ["tatra-coffee"], expires_at: new Date(Date.now() + 3600_000).toISOString(), nonce: randomUUID() };
  const order = await call("POST", "/v1/orders", { quote_id: quote.quote_id, mandate: { payload, signature: signObject(payload, wallet).value }, buyer: { name: "Jane Smith", email: "jane@example.sk", address: { line1: "1 Main Street", city: "Kosice", postal_code: "04001", country: "SK" } } });
  console.log(`   ${order.order_id}: receipt signed (order accepted), payment ${order.payment.status}`);
  const token = { "merx-order-token": order.access_token };

  step(3, "The agent hands the hosted checkout to the human");
  const s1 = await call("GET", `/v1/orders/${order.order_id}/payment`, undefined, token);
  console.log(`   next action: ${s1.next_action.type} → ${s1.next_action.url}`);

  step(4, "A forged webhook is rejected");
  const session = { ...sessions.get(order.payment.provider_payment_id), status: "complete", payment_status: "paid" };
  const event = JSON.stringify({ id: `evt_${randomUUID().replace(/-/g, "")}`, object: "event", type: "checkout.session.completed", livemode: false, data: { object: session } });
  const forged = await fetch(`${BASE}/v1/webhooks/payments/stripe_checkout`, { method: "POST", headers: { "stripe-signature": signStripePayload(event, "whsec_attacker", Math.floor(Date.now() / 1000)) }, body: event });
  console.log(`   HTTP ${forged.status}; payment still ${(await call("GET", `/v1/orders/${order.order_id}/payment`, undefined, token)).payment.status}`);

  step(5, "The human pays; Stripe's signed webhook arrives");
  const ok = await fetch(`${BASE}/v1/webhooks/payments/stripe_checkout`, { method: "POST", headers: { "stripe-signature": signStripePayload(event, WEBHOOK_SECRET, Math.floor(Date.now() / 1000)) }, body: event });
  const dup = await fetch(`${BASE}/v1/webhooks/payments/stripe_checkout`, { method: "POST", headers: { "stripe-signature": signStripePayload(event, WEBHOOK_SECRET, Math.floor(Date.now() / 1000)) }, body: event });
  console.log(`   HTTP ${ok.status} ${JSON.stringify(await ok.json())}; replay → ${JSON.stringify(await dup.json())}`);

  step(6, "Payment status and signed confirmation");
  const s2 = await call("GET", `/v1/orders/${order.order_id}/payment`, undefined, token);
  const conf = await call("GET", `/v1/orders/${order.order_id}/payment/confirmation`, undefined, token);
  const manifest = await call("GET", "/.well-known/merx.json");
  const valid = verifyObject(conf.payload, conf.signature.value, publicKeyFromB64(manifest.public_key.spki_der_b64));
  console.log(`   payment ${s2.payment.status}; ${conf.payload.typ} for ${conf.payload.amount.amount} ${conf.payload.amount.currency}, verified by ${conf.payload.verified_by}, signature valid: ${valid}`);
  console.log("\nDone. No network, no keys, no money moved.\n");
} finally {
  server.close();
}
