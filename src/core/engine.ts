import { EventEmitter } from "node:events";
import { issueToken, loadKeyPair, newId, publicKeyFromB64, readToken, sha256, canonicalize, signObject, verifyObject } from "./crypto.ts";
import type { KeyPair } from "./crypto.ts";
import { buildFeed, MERX_VERSION } from "./feed.ts";
import { lexicalScorer, matchIntent } from "./intent.ts";
import type { Scorer } from "./intent.ts";
import { lintCatalog } from "./lint.ts";
import { MerxError, negotiate, volumeDiscountPct } from "./negotiate.ts";
import type { Session } from "./negotiate.ts";
import type {
  Buyer, Catalog, Feed, FeedItem, Intent, IntentResult, Mandate, NegotiationRequest,
  NegotiationResponse, Order, Quote, QuoteLine,
} from "./types.ts";
import { toFeedItem } from "./feed.ts";
import { manualTransfer, PaymentRegistry } from "./payments.ts";
import type { PaymentProvider } from "./payments.ts";
import { buildCapabilityPacket } from "./capability-feed.ts";
import type { CapabilityRequest } from "./capability-feed.ts";

export { manualTransfer } from "./payments.ts";
export type { PaymentProvider } from "./payments.ts";

type DealPayload = { typ: "deal"; store: string; item_id: string; quantity: number; unit_price: number; exp: number; sid: string };

export type EngineOptions = {
  catalog: Catalog;
  privateKeyPem: string;
  scorer?: Scorer;
  payment?: PaymentProvider;
  payments?: PaymentProvider[];
  defaultPaymentMethod?: string;
  quoteTtlSeconds?: number;
  dealTtlSeconds?: number;
};

/**
 * The Merx engine is protocol-agnostic. REST, MCP, A2A, UCP, ACP... are just
 * adapters that translate their wire format into these method calls.
 */
export class MerxEngine extends EventEmitter {
  readonly catalog: Catalog;
  readonly keys: KeyPair;
  private scorer: Scorer;
  private payments: PaymentRegistry;
  private paymentAttempts = new Map<string, Promise<Order>>();
  private quoteTtl: number;
  private dealTtl: number;
  private sessions = new Map<string, Session>();
  private quotes = new Map<string, { quote: Quote; deals: string[]; consumed: boolean }>();
  private orders = new Map<string, Order>();
  private usedNonces = new Set<string>();
  private usedDeals = new Set<string>();
  private updatedAt = new Map<string, string>();

  constructor(opts: EngineOptions) {
    super();
    this.catalog = structuredClone(opts.catalog);
    this.keys = loadKeyPair(opts.privateKeyPem);
    this.scorer = opts.scorer ?? lexicalScorer;
    if (opts.payment && opts.payments) throw new Error("Use either payment or payments, not both");
    this.payments = new PaymentRegistry(opts.payments ?? [opts.payment ?? manualTransfer], opts.defaultPaymentMethod);
    this.catalog.policies.payment_methods = this.payments.list().map((p) => p.id);
    this.quoteTtl = opts.quoteTtlSeconds ?? 900;
    this.dealTtl = opts.dealTtlSeconds ?? 900;
    const t = new Date().toISOString();
    for (const i of this.catalog.items) this.updatedAt.set(i.id, t);
  }

  // ------------------------------------------------------------ discovery

  manifest(baseUrl: string) {
    return {
      merx: MERX_VERSION,
      store: this.catalog.store,
      public_key: { alg: "Ed25519", key_id: this.keys.keyId, spki_der_b64: this.keys.publicKeyB64 },
      capabilities: ["feed", "feed.delta", "intent", "capability-feed", "payment.discovery", "negotiate", "quote.hold", "order.mandate", "receipt.signed"],
      payment_methods: this.paymentMethods().map((p) => p.id),
      payment_handlers: this.paymentMethods(),
      mandate: { format: "merx-mandate/1", required: true },
      endpoints: { feed: `${baseUrl}/feed`, discover: `${baseUrl}/v1/discover`, payments: `${baseUrl}/v1/payment-methods`, llms_txt: `${baseUrl}/llms.txt` },
      lint_score: lintCatalog(this.catalog).score,
    };
  }

