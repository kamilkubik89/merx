import { randomUUID } from "node:crypto";
import type { Adapter } from "./adapter.ts";
import { operations, findOp } from "./operations.ts";
import { MerxError } from "../core/negotiate.ts";

/**
 * Agent2Agent (A2A) binding — minimal JSON-RPC `message/send`.
 * Send a DataPart { "operation": "<name>", "input": {...} },
 * or a plain TextPart which is treated as `find_products` with that need.
 */
export const a2aAdapter: Adapter = {
  name: "a2a",
  describe: (base) => ({ protocol: "a2a/0.3", endpoint: `${base}/a2a`, notes: `card: ${base}/.well-known/agent-card.json` }),
  mount(r, engine) {
    const card = (base: string) => ({
      protocolVersion: "0.3.0",
      name: engine.catalog.store.name,
      description: `${engine.catalog.store.description} (Merx agent-only store)`,
      url: `${base}/a2a`,
      preferredTransport: "JSONRPC",
      version: "0.2.0",
      provider: { organization: engine.catalog.store.legal.company, url: engine.catalog.store.url },
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json"],
      skills: operations.map((o) => ({ id: o.name, name: o.name, description: o.description, tags: ["commerce", "merx"] })),
    });
    r.get("/.well-known/agent-card.json", (c) => card(c.baseUrl));
    r.get("/.well-known/agent.json", (c) => card(c.baseUrl)); // older A2A path

    r.post("/a2a", async (c) => {
      const msg = c.body;
      if (msg?.method !== "message/send") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32601, message: "only message/send is supported" } };
      const parts: any[] = msg.params?.message?.parts ?? [];
      const data = parts.find((p) => p.kind === "data")?.data;
      const text = parts.filter((p) => p.kind === "text").map((p) => p.text).join(" ");
      const opName = data?.operation ?? "find_products";
      const input = data?.input ?? { need: text };
      const op = findOp(opName);
      const agent = String(c.req.headers["merx-agent-id"] ?? msg.params?.message?.metadata?.agent_id ?? "a2a-agent");
      let out: unknown;
      try {
        if (!op) throw new MerxError("invalid", `unknown operation ${opName}`);
        out = await op.run(engine, input, agent);
      } catch (e) {
        if (!(e instanceof MerxError)) throw e;
        out = { error: { code: e.code, message: e.message } };
      }
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { kind: "message", role: "agent", messageId: randomUUID(), contextId: msg.params?.message?.contextId, parts: [{ kind: "data", data: { operation: opName, output: out } }] },
      };
    });
  },
};
