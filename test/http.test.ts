import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMerx } from "../src/server.ts";
import { generateKeys, loadKeyPair, publicKeyFromB64, signObject, verifyObject } from "../src/core/crypto.ts";
import type { MandatePayload } from "../src/core/types.ts";

const catalog = JSON.parse(readFileSync(new URL("../examples/stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
const AGENT = "test-agent";
let base = "";
let close = () => {};

before(async () => {
  const { server } = createMerx({ catalog, privateKeyPem: generateKeys().privatePem });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

async function http(method: string, path: string, body?: unknown, raw = false) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "merx-agent-id": AGENT },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: raw ? await res.text() : await res.json().catch(() => null) } as { status: number; body: any };
}

function mandate(over: Partial<MandatePayload> = {}) {
  const w = loadKeyPair(generateKeys().privatePem);
  const payload: MandatePayload = {
    v: 1, principal_key: w.publicKeyB64, agent_id: AGENT, max_total: { amount: 50000, currency: "EUR" },
    merchants: ["tatra-coffee"], expires_at: new Date(Date.now() + 3600_000).toISOString(), nonce: randomUUID(), ...over,
  };
  return { payload, signature: signObject(payload, w).value };
}
const buyer = { name: "Test", email: "t@example.sk", address: { line1: "Hlavná 1", city: "Košice", postal_code: "04001", country: "SK" } };

describe("discovery", () => {
  test("manifest lists protocols and a usable public key", async () => {
    const r = await http("GET", "/.well-known/merx.json");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.protocols.map((p: any) => p.protocol.split("/")[0]), ["merx-rest", "mcp", "a2a"]);
    const feed = await http("GET", "/feed");
    const { signature, ...unsigned } = feed.body;
    assert.ok(verifyObject(unsigned, signature.value, publicKeyFromB64(r.body.public_key.spki_der_b64)));
  });

  test("root and llms.txt are plain text for humans and LLMs", async () => {
    assert.match((await http("GET", "/", undefined, true)).body, /no website/);
    assert.match((await http("GET", "/llms.txt", undefined, true)).body, /## Operations/);
  });

  test("openapi documents every operation", async () => {
    const r = await http("GET", "/openapi.json");
    const ids = Object.values(r.body.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
    for (const id of ["feed", "find_products", "negotiate", "create_quote", "place_order", "get_order"]) assert.ok(ids.includes(id), id);
  });

  test("feed supports category filter and delta sync", async () => {
    const byCat = await http("GET", "/feed?category=grinders");
    assert.deepEqual(byCat.body.items.map((i: any) => i.id), ["grinder-hand-c40"]);
    const delta = await http("GET", `/feed?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    assert.equal(delta.body.items.length, 0);
  });
});

describe("REST purchase flow", () => {
  test("intent → negotiate → quote → order → receipt", async () => {
    const intent = await http("POST", "/v1/intent", { need: "espresso milk drinks", constraints: { ship_to: "SK" } });
    assert.equal(intent.body.matches[0].item_id, "beans-brazil-cerrado-1kg");

    let neg = await http("POST", "/v1/negotiate", { item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: 7000 });
    while (!neg.body.deal_token) neg = await http("POST", "/v1/negotiate", { item_id: "grinder-hand-c40", quantity: 1, proposed_unit_price: 7000, session_id: neg.body.session_id });

    const quote = await http("POST", "/v1/quotes", {
      ship_to: "SK",
      lines: [{ item_id: "beans-brazil-cerrado-1kg", quantity: 1 }, { item_id: "grinder-hand-c40", quantity: 1, deal_token: neg.body.deal_token }],
    });
    assert.equal(quote.status, 200);
    assert.ok(quote.body.lines[1].negotiated);
    assert.equal(quote.body.shipping.price, 0, "free shipping over 35 €");

    const order = await http("POST", "/v1/orders", { quote_id: quote.body.quote_id, mandate: mandate(), buyer });
    assert.equal(order.status, 200);
    assert.equal(order.body.status, "awaiting_payment");

    const fetched = await http("GET", `/v1/orders/${order.body.order_id}`);
    assert.equal(fetched.body.receipt.payload.total.amount, quote.body.total);

    const reuseQuote = await http("POST", "/v1/orders", { quote_id: quote.body.quote_id, mandate: mandate(), buyer });
    assert.equal(reuseQuote.status, 409, "a quote can be ordered only once");
    const reuseDeal = await http("POST", "/v1/quotes", { ship_to: "SK", lines: [{ item_id: "grinder-hand-c40", quantity: 1, deal_token: neg.body.deal_token }] });
    assert.equal(reuseDeal.status, 409, "a deal token is single-use");
  });
});

describe("REST errors", () => {
  const cases: [string, string, string, unknown, number][] = [
    ["unknown route", "GET", "/nope", undefined, 404],
    ["unknown item", "GET", "/v1/items/nope", undefined, 404],
    ["invalid JSON", "POST", "/v1/intent", "{not json", 400],
    ["missing need", "POST", "/v1/intent", {}, 400],
    ["no shipping to country", "POST", "/v1/quotes", { ship_to: "US", lines: [{ item_id: "filters-v60-02-100", quantity: 1 }] }, 400],
    ["over stock", "POST", "/v1/quotes", { ship_to: "SK", lines: [{ item_id: "grinder-hand-c40", quantity: 999 }] }, 409],
    ["forged deal token", "POST", "/v1/quotes", { ship_to: "SK", lines: [{ item_id: "grinder-hand-c40", quantity: 1, deal_token: "abc.def" }] }, 403],
    ["unknown quote", "POST", "/v1/orders", { quote_id: "q_nope", mandate: mandate(), buyer }, 404],
  ];
  for (const [name, method, path, body, status] of cases) {
    test(`${name} → ${status}`, async () => {
      const r = await http(method, path, body);
      assert.equal(r.status, status);
      assert.ok(r.body.error.code);
    });
  }

  test("order with wrong country / expired mandate is refused", async () => {
    const q = async () => (await http("POST", "/v1/quotes", { ship_to: "SK", lines: [{ item_id: "filters-v60-02-100", quantity: 1 }] })).body.quote_id;
    const wrongCountry = await http("POST", "/v1/orders", { quote_id: await q(), mandate: mandate(), buyer: { ...buyer, address: { ...buyer.address, country: "CZ" } } });
    assert.equal(wrongCountry.status, 400);
    const expired = await http("POST", "/v1/orders", { quote_id: await q(), mandate: mandate({ expires_at: "2020-01-01T00:00:00Z" }), buyer });
    assert.equal(expired.status, 410);
    const otherStore = await http("POST", "/v1/orders", { quote_id: await q(), mandate: mandate({ merchants: ["other-store"] }), buyer });
    assert.equal(otherStore.status, 403);
  });

  test("CORS preflight", async () => {
    const r = await fetch(base + "/v1/intent", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });
});

describe("MCP adapter", () => {
  const rpc = (method: string, params?: unknown, id: number | null = 1) => http("POST", "/mcp", { jsonrpc: "2.0", id: id ?? undefined, method, params });

  test("initialize, ping, tools/list", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t" } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.ok(init.body.result.capabilities.tools);
    assert.deepEqual((await rpc("ping")).body.result, {});
    const tools = (await rpc("tools/list")).body.result.tools;
    assert.equal(tools.length, 7);
    for (const t of tools) assert.equal(t.inputSchema.type, "object");
  });

  test("tools/call returns structured content and tool errors", async () => {
    const ok = await rpc("tools/call", { name: "find_products", arguments: { need: "decaf" } });
    assert.equal(ok.body.result.isError, false);
    assert.equal(ok.body.result.structuredContent.matches[0].item_id, "beans-colombia-decaf-250");
    const err = await rpc("tools/call", { name: "get_product", arguments: { item_id: "nope" } });
    assert.equal(err.body.result.isError, true);
  });

  test("protocol errors and notifications", async () => {
    assert.equal((await rpc("nope/method")).body.error.code, -32601);
    assert.equal((await rpc("tools/call", { name: "nope" })).body.error.code, -32602);
    assert.equal((await rpc("notifications/initialized", undefined, null)).status, 202);
    assert.equal((await http("GET", "/mcp", undefined, true)).status, 405);
  });
});

describe("A2A adapter", () => {
  const send = (parts: unknown[]) => http("POST", "/a2a", { jsonrpc: "2.0", id: 7, method: "message/send", params: { message: { role: "user", messageId: "m1", parts } } });

  test("agent card exposes skills", async () => {
    const card = await http("GET", "/.well-known/agent-card.json");
    assert.equal(card.body.skills.length, 7);
    assert.match(card.body.url, /\/a2a$/);
    assert.deepEqual((await http("GET", "/.well-known/agent.json")).body.name, card.body.name);
  });

  test("text part is treated as find_products", async () => {
    const r = await send([{ kind: "text", text: "decaf for the evening" }]);
    assert.equal(r.body.result.parts[0].data.output.matches[0].item_id, "beans-colombia-decaf-250");
  });

  test("data part calls a named operation; errors are data", async () => {
    const ok = await send([{ kind: "data", data: { operation: "get_product", input: { item_id: "mug-tatra" } } }]);
    assert.equal(ok.body.result.parts[0].data.output.id, "mug-tatra");
    const bad = await send([{ kind: "data", data: { operation: "nope", input: {} } }]);
    assert.equal(bad.body.result.parts[0].data.output.error.code, "invalid");
    const wrongMethod = await http("POST", "/a2a", { jsonrpc: "2.0", id: 1, method: "tasks/get" });
    assert.equal(wrongMethod.body.error.code, -32601);
  });
});
