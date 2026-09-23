import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchIntent } from "../src/core/intent.ts";
import type { Catalog, Intent } from "../src/core/types.ts";

const root = new URL("../", import.meta.url);
const output = new URL("../_site/", import.meta.url);
const catalog: Catalog = JSON.parse(readFileSync(new URL("examples/stores/tatra-coffee/catalog.json", root), "utf8"));
const scenarios: { id: string; label: string; intent: Intent }[] = [
  { id: "espresso", label: "Coffee for espresso", intent: { need: "coffee beans for espresso machine, milk drinks, low acidity", constraints: { category: ["beans"], ship_to: "SK", deliver_within_days: 5 } } },
  { id: "decaf", label: "Caffeine-free coffee", intent: { need: "coffee for the evening", constraints: { category: ["beans"], attributes: [{ key: "caffeine", op: "eq", value: false }], ship_to: "SK" } } },
  { id: "budget", label: "Grinder under EUR 80", intent: { need: "hand grinder", constraints: { category: ["grinders"], max_unit_price: 8000, ship_to: "SK" } } },
];

// Publish only operation results. The merchant catalog includes private price floors.
const data = scenarios.map((scenario) => ({ ...scenario, result: matchIntent(catalog, scenario.intent) }));
if (data[0].result.matches[0]?.item_id !== "beans-brazil-cerrado-1kg") throw new Error("Unexpected espresso example; review site copy.");
if (data[1].result.matches.length !== 1 || data[1].result.matches[0].item_id !== "beans-colombia-decaf-250") throw new Error("Unexpected decaf example.");
if (data[2].result.matches.length !== 0 || !data[2].result.rejected.some((r) => r.item_id === "grinder-hand-c40" && r.reasons.some((reason) => reason.includes("negotiable")))) throw new Error("Unexpected budget example.");
const json = JSON.stringify(data, null, 2);
if (json.includes('"floor_price"') || json.includes("PRIVATE KEY")) throw new Error("Private data must not be published.");

mkdirSync(output, { recursive: true });
cpSync(new URL("site/", root), output, { recursive: true });
mkdirSync(new URL("assets/", output), { recursive: true });
for (const name of ["logo.svg", "social-preview.png"]) cpSync(new URL(`docs/assets/${name}`, root), new URL(`assets/${name}`, output));
writeFileSync(new URL("scenarios.json", output), json + "\n");
writeFileSync(new URL(".nojekyll", output), "");
console.log(`Built ${fileURLToPath(output)} with ${data.length} engine-generated scenarios.`);
