import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createMerx } from "../src/server.ts";
import { generateKeys, verifyObject } from "../src/core/crypto.ts";
import { hostedCheckoutProvider } from "../examples/payments/custom-provider.ts";

test("capability discovery and payment metadata work over REST, MCP and A2A", async () => {
  const catalog = JSON.parse(readFileSync(new URL("../examples/stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
  const { server, engine } = createMerx({ catalog, privateKeyPem: generateKeys().privatePem });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, data: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const input = { intent: { need: "decaf coffee" } };
    const rest = await post("/v1/discover", input);
    const mcp = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "discover_offers", arguments: input } });
    const a2a = await post("/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "data", data: { operation: "discover_offers", input } }] } } });
    for (const packet of [rest.body, mcp.body.result.structuredContent, a2a.body.result.parts[0].data.output]) {
      const { signature, ...payload } = packet;
      assert.equal(packet.format, "merx-capability/0.1");
      assert.ok(verifyObject(payload, signature.value, engine.keys.publicKey));
      assert.ok(packet.cards.length > 0);
    }
    assert.equal((await post("/v1/discover", { intent: { need: "x", constraints: { ship_to: "USA" } } })).status, 400);
    const methods = await (await fetch(base + "/v1/payment-methods?currency=EUR&country=SK")).json() as any[];
    assert.equal(methods[0].id, "bank_transfer");
    assert.deepEqual((await post("/v1/payment-methods", { currency: "EUR" })).body, methods);
    assert.equal((await post("/v1/payment-methods", { currency: 1 })).status, 400);
    const m = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "payment_methods", arguments: { currency: "EUR" } } });
    assert.equal(m.body.result.structuredContent[0].flow, "manual");
    const a = await post("/a2a", { jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { parts: [{ kind: "data", data: { operation: "payment_methods", input: {} } }] } } });
    assert.equal(a.body.result.parts[0].data.output[0].id, "bank_transfer");
    const api = await (await fetch(base + "/openapi.json")).json() as any;
    assert.equal(api.paths["/v1/discover"].post.operationId, "discover_offers");
    assert.ok(api.paths["/v1/quotes"].post.requestBody.content["application/json"].schema.properties.payment_method);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("hosted checkout factory preserves provider context and rejects unsafe returned URLs", async () => {
  const request = { order_id: "order-1", total: 1000, currency: "EUR", country: "SK", quote_id: "quote-1", quote_hash: "hash", idempotency_key: "order-1" };
  let url = "https://payments.example/session/1";
  let id = "session-1";
  const provider = hostedCheckoutProvider({ id: "example", label: "Example", protocols: ["example/1"], currencies: ["EUR"], createSession: async (received) => { assert.deepEqual(received, request); return { id, url }; } });
  assert.equal((await provider.createPayment(request)).checkout_url, url);
  for (const invalid of ["http://payments.example/", "https://user:secret@payments.example/", "javascript:alert(1)"]) {
    url = invalid;
    await assert.rejects(provider.createPayment(request), /HTTPS/);
  }
  url = "https://payments.example/";
  id = "";
  await assert.rejects(provider.createPayment(request), /ID is required/);
});
