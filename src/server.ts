import { createServer } from "node:http";
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

export const defaultAdapters: Adapter[] = [restAdapter, mcpAdapter, a2aAdapter];

export function createMerx(opts: EngineOptions & { adapters?: Adapter[] }) {
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

  const server = createServer((req, res) => void router.handle(req, res));
  return { engine, server, router };
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
    `5. place_order with a mandate signed by your human → signed receipt`,
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
  const { engine, server } = createMerx({ catalog, privateKeyPem: loadKey() });
  const hook = process.env.MERX_WEBHOOK_URL;
  engine.on("order.created", (o) => {
    console.log(`[merx] order ${o.order_id} ${o.quote.total} ${o.quote.currency} by agent ${o.agent_id}`);
    if (hook) fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "order.created", data: o }) }).catch((e) => console.error("[merx] webhook failed", e.message));
  });
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    const lint = engine.lint();
    console.log(`[merx] ${catalog.store.name} — ${catalog.items.length} items, agent-readiness ${lint.score}/100`);
    console.log(`[merx] http://localhost:${port}/.well-known/merx.json`);
  });
}
