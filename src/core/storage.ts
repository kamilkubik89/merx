import type { PaymentStatus } from "./payment-state.ts";
import type { Order } from "./types.ts";

/**
 * Persistence boundary for state that must survive restarts: accepted orders,
 * consumed mandate nonces, redeemed deal tokens, stock deductions, payment
 * attempts and processed provider events.
 *
 * Methods may be synchronous (in-memory, SQLite) or asynchronous (network
 * databases). Implementations MUST make `commitOrder` and `cancelOrder` atomic
 * and enforce the uniqueness rules documented on each method; the engine relies
 * on them instead of in-process locks when several instances share a database.
 */
export interface MerxStore {
  readonly kind: string;
  /** Load durable state at startup. */
  load(): StoreSnapshot | Promise<StoreSnapshot>;
  /**
   * Atomically persist a new order, consume its mandate nonce and deal tokens,
   * and deduct stock. MUST throw `StoreConflictError` (and persist nothing) when
   * the order ID, nonce or any deal ID was already used.
   */
  commitOrder(input: CommitOrderInput): void | Promise<void>;
  /** Replace the stored order record (status and payment updates). */
  saveOrder(record: OrderRecord): void | Promise<void>;
  /** Atomically persist a cancelled order and return its stock. */
  cancelOrder(input: { record: OrderRecord; stock: StockLine[] }): void | Promise<void>;
  /**
   * Insert or update a payment attempt. MUST throw `StoreConflictError` when a
   * different attempt already uses the same idempotency key, or the same
   * provider + provider_payment_id.
   */
  saveAttempt(attempt: PaymentAttempt): void | Promise<void>;
  /** True when this provider event was already processed. */
  hasWebhookEvent(providerId: string, eventId: string): boolean | Promise<boolean>;
  /** Mark a provider event processed. Repeating the call MUST be harmless. */
  recordWebhookEvent(providerId: string, eventId: string): void | Promise<void>;
  /** Append-only audit trail of security-relevant transitions. */
  audit(event: AuditEvent): void | Promise<void>;
  /** Forget persisted stock deductions after the merchant re-counts inventory in the catalog. */
  resetStock(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type OrderRecord = {
  order: Order;
  /** SHA-256 of the buyer's order access token. The token itself is never stored. */
  access_hash: string;
};

export type StockLine = { item_id: string; quantity: number };

export type CommitOrderInput = { record: OrderRecord; nonce: string; deals: string[]; stock: StockLine[] };

export type PaymentAttempt = {
  attempt_id: string;
  order_id: string;
  provider_id: string;
  sequence: number;
  idempotency_key: string;
  provider_payment_id?: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  last_event_id?: string;
  created_at: string;
  updated_at: string;
};

export type AuditEvent = { at: string; type: string; order_id?: string; data?: Record<string, unknown> };

export type StoreSnapshot = {
  orders: OrderRecord[];
  nonces: string[];
  deals: string[];
  /** Cumulative deductions per item since the last `resetStock`. Applied to catalog stock at startup. */
  stock: Record<string, number>;
  attempts: PaymentAttempt[];
};

export class StoreConflictError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`duplicate ${field}`);
    this.name = "StoreConflictError";
    this.field = field;
  }
}

/**
 * Default store: fast, dependency-free, and lost on restart. Suitable for
 * tests, demos and single-process experiments only.
 */
export class MemoryStore implements MerxStore {
  readonly kind = "memory";
  private orders = new Map<string, OrderRecord>();
  private nonces = new Set<string>();
  private deals = new Set<string>();
  private stock = new Map<string, number>();
  private attempts = new Map<string, PaymentAttempt>();
  private events = new Set<string>();
  readonly auditLog: AuditEvent[] = [];

  load(): StoreSnapshot {
    return {
      orders: [...this.orders.values()].map((r) => structuredClone(r)),
      nonces: [...this.nonces],
      deals: [...this.deals],
      stock: Object.fromEntries(this.stock),
      attempts: [...this.attempts.values()].map((a) => ({ ...a })),
    };
  }

  commitOrder({ record, nonce, deals, stock }: CommitOrderInput): void {
    if (this.orders.has(record.order.order_id)) throw new StoreConflictError("order_id");
    if (this.nonces.has(nonce)) throw new StoreConflictError("mandate_nonce");
    if (deals.some((d) => this.deals.has(d)) || new Set(deals).size !== deals.length) throw new StoreConflictError("deal");
    this.orders.set(record.order.order_id, structuredClone(record));
    this.nonces.add(nonce);
    for (const d of deals) this.deals.add(d);
    for (const l of stock) this.stock.set(l.item_id, (this.stock.get(l.item_id) ?? 0) + l.quantity);
  }

  saveOrder(record: OrderRecord): void {
    this.orders.set(record.order.order_id, structuredClone(record));
  }

  cancelOrder({ record, stock }: { record: OrderRecord; stock: StockLine[] }): void {
    this.orders.set(record.order.order_id, structuredClone(record));
    for (const l of stock) this.stock.set(l.item_id, (this.stock.get(l.item_id) ?? 0) - l.quantity);
  }

  saveAttempt(attempt: PaymentAttempt): void {
    for (const other of this.attempts.values()) {
      if (other.attempt_id === attempt.attempt_id) continue;
      if (other.idempotency_key === attempt.idempotency_key) throw new StoreConflictError("idempotency_key");
      if (attempt.provider_payment_id && other.provider_id === attempt.provider_id && other.provider_payment_id === attempt.provider_payment_id) throw new StoreConflictError("provider_payment_id");
    }
    this.attempts.set(attempt.attempt_id, { ...attempt });
  }

  hasWebhookEvent(providerId: string, eventId: string): boolean {
    return this.events.has(`${providerId}\u0000${eventId}`);
  }

  recordWebhookEvent(providerId: string, eventId: string): void {
    this.events.add(`${providerId}\u0000${eventId}`);
  }

  audit(event: AuditEvent): void {
    this.auditLog.push(structuredClone(event));
  }

  resetStock(): void {
    this.stock.clear();
  }
}
