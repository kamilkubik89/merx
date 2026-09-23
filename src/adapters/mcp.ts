import type { Adapter } from "./adapter.ts";
import { operations, findOp } from "./operations.ts";
import { MerxError } from "../core/negotiate.ts";
import { RawResponse } from "../http/router.ts";

/**
 * Model Context Protocol (Streamable HTTP, JSON responses, stateless).
 * Any MCP client (Claude, IDE agents, custom) can add this store as a server:
 *   { "url": "https://your-store/mcp" }
 */
export const mcpAdapter: Adapter = {
  name: "mcp",
  describe: (base) => ({ protocol: "mcp/2025-06-18", endpoint: `${base}/mcp`, notes: "tools = Merx operations" }),
  mount(r, engine) {
    r.post("/mcp", async (c) => {
      const msg = c.body;
      if (Array.isArray(msg)) return rpcErr(null, -32600, "batching not supported");
      if (msg?.id === undefined || msg?.id === null) return new RawResponse(202, ""); // notification
      const agent = String(c.req.headers["merx-agent-id"] ?? msg.params?.clientInfo?.name ?? "mcp-client");
      switch (msg.method) {
        case "initialize":
          return rpcOk(msg.id, {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `merx:${engine.catalog.store.id}`, version: "0.2.0" },
            instructions: `You are connected to ${engine.catalog.store.name}, an agent-only store. Start with find_products. Prices are integer minor units in ${engine.catalog.store.currency}. place_order requires a mandate signed by your human.`,
          });
        case "ping":
          return rpcOk(msg.id, {});
        case "tools/list":
          return rpcOk(msg.id, { tools: operations.map((o) => ({ name: o.name, description: o.description, inputSchema: o.input_schema })) });
        case "tools/call": {
          const op = findOp(msg.params?.name);
          if (!op) return rpcErr(msg.id, -32602, `unknown tool ${msg.params?.name}`);
          try {
            const out = await op.run(engine, msg.params?.arguments ?? {}, agent);
            return rpcOk(msg.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
          } catch (e) {
            if (e instanceof MerxError) return rpcOk(msg.id, { content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true });
            throw e;
          }
        }
        default:
          return rpcErr(msg.id, -32601, `method ${msg.method} not found`);
      }
    });
    r.get("/mcp", () => new RawResponse(405, "", { allow: "POST" }));
  },
};

const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
