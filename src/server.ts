import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MerxEngine } from "./core/engine.ts";
import type { EngineOptions } from "./core/engine.ts";
import { generateKeys } from "./core/crypto.ts";
import { Router, RawResponse } from "./http/router.ts";
import type { Adapter } from "./adapters/adapter.ts";
import { restAdapter } from "./adapters/rest.ts";
import { mcpAdapter } from "./adapters/mcp.ts";
import { a2aAdapter } from "./adapters/a2a.ts";
import { operations } from "./adapters/operations.ts";
import type { Catalog } from "./core/types.ts";
import { MerxError } from "./core/negotiate.ts";
import type { Ctx, Handler } from "./http/router.ts";
import { paymentsFromEnv, storeFromEnv } from "./config.ts";

export const defaultAdapters: Adapter[] = [restAdapter, mcpAdapter, a2aAdapter];

export type MerxServerOptions = EngineOptions & {
  adapters?: Adapter[];
  /**
   * Enables `/admin/v1/*` (reconcile, refund, retry, cancel) behind
   * `Authorization: Bearer <token>`. At least 32 characters. Omit to disable.
   */
  adminToken?: string;
};

export function createMerx(opts: MerxServerOptions) {
  if (opts.adminToken !== undefined && opts.adminToken.length < 32) throw new Error("adminToken must be at least 32 characters");
  const engine = new MerxEngine(opts);
  const adapters = opts.adapters ?? defaultAdapters;
  const router = new Router();

  // discovery — the only thing an agent needs to know is the domain
  router.get("/.well-known/merx.json", (c) => ({ ...engine.manifest(c.baseUrl), protocols: adapters.map((a) => a.describe(c.baseUrl)) }));
  router.get("/llms.txt", (c) => new RawResponse(200, llmsTxt(engine, c.baseUrl, adapters), { "content-type": "text/plain; charset=utf-8" }));
  router.get("/", (c) =>
    new RawResponse(200, `${engine.catalog.store.name}\n\nThis store has no website. It sells to software agents.\nStart here: ${c.baseUrl}/.well-known/merx.json\n`, { "content-type": "text/plain; charset=utf-8" }),
  );
  for (const a of adapters) a.mount(router, engine);

  // provider → merchant notifications; verified by the provider adapter over the raw body
  const webhook: Handler = (c) => engine.handlePaymentWebhook(c.params.provider, { method: c.req.method ?? "POST", rawBody: c.rawBody ?? Buffer.alloc(0), headers: c.req.headers, query: c.query });
  router.post("/v1/webhooks/payments/:provider", webhook, { raw: true });
  router.get("/v1/webhooks/payments/:provider", webhook, { raw: true });

  if (opts.adminToken) mountAdmin(router, engine, opts.adminToken);

  const server = createServer((req, res) => void router.handle(req, res));
  return { engine, server, router };
}

function mountAdmin(router: Router, engine: MerxEngine, token: string) {
  const expected = createHash("sha256").update(token).digest();
  const guard = (h: Handler): Handler => (c: Ctx) => {
    const auth = String(c.req.headers.authorization ?? "");
    const given = createHash("sha256").update(auth.startsWith("Bearer ") ? auth.slice(7) : "").digest();
    if (!timingSafeEqual(given, expected)) throw new MerxError("unauthenticated", "admin bearer token required");
    return h(c);
  };
  router.get("/admin/v1/orders/:id", guard((c) => engine.getOrder(c.params.id)));
  router.post("/admin/v1/orders/:id/reconcile", guard((c) => engine.reconcilePayment(c.params.id)));
  router.post("/admin/v1/orders/:id/retry-payment", guard((c) => engine.retryPayment(c.params.id)));
  router.post("/admin/v1/orders/:id/refund", guard((c) => engine.refundPayment(c.params.id, c.body ?? {})));
  router.post("/admin/v1/orders/:id/cancel", guard((c) => engine.cancelOrder(c.params.id, typeof c.body?.reason === "string" ? c.body.reason.slice(0, 200) : undefined)));
  router.post("/admin/v1/payments/reconcile", guard(async () => ({ results: await engine.reconcileOpenPayments() })));
}

