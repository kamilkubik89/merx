/**
 * Merx core domain types.
 *
 * Two shapes matter:
 *  - `Catalog`  — what the MERCHANT writes (private: contains floor prices, stock).
 *  - `Feed`     — what AGENTS read (public, signed, never contains floors).
 *
 * All money is integer minor units (cents). No floats, ever.
 */

import type { PaymentStatus } from "./payment-state.ts";

export type Money = { amount: number; currency: string };

/** Where a fact comes from. Agents weight facts by provenance. */
export type FactSource = "declared" | "measured" | "lab_test" | "certified" | "third_party";

export type Attribute = {
  key: string; // snake_case, e.g. "net_weight"
  value: string | number | boolean | string[];
  unit?: string; // SI or UCUM-ish: "g", "ml", "mm", "kWh", "%"
  source: FactSource;
  note?: string;
};

/** A claim is a marketing-ish statement that MUST carry evidence to be shown to agents. */
export type Claim = {
  id: string; // machine id: "organic_eu", "fair_trade", "vegan"
  statement: string;
  evidence?: { type: "certificate" | "lab_report" | "audit" | "self_declared"; issuer?: string; ref?: string; url?: string };
};

export type CatalogItem = {
  id: string;
  gtin?: string;
  group_id?: string; // variants share a group_id
  title: string;
  summary: string; // factual, <= 280 chars, no superlatives (see lint)
  category: string[]; // path, most general first: ["coffee", "beans"]
  attributes: Attribute[];
  claims?: Claim[];
  best_for?: string[];
  not_for?: string[]; // radical honesty: who should NOT buy this
  price: number; // list price, minor units, VAT included
  stock: number;
  lead_time_days: number; // time until the parcel leaves the warehouse
  media?: { type: "image" | "video" | "document"; url: string; alt: string }[];
  negotiation?: { floor_price: number }; // PRIVATE. Never leaves the engine.
};

export type ShippingMethod = {
  id: string;
  carrier: string;
  regions: string[]; // ISO 3166-1 alpha-2
  price: number;
  free_over?: number;
  days: [number, number]; // transit min/max
};

export type Policies = {
  returns: { window_days: number; condition: string; refund: "full" | "partial" | "store_credit"; return_shipping_paid_by: "buyer" | "seller" };
  shipping: ShippingMethod[];
  warranty_months: number;
  payment_methods: string[];
  tax_included: boolean;
};

export type NegotiationRule =
  | { type: "volume"; min_qty: number; discount_pct: number }
  | { type: "bundle"; min_distinct_items: number; discount_pct: number };

export type Catalog = {
  store: {
    id: string;
    name: string;
    url: string;
    description: string;
    currency: string;
    languages: string[];
    legal: { company: string; country: string; vat_id?: string; contact_email: string };
  };
  policies: Policies;
  negotiation?: { enabled: boolean; max_rounds: number; concession?: number; rules: NegotiationRule[] };
  items: CatalogItem[];
};

// ---------------------------------------------------------------- public feed

export type FeedOffer = {
  price: Money;
  compare_basis?: { per: string; amount: number }; // e.g. price per kg
  availability: { in_stock: boolean; quantity: number; lead_time_days: number };
  negotiable: boolean;
  valid_until: string; // ISO — the price is a signed commitment until then
};

export type FeedItem = Omit<CatalogItem, "price" | "stock" | "lead_time_days" | "negotiation"> & {
  offer: FeedOffer;
  content_hash: string; // lets agents sync incrementally
  updated_at: string;
};

export type Feed = {
  merx: string; // spec version
  store: Catalog["store"];
  policies: Policies;
  negotiation: { enabled: boolean; max_rounds: number; public_rules: NegotiationRule[] };
  generated_at: string;
  ttl_seconds: number;
  items: FeedItem[];
  signature?: Signature;
};

export type Signature = { alg: "Ed25519"; key_id: string; value: string };

// ---------------------------------------------------------------- intent

export type AttributeFilter = { key: string; op: "eq" | "gte" | "lte" | "in" | "contains"; value: unknown };

