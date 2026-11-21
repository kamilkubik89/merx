import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMerx } from "../src/server.ts";
import { publicKeyFromB64, verifyObject } from "../src/core/crypto.ts";
import { stripeCheckout, signStripePayload, verifyStripeSignature } from "../src/payments/stripe.ts";
import { WebhookVerificationError } from "../src/core/payments.ts";
import { buyer, catalog, fakeStripe, mandate, storeKey, stripeEvent } from "./helpers.ts";

const WHSEC = "whsec_testsecret";
const ADMIN = "a".repeat(40);
const AGENT = "stripe-agent";
const cfg = (fake: ReturnType<typeof fakeStripe>, over = {}) => ({ secretKey: "sk_test_123", webhookSecret: WHSEC, successUrl: "https://shop.example/ok?s={CHECKOUT_SESSION_ID}", cancelUrl: "https://shop.example/cancel", fetch: fake.fetch, ...over });

describe("Stripe adapter (unit)", () => {
  test("refuses live keys unless explicitly allowed, and validates configuration", () => {
    const fake = fakeStripe();
    assert.throws(() => stripeCheckout(cfg(fake, { secretKey: "sk_live_abc" })), /live key refused/);
    assert.doesNotThrow(() => stripeCheckout(cfg(fake, { secretKey: "sk_live_abc", allowLiveMode: true })));
    assert.throws(() => stripeCheckout(cfg(fake, { secretKey: "pk_test_abc" })), /secret or restricted/);
    assert.throws(() => stripeCheckout(cfg(fake, { webhookSecret: "nope" })), /whsec_/);
    assert.throws(() => stripeCheckout(cfg(fake, { successUrl: "http://shop.example/ok" })), /HTTPS/);
    assert.throws(() => stripeCheckout(cfg(fake, { sessionTtlSeconds: 60 })), /sessionTtlSeconds/);
  });

  test("creates a Checkout Session from server-side amounts with a stable idempotency key", async () => {
    const fake = fakeStripe();
    const p = stripeCheckout(cfg(fake, { apiVersion: "2024-06-20", accountId: "acct_1" }));
    const req = { order_id: "ord_1", total: 4590, currency: "EUR", country: "SK", quote_id: "q_1", quote_hash: "h", idempotency_key: "ord_1" };
    const setup = await p.initiatePayment!(req);
    assert.equal(setup.status, "requires_action");
    assert.match(String(setup.instructions.checkout_url), /^https:\/\/checkout\.stripe\.com\//);
    const call = fake.calls[0];
    assert.equal(call.headers["idempotency-key"], "merx:ord_1");
    assert.equal(call.headers["stripe-version"], "2024-06-20");
    assert.equal(call.headers["stripe-account"], "acct_1");
    assert.equal(call.body.get("line_items[0][price_data][unit_amount]"), "4590");
    assert.equal(call.body.get("line_items[0][price_data][currency]"), "eur");
    assert.equal(call.body.get("metadata[merx_order_id]"), "ord_1");
    assert.equal(call.body.get("success_url"), "https://shop.example/ok?s={CHECKOUT_SESSION_ID}");
    const again = await p.createPayment(req);
    assert.equal(again.checkout_url, setup.instructions.checkout_url, "same idempotency key returns the same session");
    await assert.rejects(p.initiatePayment!({ ...req, total: 0 }), /greater than zero/);
    await assert.rejects(p.initiatePayment!({ ...req, total: 12.5 }), /integer/);
  });

  test("rejects sessions that do not match the order or the key mode", async () => {
    const bad = (s: unknown) => stripeCheckout(cfg(fakeStripe(), { fetch: async () => ({ ok: true, status: 200, json: async () => s }) }));
    const req = { order_id: "ord_1", total: 100, currency: "EUR", country: "SK", quote_id: "q", quote_hash: "h", idempotency_key: "ord_1" };
    await assert.rejects(bad({ id: "x", url: "https://a" }).initiatePayment!(req), /unexpected/);
    await assert.rejects(bad({ id: "cs_test_1", url: "https://a", livemode: true }).initiatePayment!(req), /mode/);
    await assert.rejects(bad({ id: "cs_test_1", url: "https://a", amount_total: 99, currency: "eur" }).initiatePayment!(req), /amount/);
  });

  test("verifies Stripe-Signature over the raw body with timestamp tolerance", () => {
    const body = Buffer.from('{"id":"evt_1"}');
    const now = 1_700_000_000_000;
    const t = now / 1000;
    verifyStripeSignature(body, signStripePayload(body, WHSEC, t), WHSEC, 300, now);
    verifyStripeSignature(body, `${signStripePayload(body, WHSEC, t)},v1=${"0".repeat(64)}`, WHSEC, 300, now);
    const cases: [string | undefined, RegExp][] = [
      [undefined, /missing/],
      ["garbage", /malformed/],
      [signStripePayload(body, WHSEC, t - 301), /tolerance/],
      [signStripePayload(body, "whsec_other", t), /mismatch/],
      [signStripePayload(Buffer.from('{"id":"evt_2"}'), WHSEC, t), /mismatch/],
    ];
    for (const [h, re] of cases) assert.throws(() => verifyStripeSignature(body, h, WHSEC, 300, now), (e: any) => e instanceof WebhookVerificationError && re.test(e.message));
  });

  test("maps Checkout events and ignores unrelated event types", async () => {
    const fake = fakeStripe();
    const p = stripeCheckout(cfg(fake, { accountId: "acct_1" }));
    const t = Math.floor(Date.now() / 1000);
    const send = (raw: string, method = "POST") => p.verifyWebhook!({ method, rawBody: Buffer.from(raw), headers: { "stripe-signature": signStripePayload(raw, WHSEC, t) }, query: new URLSearchParams() });
    const session = { id: "cs_test_9abc", object: "checkout.session", status: "complete", payment_status: "unpaid", amount_total: 100, currency: "eur", metadata: { merx_order_id: "ord_9" } };
    assert.equal((await send(stripeEvent("checkout.session.completed", session, "evt_a", { account: "acct_1" })))!.status, "payment_pending");
    assert.equal((await send(stripeEvent("checkout.session.async_payment_failed", session, "evt_b", { account: "acct_1" })))!.status, "payment_failed");
    assert.equal((await send(stripeEvent("checkout.session.async_payment_succeeded", session, "evt_c", { account: "acct_1" })))!.status, "payment_pending");
    assert.equal((await send(stripeEvent("checkout.session.expired", { ...session, status: "expired" }, "evt_d", { account: "acct_1" })))!.status, "canceled");
    assert.equal(await send(stripeEvent("customer.created", {}, "evt_e", { account: "acct_1" })), null);
    await assert.rejects(send(stripeEvent("checkout.session.completed", session, "evt_f", { account: "acct_2" })), /different account/);
    await assert.rejects(send(stripeEvent("checkout.session.completed", session, "evt_g", { account: "acct_1", livemode: true })), /mode/);
    await assert.rejects(send(stripeEvent("checkout.session.completed", {}, "evt_h", { account: "acct_1" })), /no Checkout Session/);
    await assert.rejects(send("not json"), /not JSON/);
    await assert.rejects(send('{"x":1}'), /malformed/);
    await assert.rejects(send(stripeEvent("checkout.session.completed", session), "GET"), /POST/);
    const noSecret = stripeCheckout(cfg(fake, { webhookSecret: undefined }));
    await assert.rejects(noSecret.verifyWebhook!({ method: "POST", rawBody: Buffer.from("{}"), headers: {}, query: new URLSearchParams() }), /not configured/);
  });

  test("status lookups and cancellation validate session IDs", async () => {
    const fake = fakeStripe();
    const p = stripeCheckout(cfg(fake));
    await assert.rejects(p.getPaymentStatus!("../v1/customers"), /invalid Stripe Checkout Session ID/);
    await assert.rejects(p.cancelPayment!("cs_x/../../"), /invalid/);
    await assert.rejects(p.refund!({ order_id: "o", provider_payment_id: "cs_test_404abc", amount: 1, currency: "EUR", idempotency_key: "k" }), /HTTP 404/);
  });
});

describe("Stripe end-to-end over HTTP (mocked API)", () => {
  const fake = fakeStripe();
  let base = "";
  let close = () => {};
  let storePub: ReturnType<typeof publicKeyFromB64>;

  before(async () => {
    const { server, engine } = createMerx({ catalog, privateKeyPem: storeKey, payments: [stripeCheckout(cfg(fake))], adminToken: ADMIN });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    storePub = engine.keys.publicKey;
    close = () => server.close();
  });
  after(() => close());

  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "merx-agent-id": AGENT, ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const webhook = (raw: string, sig = signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000))) =>
    fetch(`${base}/v1/webhooks/payments/stripe_checkout`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
  const admin = (path: string, body: unknown = {}, token = ADMIN) => http("POST", path, body, { authorization: `Bearer ${token}` });
  const order = async (qty = 1) => {
    const q = await http("POST", "/v1/quotes", { ship_to: "SK", lines: [{ item_id: "beans-ethiopia-guji-250", quantity: qty }], payment_method: "stripe_checkout" });
    assert.equal(q.status, 200);
    const o = await http("POST", "/v1/orders", { quote_id: q.body.quote_id, mandate: mandate(AGENT), buyer });
    assert.equal(o.status, 200);
    return o.body;
  };
  const status = (o: any, token = o.access_token) => http("GET", `/v1/orders/${o.order_id}/payment`, undefined, { "merx-order-token": token });

  test("quote → order → hosted checkout → verified webhook → paid + signed confirmation", async () => {
    const o = await order();
    assert.equal(o.payment.status, "requires_action");
    assert.equal(o.payment.verifies_settlement, true);
    assert.match(o.payment.instructions.checkout_url, /^https:\/\/checkout\.stripe\.com/);
    assert.equal(typeof o.access_token, "string");
    const s1 = await status(o);
    assert.equal(s1.body.next_action.type, "redirect");
    assert.equal((await http("GET", `/v1/orders/${o.order_id}/payment/confirmation`, undefined, { "merx-order-token": o.access_token })).status, 404);

    const session = fake.pay(o.payment.provider_payment_id);
    const raw = stripeEvent("checkout.session.completed", session, "evt_paid_1");
    assert.deepEqual((await webhook(raw)).body, { received: true });
    const s2 = await status(o);
    assert.equal(s2.body.payment.status, "paid");
    assert.equal(s2.body.order_status, "paid");
    assert.equal(s2.body.next_action.type, "none");

    const conf = await http("GET", `/v1/orders/${o.order_id}/payment/confirmation`, undefined, { "merx-order-token": o.access_token });
    assert.equal(conf.status, 200);
    assert.equal(conf.body.payload.typ, "merx-payment-confirmation/1");
    assert.equal(conf.body.payload.verified_by, "webhook");
    assert.equal(conf.body.payload.amount.amount, o.quote.total);
    assert.ok(verifyObject(conf.body.payload, conf.body.signature.value, storePub));

    // duplicates and replays are harmless
    assert.deepEqual((await webhook(raw)).body, { received: true, duplicate: true });
    // an out-of-order "pending" after "paid" never downgrades the payment
    const late = stripeEvent("checkout.session.completed", { ...session, payment_status: "unpaid" }, "evt_late_1");
    assert.equal((await webhook(late)).status, 200);
    assert.equal((await status(o)).body.payment.status, "paid");
  });

  test("rejects forged, mismatched and foreign events without state change", async () => {
    const o = await order();
    const ref = o.payment.provider_payment_id;
    const session = { ...fake.sessions.get(ref)!, status: "complete", payment_status: "paid" };
    assert.equal((await webhook(stripeEvent("checkout.session.completed", session), "t=1,v1=" + "0".repeat(64))).status, 400);
    assert.equal((await webhook(stripeEvent("checkout.session.completed", session), signStripePayload("{}", WHSEC, Math.floor(Date.now() / 1000)))).status, 400);
    const wrongAmount = await webhook(stripeEvent("checkout.session.completed", { ...session, amount_total: 1 }));
    assert.equal(wrongAmount.status, 400);
    assert.deepEqual(wrongAmount.body, { error: { code: "invalid", message: "webhook verification failed" } });
    assert.equal((await webhook(stripeEvent("checkout.session.completed", { ...session, metadata: { merx_order_id: "ord_other" } }))).status, 400);
    assert.equal((await status(o)).body.payment.status, "requires_action");
    // events for sessions this store never created are acknowledged and ignored
    assert.deepEqual((await webhook(stripeEvent("checkout.session.completed", { ...session, id: "cs_test_unknownabc", metadata: {}, client_reference_id: null }))).body, { received: true, ignored: true });
    assert.equal((await http("POST", "/v1/webhooks/payments/bank_transfer", "{}")).status, 404);
  });

  test("buyer access control on order and payment status across REST, MCP and A2A", async () => {
    const o = await order();
    assert.equal((await status(o, "nope")).status, 403);
    assert.equal((await http("GET", `/v1/orders/${o.order_id}/payment`)).status, 403);
    assert.equal((await http("GET", `/v1/orders/${o.order_id}`, undefined, { "merx-order-token": "nope" })).status, 403);
    assert.equal((await http("GET", `/v1/orders/${o.order_id}`, undefined, { "merx-order-token": o.access_token })).body.order_id, o.order_id);
    const mcp = await http("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payment_status", arguments: { order_id: o.order_id, access_token: o.access_token } } });
    assert.equal(mcp.body.result.structuredContent.payment.status, "requires_action");
    const mcpDenied = await http("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "payment_status", arguments: { order_id: o.order_id, access_token: "x" } } });
    assert.equal(mcpDenied.body.result.isError, true);
    const a2a = await http("POST", "/a2a", { jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { role: "user", messageId: "m", parts: [{ kind: "data", data: { operation: "payment_status", input: { order_id: o.order_id, access_token: o.access_token } } }] } } });
    assert.equal(a2a.body.result.parts[0].data.output.payment.status, "requires_action");
    const a2aConf = await http("POST", "/a2a", { jsonrpc: "2.0", id: 4, method: "message/send", params: { message: { role: "user", messageId: "m", parts: [{ kind: "data", data: { operation: "payment_confirmation", input: { order_id: o.order_id, access_token: o.access_token } } }] } } });
    assert.equal(a2aConf.body.result.parts[0].data.output.error.code, "not_found");
    const statusBody = JSON.stringify((await status(o)).body);
    assert.ok(!statusBody.includes(buyer.email) && !statusBody.includes("sk_test"), "no PII or secrets in payment status");
  });

  test("expired session → new attempt with a new idempotency key; missed webhook → reconciliation", async () => {
    const o = await order();
    const first = o.payment.provider_payment_id;
    fake.sessions.get(first)!.status = "expired";
    assert.equal((await webhook(stripeEvent("checkout.session.expired", fake.sessions.get(first)))).status, 200);
    assert.equal((await status(o)).body.payment.status, "canceled");
    assert.equal((await status(o)).body.next_action.type, "contact_merchant");

    const retried = await admin(`/admin/v1/orders/${o.order_id}/retry-payment`);
    assert.equal(retried.body.payment.attempt, 2);
    assert.equal(retried.body.payment.status, "requires_action");
    assert.notEqual(retried.body.payment.provider_payment_id, first);
    assert.equal(fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/checkout/sessions")).at(-1)!.headers["idempotency-key"], `merx:${o.order_id}:2`);

    // the human pays, but the webhook never arrives
    fake.pay(retried.body.payment.provider_payment_id);
    const rec = await admin("/admin/v1/payments/reconcile");
    assert.ok(rec.body.results.some((r: any) => r.order_id === o.order_id && r.status === "paid"));
    const conf = await http("GET", `/v1/orders/${o.order_id}/payment/confirmation`, undefined, { "merx-order-token": o.access_token });
    assert.equal(conf.body.payload.verified_by, "reconciliation");

    // an old checkout that is completed later is a duplicate settlement, never silently merged
    const lateOld = { ...fake.sessions.get(first)!, status: "complete", payment_status: "paid" };
    assert.equal((await webhook(stripeEvent("checkout.session.completed", lateOld))).status, 200);
    assert.equal((await status(o)).body.payment.status, "paid");
  });

  test("admin refunds are authenticated, bounded and idempotent", async () => {
    const o = await order(2);
    fake.pay(o.payment.provider_payment_id);
    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/reconcile`)).body.payment.status, "paid");

    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/refund`, { amount: 100, idempotency_key: "refund-0001" }, "wrong-token-wrong-token-wrong-token!!")).status, 401);
    assert.equal((await http("POST", `/admin/v1/orders/${o.order_id}/refund`, { amount: 100, idempotency_key: "refund-0001" })).status, 401);
    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/refund`, { amount: 100 })).status, 400);
    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/refund`, { amount: o.quote.total + 1, idempotency_key: "refund-0002" })).status, 400);
    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/refund`, { amount: 13, idempotency_key: "refund-0003" })).status, 503, "provider-declined refunds are reported");

    const part = await admin(`/admin/v1/orders/${o.order_id}/refund`, { amount: 100, idempotency_key: "refund-0001", reason: "requested_by_customer" });
    assert.equal(part.body.payment.status, "partially_refunded");
    assert.equal(part.body.payment.refunded_amount, 100);
    const repeat = await admin(`/admin/v1/orders/${o.order_id}/refund`, { amount: 100, idempotency_key: "refund-0001" });
    assert.equal(repeat.body.payment.refunded_amount, 100, "same key does not refund twice");
    const rest = await admin(`/admin/v1/orders/${o.order_id}/refund`, { idempotency_key: "refund-0004", reason: "damaged in transit" });
    assert.equal(rest.body.payment.status, "refunded");
    assert.equal(rest.body.status, "refunded");
    assert.equal(rest.body.payment.refunded_amount, o.quote.total);
    const refundCall = fake.calls.filter((c) => c.url.endsWith("/v1/refunds")).at(-1)!;
    assert.equal(refundCall.body.get("metadata[merx_reason]"), "damaged in transit");
    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/refund`, { amount: 1, idempotency_key: "refund-0005" })).status, 409);
    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/cancel`)).status, 409, "paid orders are refunded, not cancelled");
  });

  test("cancelling an unpaid order expires the session and returns stock; a late payment is flagged", async () => {
    const stockBefore = (await http("GET", "/v1/items/beans-ethiopia-guji-250")).body.offer.availability.quantity;
    const o = await order(3);
    assert.equal((await http("GET", "/v1/items/beans-ethiopia-guji-250")).body.offer.availability.quantity, stockBefore - 3);
    const c = await admin(`/admin/v1/orders/${o.order_id}/cancel`, { reason: "buyer asked" });
    assert.equal(c.body.status, "cancelled");
    assert.equal(c.body.payment.status, "canceled");
    assert.equal(fake.sessions.get(o.payment.provider_payment_id)!.status, "expired");
    assert.equal((await http("GET", "/v1/items/beans-ethiopia-guji-250")).body.offer.availability.quantity, stockBefore);
    assert.equal((await admin(`/admin/v1/orders/${o.order_id}/cancel`)).body.status, "cancelled", "cancel is idempotent");
    assert.equal((await status(o)).body.next_action.reason, "order_cancelled");
    const s = { ...fake.sessions.get(o.payment.provider_payment_id)!, status: "complete", payment_status: "paid" };
    assert.equal((await webhook(stripeEvent("checkout.session.completed", s))).status, 200);
    const after = (await admin(`/admin/v1/orders/${o.order_id}/reconcile`)).body;
    assert.equal(after.status, "cancelled");
    assert.equal(after.payment.status, "paid", "money that arrived is recorded so the merchant can refund it");
  });

  test("provider outage during setup keeps the order and retries with the same key", async () => {
    fake.failNext(1);
    const o = await order();
    assert.equal(o.status, "payment_setup_failed");
    assert.equal((await status(o)).body.next_action.reason, "payment_setup_failed");
    const r = await admin(`/admin/v1/orders/${o.order_id}/retry-payment`);
    assert.equal(r.body.status, "awaiting_payment");
    assert.equal(r.body.payment.attempt, 1);
    const keys = fake.calls.filter((c) => c.url.endsWith("/v1/checkout/sessions") && c.method === "POST").slice(-2).map((c) => c.headers["idempotency-key"]);
    assert.deepEqual(keys, [`merx:${o.order_id}`, `merx:${o.order_id}`]);
    assert.equal((await http("GET", `/admin/v1/orders/${o.order_id}`, undefined, { authorization: `Bearer ${ADMIN}` })).body.order_id, o.order_id);
  });

  test("manifest and OpenAPI document the payment surface", async () => {
    const m = await http("GET", "/.well-known/merx.json");
    assert.ok(m.body.capabilities.includes("payment.confirmation.signed"));
    assert.equal(m.body.payment_handlers[0].verifies_settlement, true);
    const api = await http("GET", "/openapi.json");
    assert.ok(api.body.paths["/v1/orders/{order_id}/payment"].get);
    assert.ok(api.body.paths["/v1/webhooks/payments/{provider}"].post);
    assert.equal(api.body.info["x-merx-release"], "0.3.0");
  });
});

test("adminToken must be long enough", () => {
  assert.throws(() => createMerx({ catalog, privateKeyPem: storeKey, adminToken: "short" }), /32 characters/);
});
