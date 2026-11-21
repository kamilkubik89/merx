import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertMinorAmount, assertMoney, currencyExponent, formatMinor, isSupportedCurrency, registerCurrency } from "../src/core/money.ts";
import { canTransition, isOpen, isPaymentStatus, isTerminal, PAYMENT_STATUSES } from "../src/core/payment-state.ts";
import { MemoryStore, StoreConflictError } from "../src/core/storage.ts";
import { manualTransfer, PaymentRegistry } from "../src/core/payments.ts";
import { MerxEngine, MerxError } from "../src/core/engine.ts";
import type { MerxStore, PaymentProvider } from "../src/core/engine.ts";
import { formEncode, header, requestJson, assertHttpsUrl, ProviderApiError } from "../src/payments/http.ts";
import { buyer, catalog, mandate, storeKey } from "./helpers.ts";

describe("money", () => {
  test("validates integer minor units and ISO currencies", () => {
    assert.equal(currencyExponent("EUR"), 2);
    assert.equal(currencyExponent("JPY"), 0);
    assert.equal(currencyExponent("KWD"), 3);
    assert.ok(isSupportedCurrency("CZK"));
    assert.ok(!isSupportedCurrency("XXX"));
    assert.ok(!isSupportedCurrency(5));
    for (const bad of [1.5, -1, Number.NaN, "100", 1e15]) assert.throws(() => assertMinorAmount(bad), MerxError);
    assert.throws(() => assertMinorAmount(0, { positive: true }), /greater than zero/);
    assert.throws(() => assertMoney(100, "XXX"), /unsupported currency/);
    assert.throws(() => currencyExponent("XXX"), MerxError);
    assertMoney(1290, "EUR", { positive: true });
  });

  test("formats without floating point", () => {
    assert.equal(formatMinor(1290, "EUR"), "12.90");
    assert.equal(formatMinor(5, "EUR"), "0.05");
    assert.equal(formatMinor(1500, "JPY"), "1500");
    assert.equal(formatMinor(1234, "KWD"), "1.234");
  });

  test("custom currencies can be registered explicitly", () => {
    registerCurrency("XTS", 2);
    assert.equal(currencyExponent("XTS"), 2);
    assert.throws(() => registerCurrency("bad", 2));
    assert.throws(() => registerCurrency("XTT", 9));
  });
});

describe("payment state machine", () => {
  test("allows only documented transitions", () => {
    assert.ok(canTransition("requires_action", "paid"));
    assert.ok(canTransition("paid", "partially_refunded"));
    assert.ok(canTransition("disputed", "paid"));
    assert.ok(!canTransition("paid", "payment_pending"), "late pending event must not undo paid");
    assert.ok(!canTransition("refunded", "paid"));
    assert.ok(!canTransition("canceled", "paid"));
    assert.ok(isTerminal("refunded") && isTerminal("canceled") && !isTerminal("paid"));
    assert.ok(isOpen("payment_failed") && !isOpen("paid"));
    assert.equal(PAYMENT_STATUSES.length, 9);
    assert.ok(isPaymentStatus("paid") && !isPaymentStatus("settled"));
  });
});

describe("memory store", () => {
  test("enforces uniqueness for orders, nonces, deals, idempotency keys and provider refs", () => {
    const s = new MemoryStore();
    const order = { order_id: "ord_1", created_at: new Date().toISOString() } as never;
    s.commitOrder({ record: { order, access_hash: "h" }, nonce: "n1", deals: ["d1"], stock: [{ item_id: "x", quantity: 2 }] });
    assert.throws(() => s.commitOrder({ record: { order, access_hash: "h" }, nonce: "n2", deals: [], stock: [] }), (e: any) => e instanceof StoreConflictError && e.field === "order_id");
    assert.throws(() => s.commitOrder({ record: { order: { order_id: "ord_2" } as never, access_hash: "h" }, nonce: "n1", deals: [], stock: [] }), /mandate_nonce/);
    assert.throws(() => s.commitOrder({ record: { order: { order_id: "ord_3" } as never, access_hash: "h" }, nonce: "n3", deals: ["d1"], stock: [] }), /deal/);
    const a = { attempt_id: "pay_1", order_id: "ord_1", provider_id: "p", sequence: 1, idempotency_key: "k1", provider_payment_id: "ref1", amount: 1, currency: "EUR", status: "unpaid" as const, created_at: "", updated_at: "" };
    s.saveAttempt(a);
    s.saveAttempt({ ...a, status: "paid" });
    assert.throws(() => s.saveAttempt({ ...a, attempt_id: "pay_2", provider_payment_id: "ref2" }), /idempotency_key/);
    assert.throws(() => s.saveAttempt({ ...a, attempt_id: "pay_3", idempotency_key: "k3" }), /provider_payment_id/);
    assert.equal(s.load().stock.x, 2);
    s.cancelOrder({ record: { order, access_hash: "h" }, stock: [{ item_id: "x", quantity: 2 }] });
    assert.equal(s.load().stock.x, 0);
    s.resetStock();
    assert.deepEqual(s.load().stock, {});
    assert.ok(!s.hasWebhookEvent("p", "e1"));
    s.recordWebhookEvent("p", "e1");
    s.recordWebhookEvent("p", "e1");
    assert.ok(s.hasWebhookEvent("p", "e1"));
  });
});

