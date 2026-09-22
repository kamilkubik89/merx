import type { Catalog, CatalogItem, NegotiationRequest, NegotiationResponse } from "./types.ts";

/**
 * Negotiation as POLICY, not as a chatbot.
 *
 * The merchant declares public rules (volume/bundle discounts) and a private
 * floor per item. The engine concedes deterministically: every round it moves
 * a fixed fraction (`concession`, default 0.35) towards the agent's proposal,
 * but never below the floor. After
 * `max_rounds` it issues a take-it-or-leave-it final offer. Same inputs,
 * same outputs — agents can reason about it, merchants can audit it.
 */

export type Session = { id: string; item_id: string; quantity: number; ask: number; round: number; agent_id?: string; created: number };

export function volumeDiscountPct(catalog: Catalog, quantity: number, distinctItems = 1): number {
  let pct = 0;
  for (const r of catalog.negotiation?.rules ?? []) {
    if (r.type === "volume" && quantity >= r.min_qty) pct = Math.max(pct, r.discount_pct);
    if (r.type === "bundle" && distinctItems >= r.min_distinct_items) pct = Math.max(pct, r.discount_pct);
  }
  return pct;
}

export const openingAsk = (catalog: Catalog, item: CatalogItem, quantity: number) =>
  Math.round(item.price * (1 - volumeDiscountPct(catalog, quantity) / 100));

export type DealIssuer = (d: { item_id: string; quantity: number; unit_price: number; session_id: string }) => string;

export function negotiate(
  catalog: Catalog,
  sessions: Map<string, Session>,
  req: NegotiationRequest,
  issueDeal: DealIssuer,
  newId: () => string,
): NegotiationResponse {
  const item = catalog.items.find((i) => i.id === req.item_id);
  if (!item) throw new MerxError("not_found", `item ${req.item_id} not found`);
  if (!Number.isInteger(req.quantity) || req.quantity < 1) throw new MerxError("invalid", "quantity must be a positive integer");
  if (!Number.isInteger(req.proposed_unit_price) || req.proposed_unit_price < 0) throw new MerxError("invalid", "proposed_unit_price must be integer minor units");

  const maxRounds = catalog.negotiation?.max_rounds ?? 0;
  const ask0 = openingAsk(catalog, item, req.quantity);

  if (!catalog.negotiation?.enabled || !item.negotiation) {
    return { session_id: "", status: "rejected", unit_price: ask0, rounds_left: 0, message: "This item is not negotiable. Volume rules (if any) are already applied to unit_price." };
  }

  let s = req.session_id ? sessions.get(req.session_id) : undefined;
  if (s && (s.item_id !== req.item_id || s.quantity !== req.quantity)) s = undefined; // new terms, new session
  if (!s) {
    s = { id: newId(), item_id: item.id, quantity: req.quantity, ask: ask0, round: 0, agent_id: req.agent_id, created: Date.now() };
    sessions.set(s.id, s);
  }
  s.round += 1;
  const floor = Math.min(item.negotiation.floor_price, s.ask);
  const p = req.proposed_unit_price;
  const accept = (price: number, message: string): NegotiationResponse => {
    sessions.delete(s!.id);
    return { session_id: s!.id, status: "accepted", unit_price: price, rounds_left: 0, deal_token: issueDeal({ item_id: item.id, quantity: s!.quantity, unit_price: price, session_id: s!.id }), message };
  };

  if (p >= s.ask) return accept(s.ask, "Accepted at current ask.");

  const k = catalog.negotiation.concession ?? 0.35;
  const next = Math.max(floor, Math.round(s.ask - (s.ask - p) * k));
  if (next <= p) return accept(p, "Accepted.");

  if (s.round >= maxRounds) {
    sessions.delete(s.id);
    return {
      session_id: s.id,
      status: "counter",
      unit_price: next,
      rounds_left: 0,
      deal_token: issueDeal({ item_id: item.id, quantity: s.quantity, unit_price: next, session_id: s.id }),
      message: "Final offer. The deal_token is redeemable in a quote until it expires.",
    };
  }
  s.ask = next;
  return { session_id: s.id, status: "counter", unit_price: next, rounds_left: maxRounds - s.round, message: "Counter-offer. Propose again with the same session_id." };
}

export class MerxError extends Error {
  code: "not_found" | "invalid" | "conflict" | "unauthorized" | "expired";
  constructor(code: MerxError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