  /** Catalog with stock reduced by active holds. */
  private view(): Catalog {
    this.expire();
    const held = new Map<string, number>();
    for (const q of this.quotes.values()) if (!q.consumed) for (const l of q.quote.lines) held.set(l.item_id, (held.get(l.item_id) ?? 0) + l.quantity);
    return { ...this.catalog, items: this.catalog.items.map((i) => ({ ...i, stock: Math.max(0, i.stock - (held.get(i.id) ?? 0)) })) };
  }

  feed(opts: { since?: string; category?: string } = {}): Feed {
    const feed = buildFeed(this.view(), this.updatedAt, opts);
    return { ...feed, signature: signObject(feed, this.keys) };
  }

  getItem(id: string): FeedItem {
    const v = this.view();
    const item = v.items.find((i) => i.id === id);
    if (!item) throw new MerxError("not_found", `item ${id} not found`);
    return toFeedItem(item, v, { updatedAt: this.updatedAt.get(id)!, offerTtlSeconds: 900, now: new Date() });
  }

  intent(intent: Intent): IntentResult {
    if (!intent || typeof intent.need !== "string") throw new MerxError("invalid", "intent.need (string) is required");
    return matchIntent(this.view(), intent, this.scorer);
  }

  paymentMethods(filter: { currency?: string; country?: string } = {}) {
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || (filter.currency !== undefined && (typeof filter.currency !== "string" || !/^[A-Z]{3}$/.test(filter.currency))) || (filter.country !== undefined && (typeof filter.country !== "string" || !/^[A-Z]{2}$/.test(filter.country)))) throw new MerxError("invalid", "payment filters require ISO currency and country codes");
    return this.payments.list(filter);
  }

  discover(input: CapabilityRequest) {
    const packet = buildCapabilityPacket(this.view(), this.updatedAt, input, this.scorer, (filter) => this.paymentMethods(filter));
    return { ...packet, signature: signObject(packet, this.keys) };
  }

  // ------------------------------------------------------------ negotiation

  negotiate(req: NegotiationRequest): NegotiationResponse {
    return negotiate(this.catalog, this.sessions, req, (d) => this.issueDeal(d), () => newId("neg"));
  }

  private issueDeal(d: { item_id: string; quantity: number; unit_price: number; session_id: string }) {
    const payload: DealPayload = { typ: "deal", store: this.catalog.store.id, ...d, sid: d.session_id, exp: Date.now() + this.dealTtl * 1000 };
    delete (payload as Record<string, unknown>).session_id;
    return issueToken(payload, this.keys);
  }

  // ------------------------------------------------------------ checkout

  createQuote(input: { lines: QuoteLine[]; ship_to: string; shipping_method?: string; payment_method?: string }): Quote {
    const { lines, ship_to } = input;
    if (!Array.isArray(lines) || lines.length === 0) throw new MerxError("invalid", "lines[] required");
    if (!ship_to) throw new MerxError("invalid", "ship_to (ISO country) required");
    const v = this.view();
    const payment = this.payments.select(input.payment_method, { currency: v.store.currency, country: ship_to });
    const distinct = new Set(lines.map((l) => l.item_id)).size;
    if (distinct !== lines.length) throw new MerxError("invalid", "duplicate item_id in lines; merge quantities");
    const deals: string[] = [];

    const out = lines.map((l) => {
      const item = v.items.find((i) => i.id === l.item_id);
      if (!item) throw new MerxError("not_found", `item ${l.item_id} not found`);
      if (!Number.isInteger(l.quantity) || l.quantity < 1) throw new MerxError("invalid", `bad quantity for ${l.item_id}`);
      if (item.stock < l.quantity) throw new MerxError("conflict", `only ${item.stock} of ${l.item_id} available`);
      let unit = Math.round(item.price * (1 - volumeDiscountPct(v, l.quantity, distinct) / 100));
      let negotiated = false;
      if (l.deal_token) {
        const d = readToken<DealPayload>(l.deal_token, this.keys.publicKey);
        if (!d || d.typ !== "deal" || d.store !== this.catalog.store.id) throw new MerxError("unauthorized", "invalid deal_token");
        if (d.item_id !== item.id) throw new MerxError("invalid", "deal_token is for a different item");
        if (d.exp < Date.now()) throw new MerxError("expired", "deal_token expired");
        if (l.quantity < d.quantity) throw new MerxError("invalid", `deal requires quantity >= ${d.quantity}`);
        if (this.usedDeals.has(d.sid)) throw new MerxError("conflict", "deal_token already redeemed");
        if (d.unit_price < unit) { unit = d.unit_price; negotiated = true; }
        deals.push(d.sid);
      }
      return { item_id: item.id, title: item.title, quantity: l.quantity, unit_price: unit, line_total: unit * l.quantity, negotiated };
    });

    const subtotal = out.reduce((s, l) => s + l.line_total, 0);
    const methods = v.policies.shipping.filter((m) => m.regions.includes(ship_to));
    if (!methods.length) throw new MerxError("invalid", `no shipping to ${ship_to}`);
    const method = input.shipping_method
      ? methods.find((m) => m.id === input.shipping_method)
      : [...methods].sort((a, b) => a.price - b.price)[0];
    if (!method) throw new MerxError("invalid", `shipping_method ${input.shipping_method} unavailable for ${ship_to}`);
    const shipPrice = method.free_over !== undefined && subtotal >= method.free_over ? 0 : method.price;
    const maxLead = Math.max(...out.map((l) => v.items.find((i) => i.id === l.item_id)!.lead_time_days));

    const quote: Quote = {
      quote_id: newId("q"),
      store_id: v.store.id,
      lines: out,
      shipping: { method_id: method.id, carrier: method.carrier, price: shipPrice, eta_days: [method.days[0] + maxLead, method.days[1] + maxLead] },
      subtotal,
      total: subtotal + shipPrice,
      currency: v.store.currency,
      tax_included: v.policies.tax_included,
      ship_to,
      payment_method: payment.id,
      expires_at: new Date(Date.now() + this.quoteTtl * 1000).toISOString(),
    };
    quote.signature = signObject(quote, this.keys);
    this.quotes.set(quote.quote_id, { quote, deals, consumed: false });
    this.emit("quote.created", quote);
    return quote;
  }

  verifyMandate(m: Mandate, ctx: { total: number; currency: string; categories: string[]; agent_id: string }): void {
    const p = m?.payload;
    if (!p || p.v !== 1 || !m.signature) throw new MerxError("unauthorized", "mandate missing or malformed");
    let key;
    try { key = publicKeyFromB64(p.principal_key); } catch { throw new MerxError("unauthorized", "mandate principal_key is not a valid Ed25519 SPKI key"); }
    if (!verifyObject(p, m.signature, key)) throw new MerxError("unauthorized", "mandate signature invalid");
    if (new Date(p.expires_at).getTime() < Date.now()) throw new MerxError("expired", "mandate expired");
    if (p.agent_id !== ctx.agent_id) throw new MerxError("unauthorized", `mandate was issued to agent ${p.agent_id}`);
    if (!p.merchants.includes("*") && !p.merchants.includes(this.catalog.store.id)) throw new MerxError("unauthorized", "mandate does not cover this merchant");
    if (p.max_total.currency !== ctx.currency) throw new MerxError("unauthorized", "mandate currency mismatch");
    if (ctx.total > p.max_total.amount) throw new MerxError("unauthorized", `total ${ctx.total} exceeds mandate limit ${p.max_total.amount}`);
    if (p.categories?.length) {
      const bad = ctx.categories.filter((c) => !p.categories!.includes(c));
      if (bad.length) throw new MerxError("unauthorized", `mandate does not allow categories: ${bad.join(",")}`);
    }
    if (this.usedNonces.has(p.nonce)) throw new MerxError("conflict", "mandate nonce already used (replay)");
  }

  async placeOrder(input: { quote_id: string; mandate: Mandate; buyer: Buyer; agent_id: string }): Promise<Order> {
    this.expire();
    const entry = this.quotes.get(input.quote_id);
    if (!entry) throw new MerxError("not_found", "quote not found or expired; create a new quote");
    if (entry.consumed) throw new MerxError("conflict", "quote already used");
    const q = entry.quote;
    const b = input.buyer;
    if (!b?.name || !b?.email || !b?.address?.country) throw new MerxError("invalid", "buyer.name, buyer.email, buyer.address required");
    if (b.address.country !== q.ship_to) throw new MerxError("invalid", `buyer country ${b.address.country} != quote ship_to ${q.ship_to}`);
    const categories = [...new Set(q.lines.map((l) => this.catalog.items.find((i) => i.id === l.item_id)!.category[0]))];
    this.verifyMandate(input.mandate, { total: q.total, currency: q.currency, categories, agent_id: input.agent_id });

    // commit
    entry.consumed = true;
    this.usedNonces.add(input.mandate.payload.nonce);
    entry.deals.forEach((d) => this.usedDeals.add(d));
    const now = new Date().toISOString();
    for (const l of q.lines) {
      const item = this.catalog.items.find((i) => i.id === l.item_id)!;
      item.stock -= l.quantity;
      this.updatedAt.set(item.id, now);
    }
    const order_id = newId("ord");
    const receiptPayload = {
      typ: "merx-receipt/1",
      order_id,
      store_id: q.store_id,
      quote_hash: sha256(canonicalize(q)),
      total: { amount: q.total, currency: q.currency },
      lines: q.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price })),
      agent_id: input.agent_id,
      mandate_nonce: input.mandate.payload.nonce,
      issued_at: now,
    };
    const order: Order = {
      order_id,
      quote: q,
      buyer: b,
      agent_id: input.agent_id,
      mandate_nonce: input.mandate.payload.nonce,
      status: "payment_pending",
      payment: { method: q.payment_method, instructions: {} },
      created_at: now,
      receipt: { payload: receiptPayload, signature: signObject(receiptPayload, this.keys) },
    };
    this.orders.set(order_id, order);
    await this.retryPayment(order_id);
    this.emit("order.created", order);
    return order;
  }

  /** Server-side recovery hook. Do not expose without authenticating the caller. */
  async retryPayment(orderId: string): Promise<Order> {
    const existing = this.paymentAttempts.get(orderId);
    if (existing) return existing;
    const order = this.getOrder(orderId);
    if (order.status !== "payment_pending" && order.status !== "payment_setup_failed") return order;
    const attempt = Promise.resolve().then(async () => {
      order.status = "payment_pending";
      delete order.payment.error;
      try {
        const provider = this.payments.select(order.payment.method, { currency: order.quote.currency, country: order.quote.ship_to });
        order.payment.instructions = await provider.createPayment({ order_id: order.order_id, total: order.quote.total, currency: order.quote.currency, country: order.quote.ship_to, quote_id: order.quote.quote_id, quote_hash: sha256(canonicalize(order.quote)), idempotency_key: order.order_id });
        order.status = "awaiting_payment";
      } catch {
        // A timeout may have happened after provider-side creation. Keep the order
        // and reservation; retry the same provider with the same idempotency key.
        order.status = "payment_setup_failed";
        order.payment.error = "payment_setup_failed";
      }
      return order;
    });
    this.paymentAttempts.set(orderId, attempt);
    try { return await attempt; } finally { this.paymentAttempts.delete(orderId); }
  }

  getOrder(id: string): Order {
    const o = this.orders.get(id);
    if (!o) throw new MerxError("not_found", `order ${id} not found`);
    return o;
  }

  lint() {
    return lintCatalog(this.catalog);
  }

  private expire() {
    const now = Date.now();
    for (const [id, q] of this.quotes) if (!q.consumed && new Date(q.quote.expires_at).getTime() < now) this.quotes.delete(id);
    for (const [id, s] of this.sessions) if (now - s.created > 30 * 60_000) this.sessions.delete(id);
  }
}

export { MerxError };