describe("payment registry and demo transfer", () => {
  test("descriptors advertise verification capabilities", async () => {
    const verified: PaymentProvider = { id: "v", descriptor: { label: "V", flow: "redirect", protocols: [] }, createPayment: async () => ({}), getPaymentStatus: async () => ({ status: "paid" }), verifyWebhook: async () => null, refund: async () => ({ refund_id: "r", status: "succeeded" }) };
    const r = new PaymentRegistry([manualTransfer, verified]);
    const [demo, v] = r.list();
    assert.equal(demo.verifies_settlement, false);
    assert.deepEqual(demo.capabilities, []);
    assert.deepEqual(v.capabilities, ["webhook", "status", "refund"]);
    assert.equal(r.get("v"), verified);
    const instructions = await manualTransfer.createPayment({ order_id: "ord_x", total: 100, currency: "EUR", country: "SK", quote_id: "q", quote_hash: "h", idempotency_key: "ord_x" });
    assert.equal(instructions.demo, true);
    assert.equal(instructions.settlement, "not_verified");
  });
});

describe("http helpers", () => {
  test("form encoding, headers and URL checks", () => {
    assert.equal(formEncode({ a: 1, b: { c: "x y", d: [{ e: 2 }] }, skip: undefined }), "a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B0%5D%5Be%5D=2");
    assert.equal(header({ "x-a": ["1", "2"] }, "X-A"), "1");
    assert.throws(() => assertHttpsUrl("http://example.com", "u"));
    assert.throws(() => assertHttpsUrl("https://u:p@example.com", "u"));
    assert.throws(() => assertHttpsUrl("not a url", "u"));
    assert.equal(assertHttpsUrl("http://localhost:3000/x", "u", true), "http://localhost:3000/x");
  });

  test("provider errors never include response bodies", async () => {
    const leak = async () => ({ ok: false, status: 402, json: async () => ({ error: { code: "card_declined", message: "jane@example.sk" } }) });
    await assert.rejects(requestJson("X", leak, "https://x", { method: "GET", headers: {} }, 100), (e: any) => e instanceof ProviderApiError && e.providerCode === "card_declined" && !e.message.includes("@"));
    await assert.rejects(requestJson("X", async () => { throw new Error("ECONNRESET"); }, "https://x", { method: "GET", headers: {} }, 100), /network_error/);
    await assert.rejects(requestJson("X", async () => ({ ok: false, status: 500, json: async () => { throw new Error("no json"); } }), "https://x", { method: "GET", headers: {} }, 100), /HTTP 500/);
  });
});

describe("engine with async store", () => {
  test("waits for hydration before accepting checkout", async () => {
    const inner = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store: MerxStore = Object.assign(Object.create(inner), { kind: "slow", load: async () => { await gate; return inner.load(); } });
    const e = new MerxEngine({ catalog, privateKeyPem: storeKey, store });
    assert.throws(() => e.createQuote({ lines: [{ item_id: "beans-ethiopia-guji-250", quantity: 1 }], ship_to: "SK" }), (err: any) => err.code === "unavailable");
    release();
    await e.ready();
    const q = e.createQuote({ lines: [{ item_id: "beans-ethiopia-guji-250", quantity: 1 }], ship_to: "SK" });
    const { order, access_token } = await e.checkout({ quote_id: q.quote_id, mandate: mandate(), buyer, agent_id: "a1" });
    assert.equal(e.paymentStatus(order.order_id, access_token).payment.status, "payment_pending");
    assert.throws(() => e.paymentStatus(order.order_id, "wrong"), /invalid order access_token/);
    assert.throws(() => e.paymentStatus(order.order_id, undefined), /access_token required/);
    assert.throws(() => e.paymentConfirmation(order.order_id, access_token), /does not verify settlement/);
    await assert.rejects(e.reconcilePayment(order.order_id), /cannot be reconciled/);
    await assert.rejects(e.refundPayment(order.order_id, { idempotency_key: "refund-0001" }), /does not support refunds/);
    await e.close();
  });

  test("store conflicts roll back in-memory reservations", async () => {
    const inner = new MemoryStore();
    let fail = true;
    const store: MerxStore = Object.assign(Object.create(inner), {
      kind: "flaky",
      load: () => inner.load(),
      commitOrder: (i: any) => { if (fail) { fail = false; throw new StoreConflictError("mandate_nonce"); } return inner.commitOrder(i); },
      audit: () => { throw new Error("audit sink down"); },
    });
    const e = new MerxEngine({ catalog, privateKeyPem: storeKey, store });
    const before = e.getItem("beans-ethiopia-guji-250").offer.availability.quantity;
    const q = e.createQuote({ lines: [{ item_id: "beans-ethiopia-guji-250", quantity: 2 }], ship_to: "SK" });
    const m = mandate();
    await assert.rejects(e.checkout({ quote_id: q.quote_id, mandate: m, buyer, agent_id: "a1" }), /replay/);
    // the quote, nonce and stock were released, so the same request succeeds once the conflict clears
    const { order } = await e.checkout({ quote_id: q.quote_id, mandate: m, buyer, agent_id: "a1" });
    assert.equal(order.status, "awaiting_payment");
    assert.equal(e.getItem("beans-ethiopia-guji-250").offer.availability.quantity, before - 2);
  });
});
