import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MerxEngine } from "../src/core/engine.ts";
import { SqliteStore } from "../src/storage/sqlite.ts";
import { stripeCheckout } from "../src/payments/stripe.ts";
import { paymentsFromEnv, storeFromEnv } from "../src/config.ts";
import { signStripePayload } from "../src/payments/stripe.ts";
import { buyer, catalog, fakeStripe, mandate, storeKey, stripeEvent } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "merx-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const ITEM = "beans-ethiopia-guji-250";

describe("SqliteStore durability", () => {
  test("orders, nonces, deals, stock, attempts and webhook events survive a restart", async () => {
    const path = join(dir, "restart.db");
    const fake = fakeStripe();
    const provider = () => stripeCheckout({ secretKey: "sk_test_123", webhookSecret: "whsec_x", successUrl: "https://s.example/ok", cancelUrl: "https://s.example/no", fetch: fake.fetch });
    const e1 = new MerxEngine({ catalog, privateKeyPem: storeKey, store: new SqliteStore(path), payments: [provider()] });
    const stock0 = e1.getItem(ITEM).offer.availability.quantity;

    let neg = e1.negotiate({ item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: 7000 });
    while (!neg.deal_token) neg = e1.negotiate({ item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: 7000, session_id: neg.session_id });
    const q = e1.createQuote({ lines: [{ item_id: ITEM, quantity: 2 }, { item_id: "grinder-hand-c40", quantity: 1, deal_token: neg.deal_token }], ship_to: "SK" });
    const m = mandate();
    const { order, access_token } = await e1.checkout({ quote_id: q.quote_id, mandate: m, buyer, agent_id: "a1" });
    const raw = stripeEvent("checkout.session.completed", fake.pay(order.payment.provider_payment_id!), "evt_restart");
    const hook = { method: "POST", rawBody: Buffer.from(raw), headers: { "stripe-signature": signStripePayload(raw, "whsec_x", Math.floor(Date.now() / 1000)) }, query: new URLSearchParams() };
    await e1.handlePaymentWebhook("stripe_checkout", hook);
    await e1.close();

    const store2 = new SqliteStore(path);
    assert.equal(store2.schemaVersion, 1);
    const e2 = new MerxEngine({ catalog, privateKeyPem: storeKey, store: store2, payments: [provider()] });
    const restored = e2.getOrder(order.order_id);
    assert.equal(restored.payment.status, "paid");
    assert.ok(restored.payment.confirmation);
    assert.equal(e2.paymentStatus(order.order_id, access_token).payment.status, "paid", "access token hash persisted");
    assert.equal(e2.getItem(ITEM).offer.availability.quantity, stock0 - 2, "stock deductions persisted");
    assert.deepEqual(await e2.handlePaymentWebhook("stripe_checkout", hook), { received: true, duplicate: true }, "webhook dedupe persisted");

    const q2 = e2.createQuote({ lines: [{ item_id: ITEM, quantity: 1 }], ship_to: "SK" });
    await assert.rejects(e2.checkout({ quote_id: q2.quote_id, mandate: m, buyer, agent_id: "a1" }), /replay/, "consumed nonce persisted");
    assert.throws(() => e2.createQuote({ lines: [{ item_id: "grinder-hand-c40", quantity: 1, deal_token: neg.deal_token }], ship_to: "SK" }), /already redeemed/, "redeemed deal persisted");
    assert.ok(store2.auditTrail().some((a) => a.type === "payment.status_changed" && a.order_id === order.order_id));
    store2.resetStock();
    await e2.close();
  });

  test("two engines on one database cannot consume the same mandate twice", async () => {
    const path = join(dir, "concurrent.db");
    const a = new MerxEngine({ catalog, privateKeyPem: storeKey, store: new SqliteStore(path) });
    const b = new MerxEngine({ catalog, privateKeyPem: storeKey, store: new SqliteStore(path) });
    const m = mandate();
    const qa = a.createQuote({ lines: [{ item_id: ITEM, quantity: 1 }], ship_to: "SK" });
    const qb = b.createQuote({ lines: [{ item_id: ITEM, quantity: 1 }], ship_to: "SK" });
    const results = await Promise.allSettled([a.checkout({ quote_id: qa.quote_id, mandate: m, buyer, agent_id: "a1" }), b.checkout({ quote_id: qb.quote_id, mandate: m, buyer, agent_id: "a1" })]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message), /replay/);
    await a.close();
    await b.close();
  });

  test("concurrent duplicate submissions in one process create one order", async () => {
    const e = new MerxEngine({ catalog, privateKeyPem: storeKey, store: new SqliteStore(join(dir, "dup.db")) });
    const q = e.createQuote({ lines: [{ item_id: ITEM, quantity: 1 }], ship_to: "SK" });
    const m = mandate();
    const results = await Promise.allSettled([1, 2, 3].map(() => e.checkout({ quote_id: q.quote_id, mandate: m, buyer, agent_id: "a1" })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    await e.close();
  });

  test("attempt uniqueness is enforced by the database", () => {
    const s = new SqliteStore(join(dir, "attempts.db"));
    const a = { attempt_id: "pay_1", order_id: "o", provider_id: "p", sequence: 1, idempotency_key: "k1", provider_payment_id: "r1", amount: 1, currency: "EUR", status: "unpaid" as const, created_at: "", updated_at: "" };
    s.saveAttempt(a);
    s.saveAttempt({ ...a, status: "paid" });
    assert.throws(() => s.saveAttempt({ ...a, attempt_id: "pay_2", provider_payment_id: "r2" }), /idempotency_key/);
    assert.throws(() => s.saveAttempt({ ...a, attempt_id: "pay_3", idempotency_key: "k3" }), /provider_payment_id/);
    assert.equal(s.load().attempts[0].status, "paid");
    s.close();
  });
});

describe("environment configuration", () => {
  test("no variables → offline demo provider only", () => {
    const r = paymentsFromEnv({});
    assert.deepEqual(r.enabled, ["bank_transfer"]);
    assert.equal(r.defaultPaymentMethod, undefined);
  });

  test("providers are opt-in and validated", () => {
    const env = { MERX_PUBLIC_URL: "https://shop.example/", STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_COUNTRIES: "sk, cz", GOPAY_CLIENT_ID: "cid", GOPAY_CLIENT_SECRET: "s", GOPAY_GOID: "123", MERX_DEFAULT_PAYMENT_METHOD: "gopay", MERX_DISABLE_DEMO_TRANSFER: "1", STRIPE_ACCOUNT_ID: "acct_1", STRIPE_API_VERSION: "2024-06-20", GOPAY_LANG: "SK" };
    const r = paymentsFromEnv(env);
    assert.deepEqual(r.enabled, ["stripe_checkout", "gopay"]);
    assert.deepEqual(r.payments[0].descriptor?.countries, ["SK", "CZ"]);
    assert.equal(r.defaultPaymentMethod, "gopay");
    assert.throws(() => paymentsFromEnv({ STRIPE_SECRET_KEY: "sk_test_123" }), /STRIPE_SUCCESS_URL/);
    assert.throws(() => paymentsFromEnv({ GOPAY_CLIENT_ID: "x", MERX_PUBLIC_URL: "https://s.example" }), /GOPAY_CLIENT_SECRET/);
    assert.throws(() => paymentsFromEnv({ MERX_DISABLE_DEMO_TRANSFER: "1" }), /No payment provider/);
  });

  test("store selection", async () => {
    assert.equal((await storeFromEnv({})).kind, "memory");
    const s = await storeFromEnv({ MERX_STORE: `sqlite:${join(dir, "env.db")}` });
    assert.equal(s.kind, "sqlite");
    await s.close?.();
    await assert.rejects(storeFromEnv({ MERX_STORE: "postgres://x" }), /Unsupported MERX_STORE/);
  });
});