export type Intent = {
  need: string; // natural language, e.g. "whole bean coffee for espresso, low acidity"
  quantity?: number;
  constraints?: {
    max_unit_price?: number;
    currency?: string;
    category?: string[];
    must_have_claims?: string[];
    attributes?: AttributeFilter[];
    ship_to?: string;
    deliver_within_days?: number;
  };
  limit?: number;
};

export type IntentMatch = {
  item_id: string;
  title: string;
  score: number; // 0..1
  unit_price: Money;
  reasons: string[];
  warnings: string[];
};

export type IntentResult = {
  matches: IntentMatch[];
  rejected: { item_id: string; reasons: string[] }[];
};

// ---------------------------------------------------------------- negotiation, checkout

export type NegotiationRequest = {
  session_id?: string;
  item_id: string;
  quantity: number;
  proposed_unit_price: number;
  agent_id?: string;
};

export type NegotiationResponse = {
  session_id: string;
  status: "accepted" | "counter" | "rejected";
  unit_price: number; // accepted price, or counter-offer
  rounds_left: number;
  deal_token?: string; // present when accepted: signed, redeemable in a quote
  message: string;
};

export type QuoteLine = { item_id: string; quantity: number; deal_token?: string };

export type Quote = {
  quote_id: string;
  store_id: string;
  lines: { item_id: string; title: string; quantity: number; unit_price: number; line_total: number; negotiated: boolean }[];
  shipping: { method_id: string; carrier: string; price: number; eta_days: [number, number] };
  subtotal: number;
  total: number;
  currency: string;
  tax_included: boolean;
  ship_to: string;
  payment_method: string; // provider selected before signing the quote
  expires_at: string; // stock is held until then
  signature?: Signature;
};

/** A mandate is the human's signed permission for an agent to spend. Inspired by AP2 intent mandates. */
export type MandatePayload = {
  v: 1;
  principal_key: string; // base64 SPKI DER Ed25519 public key of the human / wallet
  agent_id: string;
  max_total: Money;
  merchants: string[]; // store ids, or ["*"]
  categories?: string[]; // allowed top-level categories
  expires_at: string;
  nonce: string;
};

export type Mandate = { payload: MandatePayload; signature: string };

export type Buyer = {
  name: string;
  email: string;
  address: { line1: string; city: string; postal_code: string; country: string };
};

/** Signed statement that a payment provider event was verified server-side. Distinct from the order receipt. */
export type PaymentConfirmation = {
  payload: {
    typ: "merx-payment-confirmation/1";
    order_id: string;
    store_id: string;
    quote_hash: string;
    receipt_hash: string;
    amount: Money;
    provider: string;
    provider_payment_id: string;
    status: "paid";
    verified_by: "webhook" | "reconciliation";
    event_id?: string;
    verified_at: string;
  };
  signature: Signature;
};

export type OrderPayment = {
  method: string;
  /** What the buyer needs next (redirect URL, demo transfer details...). Defined by the trusted provider adapter. */
  instructions: Record<string, unknown>;
  error?: "payment_setup_failed";
  /** Payment state machine, independent of fulfillment. See docs/adr/0001-verified-payments.md. */
  status: PaymentStatus;
  /** True only for providers that verify settlement (webhook or server-to-server status check). */
  verifies_settlement: boolean;
  amount: number;
  currency: string;
  refunded_amount: number;
  attempt_id?: string;
  attempt?: number;
  provider_payment_id?: string;
  updated_at?: string;
  confirmation?: PaymentConfirmation;
  /** Administrative refunds issued through the provider. */
  refunds?: { refund_id: string; amount: number; idempotency_key: string; status: "succeeded" | "pending"; created_at: string }[];
};

export type Order = {
  order_id: string;
  quote: Quote;
  buyer: Buyer;
  agent_id: string;
  mandate_nonce: string;
  /**
   * Legacy combined status kept for 0.2 compatibility. New integrations should
   * read `payment.status` for money and track fulfillment separately.
   */
  status: "payment_pending" | "payment_setup_failed" | "awaiting_payment" | "paid" | "refunded" | "shipped" | "delivered" | "cancelled";
  payment: OrderPayment;
  created_at: string;
  receipt: { payload: Record<string, unknown>; signature: Signature };
};
