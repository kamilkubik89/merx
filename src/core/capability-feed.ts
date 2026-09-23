import { canonicalize, sha256 } from "./crypto.ts";
import { toFeedItem } from "./feed.ts";
import { matchIntent } from "./intent.ts";
import type { Scorer } from "./intent.ts";
import { MerxError } from "./negotiate.ts";
import type { Catalog, Intent } from "./types.ts";
import type { PaymentDescriptor } from "./payments.ts";

export type CapabilityRequest = { intent: Intent; known_facts?: Record<string, string> };

function validate(input: CapabilityRequest) {
  const intent = input?.intent;
  const invalid = () => { throw new MerxError("invalid", "invalid capability request; supply a bounded intent and optional known_facts hashes"); };
  if (!intent || typeof intent.need !== "string" || !intent.need.trim() || intent.need.length > 2000) return invalid();
  if (Object.keys(input).some((key) => !["intent", "known_facts"].includes(key)) || Object.keys(intent).some((key) => !["need", "quantity", "limit", "constraints"].includes(key))) return invalid();
  if (intent.limit !== undefined && (!Number.isSafeInteger(intent.limit) || intent.limit < 1 || intent.limit > 50)) return invalid();
  if (intent.quantity !== undefined && (!Number.isSafeInteger(intent.quantity) || intent.quantity < 1)) return invalid();
  if (intent.constraints !== undefined && (!intent.constraints || typeof intent.constraints !== "object" || Array.isArray(intent.constraints))) return invalid();
  const c = intent.constraints ?? {};
  if (Object.keys(c).some((key) => !["max_unit_price", "deliver_within_days", "currency", "ship_to", "category", "must_have_claims", "attributes"].includes(key))) return invalid();
  for (const value of [c.max_unit_price, c.deliver_within_days]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) return invalid();
  if (c.currency !== undefined && (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency))) return invalid();
  if (c.ship_to !== undefined && (typeof c.ship_to !== "string" || !/^[A-Z]{2}$/.test(c.ship_to))) return invalid();
  for (const values of [c.category, c.must_have_claims]) if (values !== undefined && (!Array.isArray(values) || values.length > 50 || values.some((v) => typeof v !== "string" || v.length > 200))) return invalid();
  if (c.attributes !== undefined && (!Array.isArray(c.attributes) || c.attributes.length > 50 || c.attributes.some((a) => !a || typeof a.key !== "string" || !["eq", "gte", "lte", "in", "contains"].includes(a.op) || !("value" in a)))) return invalid();
  if (input.known_facts !== undefined && (!input.known_facts || typeof input.known_facts !== "object" || Array.isArray(input.known_facts) || Object.keys(input.known_facts).length > 1000 || Object.entries(input.known_facts).some(([id, hash]) => id.length > 200 || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))) return invalid();
}

/** Merx experimental format: stable evidence cards + short-lived decision context. */
export function buildCapabilityPacket(
  catalog: Catalog,
  updatedAt: Map<string, string>,
  input: CapabilityRequest,
  scorer: Scorer,
  payments: (filter: { currency?: string; country?: string }) => PaymentDescriptor[],
) {
  validate(input);
  const intent = { ...input.intent, limit: input.intent.limit ?? 10 };
  const result = matchIntent(catalog, intent, scorer);
  const now = new Date();
  const paymentMethods = payments({ currency: catalog.store.currency, country: intent.constraints?.ship_to });
  const cards = result.matches.map((match) => {
    const item = catalog.items.find((candidate) => candidate.id === match.item_id)!;
    const feedItem = toFeedItem(item, catalog, { updatedAt: updatedAt.get(item.id) ?? now.toISOString(), offerTtlSeconds: 60, now });
    const { offer, content_hash: _contentHash, updated_at: _updatedAt, ...facts } = feedItem;
    const revision = sha256(canonicalize(facts));
    const quantity = intent.quantity ?? 1;
    const shipTo = intent.constraints?.ship_to;
    return {
      item_id: item.id,
      facts_revision: revision,
      ...(input.known_facts?.[item.id] === revision ? {} : { facts }),
      decision: { score: match.score, reasons: match.reasons, warnings: match.warnings },
      evidence: {
        referenced_claims: (item.claims ?? []).filter((claim) => claim.evidence && claim.evidence.type !== "self_declared").map((claim) => claim.id),
        unverified_claims: (item.claims ?? []).filter((claim) => !claim.evidence || claim.evidence.type === "self_declared").map((claim) => claim.id),
        verification: "references_only_not_independently_verified",
      },
      offer: { ...offer, observed_at: now.toISOString(), binding: "indicative_requires_quote" },
      missing_context: [...(!shipTo ? ["ship_to_required_for_shipping_total"] : []), ...(!paymentMethods.length ? ["no_configured_payment_method_for_context"] : [])],
      actions: [
        { operation: "create_quote", arguments: { lines: [{ item_id: item.id, quantity }], ...(shipTo ? { ship_to: shipTo } : {}) }, requires: !shipTo ? ["ship_to"] : [], optional: ["payment_method"] },
        ...(offer.negotiable ? [{ operation: "negotiate", arguments: { item_id: item.id, quantity }, requires: ["proposed_unit_price"] }] : []),
      ],
    };
  });
  return {
    format: "merx-capability/0.1",
    merchant: { id: catalog.store.id, name: catalog.store.name },
    request_hash: sha256(canonicalize(input)),
    generated_at: now.toISOString(),
    refresh_after: new Date(now.getTime() + 60_000).toISOString(),
    cache: { facts: "reuse_by_sha256_revision", offers: "refresh_before_quote", removal_semantics: "absence_is_not_a_deletion" },
    policy_revision: sha256(canonicalize(catalog.policies)),
    policies: catalog.policies,
    payment_methods: paymentMethods,
    cards,
    rejected: result.rejected.slice(0, 100),
    rejections_truncated: result.rejected.length > 100,
    limits: { returned: cards.length, requested: intent.limit, scope: "this_merchant_only" },
  };
}
