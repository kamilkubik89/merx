import type { Catalog, CatalogItem } from "./types.ts";

/**
 * Agent-readiness linter. Agents don't read adjectives, they read facts.
 * `merx lint catalog.json` scores every item 0–100 and tells you why.
 */

const HYPE = [
  "best", "amazing", "incredible", "revolutionary", "perfect", "unbeatable", "world-class", "world class",
  "premium quality", "must-have", "must have", "game-changer", "game changer", "ultimate", "#1", "number one",
  "stunning", "luxurious", "exclusive", "unique", "top quality", "high quality", "best-seller", "bestseller",
];

export type LintIssue = { level: "error" | "warn" | "info"; field: string; message: string };
export type ItemReport = { item_id: string; score: number; issues: LintIssue[] };
export type LintReport = { score: number; store_issues: LintIssue[]; items: ItemReport[] };

export function lintItem(item: CatalogItem): ItemReport {
  const issues: LintIssue[] = [];
  let score = 100;
  const hit = (level: LintIssue["level"], field: string, message: string, cost: number) => {
    issues.push({ level, field, message });
    score -= cost;
  };

  const text = `${item.title} ${item.summary}`.toLowerCase();
  const hype = HYPE.filter((h) => new RegExp(`(^|[^a-z])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(text));
  if (hype.length) hit("error", "summary", `marketing language agents ignore or distrust: ${hype.join(", ")}. State the fact instead.`, 10 * hype.length);
  if (item.summary.length > 280) hit("warn", "summary", "summary > 280 chars; keep it a factual one-liner", 5);
  if (item.summary.length < 30) hit("warn", "summary", "summary too short to be useful", 5);
  if (!item.gtin) hit("warn", "gtin", "no GTIN/EAN; agents can't cross-check price or reviews elsewhere", 10);
  if (item.attributes.length < 4) hit("error", "attributes", `only ${item.attributes.length} attributes; aim for 6+ structured facts`, 15);

  for (const a of item.attributes) {
    if (typeof a.value === "number" && !a.unit && !/count|pieces|qty|rating|score|level|steps/.test(a.key))
      hit("warn", `attributes.${a.key}`, "numeric value without unit", 3);
    if (!a.source) hit("warn", `attributes.${a.key}`, "no source (declared | measured | lab_test | certified | third_party)", 3);
    if (!/^[a-z][a-z0-9_]*$/.test(a.key)) hit("warn", `attributes.${a.key}`, "key should be snake_case", 2);
  }
  const strong = item.attributes.filter((a) => a.source !== "declared").length;
  if (item.attributes.length && strong === 0) hit("info", "attributes", "all facts are self-declared; measured/certified facts rank higher", 5);

  for (const c of item.claims ?? []) {
    if (!c.evidence) hit("error", `claims.${c.id}`, "claim without evidence will be hidden from strict agents", 10);
    else if (c.evidence.type !== "self_declared" && !c.evidence.ref && !c.evidence.url) hit("warn", `claims.${c.id}`, "evidence has no ref or url to verify", 5);
  }
  if (!item.best_for?.length) hit("warn", "best_for", "declare who this is for; it drives intent matching", 8);
  if (!item.not_for?.length) hit("warn", "not_for", "declare who should NOT buy this; honesty is a ranking signal for agents", 8);
  if (!item.media?.length) hit("info", "media", "no media; multimodal agents use images for verification", 2);
  if (item.negotiation && item.negotiation.floor_price > item.price) hit("error", "negotiation.floor_price", "floor above list price", 20);

  return { item_id: item.id, score: Math.max(0, score), issues };
}

export function lintCatalog(catalog: Catalog): LintReport {
  const store_issues: LintIssue[] = [];
  if (!catalog.policies?.returns) store_issues.push({ level: "error", field: "policies.returns", message: "missing machine-readable return policy" });
  if (!catalog.policies?.shipping?.length) store_issues.push({ level: "error", field: "policies.shipping", message: "no shipping methods" });
  if (!catalog.store.legal?.company) store_issues.push({ level: "error", field: "store.legal", message: "legal entity is required for agent trust" });
  const ids = new Set<string>();
  for (const i of catalog.items) {
    if (ids.has(i.id)) store_issues.push({ level: "error", field: `items.${i.id}`, message: "duplicate id" });
    ids.add(i.id);
  }
  const items = catalog.items.map(lintItem);
  const avg = items.length ? items.reduce((s, r) => s + r.score, 0) / items.length : 0;
  const penalty = store_issues.filter((s) => s.level === "error").length * 10;
  return { score: Math.max(0, Math.round(avg - penalty)), store_issues, items };
}
