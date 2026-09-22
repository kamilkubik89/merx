#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { generateKeys, loadKeyPair, signObject } from "./core/crypto.ts";
import { lintCatalog } from "./core/lint.ts";
import { MerxEngine } from "./core/engine.ts";
import type { Catalog, MandatePayload } from "./core/types.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const VALUE_FLAGS = new Set(["out", "min", "key", "agent", "max", "currency", "merchants", "categories", "hours"]);
const positional = () => rest.find((r, i) => !r.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(rest[i - 1].slice(2))));
const readCatalog = (p?: string) => JSON.parse(readFileSync(p ?? "examples/stores/tatra-coffee/catalog.json", "utf8")) as Catalog;

const C = { red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", dim: "\x1b[2m", reset: "\x1b[0m" };

switch (cmd) {
  case "keygen": {
    const out = flag("out", ".merx/store-key.pem")!;
    if (existsSync(out) && !rest.includes("--force")) { console.error(`${out} exists (use --force)`); process.exit(1); }
    mkdirSync(out.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    const { privatePem } = generateKeys();
    writeFileSync(out, privatePem, { mode: 0o600 });
    console.log(`wrote ${out}\nkey_id ${loadKeyPair(privatePem).keyId}`);
    break;
  }
  case "lint": {
    const file = positional();
    const report = lintCatalog(readCatalog(file));
    if (rest.includes("--json")) { console.log(JSON.stringify(report, null, 2)); break; }
    const color = (s: number) => (s >= 85 ? C.green : s >= 60 ? C.yellow : C.red);
    console.log(`\nAgent-readiness: ${color(report.score)}${report.score}/100${C.reset}\n`);
    for (const i of report.store_issues) console.log(`  ${C.red}store${C.reset} ${i.field}: ${i.message}`);
    for (const it of report.items) {
      console.log(`${color(it.score)}${String(it.score).padStart(3)}${C.reset}  ${it.item_id}`);
      for (const i of it.issues) console.log(`       ${i.level === "error" ? C.red : i.level === "warn" ? C.yellow : C.dim}${i.level}${C.reset} ${i.field}: ${i.message}`);
    }
    console.log();
    if (rest.includes("--min") && report.score < Number(flag("min"))) process.exit(1);
    break;
  }
  case "feed": {
    const file = positional();
    const e = new MerxEngine({ catalog: readCatalog(file), privateKeyPem: generateKeys().privatePem });
    console.log(JSON.stringify(e.feed(), null, 2));
    break;
  }
  case "mandate": {
    // Simulates the human's wallet: creates a principal key (if missing) and signs a spending mandate for an agent.
    const keyFile = flag("key", ".merx/principal-key.pem")!;
    if (!existsSync(keyFile)) { mkdirSync(".merx", { recursive: true }); writeFileSync(keyFile, generateKeys().privatePem, { mode: 0o600 }); }
    const kp = loadKeyPair(readFileSync(keyFile, "utf8"));
    const payload: MandatePayload = {
      v: 1,
      principal_key: kp.publicKeyB64,
      agent_id: flag("agent", "my-agent")!,
      max_total: { amount: Number(flag("max", "5000")), currency: flag("currency", "EUR")! },
      merchants: (flag("merchants", "*")!).split(","),
      categories: flag("categories")?.split(","),
      expires_at: new Date(Date.now() + Number(flag("hours", "24")) * 3600_000).toISOString(),
      nonce: randomUUID(),
    };
    console.log(JSON.stringify({ payload, signature: signObject(payload, kp).value }, null, 2));
    break;
  }
  default:
    console.log(`merx — agent-native commerce engine

  merx lint [catalog.json] [--json] [--min 80]   agent-readiness score
  merx feed [catalog.json]                       print a signed feed
  merx keygen [--out path] [--force]             store signing key
  merx mandate --agent id --max 5000 [--merchants a,b] [--categories coffee] [--hours 24]
                                                 sign a spending mandate (test wallet)
  npm start                                      run the store server`);
}
