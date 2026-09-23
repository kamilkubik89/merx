/** Demonstrates intent-specific discovery and reuse of verified product facts. */
import { readFileSync } from "node:fs";
import { MerxEngine } from "../src/core/engine.ts";
import { generateKeys, verifyObject } from "../src/core/crypto.ts";
import type { Catalog } from "../src/core/types.ts";

const catalog: Catalog = JSON.parse(readFileSync(new URL("./stores/tatra-coffee/catalog.json", import.meta.url), "utf8"));
const engine = new MerxEngine({ catalog, privateKeyPem: generateKeys().privatePem });
const intent = { need: "coffee for espresso, low acidity", constraints: { category: ["beans"], ship_to: "SK" }, limit: 2 };
const packet = engine.discover({ intent });
const { signature, ...payload } = packet;
if (!verifyObject(payload, signature.value, engine.keys.publicKey)) throw new Error("Invalid packet signature");
console.log("Verified capability packet:");
console.log(JSON.stringify(packet, null, 2));

const known_facts = Object.fromEntries(packet.cards.map((card) => [card.item_id, card.facts_revision]));
const refreshed = engine.discover({ intent, known_facts });
console.log("\nRefresh: cached facts omitted, current offers retained");
console.log(JSON.stringify(refreshed.cards.map((card) => ({ item_id: card.item_id, facts_included: card.facts !== undefined, offer: card.offer, actions: card.actions })), null, 2));
