import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { generateKeys, loadKeyPair, signObject } from "../src/core/crypto.ts";
import type { Catalog, MandatePayload } from "../src/core/types.ts";
import type { FetchLike } from "../src/payments/http.ts";

export const catalog: Catalog = JSON.parse(readFileSync(new URL("../examples/stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
export const storeKey = generateKeys().privatePem;
export const buyer = { name: "Test", email: "t@example.sk", address: { line1: "1 Main Street", city: "Kosice", postal_code: "04001", country: "SK" } };
const wallet = loadKeyPair(generateKeys().privatePem);

export function mandate(agent = "a1", over: Partial<MandatePayload> = {}) {
  const payload: MandatePayload = {
    v: 1, principal_key: wallet.publicKeyB64, agent_id: agent, max_total: { amount: 100000, currency: "EUR" },
    merchants: ["tatra-coffee"], expires_at: new Date(Date.now() + 3600_000).toISOString(), nonce: randomUUID(), ...over,
  };
  return { payload, signature: signObject(payload, wallet).value };
}

type Res = { ok: boolean; status: number; json(): Promise<unknown> };
const reply = (status: number, body: unknown): Res => ({ ok: status < 400, status, json: async () => body });

export type FakeSession = {
  id: string; object: "checkout.session"; url: string; status: "open" | "complete" | "expired"; payment_status: "paid" | "unpaid";
  amount_total: number; currency: string; client_reference_id: string; metadata: Record<string, string>; payment_intent: string | null; livemode: boolean; expires_at: number;
};

/** In-memory imitation of the Stripe endpoints Merx uses. Honors Idempotency-Key like Stripe. */
export function fakeStripe() {
  const sessions = new Map<string, FakeSession>();
  const byKey = new Map<string, unknown>();
  const calls: { method: string; url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  let n = 0;
  let failNext = 0;
  const fetch: FetchLike = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    const body = new URLSearchParams(init.body ?? "");
    calls.push({ method, url, headers, body });
    if (failNext > 0) { failNext--; return reply(500, { error: { code: "api_error", message: "boom with buyer@example.sk" } }); }
    if (headers.authorization !== "Bearer sk_test_123") return reply(401, { error: { code: "invalid_api_key" } });
    const key = headers["idempotency-key"];
    if (key && byKey.has(`${method} ${new URL(url).pathname} ${key}`)) return reply(200, byKey.get(`${method} ${new URL(url).pathname} ${key}`));
    const path = new URL(url).pathname;
    let out: unknown;
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const id = `cs_test_${++n}abc`;
      const s: FakeSession = {
        id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid",
        amount_total: Number(body.get("line_items[0][price_data][unit_amount]")), currency: body.get("line_items[0][price_data][currency]")!,
        client_reference_id: body.get("client_reference_id")!, metadata: { merx_order_id: body.get("metadata[merx_order_id]")! }, payment_intent: null, livemode: false, expires_at: Number(body.get("expires_at")),
      };
      sessions.set(id, s);
      out = s;
    } else if (method === "GET" && path.startsWith("/v1/checkout/sessions/")) {
      out = sessions.get(path.split("/").pop()!);
      if (!out) return reply(404, { error: { code: "resource_missing" } });
    } else if (method === "POST" && path.endsWith("/expire")) {
      const s = sessions.get(path.split("/")[4])!;
      s.status = "expired";
      out = s;
    } else if (method === "POST" && path === "/v1/refunds") {
      out = { id: `re_${++n}`, status: Number(body.get("amount")) === 13 ? "failed" : "succeeded" };
    } else {
      return reply(404, { error: { code: "unknown" } });
    }
    if (key) byKey.set(`${method} ${path} ${key}`, out);
    return reply(200, out);
  };
  return {
    fetch, sessions, calls,
    failNext: (count = 1) => { failNext = count; },
    pay(id: string) {
      const s = sessions.get(id)!;
      Object.assign(s, { status: "complete", payment_status: "paid", payment_intent: `pi_${id}` });
      return s;
    },
  };
}

export function stripeEvent(type: string, session: unknown, id = `evt_${randomUUID().replace(/-/g, "")}`, over: Record<string, unknown> = {}) {
  return JSON.stringify({ id, object: "event", type, livemode: false, data: { object: session }, ...over });
}

/** In-memory imitation of the GoPay REST endpoints Merx uses. */
export function fakeGoPay() {
  const payments = new Map<string, { id: number; order_number: string; state: string; amount: number; currency: string; gw_url: string }>();
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  let n = 3000000000;
  let tokens = 0;
  const fetch: FetchLike = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    calls.push({ method, url, headers, body: init.body });
    const path = new URL(url).pathname;
    if (path === "/api/oauth2/token") {
      if (headers.authorization !== `Basic ${Buffer.from("cid:secret").toString("base64")}`) return reply(401, { errors: [{ error_name: "AUTH_WRONG_CREDENTIALS" }] });
      tokens++;
      return reply(200, { access_token: `tok${tokens}`, token_type: "bearer", expires_in: 1800 });
    }
    if (!headers.authorization?.startsWith("Bearer tok")) return reply(403, { errors: [{ error_name: "AUTH_WRONG_TOKEN" }] });
    if (method === "POST" && path === "/api/payments/payment") {
      const b = JSON.parse(init.body!);
      const id = ++n;
      const p = { id, order_number: b.order_number, state: "CREATED", amount: b.amount, currency: b.currency, gw_url: `https://gw.sandbox.gopay.com/gw/v3/${id}` };
      payments.set(String(id), p);
      return reply(200, p);
    }
    const m = path.match(/^\/api\/payments\/payment\/(\d+)(\/refund)?$/);
    if (m && payments.has(m[1])) {
      const p = payments.get(m[1])!;
      if (m[2]) {
        const amount = Number(new URLSearchParams(init.body).get("amount"));
        p.state = amount === p.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
        return reply(200, { id: p.id, result: amount === 7 ? "FAILED" : "FINISHED" });
      }
      return reply(200, p);
    }
    return reply(404, { errors: [{ error_name: "PAYMENT_NOT_FOUND" }] });
  };
  return { fetch, payments, calls, tokens: () => tokens };
}
