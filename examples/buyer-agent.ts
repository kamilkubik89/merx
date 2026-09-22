/**
 * A scripted buyer agent doing a full purchase against a Merx store.
 * Run:  npm run demo
 *
 * The human said: "Buy me good coffee for my espresso machine, organic if
 * possible, and a hand grinder. Max 150 EUR. Deliver to Košice this week."
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createMerx } from "../src/server.ts";
import { generateKeys, loadKeyPair, publicKeyFromB64, signObject, verifyObject } from "../src/core/crypto.ts";
import type { MandatePayload } from "../src/core/types.ts";

const AGENT = "demo-buyer-agent/1.0";
const catalog = JSON.parse(readFileSync(new URL("./stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
const { server } = createMerx({ catalog, privateKeyPem: generateKeys().privatePem });
await new Promise<void>((r) => server.listen(0, r));
const BASE = `http://localhost:${(server.address() as any).port}`;

const eur = (c: number) => `${(c / 100).toFixed(2)} €`;
const step = (n: number, s: string) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "merx-agent-id": AGENT }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json as any;
};

try {
  step(1, "Discover the store from its domain");
  const manifest = await call("GET", "/.well-known/merx.json");
  console.log(`   ${manifest.store.name} — speaks: ${manifest.protocols.map((p: any) => p.protocol).join(", ")}`);
  console.log(`   agent-readiness ${manifest.lint_score}/100, key ${manifest.public_key.key_id}`);
  const storeKey = publicKeyFromB64(manifest.public_key.spki_der_b64);

  step(2, "Pull the feed and verify the store's signature");
  const feed = await call("GET", "/feed");
  const { signature, ...unsigned } = feed;
  console.log(`   ${feed.items.length} items, signature valid: ${verifyObject(unsigned, signature.value, storeKey)}`);

  step(3, "State the intent (no browsing)");
  const coffee = await call("POST", "/v1/intent", {
    need: "coffee beans for espresso machine, milk drinks, low acidity",
    constraints: { category: ["beans"], ship_to: "SK", deliver_within_days: 5 },
  });
  for (const m of coffee.matches) console.log(`   ✓ ${m.score.toFixed(2)}  ${m.title}  ${eur(m.unit_price.amount)}  ${m.warnings.join("; ")}`);
  for (const r of coffee.rejected) console.log(`   ✗ ${r.item_id}: ${r.reasons.join("; ")}`);

  const organic = await call("POST", "/v1/intent", { need: "espresso coffee", constraints: { must_have_claims: ["organic_eu"] } });
  console.log(`   organic espresso available? ${organic.matches.filter((m: any) => !m.warnings.length).length ? "yes" : "no — merchant marks the only organic coffee as not_for espresso"}`);

  const grinder = await call("POST", "/v1/intent", { need: "hand grinder for espresso", constraints: { category: ["grinders"], max_unit_price: 8000 } });
  console.log(`   grinder under 80 €: ${grinder.matches.length} match; rejected: ${grinder.rejected.find((r: any) => r.item_id === "grinder-hand-c40")?.reasons.join("; ")}`);

  step(4, "Negotiate the grinder (policy engine, max 3 rounds)");
  let neg = await call("POST", "/v1/negotiate", { item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: 7000 });
  console.log(`   offer 70.00 € → ${neg.status} ${eur(neg.unit_price)} (${neg.rounds_left} rounds left)`);
  while (neg.status === "counter" && !neg.deal_token) {
    const proposal = neg.unit_price - 300;
    neg = await call("POST", "/v1/negotiate", { item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: proposal, session_id: neg.session_id });
    console.log(`   offer ${eur(proposal)} → ${neg.status} ${eur(neg.unit_price)} ${neg.deal_token ? "[deal_token]" : ""}`);
  }

  step(5, "Quote: lock prices, hold stock");
  const coffeeId = coffee.matches[0].item_id;
  const quote = await call("POST", "/v1/quotes", {
    ship_to: "SK",
    lines: [
      { item_id: coffeeId, quantity: 1 },
      { item_id: "grinder-hand-c40", quantity: 1, deal_token: neg.deal_token },
    ],
  });
  for (const l of quote.lines) console.log(`   ${l.quantity}× ${l.title}  ${eur(l.line_total)}${l.negotiated ? "  (negotiated)" : ""}`);
  console.log(`   shipping ${quote.shipping.carrier} ${eur(quote.shipping.price)}, ETA ${quote.shipping.eta_days.join("–")} days`);
  console.log(`   TOTAL ${eur(quote.total)} (VAT incl.), held until ${quote.expires_at}`);

  step(6, "Human's wallet signs a mandate (max 150 €, this store, coffee+equipment, 24 h)");
  const wallet = loadKeyPair(generateKeys().privatePem);
  const payload: MandatePayload = {
    v: 1, principal_key: wallet.publicKeyB64, agent_id: AGENT,
    max_total: { amount: 15000, currency: "EUR" }, merchants: ["tatra-coffee"], categories: ["coffee", "equipment"],
    expires_at: new Date(Date.now() + 86400_000).toISOString(), nonce: randomUUID(),
  };
  const mandate = { payload, signature: signObject(payload, wallet).value };
  console.log(`   mandate nonce ${payload.nonce.slice(0, 8)}…, limit ${eur(payload.max_total.amount)}`);

  step(7, "Place the order");
  const order = await call("POST", "/v1/orders", {
    quote_id: quote.quote_id, mandate,
    buyer: { name: "Jana Nováková", email: "jana@example.sk", address: { line1: "Hlavná 1", city: "Košice", postal_code: "04001", country: "SK" } },
  });
  console.log(`   ${order.order_id} — ${order.status}, pay via ${order.payment.method}`);
  const receiptOk = verifyObject(order.receipt.payload, order.receipt.signature.value, storeKey);
  console.log(`   store-signed receipt valid: ${receiptOk}`);

  step(8, "Replay attack with the same mandate");
  const q2 = await call("POST", "/v1/quotes", { ship_to: "SK", lines: [{ item_id: "filters-v60-02-100", quantity: 1 }] });
  try {
    await call("POST", "/v1/orders", { quote_id: q2.quote_id, mandate, buyer: order.buyer });
  } catch (e: any) {
    console.log(`   rejected as expected: ${e.message}`);
  }

  step(9, "Same store over MCP");
  const tools = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  console.log(`   MCP tools: ${tools.result.tools.map((t: any) => t.name).join(", ")}`);
  console.log("\nDone.\n");
} finally {
  server.close();
}
