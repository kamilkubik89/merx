import { EventEmitter } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
  NegotiationResponse, Order, PaymentConfirmation, Quote, QuoteLine,
} from "./types.ts";
import { assertMinorAmount, assertMoney } from "./money.ts";
import { canTransition, isOpen, isPaymentStatus, SETTLED_STATUSES } from "./payment-state.ts";
import type { PaymentStatus } from "./payment-state.ts";
import { MemoryStore, StoreConflictError } from "./storage.ts";
import type { MerxStore, OrderRecord, PaymentAttempt, StoreSnapshot } from "./storage.ts";
import { WebhookVerificationError } from "./payments.ts";
import type { ProviderPaymentStatus, VerifiedPaymentEvent, WebhookRequest } from "./payments.ts";
import { toFeedItem } from "./feed.ts";
import { manualTransfer, PaymentRegistry } from "./payments.ts";
import type { PaymentProvider } from "./payments.ts";
import { buildCapabilityPacket } from "./capability-feed.ts";
import type { CapabilityRequest } from "./capability-feed.ts";

export { manualTransfer, WebhookVerificationError } from "./payments.ts";
export type { PaymentProvider, PaymentSetup, ProviderPaymentStatus, VerifiedPaymentEvent, WebhookRequest, RefundRequest, RefundResult } from "./payments.ts";
export { MemoryStore, StoreConflictError } from "./storage.ts";
export type { MerxStore } from "./storage.ts";
export type { PaymentStatus } from "./payment-state.ts";

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
  /** Durable state. Defaults to a non-durable `MemoryStore`. */
  store?: MerxStore;
  /** Require the buyer's order access token for `get_order`. Defaults to false in 0.3 for compatibility; planned default in 0.4. */
  requireOrderAccessToken?: boolean;
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
  private store: MerxStore;
  private hydrated = false;
  private readyPromise: Promise<void>;
  private requireAccessToken: boolean;
  private attempts = new Map<string, PaymentAttempt>();
  private attemptRefs = new Map<string, string>();
  private locks = new Map<string, Promise<void>>();
  private quoteTtl: number;
  private dealTtl: number;
  private sessions = new Map<string, Session>();
  private quotes = new Map<string, { quote: Quote; deals: string[]; consumed: boolean }>();
  private orders = new Map<string, OrderRecord>();
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
    this.requireAccessToken = opts.requireOrderAccessToken ?? false;
    this.store = opts.store ?? new MemoryStore();
    const snapshot = this.store.load();
    if (snapshot instanceof Promise) {
      this.readyPromise = snapshot.then((s) => this.hydrate(s));
      this.readyPromise.catch(() => {});
    } else {
      this.hydrate(snapshot);
      this.readyPromise = Promise.resolve();
    }
  }

  // ------------------------------------------------------------ discovery

  manifest(baseUrl: string) {
    return {
      merx: MERX_VERSION,
      store: this.catalog.store,
      public_key: { alg: "Ed25519", key_id: this.keys.keyId, spki_der_b64: this.keys.publicKeyB64 },
      capabilities: ["feed", "feed.delta", "intent", "capability-feed", "payment.discovery", "payment.status", "payment.confirmation.signed", "negotiate", "quote.hold", "order.mandate", "receipt.signed"],
      payment_methods: this.paymentMethods().map((p) => p.id),
      payment_handlers: this.paymentMethods(),
      mandate: { format: "merx-mandate/1", required: true },
      payment_confirmation: { format: "merx-payment-confirmation/1", note: "Issued only after verified settlement; the receipt proves order acceptance, not payment." },
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
    this.assertReady();
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

  /** Resolves once durable state has been loaded from the configured store. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private assertReady() {
    if (!this.hydrated) throw new MerxError("unavailable", "store is still loading; retry shortly");
  }

  async placeOrder(input: { quote_id: string; mandate: Mandate; buyer: Buyer; agent_id: string }): Promise<Order> {
    return (await this.checkout(input)).order;
  }

  /**
   * Same as `placeOrder`, but also returns the buyer's order access token. The
   * token is shown exactly once; only its SHA-256 hash is stored. Agents present
   * it to read payment status and confirmations.
   */
  async checkout(input: { quote_id: string; mandate: Mandate; buyer: Buyer; agent_id: string }): Promise<{ order: Order; access_token: string }> {
    await this.ready();
    this.expire();
    const entry = this.quotes.get(input.quote_id);
    if (!entry) throw new MerxError("not_found", "quote not found or expired; create a new quote");
    if (entry.consumed) throw new MerxError("conflict", "quote already used");
    const q = entry.quote;
    const b = input.buyer;
    if (!b?.name || !b?.email || !b?.address?.country) throw new MerxError("invalid", "buyer.name, buyer.email, buyer.address required");
    if (b.address.country !== q.ship_to) throw new MerxError("invalid", `buyer country ${b.address.country} != quote ship_to ${q.ship_to}`);
    assertMoney(q.total, q.currency);
    const categories = [...new Set(q.lines.map((l) => this.catalog.items.find((i) => i.id === l.item_id)!.category[0]))];
    this.verifyMandate(input.mandate, { total: q.total, currency: q.currency, categories, agent_id: input.agent_id });
    const nonce = input.mandate.payload.nonce;
    const provider = this.payments.select(q.payment_method, { currency: q.currency, country: q.ship_to });

    // Reserve synchronously so concurrent calls in this process cannot double-commit,
    // then persist atomically. The store's unique constraints protect other processes.
    entry.consumed = true;
    this.usedNonces.add(nonce);
    entry.deals.forEach((d) => this.usedDeals.add(d));
    const stock = q.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity }));
    this.applyStock(stock, -1);

    const now = new Date().toISOString();
    const order_id = newId("ord");
    const receiptPayload = {
      typ: "merx-receipt/1",
      order_id,
      store_id: q.store_id,
      quote_hash: sha256(canonicalize(q)),
      total: { amount: q.total, currency: q.currency },
      lines: q.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price })),
      agent_id: input.agent_id,
      mandate_nonce: nonce,
      issued_at: now,
    };
    const order: Order = {
      order_id,
      quote: q,
      buyer: b,
      agent_id: input.agent_id,
      mandate_nonce: nonce,
      status: "payment_pending",
      payment: { method: q.payment_method, instructions: {}, status: "unpaid", verifies_settlement: !!provider.initiatePayment, amount: q.total, currency: q.currency, refunded_amount: 0 },
      created_at: now,
      receipt: { payload: receiptPayload, signature: signObject(receiptPayload, this.keys) },
    };
    const access_token = randomBytes(32).toString("base64url");
    const record: OrderRecord = { order, access_hash: sha256(access_token) };
    try {
      await this.store.commitOrder({ record, nonce, deals: entry.deals, stock });
    } catch (e) {
      entry.consumed = false;
      this.usedNonces.delete(nonce);
      entry.deals.forEach((d) => this.usedDeals.delete(d));
      this.applyStock(stock, 1);
      if (e instanceof StoreConflictError) throw new MerxError("conflict", e.field === "mandate_nonce" ? "mandate nonce already used (replay)" : `${e.field} already used`);
      throw e;
    }
    this.orders.set(order_id, record);
    await this.audit("order.created", order_id, { total: q.total, currency: q.currency, agent_id: input.agent_id, payment_method: q.payment_method });
    await this.retryPayment(order_id);
    this.emit("order.created", order);
    return { order, access_token };
  }

  /**
   * Server-side recovery hook: repeats a failed payment setup with the same
   * idempotency key, or opens a new attempt after the provider reported the
   * previous one failed or canceled. Do not expose without authenticating the caller.
   */
  async retryPayment(orderId: string): Promise<Order> {
    const existing = this.paymentAttempts.get(orderId);
    if (existing) return existing;
    const order = this.getOrder(orderId);
    const p = order.payment;
    const setupPending = order.status === "payment_pending" || order.status === "payment_setup_failed";
    const newAttempt = (p.status === "payment_failed" || p.status === "canceled") && order.status !== "cancelled";
    if (!setupPending && !newAttempt) return order;
    const attempt = this.withOrderLock(orderId, () => this.setupPayment(order, newAttempt));
    this.paymentAttempts.set(orderId, attempt);
    try { return await attempt; } finally { this.paymentAttempts.delete(orderId); }
  }

  private async setupPayment(order: Order, newAttempt: boolean): Promise<Order> {
    const p = order.payment;
    const now = new Date().toISOString();
    let attempt = p.attempt_id ? this.attempts.get(p.attempt_id) : undefined;
    if (!attempt || newAttempt) {
      const sequence = (p.attempt ?? 0) + 1;
      // The first attempt keeps the 0.2 idempotency key (order ID) for compatibility.
      attempt = { attempt_id: newId("pay"), order_id: order.order_id, provider_id: p.method, sequence, idempotency_key: sequence === 1 ? order.order_id : `${order.order_id}:${sequence}`, amount: order.quote.total, currency: order.quote.currency, status: "unpaid", created_at: now, updated_at: now };
      await this.store.saveAttempt(attempt);
      this.indexAttempt(attempt);
      Object.assign(p, { attempt_id: attempt.attempt_id, attempt: sequence, status: "unpaid" as PaymentStatus, instructions: {} });
      delete p.provider_payment_id;
    }
    order.status = "payment_pending";
    delete p.error;
    try {
      const provider = this.payments.select(p.method, { currency: order.quote.currency, country: order.quote.ship_to });
      const request = { order_id: order.order_id, total: attempt.amount, currency: attempt.currency, country: order.quote.ship_to, quote_id: order.quote.quote_id, quote_hash: sha256(canonicalize(order.quote)), idempotency_key: attempt.idempotency_key };
      if (provider.initiatePayment) {
        const setup = await provider.initiatePayment(request);
        if (!isPaymentStatus(setup?.status) || !isOpen(setup.status) || (setup.provider_payment_id !== undefined && (typeof setup.provider_payment_id !== "string" || !setup.provider_payment_id))) throw new Error("provider returned an invalid payment setup");
        const updated: PaymentAttempt = { ...attempt, status: setup.status, updated_at: new Date().toISOString(), ...(setup.provider_payment_id ? { provider_payment_id: setup.provider_payment_id } : {}) };
        await this.store.saveAttempt(updated);
        this.indexAttempt(updated);
        Object.assign(p, { status: setup.status, instructions: setup.instructions ?? {}, verifies_settlement: true, ...(setup.provider_payment_id ? { provider_payment_id: setup.provider_payment_id } : {}) });
      } else {
        p.instructions = await provider.createPayment(request);
        p.status = "payment_pending";
        p.verifies_settlement = false;
        const updated: PaymentAttempt = { ...attempt, status: "payment_pending", updated_at: new Date().toISOString() };
        await this.store.saveAttempt(updated);
        this.indexAttempt(updated);
      }
      p.updated_at = new Date().toISOString();
      order.status = legacyStatus(order);
      await this.audit("payment.setup", order.order_id, { attempt_id: attempt.attempt_id, provider: p.method, status: p.status });
    } catch {
      // A timeout may have happened after provider-side creation. Keep the order
      // and reservation; retry the same provider with the same idempotency key.
      order.status = "payment_setup_failed";
      p.error = "payment_setup_failed";
      await this.audit("payment.setup_failed", order.order_id, { attempt_id: attempt.attempt_id, provider: p.method });
    }
    await this.persist(order);
    return order;
  }

  // ------------------------------------------------------------ verified payment events

  /**
   * Entry point for provider notifications. The provider adapter authenticates
   * the request (signature over the raw body, or a server-to-server status
   * check); the engine then deduplicates the event, checks order linkage, amount
   * and currency, and applies an allowed state transition.
   */
  async handlePaymentWebhook(providerId: string, request: WebhookRequest): Promise<{ received: true; duplicate?: true; ignored?: true }> {
    await this.ready();
    const provider = this.payments.get(providerId);
    if (!provider?.verifyWebhook) throw new MerxError("not_found", "no webhook handler for this provider");
    const event = await provider.verifyWebhook(request);
    if (!event) return { received: true, ignored: true };
    if (typeof event.event_id !== "string" || !event.event_id || typeof event.provider_payment_id !== "string" || !event.provider_payment_id || !isPaymentStatus(event.status)) throw new WebhookVerificationError("provider adapter returned a malformed event");
    if (await this.store.hasWebhookEvent(providerId, event.event_id)) return { received: true, duplicate: true };
    let attempt = this.attemptByRef(providerId, event.provider_payment_id);
    if (!attempt) attempt = await this.adoptOrphan(providerId, event);
    if (!attempt) {
      await this.audit("payment.webhook_unmatched", event.order_id && this.orders.has(event.order_id) ? event.order_id : undefined, { provider: providerId, event_id: event.event_id, status: event.status });
      await this.store.recordWebhookEvent(providerId, event.event_id);
      return { received: true, ignored: true };
    }
    await this.applyProviderStatus(attempt, event, "webhook", event.event_id);
    await this.store.recordWebhookEvent(providerId, event.event_id);
    return { received: true };
  }

  /**
   * A verified provider payment for one of our orders that has no recorded attempt
   * (e.g. a request timed out after the provider created it). Money may have moved,
   * so a settled one is adopted as a new attempt and then verified like any other.
   */
  private adoptOrphan(providerId: string, event: VerifiedPaymentEvent): Promise<PaymentAttempt | undefined> {
    const record = event.order_id ? this.orders.get(event.order_id) : undefined;
    if (!record || record.order.payment.method !== providerId || !SETTLED_STATUSES.includes(event.status)) return Promise.resolve(undefined);
    return this.withOrderLock(record.order.order_id, async () => {
      const existing = this.attemptByRef(providerId, event.provider_payment_id);
      if (existing) return existing;
      const order = record.order;
      const now = new Date().toISOString();
      const sequence = (order.payment.attempt ?? 0) + 1;
      const attempt: PaymentAttempt = { attempt_id: newId("pay"), order_id: order.order_id, provider_id: providerId, sequence, idempotency_key: `${order.order_id}:adopted:${event.provider_payment_id}`, provider_payment_id: event.provider_payment_id, amount: order.quote.total, currency: order.quote.currency, status: "payment_pending", created_at: now, updated_at: now };
      await this.store.saveAttempt(attempt);
      this.indexAttempt(attempt);
      if (!order.payment.attempt_id) Object.assign(order.payment, { attempt_id: attempt.attempt_id, attempt: sequence });
      await this.audit("payment.orphan_adopted", order.order_id, { attempt_id: attempt.attempt_id, provider: providerId });
      return attempt;
    });
  }

  /** Pull the authoritative status from the provider (missed or late webhooks). Server-side only. */
  async reconcilePayment(orderId: string): Promise<Order> {
    await this.ready();
    const order = this.getOrder(orderId);
    const attempt = order.payment.attempt_id ? this.attempts.get(order.payment.attempt_id) : undefined;
    const provider = this.payments.get(order.payment.method);
    if (!attempt?.provider_payment_id || !provider?.getPaymentStatus) throw new MerxError("invalid", "this payment cannot be reconciled with its provider");
    const status = await providerCall(() => provider.getPaymentStatus!(attempt.provider_payment_id!));
    if (!isPaymentStatus(status?.status)) throw new MerxError("unavailable", "provider returned an invalid status");
    return this.applyProviderStatus(attempt, status, "reconciliation");
  }

  /** Reconcile every order whose verified payment is still open. Returns a per-order summary. */
  async reconcileOpenPayments(): Promise<{ order_id: string; status?: PaymentStatus; error?: string }[]> {
    await this.ready();
    const out: { order_id: string; status?: PaymentStatus; error?: string }[] = [];
    for (const { order } of this.orders.values()) {
      if (!order.payment.verifies_settlement || !isOpen(order.payment.status) || order.status === "cancelled" || !order.payment.provider_payment_id) continue;
      try {
        out.push({ order_id: order.order_id, status: (await this.reconcilePayment(order.order_id)).payment.status });
      } catch (e) {
        out.push({ order_id: order.order_id, error: e instanceof MerxError ? e.code : "provider_error" });
      }
    }
    return out;
  }

  private applyProviderStatus(attempt: PaymentAttempt, update: ProviderPaymentStatus, source: "webhook" | "reconciliation", eventId?: string): Promise<Order> {
    return this.withOrderLock(attempt.order_id, async () => {
      const order = this.getOrder(attempt.order_id);
      const p = order.payment;
      const current = this.attempts.get(attempt.attempt_id)!;
      const to = update.status;
      const ctx = { attempt_id: current.attempt_id, provider: current.provider_id, source, ...(eventId ? { event_id: eventId } : {}) };
      if (update.order_id !== undefined && update.order_id !== order.order_id) {
        await this.audit("payment.rejected", order.order_id, { ...ctx, reason: "order_mismatch" });
        throw new WebhookVerificationError("provider payment is linked to a different order");
      }
      if (SETTLED_STATUSES.includes(to) && (update.amount !== current.amount || update.currency !== current.currency)) {
        await this.audit("payment.rejected", order.order_id, { ...ctx, reason: "amount_mismatch", amount: update.amount ?? null, currency: update.currency ?? null });
        this.emit("payment.anomaly", { order_id: order.order_id, reason: "amount_mismatch", ...ctx });
        throw new WebhookVerificationError("provider amount or currency does not match the order");
      }
      const isCurrent = p.attempt_id === current.attempt_id;
      const lateForCancelled = order.status === "cancelled" && to === "paid";
      if (current.status === to && to !== "partially_refunded") return order;
      if (!canTransition(current.status, to) && !lateForCancelled) {
        await this.audit("payment.transition_ignored", order.order_id, { ...ctx, from: current.status, to });
        return order;
      }
      const now = new Date().toISOString();
      const updated: PaymentAttempt = { ...current, status: to, updated_at: now, ...(eventId ? { last_event_id: eventId } : {}) };
      await this.store.saveAttempt(updated);
      this.indexAttempt(updated);

      if (!isCurrent) {
        // An older checkout was completed after a newer attempt was opened. Money moved,
        // so it becomes the order's payment unless the current attempt is also settled.
        if (!SETTLED_STATUSES.includes(to)) return order;
        if (SETTLED_STATUSES.includes(p.status)) {
          await this.audit("payment.duplicate_settlement", order.order_id, ctx);
          this.emit("payment.anomaly", { order_id: order.order_id, reason: "duplicate_settlement", ...ctx });
          return order;
        }
        Object.assign(p, { attempt_id: updated.attempt_id, attempt: updated.sequence, provider_payment_id: updated.provider_payment_id });
      }
      p.status = to;
      if (update.refunded_amount !== undefined && Number.isSafeInteger(update.refunded_amount) && update.refunded_amount >= p.refunded_amount && update.refunded_amount <= p.amount) p.refunded_amount = update.refunded_amount;
      if (to === "refunded") p.refunded_amount = p.amount;
      p.updated_at = now;
      if (!isOpen(to)) p.instructions = {};
      if (to === "paid" && !p.confirmation) p.confirmation = this.confirmPayment(order, updated, source, eventId);
      if (lateForCancelled) {
        await this.audit("payment.received_for_cancelled_order", order.order_id, ctx);
        this.emit("payment.anomaly", { order_id: order.order_id, reason: "paid_after_cancel", ...ctx });
      } else {
        order.status = legacyStatus(order);
      }
      await this.persist(order);
      await this.audit("payment.status_changed", order.order_id, { ...ctx, from: current.status, to });
      this.emit("payment.updated", order);
      if (to === "paid") this.emit("order.paid", order);
      return order;
    });
  }

  private confirmPayment(order: Order, attempt: PaymentAttempt, source: "webhook" | "reconciliation", eventId?: string): PaymentConfirmation {
    const payload: PaymentConfirmation["payload"] = {
      typ: "merx-payment-confirmation/1",
      order_id: order.order_id,
      store_id: order.quote.store_id,
      quote_hash: sha256(canonicalize(order.quote)),
      receipt_hash: sha256(canonicalize(order.receipt.payload)),
      amount: { amount: attempt.amount, currency: attempt.currency },
      provider: attempt.provider_id,
      provider_payment_id: attempt.provider_payment_id!,
      status: "paid",
      verified_by: source,
      ...(eventId ? { event_id: eventId } : {}),
      verified_at: new Date().toISOString(),
    };
    return { payload, signature: signObject(payload, this.keys) };
  }

  // ------------------------------------------------------------ administrative operations

  /**
   * Refund a settled payment through its provider. Administrative, server-side
   * only: never expose to buyer agents. `idempotency_key` makes retries safe.
   */
  async refundPayment(orderId: string, input: { amount?: number; reason?: string; idempotency_key: string }): Promise<Order> {
    await this.ready();
    if (typeof input?.idempotency_key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotency_key)) throw new MerxError("invalid", "idempotency_key (8-128 URL-safe characters) is required");
    return this.withOrderLock(orderId, async () => {
      const order = this.getOrder(orderId);
      const p = order.payment;
      const provider = this.payments.get(p.method);
      if (!provider?.refund || !p.provider_payment_id) throw new MerxError("invalid", "this payment provider does not support refunds");
      const key = `refund:${orderId}:${input.idempotency_key}`;
      const refunds = (p.refunds ??= []);
      if (refunds.some((r) => r.idempotency_key === key)) return order;
      if (p.status !== "paid" && p.status !== "partially_refunded") throw new MerxError("conflict", `cannot refund a payment in status ${p.status}`);
      const remaining = p.amount - p.refunded_amount;
      const amount = input.amount ?? remaining;
      assertMinorAmount(amount, { positive: true });
      if (amount > remaining) throw new MerxError("invalid", `refund exceeds refundable amount ${remaining}`);
      const result = await providerCall(() => provider.refund!({ order_id: orderId, provider_payment_id: p.provider_payment_id!, amount, currency: p.currency, idempotency_key: key, ...(input.reason ? { reason: input.reason } : {}) }));
      if (result?.status !== "succeeded" && result?.status !== "pending") throw new MerxError("unavailable", "provider did not accept the refund");
      refunds.push({ idempotency_key: key, refund_id: result.refund_id, amount, status: result.status, created_at: new Date().toISOString() });
      const from = p.status;
      p.refunded_amount += amount;
      p.status = p.refunded_amount === p.amount ? "refunded" : "partially_refunded";
      p.updated_at = new Date().toISOString();
      const attempt = this.attempts.get(p.attempt_id!);
      if (attempt) {
        const updated = { ...attempt, status: p.status, updated_at: p.updated_at };
        await this.store.saveAttempt(updated);
        this.indexAttempt(updated);
      }
      order.status = legacyStatus(order);
      await this.persist(order);
      await this.audit("payment.refunded", orderId, { amount, refund_id: result.refund_id, refund_status: result.status, from, to: p.status });
      this.emit("payment.updated", order);
      return order;
    });
  }

  /**
   * Cancel an order whose payment has not settled, and return its stock.
   * Open provider sessions are canceled when the adapter supports it; a payment
   * that still arrives later is recorded and raised as a `payment.anomaly`.
   */
  async cancelOrder(orderId: string, reason = "merchant_cancelled"): Promise<Order> {
    await this.ready();
    return this.withOrderLock(orderId, async () => {
      const order = this.getOrder(orderId);
      if (order.status === "cancelled") return order;
      if (SETTLED_STATUSES.includes(order.payment.status)) throw new MerxError("conflict", "order is paid; refund it instead of cancelling");
      if (order.status === "shipped" || order.status === "delivered") throw new MerxError("conflict", "order has been fulfilled");
      const p = order.payment;
      const provider = this.payments.get(p.method);
      if (p.provider_payment_id && provider?.cancelPayment && isOpen(p.status)) await providerCall(() => provider.cancelPayment!(p.provider_payment_id!));
      p.status = "canceled";
      p.instructions = {};
      p.updated_at = new Date().toISOString();
      const attempt = p.attempt_id ? this.attempts.get(p.attempt_id) : undefined;
      if (attempt && attempt.status !== "canceled") {
        const updated = { ...attempt, status: "canceled" as PaymentStatus, updated_at: p.updated_at };
        await this.store.saveAttempt(updated);
        this.indexAttempt(updated);
      }
      order.status = "cancelled";
      const stock = order.quote.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity }));
      await this.store.cancelOrder({ record: this.orders.get(orderId)!, stock });
      this.applyStock(stock, 1);
      await this.audit("order.cancelled", orderId, { reason });
      this.emit("order.cancelled", order);
      return order;
    });
  }

  // ------------------------------------------------------------ buyer access

  /** Verify a buyer's order access token (timing-safe). */
  verifyOrderAccess(orderId: string, accessToken: unknown): Order {
    const record = this.orders.get(orderId);
    if (!record) throw new MerxError("not_found", `order ${orderId} not found`);
    if (typeof accessToken !== "string" || !accessToken) throw new MerxError("unauthorized", "order access_token required");
    const a = Buffer.from(sha256(accessToken), "hex");
    const b = Buffer.from(record.access_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new MerxError("unauthorized", "invalid order access_token");
    return record.order;
  }

  /** Order lookup for agents: requires the access token when `requireOrderAccessToken` is set, and always verifies one if given. */
  getOrderForAgent(orderId: string, accessToken?: unknown): Order {
    this.assertReady();
    if (accessToken !== undefined || this.requireAccessToken) return this.verifyOrderAccess(orderId, accessToken);
    return this.getOrder(orderId);
  }

  /** Access-controlled payment status for buyer agents. Contains no provider secrets or buyer PII. */
  paymentStatus(orderId: string, accessToken: unknown) {
    this.assertReady();
    const order = this.verifyOrderAccess(orderId, accessToken);
    const p = order.payment;
    return {
      order_id: order.order_id,
      order_status: order.status,
      payment: {
        method: p.method,
        status: p.status,
        verifies_settlement: p.verifies_settlement,
        amount: { amount: p.amount, currency: p.currency },
        refunded_amount: p.refunded_amount,
        attempt: p.attempt ?? 0,
        ...(p.error ? { error: p.error } : {}),
        ...(p.updated_at ? { updated_at: p.updated_at } : {}),
      },
      next_action: nextAction(order),
      ...(p.confirmation ? { confirmation: p.confirmation } : {}),
    };
  }

  /** Signed payment confirmation, available once a provider event or reconciliation verified settlement. */
  paymentConfirmation(orderId: string, accessToken: unknown): PaymentConfirmation {
    this.assertReady();
    const order = this.verifyOrderAccess(orderId, accessToken);
    if (!order.payment.confirmation) throw new MerxError("not_found", order.payment.verifies_settlement ? "payment has not been verified yet" : "this payment method does not verify settlement");
    return order.payment.confirmation;
  }

  getOrder(id: string): Order {
    this.assertReady();
    const o = this.orders.get(id);
    if (!o) throw new MerxError("not_found", `order ${id} not found`);
    return o.order;
  }

  /** Close the underlying store (database handles). */
  async close(): Promise<void> {
    await this.store.close?.();
  }

  // ------------------------------------------------------------ internals

  private hydrate(snapshot: StoreSnapshot) {
    for (const r of snapshot.orders) this.orders.set(r.order.order_id, r);
    for (const n of snapshot.nonces) this.usedNonces.add(n);
    for (const d of snapshot.deals) this.usedDeals.add(d);
    for (const a of snapshot.attempts) this.indexAttempt(a);
    this.applyStock(Object.entries(snapshot.stock).map(([item_id, quantity]) => ({ item_id, quantity })), -1);
    this.hydrated = true;
  }

  private applyStock(lines: { item_id: string; quantity: number }[], sign: 1 | -1) {
    const now = new Date().toISOString();
    for (const l of lines) {
      const item = this.catalog.items.find((i) => i.id === l.item_id);
      if (!item) continue;
      item.stock = Math.max(0, item.stock + sign * l.quantity);
      this.updatedAt.set(item.id, now);
    }
  }

  private indexAttempt(a: PaymentAttempt) {
    this.attempts.set(a.attempt_id, a);
    if (a.provider_payment_id) this.attemptRefs.set(`${a.provider_id}\u0000${a.provider_payment_id}`, a.attempt_id);
  }

  private attemptByRef(providerId: string, ref: string): PaymentAttempt | undefined {
    const id = this.attemptRefs.get(`${providerId}\u0000${ref}`);
    return id ? this.attempts.get(id) : undefined;
  }

  private async persist(order: Order) {
    const record = this.orders.get(order.order_id)!;
    await this.store.saveOrder(record);
  }

  private async audit(type: string, order_id?: string, data?: Record<string, unknown>) {
    try {
      await this.store.audit({ at: new Date().toISOString(), type, ...(order_id ? { order_id } : {}), ...(data ? { data } : {}) });
    } catch {
      // Audit failures must not break checkout; operators monitor the store separately.
    }
  }

  private withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(orderId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(orderId, tail);
    void tail.then(() => { if (this.locks.get(orderId) === tail) this.locks.delete(orderId); });
    return run;
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

/** Provider failures surface as 503 without leaking provider messages. */
async function providerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MerxError) throw e;
    throw new MerxError("unavailable", "payment provider request failed; retry later");
  }
}

