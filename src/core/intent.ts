import type { AttributeFilter, Catalog, CatalogItem, Intent, IntentResult } from "./types.ts";

/**
 * Intent matching: an agent says what it NEEDS, the store answers with ranked
 * candidates AND with explicit reasons why other items were rejected.
 *
 * The default scorer is lexical and dependency-free on purpose. Swap it for
 * embeddings by passing your own `Scorer` to the engine.
 */
export type Scorer = (need: string, item: CatalogItem) => { score: number; reasons: string[]; warnings: string[] };

const STOP = new Set(["a", "an", "the", "for", "and", "or", "with", "of", "to", "in", "on", "my", "i", "need", "want", "some", "that", "is", "it", "be", "not", "no"]);

export const tokenize = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1 && !STOP.has(t));

// light stemming so "grinders" ~ "grinder", "brewing" ~ "brew"
const stem = (t: string) => t.replace(/(ing|ers|er|es|s)$/u, "") || t;

function hits(query: string[], text: string | string[]): string[] {
  const bag = new Set(tokenize(Array.isArray(text) ? text.join(" ") : text).map(stem));
  return query.filter((q) => bag.has(stem(q)));
}

export const lexicalScorer: Scorer = (need, item) => {
  const q = [...new Set(tokenize(need))];
  if (q.length === 0) return { score: 0.5, reasons: ["no keywords in need, neutral score"], warnings: [] };
  const reasons: string[] = [];
  const warnings: string[] = [];
  const fields: [string, string | string[], number][] = [
    ["title", item.title, 3],
    ["best_for", item.best_for ?? [], 3],
    ["category", item.category, 2],
    ["claims", (item.claims ?? []).map((c) => `${c.id} ${c.statement}`), 2],
    ["attributes", item.attributes.map((a) => `${a.key} ${String(a.value)}`), 1.5],
    ["summary", item.summary, 1],
  ];
  const matched = new Set<string>();
  let raw = 0;
  for (const [name, text, weight] of fields) {
    const h = hits(q, text);
    if (h.length) {
      raw += weight * h.length;
      h.forEach((x) => matched.add(x));
      reasons.push(`${name} matches: ${h.join(", ")}`);
    }
  }
  const bad = hits(q, item.not_for ?? []);
  if (bad.length) {
    raw -= 4 * bad.length;
    warnings.push(`merchant says NOT suitable for: ${bad.join(", ")}`);
  }
  const coverage = matched.size / q.length;
  const intensity = Math.min(1, raw / (q.length * 4));
  const score = Math.max(0, Math.min(1, 0.6 * coverage + 0.4 * intensity));
  return { score: Math.round(score * 1000) / 1000, reasons, warnings };
};

function checkAttr(item: CatalogItem, f: AttributeFilter): string | null {
  const a = item.attributes.find((x) => x.key === f.key);
  if (!a) return `attribute ${f.key} unknown`;
  const v = a.value;
  const ok =
    f.op === "eq" ? v === f.value :
    f.op === "gte" ? typeof v === "number" && v >= Number(f.value) :
    f.op === "lte" ? typeof v === "number" && v <= Number(f.value) :
    f.op === "in" ? Array.isArray(f.value) && (f.value as unknown[]).includes(v) :
    f.op === "contains" ? (Array.isArray(v) ? v.includes(String(f.value)) : String(v).toLowerCase().includes(String(f.value).toLowerCase())) :
    false;
  return ok ? null : `${f.key}=${JSON.stringify(v)}${a.unit ? a.unit : ""} fails ${f.op} ${JSON.stringify(f.value)}`;
}

export function matchIntent(catalog: Catalog, intent: Intent, scorer: Scorer = lexicalScorer): IntentResult {
  const c = intent.constraints ?? {};
  const qty = intent.quantity ?? 1;
  const result: IntentResult = { matches: [], rejected: [] };

  for (const item of catalog.items) {
    const why: string[] = [];
    if (item.stock < qty) why.push(`insufficient stock (${item.stock} < ${qty})`);
    if (c.currency && c.currency !== catalog.store.currency) why.push(`currency ${catalog.store.currency} != ${c.currency}`);
    if (c.max_unit_price !== undefined && item.price > c.max_unit_price) {
      const negotiable = catalog.negotiation?.enabled && item.negotiation;
      why.push(`price ${item.price} > max ${c.max_unit_price}${negotiable ? " (item is negotiable, try /negotiate)" : ""}`);
    }
    if (c.category?.length && !c.category.some((x) => item.category.includes(x))) why.push(`category ${item.category.join("/")} not in ${c.category.join(",")}`);
    for (const claim of c.must_have_claims ?? []) {
      const found = item.claims?.find((x) => x.id === claim);
      if (!found) why.push(`missing claim ${claim}`);
      else if (!found.evidence || found.evidence.type === "self_declared") why.push(`claim ${claim} has no third-party evidence`);
    }
    for (const f of c.attributes ?? []) {
      const e = checkAttr(item, f);
      if (e) why.push(e);
    }
    const methods = c.ship_to ? catalog.policies.shipping.filter((s) => s.regions.includes(c.ship_to!)) : catalog.policies.shipping;
    if (c.ship_to && methods.length === 0) why.push(`does not ship to ${c.ship_to}`);
    if (c.deliver_within_days !== undefined && methods.length) {
      const fastest = Math.min(...methods.map((m) => m.days[1])) + item.lead_time_days;
      if (fastest > c.deliver_within_days) why.push(`worst-case delivery ${fastest}d > ${c.deliver_within_days}d`);
    }

    if (why.length) {
      result.rejected.push({ item_id: item.id, reasons: why });
      continue;
    }
    const s = scorer(intent.need, item);
    if (s.score <= 0) {
      result.rejected.push({ item_id: item.id, reasons: ["not relevant to the stated need", ...s.warnings] });
      continue;
    }
    result.matches.push({
      item_id: item.id,
      title: item.title,
      score: s.score,
      unit_price: { amount: item.price, currency: catalog.store.currency },
      reasons: s.reasons,
      warnings: s.warnings,
    });
  }
  result.matches.sort((a, b) => b.score - a.score || a.unit_price.amount - b.unit_price.amount);
  result.matches = result.matches.slice(0, intent.limit ?? 10);
  return result;
}
