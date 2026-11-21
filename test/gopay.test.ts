import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MerxEngine } from "../src/core/engine.ts";
import { gopay } from "../src/payments/gopay.ts";
import { stripeCheckout } from "../src/payments/stripe.ts";
import { buyer, catalog, fakeGoPay, fakeStripe, mandate, storeKey } from "./helpers.ts";

const cfg = (fake: ReturnType<typeof fakeGoPay>, over = {}) => ({ clientId: "cid", clientSecret: "secret", goid: "8123456789", returnUrl: "https://shop.example/return", notificationUrl: "https://shop.example/v1/webhooks/payments/gopay", fetch: fake.fetch, ...over });
const notify = (id: string | number, method = "GET") => ({ method, rawBody: Buffer.alloc(0), headers: {}, query: new URLSearchParams({ id: String(id) }) });

async function setup(over = {}) {
  const fake = fakeGoPay();
  const e = new MerxEngine({ catalog, privateKeyPem: storeKey, payments: [gopay(cfg(fake, over))] });
  const q = e.createQuote({ lines: [{ item_id: "beans-ethiopia-guji-250", quantity: 1 }], ship_to: "SK" });
  const { order, access_token } = await e.checkout({ quote_id: q.quote_id, mandate: mandate(), buyer, agent_id: "a1" });
  return { fake, e, order, access_token };
}

