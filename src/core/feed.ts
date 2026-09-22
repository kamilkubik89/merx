import { canonicalize, sha256 } from "./crypto.ts";
import type { Catalog, CatalogItem, Feed, FeedItem } from "./types.ts";

export const MERX_VERSION = "0.1";

/** Units we know how to normalise into a "price per X" basis, so agents can compare apples to apples. */
const BASIS: Record<string, { per: string; factor: number }> = {
  g: { per: "kg", factor: 1000 },
  kg: { per: "kg", factor: 1 },
  ml: { per: "l", factor: 1000 },
  l: { per: "l", factor: 1 },
};

function compareBasis(item: CatalogItem) {
  const qty = item.attributes.find((a) => a.key === "net_weight" || a.key === "net_volume");
  if (!qty || typeof qty.value !== "number" || !qty.unit || !BASIS[qty.unit]) return undefined;
  const b = BASIS[qty.unit];
  return { per: b.per, amount: Math.round((item.price / qty.value) * b.factor) };
}

export function toFeedItem(item: CatalogItem, catalog: Catalog, opts: { updatedAt: string; offerTtlSeconds: number; now: Date }): FeedItem {
  const { price, stock, lead_time_days, negotiation, ...pub } = item;
  const negotiable = Boolean(catalog.negotiation?.enabled && negotiation);
  const offer = {
    price: { amount: price, currency: catalog.store.currency },
    compare_basis: compareBasis(item),
    availability: { in_stock: stock > 0, quantity: stock, lead_time_days },
    negotiable,
    valid_until: new Date(opts.now.getTime() + opts.offerTtlSeconds * 1000).toISOString(),
  };
  // content_hash ignores valid_until so it only changes when something real changes
  const content_hash = sha256(canonicalize({ ...pub, offer: { ...offer, valid_until: null } })).slice(0, 24);
  return { ...pub, offer, content_hash, updated_at: opts.updatedAt };
}

export function buildFeed(
  catalog: Catalog,
  updatedAt: Map<string, string>,
  opts: { since?: string; category?: string; ttlSeconds?: number; now?: Date } = {},
): Feed {
  const now = opts.now ?? new Date();
  const ttl = opts.ttlSeconds ?? 900;
  let items = catalog.items;
  if (opts.category) items = items.filter((i) => i.category.includes(opts.category!));
  if (opts.since) items = items.filter((i) => (updatedAt.get(i.id) ?? "") > opts.since!);

  return {
    merx: MERX_VERSION,
    store: catalog.store,
    policies: catalog.policies,
    negotiation: {
      enabled: Boolean(catalog.negotiation?.enabled),
      max_rounds: catalog.negotiation?.max_rounds ?? 0,
      public_rules: catalog.negotiation?.rules ?? [],
    },
    generated_at: now.toISOString(),
    ttl_seconds: ttl,
    items: items.map((i) => toFeedItem(i, catalog, { updatedAt: updatedAt.get(i.id) ?? now.toISOString(), offerTtlSeconds: ttl, now })),
  };
}
