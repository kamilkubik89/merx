import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MerxEngine } from "../src/core/engine.ts";
import { canonicalize, generateKeys, loadKeyPair, sha256, signObject, verifyObject } from "../src/core/crypto.ts";
import { PaymentRegistry, manualTransfer } from "../src/core/payments.ts";
import type { PaymentProvider, PaymentRequest } from "../src/core/payments.ts";
import type { Catalog, MandatePayload } from "../src/core/types.ts";

const catalog: Catalog = JSON.parse(readFileSync(new URL("../examples/stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
const engine = (payments?: PaymentProvider[]) => new MerxEngine({ catalog, privateKeyPem: generateKeys().privatePem, ...(payments ? { payments } : {}) });
const request = { intent: { need: "coffee for espresso", constraints: { category: ["beans"], ship_to: "SK" } } };
const buyer = { name: "Example Buyer", email: "buyer@example.com", address: { line1: "1 Main Street", city: "Kosice", postal_code: "04001", country: "SK" } };
const authorize = () => {
  const keys = loadKeyPair(generateKeys().privatePem);
  const payload: MandatePayload = { v: 1, principal_key: keys.publicKeyB64, agent_id: "buyer", max_total: { amount: 10000, currency: "EUR" }, merchants: ["tatra-coffee"], expires_at: new Date(Date.now() + 60000).toISOString(), nonce: randomUUID() };
  return { payload, signature: signObject(payload, keys).value };
};

test("capability packet verifies, binds the request and separates cached facts from fresh availability", () => {
  const e = engine();
  const first = e.discover(request);
  const { signature, ...payload } = first;
  assert.ok(verifyObject(payload, signature.value, e.keys.publicKey));
  assert.equal(first.request_hash, sha256(canonicalize(request)));
  assert.ok(!verifyObject({ ...payload, merchant: { id: "other", name: "Other" } }, signature.value, e.keys.publicKey));
  assert.ok(!JSON.stringify(first).includes("floor_price"));
  const card = first.cards[0];
  assert.ok(card.facts);
  assert.equal(card.evidence.verification, "references_only_not_independently_verified");
  assert.equal(card.offer.binding, "indicative_requires_quote");
  e.createQuote({ lines: [{ item_id: card.item_id, quantity: 1 }], ship_to: "SK" });
  const next = e.discover({ ...request, known_facts: { [card.item_id]: card.facts_revision } });
  assert.equal(next.cards[0].facts, undefined);
  assert.equal(next.cards[0].facts_revision, card.facts_revision);
  assert.equal(next.cards[0].offer.availability.quantity, card.offer.availability.quantity - 1);
  const quoteArgs = next.cards[0].actions[0].arguments;
  assert.ok("ship_to" in quoteArgs);
  assert.equal(quoteArgs.ship_to, "SK");
  assert.notEqual(next.request_hash, first.request_hash);
});

test("capability packet reports missing context, absent evidence, non-negotiable items and empty results", () => {
  const e = engine();
  const mug = e.discover({ intent: { need: "mug", quantity: 2 } }).cards[0];
  assert.ok(mug.missing_context.includes("ship_to_required_for_shipping_total"));
  assert.ok(mug.evidence.unverified_claims.includes("dishwasher_safe"));
  assert.equal(mug.actions.length, 1);
  const mugArgs = mug.actions[0].arguments;
  assert.ok("lines" in mugArgs);
  assert.equal(mugArgs.lines[0].quantity, 2);
  const budget = e.discover({ intent: { need: "grinder", constraints: { category: ["grinders"], max_unit_price: 8000 } } });
  assert.equal(budget.cards.length, 0);
  assert.ok(budget.rejected.some((r) => r.reasons.some((reason) => reason.includes("negotiable"))));
  const restricted: PaymentProvider = { id: "usd", descriptor: { label: "USD only", flow: "custom", protocols: [], currencies: ["USD"] }, createPayment: async () => ({}) };
  assert.ok(engine([restricted]).discover(request).cards[0].missing_context.includes("no_configured_payment_method_for_context"));
  const unknown = e.discover({ ...request, known_facts: { [e.discover(request).cards[0].item_id]: "0".repeat(64) } });
  assert.ok(unknown.cards[0].facts);
});

test("capability requests reject invalid or unbounded inputs", () => {
  const e = engine();
  for (const invalid of [null, {}, { intent: { need: "" } }, { intent: { need: "x".repeat(2001) } }, { intent: { need: "coffee", limit: 0 } }, { intent: { need: "coffee", quantity: -1 } }, { intent: { need: "coffee", constraints: null } }, { intent: { need: "coffee", constraints: { max_unit_price: -1 } } }, { intent: { need: "coffee", constraints: { currency: 1 } } }, { intent: { need: "coffee", constraints: { category: "beans" } } }, { intent: { need: "coffee", constraints: { attributes: [{}] } } }, { ...request, known_facts: { item: "bad" } }]) {
    assert.throws(() => e.discover(invalid as any), /invalid capability request/);
  }
});

test("provider registry rejects invalid configurations and filters capabilities without sharing arrays", () => {
  const usd: PaymentProvider = { id: "wallet", descriptor: { label: "Wallet", flow: "wallet", protocols: ["example-wallet/1"], currencies: ["USD"], countries: ["US"] }, createPayment: async () => ({}) };
  assert.throws(() => new PaymentRegistry([]));
  assert.throws(() => new PaymentRegistry([usd, usd]));
  assert.throws(() => new PaymentRegistry([{ ...usd, id: "bad/id" }]));
  assert.throws(() => new PaymentRegistry([usd], "missing"));
  assert.throws(() => new MerxEngine({ catalog, privateKeyPem: generateKeys().privatePem, payment: usd, payments: [usd] }));
  const registry = new PaymentRegistry([manualTransfer, usd]);
  assert.deepEqual(registry.list({ currency: "EUR" }).map((p) => p.id), ["bank_transfer"]);
  assert.equal(registry.list({ country: "SK" }).length, 1);
  registry.list()[1].protocols.push("mutated");
  assert.deepEqual(registry.list()[1].protocols, ["example-wallet/1"]);
  assert.throws(() => registry.select("wallet", { currency: "USD", country: "SK" }));
  assert.equal(registry.select("wallet", { currency: "USD", country: "US" }).id, "wallet");
  assert.equal(new PaymentRegistry([{ id: "legacy", createPayment: async () => ({}) }]).list()[0].flow, "custom");
});

test("selected provider is quote-bound and receives amount, hash and stable idempotency context", async () => {
  let received: PaymentRequest | undefined;
  const provider: PaymentProvider = { id: "example_redirect", descriptor: { label: "Example", flow: "redirect", protocols: ["example/1"], currencies: ["EUR"], countries: ["SK"] }, createPayment: async (context) => { received = context; return { checkout_url: "https://payments.example/session" }; } };
  const e = engine([manualTransfer, provider]);
  const q = e.createQuote({ lines: [{ item_id: "filters-v60-02-100", quantity: 1 }], ship_to: "SK", payment_method: provider.id });
  const { signature, ...quoteBody } = q;
  assert.ok(verifyObject(quoteBody, signature!.value, e.keys.publicKey));
  assert.ok(!verifyObject({ ...quoteBody, payment_method: "bank_transfer" }, signature!.value, e.keys.publicKey));
  const order = await e.placeOrder({ quote_id: q.quote_id, mandate: authorize(), buyer, agent_id: "buyer" });
  assert.equal(order.payment.method, provider.id);
  assert.equal(order.status, "awaiting_payment");
  assert.equal(received!.idempotency_key, order.order_id);
  assert.equal(received!.quote_hash, sha256(canonicalize(q)));
  assert.equal(received!.total, q.total);
  assert.deepEqual(e.manifest("http://example").payment_methods, ["bank_transfer", provider.id]);
  assert.deepEqual(e.feed().policies.payment_methods, ["bank_transfer", provider.id]);
  assert.throws(() => e.createQuote({ lines: [{ item_id: "filters-v60-02-100", quantity: 1 }], ship_to: "SK", payment_method: "unknown" }));
  assert.equal(await e.retryPayment(order.order_id), order);
});

test("provider failure preserves order and concurrent retries reuse a single idempotency key", async () => {
  const calls: PaymentRequest[] = [];
  const provider: PaymentProvider = { id: "flaky", createPayment: async (context) => { calls.push(context); if (calls.length === 1) throw new Error("secret provider token"); return { reference: "session-1" }; } };
  const e = engine([provider]);
  const item = "filters-v60-02-100";
  const originalStock = e.getItem(item).offer.availability.quantity;
  const q = e.createQuote({ lines: [{ item_id: item, quantity: 1 }], ship_to: "SK" });
  const signedMandate = authorize();
  const order = await e.placeOrder({ quote_id: q.quote_id, mandate: signedMandate, buyer, agent_id: "buyer" });
  assert.equal(order.status, "payment_setup_failed");
  assert.equal(e.getOrder(order.order_id), order);
  assert.ok(!JSON.stringify(order).includes("secret provider token"));
  assert.equal(e.getItem(item).offer.availability.quantity, originalStock - 1);
  await assert.rejects(e.placeOrder({ quote_id: q.quote_id, mandate: signedMandate, buyer, agent_id: "buyer" }), /already used/);
  await Promise.all([e.retryPayment(order.order_id), e.retryPayment(order.order_id)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotency_key, calls[1].idempotency_key);
  assert.equal(order.status, "awaiting_payment");
  assert.equal(order.payment.error, undefined);
  assert.equal(e.getItem(item).offer.availability.quantity, originalStock - 1);
});