describe("GoPay adapter", () => {
  test("validates configuration and defaults to the sandbox", async () => {
    const fake = fakeGoPay();
    assert.throws(() => gopay(cfg(fake, { goid: "abc" })), /numeric/);
    assert.throws(() => gopay(cfg(fake, { clientSecret: "" })), /required/);
    assert.throws(() => gopay(cfg(fake, { environment: "production", returnUrl: "http://localhost/r" })), /HTTPS/);
    const p = gopay(cfg(fake));
    assert.deepEqual(p.descriptor?.countries, ["CZ", "SK"]);
    await p.getPaymentStatus!("1").catch(() => {});
    assert.ok(fake.calls[0].url.startsWith("https://gw.sandbox.gopay.com/api/oauth2/token"));
    assert.equal(fake.calls[0].body, "grant_type=client_credentials&scope=payment-all");
  });

  test("creates a payment with server-side totals and caches the OAuth token", async () => {
    const { fake, order } = await setup({ lang: "SK" });
    assert.equal(order.payment.status, "requires_action");
    assert.match(String(order.payment.instructions.checkout_url), /^https:\/\/gw\.sandbox\.gopay\.com\//);
    const create = fake.calls.find((c) => c.url.endsWith("/api/payments/payment"))!;
    const body = JSON.parse(create.body!);
    assert.equal(body.amount, order.quote.total);
    assert.equal(body.currency, "EUR");
    assert.equal(body.order_number, order.order_id);
    assert.deepEqual(body.target, { type: "ACCOUNT", goid: 8123456789 });
    assert.equal(body.callback.notification_url, "https://shop.example/v1/webhooks/payments/gopay");
    assert.equal(body.lang, "SK");
    assert.equal(fake.tokens(), 1);
  });

  test("an unauthenticated notification is verified by a server-to-server status check", async () => {
    const { fake, e, order, access_token } = await setup();
    const id = order.payment.provider_payment_id!;
    // notification while still CREATED: nothing changes
    assert.deepEqual(await e.handlePaymentWebhook("gopay", notify(id)), { received: true });
    assert.equal(e.paymentStatus(order.order_id, access_token).payment.status, "requires_action");
    fake.payments.get(id)!.state = "PAID";
    assert.deepEqual(await e.handlePaymentWebhook("gopay", notify(id)), { received: true });
    assert.equal(e.paymentStatus(order.order_id, access_token).payment.status, "paid");
    assert.deepEqual(await e.handlePaymentWebhook("gopay", notify(id)), { received: true, duplicate: true });
    assert.equal(fake.tokens(), 1, "token reused within its lifetime");
    assert.equal(e.paymentConfirmation(order.order_id, access_token).payload.provider, "gopay");
    await assert.rejects(e.handlePaymentWebhook("gopay", notify("abc")), /no valid payment id/);
    await assert.rejects(e.handlePaymentWebhook("gopay", notify(id, "PUT")), /unsupported/);
  });

  test("a tampered amount at the provider is never marked paid", async () => {
    const { fake, e, order, access_token } = await setup();
    const p = fake.payments.get(order.payment.provider_payment_id!)!;
    Object.assign(p, { state: "PAID", amount: 1 });
    await assert.rejects(e.handlePaymentWebhook("gopay", notify(p.id)), /amount/);
    assert.equal(e.paymentStatus(order.order_id, access_token).payment.status, "requires_action");
  });

  test("timeouts, cancellations and refunds follow the shared state machine", async () => {
    const { fake, e, order, access_token } = await setup();
    const id = order.payment.provider_payment_id!;
    fake.payments.get(id)!.state = "TIMEOUTED";
    await e.handlePaymentWebhook("gopay", notify(id));
    assert.equal(e.paymentStatus(order.order_id, access_token).payment.status, "canceled");
    const retried = await e.retryPayment(order.order_id);
    assert.equal(retried.payment.attempt, 2);
    const id2 = retried.payment.provider_payment_id!;
    assert.equal(JSON.parse(fake.calls.filter((c) => c.url.endsWith("/api/payments/payment")).at(-1)!.body!).order_number, `${order.order_id}:2`);
    fake.payments.get(id2)!.state = "PAID";
    assert.equal((await e.reconcilePayment(order.order_id)).payment.status, "paid");
    await assert.rejects(e.refundPayment(order.order_id, { amount: 7, idempotency_key: "refund-fail-1" }), (err: any) => err.code === "unavailable");
    const partial = await e.refundPayment(order.order_id, { amount: 100, idempotency_key: "refund-gopay-1" });
    assert.equal(partial.payment.status, "partially_refunded");
    assert.equal(fake.calls.at(-1)!.body, "amount=100");
    await e.handlePaymentWebhook("gopay", notify(id2));
    assert.equal(e.getOrder(order.order_id).payment.status, "partially_refunded");
    const full = await e.refundPayment(order.order_id, { idempotency_key: "refund-gopay-2" });
    assert.equal(full.payment.status, "refunded");
  });

  test("a paid orphan payment for a known order is adopted after verification", async () => {
    const { fake, e, order, access_token } = await setup();
    // simulate a request that timed out after GoPay created a second payment
    const orphan = { id: 3999999999, order_number: order.order_id, state: "PAID", amount: order.quote.total, currency: "EUR", gw_url: "https://gw.sandbox.gopay.com/gw/v3/x" };
    fake.payments.set(String(orphan.id), orphan);
    await e.handlePaymentWebhook("gopay", notify(orphan.id));
    const s = e.paymentStatus(order.order_id, access_token);
    assert.equal(s.payment.status, "paid");
    assert.equal(s.payment.attempt, 2);
    // an orphan that is not settled is acknowledged and ignored
    fake.payments.set("3999999998", { ...orphan, id: 3999999998, state: "CREATED" });
    assert.deepEqual(await e.handlePaymentWebhook("gopay", notify(3999999998)), { received: true, ignored: true });
  });

  test("unknown states and wrong credentials fail closed", async () => {
    const fake = fakeGoPay();
    const p = gopay(cfg(fake, { clientSecret: "bad" }));
    await assert.rejects(p.getPaymentStatus!("1"), /HTTP 401 \(AUTH_WRONG_CREDENTIALS\)/);
    const ok = gopay(cfg(fake));
    fake.payments.set("42", { id: 42, order_number: "ord_1", state: "SOMETHING_NEW", amount: 1, currency: "EUR", gw_url: "" });
    await assert.rejects(ok.getPaymentStatus!("42"), /unknown payment state/);
    await assert.rejects(ok.getPaymentStatus!("../x"), /invalid GoPay payment ID/);
    const badCreate = gopay(cfg(fake, { fetch: async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes("oauth2") ? { access_token: "tok" } : { id: "x" }) }) }));
    await assert.rejects(badCreate.createPayment({ order_id: "o", total: 100, currency: "EUR", country: "SK", quote_id: "q", quote_hash: "h", idempotency_key: "o" }), /unexpected payment/);
    const noToken = gopay(cfg(fake, { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }));
    await assert.rejects(noToken.getPaymentStatus!("1"), /no access token/);
  });

  test("Stripe and GoPay can run side by side and be disabled independently", async () => {
    const e = new MerxEngine({ catalog, privateKeyPem: storeKey, payments: [gopay(cfg(fakeGoPay())), stripeCheckout({ secretKey: "sk_test_123", successUrl: "https://s.example/ok", cancelUrl: "https://s.example/no", fetch: fakeStripe().fetch })] });
    assert.deepEqual(e.paymentMethods({ currency: "EUR", country: "SK" }).map((p) => p.id), ["gopay", "stripe_checkout"]);
    assert.deepEqual(e.paymentMethods({ currency: "EUR", country: "DE" }).map((p) => p.id), ["stripe_checkout"]);
  });
});
