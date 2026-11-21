/**
 * Payment state machine. It is deliberately separate from order fulfillment:
 * an accepted order (signed receipt) is not a settled payment, and a settled
 * payment is not a shipped parcel. See docs/adr/0001-verified-payments.md.
 */
export type PaymentStatus =
  | "unpaid"
  | "payment_pending"
  | "requires_action"
  | "paid"
  | "payment_failed"
  | "canceled"
  | "partially_refunded"
  | "refunded"
  | "disputed";

export const PAYMENT_STATUSES: readonly PaymentStatus[] = ["unpaid", "payment_pending", "requires_action", "paid", "payment_failed", "canceled", "partially_refunded", "refunded", "disputed"];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  unpaid: ["payment_pending", "requires_action", "paid", "payment_failed", "canceled"],
  requires_action: ["payment_pending", "paid", "payment_failed", "canceled"],
  payment_pending: ["requires_action", "paid", "payment_failed", "canceled"],
  payment_failed: ["payment_pending", "requires_action", "paid", "canceled"],
  paid: ["partially_refunded", "refunded", "disputed"],
  partially_refunded: ["partially_refunded", "refunded", "disputed"],
  disputed: ["paid", "partially_refunded", "refunded"],
  canceled: [],
  refunded: [],
};

/** Statuses after which money has been received at least once. */
export const SETTLED_STATUSES: readonly PaymentStatus[] = ["paid", "partially_refunded", "refunded", "disputed"];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses a buyer can still act on (pay, retry) before the attempt is settled or closed. */
export function isOpen(status: PaymentStatus): boolean {
  return status === "unpaid" || status === "payment_pending" || status === "requires_action" || status === "payment_failed";
}
