import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MerxEngine } from "../src/core/engine.ts";
import { generateKeys, loadKeyPair, signObject, verifyObject, canonicalize } from "../src/core/crypto.ts";
import { lintItem } from "../src/core/lint.ts";
import type { Catalog, MandatePayload } from "../src/core/types.ts";

const catalog: Catalog = JSON.parse(readFileSync(new URL("../examples/stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
const engine = () => new MerxEngine({ catalog, privateKeyPem: generateKeys().privatePem });
const wallet = loadKeyPair(generateKeys().privatePem);
const mandate = (over: Partial<MandatePayload> = {}) => {
  const payload: MandatePayload = {
    v: 1, principal_key: wallet.publicKeyB64, agent_id: "a1", max_total: { amount: 100000, currency: "EUR" },
    merchants: ["tatra-coffee"], expires_at: new Date(Date.now() + 3600_000).toISOString(), nonce: randomUUID(), ...over,
  };
  return { payload, signature: signObject(payload, wallet).value };
};
const buyer = { name: "Test", email: "t@example.sk", address: { line1: "x", city: "Kosice", postal_code: "04001", country: "SK" } };

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalize({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("feed is signed and never leaks floor prices", () => {
  const e = engine();
  const { signature, ...body } = e.feed();
  assert.ok(verifyObject(body, signature!.value, e.keys.publicKey));
  assert.ok(!JSON.stringify(body).includes("floor_price"));
});

test("feed items expose price-per-kg basis", () => {
  const item = engine().getItem("beans-ethiopia-guji-250");
  assert.deepEqual(item.offer.compare_basis, { per: "kg", amount: 5960 });
});

test("intent ranks espresso beans first and explains rejections", () => {
  const r = engine().intent({ need: "espresso low acidity", constraints: { category: ["beans"] } });
  assert.equal(r.matches[0].item_id, "beans-brazil-cerrado-1kg");
  assert.ok(r.rejected.some((x) => x.item_id === "grinder-hand-c40"));
});

test("must_have_claims requires third-party evidence", () => {
  const r = engine().intent({ need: "coffee", constraints: { must_have_claims: ["organic_eu"] } });
  assert.deepEqual(r.matches.map((m) => m.item_id), ["beans-ethiopia-guji-250"]);
});

test("negotiation never goes below floor and ends with a deal token", () => {
  const e = engine();
  let r = e.negotiate({ item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: 100 });
  while (!r.deal_token) r = e.negotiate({ item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: 100, session_id: r.session_id });
  assert.ok(r.unit_price >= 7900);
});

test("non-negotiable item is rejected", () => {
  assert.equal(engine().negotiate({ item_id: "filters-v60-02-100", quantity: 1, proposed_unit_price: 100 }).status, "rejected");
});

test("volume discount applies in quotes", () => {
  const q = engine().createQuote({ lines: [{ item_id: "beans-ethiopia-guji-250", quantity: 10 }], ship_to: "SK" });
  assert.equal(q.lines[0].unit_price, Math.round(1490 * 0.88));
});

test("quotes hold stock", () => {
  const e = engine();
  e.createQuote({ lines: [{ item_id: "grinder-hand-c40", quantity: 7 }], ship_to: "SK" });
  assert.throws(() => e.createQuote({ lines: [{ item_id: "grinder-hand-c40", quantity: 1 }], ship_to: "SK" }), /available/);
});

test("order requires a valid mandate and rejects replay", async () => {
  const e = engine();
  const q = e.createQuote({ lines: [{ item_id: "filters-v60-02-100", quantity: 1 }], ship_to: "SK" });
  const m = mandate();
  const o = await e.placeOrder({ quote_id: q.quote_id, mandate: m, buyer, agent_id: "a1" });
  assert.ok(verifyObject(o.receipt.payload, o.receipt.signature.value, e.keys.publicKey));
  const q2 = e.createQuote({ lines: [{ item_id: "filters-v60-02-100", quantity: 1 }], ship_to: "SK" });
  await assert.rejects(e.placeOrder({ quote_id: q2.quote_id, mandate: m, buyer, agent_id: "a1" }), /replay/);
});

test("mandate limits are enforced", async () => {
  const e = engine();
  const q = () => e.createQuote({ lines: [{ item_id: "grinder-hand-c40", quantity: 1 }], ship_to: "SK" }).quote_id;
  await assert.rejects(e.placeOrder({ quote_id: q(), mandate: mandate({ max_total: { amount: 1000, currency: "EUR" } }), buyer, agent_id: "a1" }), /exceeds/);
  await assert.rejects(e.placeOrder({ quote_id: q(), mandate: mandate({ categories: ["coffee"] }), buyer, agent_id: "a1" }), /categories/);
  await assert.rejects(e.placeOrder({ quote_id: q(), mandate: mandate(), buyer, agent_id: "someone-else" }), /issued to agent/);
  const tampered = mandate();
  tampered.payload.max_total.amount = 99999999;
  await assert.rejects(e.placeOrder({ quote_id: q(), mandate: tampered, buyer, agent_id: "a1" }), /signature/);
});

test("linter flags marketing language", () => {
  const r = lintItem(catalog.items.find((i) => i.id === "mug-tatra")!);
  assert.ok(r.score < 50);
  assert.ok(r.issues.some((i) => i.message.includes("marketing")));
  const sample = catalog.items[0];
  const phrases = lintItem({ ...sample, title: "#1 world-class grinder", summary: "A must-have tool with premium quality construction." });
  const message = phrases.issues.find((i) => i.message.includes("marketing"))!.message;
  for (const phrase of ["#1", "world-class", "must-have", "premium quality"]) assert.ok(message.includes(phrase));
  const factual = lintItem({ ...sample, title: "Coffee beans", summary: "Harvested near a stunningly tall tree; packed in numbered bags." });
  assert.ok(!factual.issues.some((i) => i.message.includes("marketing")), "whole phrases must not match inside longer words");
});

test("attribute filters, delivery window and currency constraints", () => {
  const e = engine();
  const ids = (r: ReturnType<typeof e.intent>) => r.matches.map((m) => m.item_id).sort();
  assert.deepEqual(ids(e.intent({ need: "coffee", constraints: { attributes: [{ key: "acidity_level", op: "lte", value: 2 }] } })), ["beans-brazil-cerrado-1kg", "beans-colombia-decaf-250"]);
  assert.deepEqual(ids(e.intent({ need: "coffee", constraints: { attributes: [{ key: "caffeine", op: "eq", value: false }] } })), ["beans-colombia-decaf-250"]);
  assert.deepEqual(ids(e.intent({ need: "coffee", constraints: { attributes: [{ key: "roast_level", op: "in", value: ["light"] }] } })), ["beans-ethiopia-guji-250"]);
  assert.deepEqual(ids(e.intent({ need: "filters", constraints: { attributes: [{ key: "compatible_with", op: "contains", value: "V60 02" }] } })), ["filters-v60-02-100"]);
  const slow = e.intent({ need: "grinder", constraints: { ship_to: "DE", deliver_within_days: 5 } });
  assert.ok(slow.rejected.find((r) => r.item_id === "grinder-hand-c40")!.reasons[0].includes("delivery"));
  assert.equal(e.intent({ need: "coffee", constraints: { currency: "USD" } }).matches.length, 0);
  assert.ok(e.intent({ need: "coffee", constraints: { ship_to: "US" } }).rejected.every((r) => r.reasons.some((x) => x.includes("ship"))));
  assert.equal(e.intent({ need: "the" }).matches.length, 6, "empty need falls back to neutral score");
});
