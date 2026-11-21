import { createRequire } from "node:module";
import type { AuditEvent, CommitOrderInput, MerxStore, OrderRecord, PaymentAttempt, StockLine, StoreSnapshot } from "../core/storage.ts";
import { StoreConflictError } from "../core/storage.ts";

/**
 * Durable single-node store on Node's built-in `node:sqlite` (Node >= 22.13,
 * no npm dependency). Good for self-hosted demos and small single-instance
 * shops. Several Merx processes on one SQLite file are serialized by
 * `BEGIN IMMEDIATE`, but each engine keeps a read cache, so multi-instance
 * deployments should use a network database adapter implementing `MerxStore`.
 */

type Statement = { run(...a: unknown[]): { changes: number | bigint }; get(...a: unknown[]): any; all(...a: unknown[]): any[] };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };

const MIGRATIONS: string[] = [
  `CREATE TABLE orders (order_id TEXT PRIMARY KEY, record TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE mandate_nonces (nonce TEXT PRIMARY KEY, order_id TEXT NOT NULL);
   CREATE TABLE deal_redemptions (deal_id TEXT PRIMARY KEY, order_id TEXT NOT NULL);
   CREATE TABLE stock_deductions (item_id TEXT PRIMARY KEY, quantity INTEGER NOT NULL);
   CREATE TABLE payment_attempts (
     attempt_id TEXT PRIMARY KEY,
     order_id TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     provider_payment_id TEXT,
     idempotency_key TEXT NOT NULL UNIQUE,
     record TEXT NOT NULL,
     UNIQUE (provider_id, provider_payment_id)
   );
   CREATE INDEX payment_attempts_order ON payment_attempts(order_id);
   CREATE TABLE webhook_events (provider_id TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY (provider_id, event_id));
   CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, order_id TEXT, data TEXT);`,
];

function openDatabase(path: string): Database {
  let mod: { DatabaseSync: new (path: string) => Database };
  try {
    mod = createRequire(import.meta.url)("node:sqlite");
  } catch {
    throw new Error("SqliteStore requires Node.js >= 22.13 (built-in node:sqlite)");
  }
  return new mod.DatabaseSync(path);
}

export class SqliteStore implements MerxStore {
  readonly kind = "sqlite";
  private db: Database;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const current = Number(this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get().v);
    MIGRATIONS.slice(current).forEach((sql, i) => this.tx(() => {
      this.db.exec(sql);
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(current + i + 1, new Date().toISOString());
    }));
  }

  /** Schema version, for operational checks. */
  get schemaVersion(): number {
    return Number(this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  load(): StoreSnapshot {
    return {
      orders: this.db.prepare("SELECT record FROM orders ORDER BY created_at").all().map((r) => JSON.parse(r.record)),
      nonces: this.db.prepare("SELECT nonce FROM mandate_nonces").all().map((r) => r.nonce),
      deals: this.db.prepare("SELECT deal_id FROM deal_redemptions").all().map((r) => r.deal_id),
      stock: Object.fromEntries(this.db.prepare("SELECT item_id, quantity FROM stock_deductions").all().map((r) => [r.item_id, Number(r.quantity)])),
      attempts: this.db.prepare("SELECT record FROM payment_attempts").all().map((r) => JSON.parse(r.record)),
    };
  }

  commitOrder({ record, nonce, deals, stock }: CommitOrderInput): void {
    const id = record.order.order_id;
    this.tx(() => {
      this.insertUnique("INSERT INTO orders (order_id, record, created_at) VALUES (?, ?, ?)", [id, JSON.stringify(record), record.order.created_at], "order_id");
      this.insertUnique("INSERT INTO mandate_nonces (nonce, order_id) VALUES (?, ?)", [nonce, id], "mandate_nonce");
      for (const d of deals) this.insertUnique("INSERT INTO deal_redemptions (deal_id, order_id) VALUES (?, ?)", [d, id], "deal");
      this.adjust(stock, 1);
    });
  }

  saveOrder(record: OrderRecord): void {
    this.db.prepare("UPDATE orders SET record = ? WHERE order_id = ?").run(JSON.stringify(record), record.order.order_id);
  }

  cancelOrder({ record, stock }: { record: OrderRecord; stock: StockLine[] }): void {
    this.tx(() => {
      this.saveOrder(record);
      this.adjust(stock, -1);
    });
  }

  saveAttempt(a: PaymentAttempt): void {
    try {
      this.db.prepare(
        `INSERT INTO payment_attempts (attempt_id, order_id, provider_id, provider_payment_id, idempotency_key, record) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET provider_payment_id = excluded.provider_payment_id, record = excluded.record`,
      ).run(a.attempt_id, a.order_id, a.provider_id, a.provider_payment_id ?? null, a.idempotency_key, JSON.stringify(a));
    } catch (e) {
      throw this.conflict(e, (e as Error).message.includes("idempotency_key") ? "idempotency_key" : "provider_payment_id");
    }
  }

  hasWebhookEvent(providerId: string, eventId: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM webhook_events WHERE provider_id = ? AND event_id = ?").get(providerId, eventId);
  }

  recordWebhookEvent(providerId: string, eventId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO webhook_events (provider_id, event_id, received_at) VALUES (?, ?, ?)").run(providerId, eventId, new Date().toISOString());
  }

  audit(e: AuditEvent): void {
    this.db.prepare("INSERT INTO audit_log (at, type, order_id, data) VALUES (?, ?, ?, ?)").run(e.at, e.type, e.order_id ?? null, e.data ? JSON.stringify(e.data) : null);
  }

  /** Most recent audit events first. */
  auditTrail(limit = 100): AuditEvent[] {
    return this.db.prepare("SELECT at, type, order_id, data FROM audit_log ORDER BY id DESC LIMIT ?").all(limit).map((r) => ({ at: r.at, type: r.type, ...(r.order_id ? { order_id: r.order_id } : {}), ...(r.data ? { data: JSON.parse(r.data) } : {}) }));
  }

  resetStock(): void {
    this.db.exec("DELETE FROM stock_deductions");
  }

  close(): void {
    this.db.close();
  }

  private adjust(stock: StockLine[], sign: 1 | -1) {
    const stmt = this.db.prepare("INSERT INTO stock_deductions (item_id, quantity) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET quantity = quantity + excluded.quantity");
    for (const l of stock) stmt.run(l.item_id, sign * l.quantity);
  }

  private insertUnique(sql: string, args: unknown[], field: string) {
    try {
      this.db.prepare(sql).run(...args);
    } catch (e) {
      throw this.conflict(e, field);
    }
  }

  private conflict(e: unknown, field: string): Error {
    return /UNIQUE|PRIMARY KEY|constraint/i.test(String((e as Error)?.message)) ? new StoreConflictError(field) : (e as Error);
  }
}