function llmsTxt(e: MerxEngine, base: string, adapters: Adapter[]) {
  const s = e.catalog.store;
  return [
    `# ${s.name}`,
    `> ${s.description}. Agent-only store powered by Merx. Prices are integer minor units (${s.currency}), tax ${e.catalog.policies.tax_included ? "included" : "excluded"}.`,
    ``,
    `## How to buy`,
    `1. GET ${base}/.well-known/merx.json (manifest, public key)`,
    `2. find_products with your need + constraints (or GET ${base}/feed)`,
    `3. optional: negotiate → deal_token`,
    `4. create_quote → stock is held, price locked`,
    `5. place_order with a mandate signed by your human → signed receipt (order accepted, not yet paid) + one-time access_token`,
    `6. follow payment next_action (e.g. the human pays on a provider-hosted page), then poll payment_status with the access_token`,
    `7. payment_confirmation → store-signed proof of verified settlement (only for providers that verify settlement)`,
    ``,
    `## Protocols`,
    ...adapters.map((a) => { const d = a.describe(base); return `- ${d.protocol}: ${d.endpoint}${d.notes ? ` (${d.notes})` : ""}`; }),
    ``,
    `## Operations`,
    ...operations.map((o) => `- ${o.name}: ${o.description}`),
    ``,
  ].join("\n");
}

function loadKey(): string {
  if (process.env.MERX_PRIVATE_KEY) return process.env.MERX_PRIVATE_KEY.replace(/\\n/g, "\n");
  const path = resolve(process.env.MERX_KEY_FILE ?? ".merx/store-key.pem");
  if (existsSync(path)) return readFileSync(path, "utf8");
  const { privatePem } = generateKeys();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privatePem, { mode: 0o600 });
  console.warn(`[merx] generated new store signing key at ${path} — back it up, agents pin it.`);
  return privatePem;
}

if (import.meta.main ?? process.argv[1]?.endsWith("server.ts")) {
  const catalogPath = resolve(process.env.MERX_CATALOG ?? "examples/stores/tatra-coffee/catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;
  const { payments, defaultPaymentMethod, enabled } = paymentsFromEnv(process.env);
  const store = await storeFromEnv(process.env);
  const { engine, server } = createMerx({
    catalog,
    privateKeyPem: loadKey(),
    payments,
    defaultPaymentMethod,
    store,
    requireOrderAccessToken: process.env.MERX_REQUIRE_ORDER_TOKEN === "1",
    adminToken: process.env.MERX_ADMIN_TOKEN || undefined,
  });
  await engine.ready();
  const hook = process.env.MERX_WEBHOOK_URL;
  const forward = (type: string, data: unknown) => {
    if (hook) fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, data }) }).catch((e) => console.error("[merx] webhook failed", e.message));
  };
  engine.on("order.created", (o) => {
    console.log(`[merx] order ${o.order_id} ${o.quote.total} ${o.quote.currency} by agent ${o.agent_id}`);
    forward("order.created", o);
  });
  engine.on("payment.updated", (o) => {
    console.log(`[merx] payment ${o.order_id} → ${o.payment.status}`);
    forward("payment.updated", { order_id: o.order_id, payment_status: o.payment.status });
  });
  engine.on("payment.anomaly", (a) => console.warn("[merx] payment anomaly — review required", a));
  const interval = Number(process.env.MERX_RECONCILE_INTERVAL_SECONDS ?? 0);
  if (interval > 0) setInterval(() => void engine.reconcileOpenPayments().catch(() => {}), Math.max(60, interval) * 1000).unref();
  const shutdown = () => server.close(() => void engine.close().finally(() => process.exit(0)));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    const lint = engine.lint();
    console.log(`[merx] ${catalog.store.name} — ${catalog.items.length} items, agent-readiness ${lint.score}/100`);
    console.log(`[merx] store: ${store.kind}; payments: ${enabled.join(", ")}${process.env.MERX_ADMIN_TOKEN ? "; admin API enabled" : ""}`);
    console.log(`[merx] http://localhost:${port}/.well-known/merx.json`);
  });
}
