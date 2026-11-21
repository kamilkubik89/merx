import type { MerxEngine } from "../core/engine.ts";

/**
 * Every commerce capability is defined ONCE here, with a JSON Schema.
 * Protocol adapters (MCP tools, A2A skills, REST routes, your own protocol)
 * are generated from this list. Add an operation → every protocol gets it.
 */
export type Operation = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (engine: MerxEngine, args: any, agentId: string) => unknown | Promise<unknown>;
};

const money = { type: "integer", description: "minor units (cents)" };

export const operations: Operation[] = [
  {
    name: "store_info",
    description: "Store identity, legal entity, policies (returns, shipping, warranty), negotiation rules and public key.",
    input_schema: { type: "object", properties: {} },
    run: (e) => {
      const f = e.feed();
      return { store: f.store, policies: f.policies, negotiation: f.negotiation, public_key: e.keys.publicKeyB64 };
    },
  },
  {
    name: "find_products",
    description:
      "Describe what the buyer needs; get ranked matches with reasons, plus rejected items with the exact reason (price, stock, shipping, missing certification...). Prefer this over browsing the feed.",
    input_schema: {
      type: "object",
      required: ["need"],
      properties: {
        need: { type: "string", description: "What the buyer needs, in plain language" },
        quantity: { type: "integer", minimum: 1 },
        limit: { type: "integer" },
        constraints: {
          type: "object",
          properties: {
            max_unit_price: money,
            currency: { type: "string" },
            category: { type: "array", items: { type: "string" } },
            must_have_claims: { type: "array", items: { type: "string" }, description: "e.g. organic_eu, fair_trade — only claims with third-party evidence count" },
            attributes: {
              type: "array",
              items: { type: "object", required: ["key", "op", "value"], properties: { key: { type: "string" }, op: { enum: ["eq", "gte", "lte", "in", "contains"] }, value: {} } },
            },
            ship_to: { type: "string", description: "ISO 3166-1 alpha-2" },
            deliver_within_days: { type: "integer" },
          },
        },
      },
    },
    run: (e, a) => e.intent(a),
  },
  {
    name: "discover_offers",
    description: "Experimental Merx Capability Feed: signed intent-specific product facts, evidence references, fresh indicative offers and next actions. Reuse facts by hash; request a quote before ordering.",
    input_schema: {
      type: "object", required: ["intent"], properties: {
        intent: { type: "object", required: ["need"], properties: { need: { type: "string", minLength: 1, maxLength: 2000 }, quantity: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 }, constraints: { type: "object", description: "Same constraints as find_products: category, currency, max_unit_price, attributes, must_have_claims, ship_to, deliver_within_days" } } },
        known_facts: { type: "object", description: "Item ID to previously verified facts_revision SHA-256 hash", additionalProperties: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      },
    },
    run: (e, a) => e.discover(a),
  },
  {
    name: "payment_methods",
    description: "Discover configured payment providers and their advertised protocol identifiers. Optional currency and country filters. Metadata does not imply independent protocol certification.",
    input_schema: { type: "object", properties: { currency: { type: "string" }, country: { type: "string" } } },
    run: (e, a) => e.paymentMethods(a),
  },
  {
    name: "get_product",
    description: "Full structured record of one product: attributes with provenance, evidenced claims, best_for / not_for, live offer.",
    input_schema: { type: "object", required: ["item_id"], properties: { item_id: { type: "string" } } },
    run: (e, a) => e.getItem(a.item_id),
  },
  {
    name: "negotiate",
    description:
      "Propose a unit price for a quantity. Returns accepted / counter / rejected. On acceptance (or final offer) you receive a signed deal_token to use in create_quote. Reuse session_id for the next round.",
    input_schema: {
      type: "object",
      required: ["item_id", "quantity", "proposed_unit_price"],
      properties: { item_id: { type: "string" }, quantity: { type: "integer", minimum: 1 }, proposed_unit_price: money, session_id: { type: "string" } },
    },
    run: (e, a, agent) => e.negotiate({ ...a, agent_id: agent }),
  },
  {
    name: "create_quote",
    description: "Lock prices and HOLD stock for a basket (default 15 minutes). Returns a signed quote with shipping and total.",
    input_schema: {
      type: "object",
      required: ["lines", "ship_to"],
      properties: {
        lines: {
          type: "array",
          items: { type: "object", required: ["item_id", "quantity"], properties: { item_id: { type: "string" }, quantity: { type: "integer" }, deal_token: { type: "string" } } },
        },
        ship_to: { type: "string" },
        shipping_method: { type: "string" },
        payment_method: { type: "string", description: "ID returned by payment_methods; defaults to the store's configured provider" },
      },
    },
    run: (e, a) => e.createQuote(a),
  },
  {
    name: "place_order",
    description:
      "Commit a quote. Requires a mandate signed by the human principal (spending limit, merchant scope, expiry). Returns the order, payment next step, a store-signed receipt (order accepted, not paid) and a one-time order access_token for payment_status.",
    input_schema: {
      type: "object",
      required: ["quote_id", "mandate", "buyer"],
      properties: {
        quote_id: { type: "string" },
        mandate: { type: "object", description: "merx-mandate/1: { payload: {...}, signature }" },
        buyer: {
          type: "object",
          required: ["name", "email", "address"],
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            address: { type: "object", properties: { line1: { type: "string" }, city: { type: "string" }, postal_code: { type: "string" }, country: { type: "string" } } },
          },
        },
      },
    },
    run: async (e, a, agent) => {
      const { order, access_token } = await e.checkout({ ...a, agent_id: agent });
      return { ...order, access_token };
    },
  },
  {
    name: "get_order",
    description: "Order status, payment instructions and signed receipt. Pass the order access_token returned by place_order; stores may require it.",
    input_schema: { type: "object", required: ["order_id"], properties: { order_id: { type: "string" }, access_token: { type: "string", description: "Order access token returned once by place_order" } } },
    run: (e, a) => e.getOrderForAgent(a.order_id, a.access_token),
  },
  {
    name: "payment_status",
    description:
      "Access-controlled payment state for one order (unpaid, requires_action, payment_pending, paid, payment_failed, canceled, refunded...), whether the provider verifies settlement, and the next action. A browser redirect is never proof of payment; poll this instead.",
    input_schema: { type: "object", required: ["order_id", "access_token"], properties: { order_id: { type: "string" }, access_token: { type: "string", description: "Order access token returned once by place_order" } } },
    run: (e, a) => e.paymentStatus(a.order_id, a.access_token),
  },
  {
    name: "payment_confirmation",
    description:
      "Store-signed merx-payment-confirmation/1 statement, issued only after a verified provider event or reconciliation. Distinct from the order receipt, which proves acceptance, not settlement.",
    input_schema: { type: "object", required: ["order_id", "access_token"], properties: { order_id: { type: "string" }, access_token: { type: "string" } } },
    run: (e, a) => e.paymentConfirmation(a.order_id, a.access_token),
  },
];

export const findOp = (name: string) => operations.find((o) => o.name === name);
