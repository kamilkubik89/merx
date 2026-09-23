import type { Adapter } from "./adapter.ts";
import { RawResponse } from "../http/router.ts";
import { operations } from "./operations.ts";
import { MERX_VERSION } from "../core/feed.ts";

/** Plain HTTP+JSON. The reference binding; every other adapter maps onto the same engine. */
export const restAdapter: Adapter = {
  name: "rest",
  describe: (base) => ({ protocol: "merx-rest/0.1", endpoint: `${base}/v1`, notes: `OpenAPI: ${base}/openapi.json` }),
  mount(r, e) {
    r.get("/feed", (c) => e.feed({ since: c.query.get("since") ?? undefined, category: c.query.get("category") ?? undefined }));
    r.get("/feed.json", (c) => e.feed({ since: c.query.get("since") ?? undefined, category: c.query.get("category") ?? undefined }));
    r.get("/v1/store", () => e.feed().store);
    r.get("/v1/items/:id", (c) => e.getItem(c.params.id));
    r.post("/v1/intent", (c) => e.intent(c.body));
    r.post("/v1/discover", (c) => e.discover(c.body));
    r.post("/v1/payment-methods", (c) => e.paymentMethods(c.body ?? {}));
    r.get("/v1/payment-methods", (c) => e.paymentMethods({ currency: c.query.get("currency") ?? undefined, country: c.query.get("country") ?? undefined }));
    r.post("/v1/negotiate", (c) => e.negotiate({ ...c.body, agent_id: c.agentId }));
    r.post("/v1/quotes", (c) => e.createQuote(c.body));
    r.post("/v1/orders", (c) => e.placeOrder({ ...c.body, agent_id: c.agentId }));
    r.get("/v1/orders/:id", (c) => e.getOrder(c.params.id));
    r.get("/v1/lint", () => e.lint());
    r.get("/openapi.json", (c) => openapi(c.baseUrl));
  },
};

const REST_PATHS: Record<string, [string, string]> = {
  store_info: ["get", "/v1/store"],
  find_products: ["post", "/v1/intent"],
  discover_offers: ["post", "/v1/discover"],
  payment_methods: ["post", "/v1/payment-methods"],
  get_product: ["get", "/v1/items/{item_id}"],
  negotiate: ["post", "/v1/negotiate"],
  create_quote: ["post", "/v1/quotes"],
  place_order: ["post", "/v1/orders"],
  get_order: ["get", "/v1/orders/{order_id}"],
};

function openapi(base: string) {
  const paths: Record<string, any> = {
    "/feed": { get: { operationId: "feed", summary: "Signed product feed. ?since=ISO for delta sync, ?category= to filter.", responses: { 200: { description: "Feed" } } } },
  };
  for (const op of operations) {
    const [method, path] = REST_PATHS[op.name];
    const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    paths[path] = {
      ...paths[path],
      [method]: {
        operationId: op.name,
        summary: op.description,
        parameters: [{ name: "Merx-Agent-Id", in: "header", required: false, schema: { type: "string" } }, ...params],
        ...(method === "post" ? { requestBody: { required: true, content: { "application/json": { schema: op.input_schema } } } } : {}),
        responses: { 200: { description: "OK" }, 400: { description: "invalid" }, 403: { description: "unauthorized (mandate)" }, 404: { description: "not found" }, 409: { description: "conflict" }, 410: { description: "expired" } },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: "Merx store API", version: MERX_VERSION }, servers: [{ url: base }], paths };
}

export { RawResponse };