/** Legacy combined order status derived from payment state (fulfillment states are kept). */
function legacyStatus(order: Order): Order["status"] {
  if (order.status === "shipped" || order.status === "delivered" || order.status === "cancelled") return order.status;
  if (order.payment.error) return "payment_setup_failed";
  switch (order.payment.status) {
    case "paid": case "partially_refunded": case "disputed": return "paid";
    case "refunded": return "refunded";
    default: return "awaiting_payment";
  }
}

function nextAction(order: Order): Record<string, unknown> {
  const p = order.payment;
  if (order.status === "cancelled") return { type: "none", reason: "order_cancelled" };
  if (p.error) return { type: "wait", reason: "payment_setup_failed", detail: "The merchant will retry payment setup; do not place a new order." };
  if (p.status === "paid" || p.status === "partially_refunded" || p.status === "refunded" || p.status === "disputed") return { type: "none", reason: `payment_${p.status}` };
  if (p.status === "payment_failed" || p.status === "canceled") return { type: "contact_merchant", reason: `payment_${p.status}` };
  if (!p.verifies_settlement) return { type: "follow_instructions", settlement: "not_verified", instructions: p.instructions };
  if (typeof p.instructions.checkout_url === "string") return { type: "redirect", url: p.instructions.checkout_url, detail: "The human completes payment on the provider-hosted page. A browser redirect is not proof of payment; poll payment_status." };
  return { type: "wait", reason: p.status };
}

export { MerxError };
