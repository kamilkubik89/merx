import type { IncomingMessage, ServerResponse } from "node:http";
import { MerxError } from "../core/negotiate.ts";
import { WebhookVerificationError } from "../core/payments.ts";

export type Ctx = {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  /** Exact request bytes; populated only on routes registered with `{ raw: true }` (e.g. webhooks). */
  rawBody?: Buffer;
  baseUrl: string;
  agentId: string; // from `Merx-Agent-Id` header, "anonymous" otherwise
};
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Route = { method: string; re: RegExp; keys: string[]; handler: Handler; raw?: boolean };
export type RouteOptions = { raw?: boolean };

const STATUS: Record<MerxError["code"], number> = { not_found: 404, invalid: 400, conflict: 409, unauthorized: 403, expired: 410, unauthenticated: 401, unavailable: 503 };

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler, opts: RouteOptions = {}) {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/\/:(\w+)/g, (_, k) => (keys.push(k), "/([^/]+)")) + "/?$");
    this.routes.push({ method, re, keys, handler, raw: opts.raw });
    return this;
  }
  get = (p: string, h: Handler, o?: RouteOptions) => this.on("GET", p, h, o);
  post = (p: string, h: Handler, o?: RouteOptions) => this.on("POST", p, h, o);

  async handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
    const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
    const url = new URL(req.url ?? "/", `${proto}://${host}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, merx-agent-id, merx-order-token, mcp-session-id, mcp-protocol-version");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      try {
        const raw = req.method === "POST" ? await readBody(req) : undefined;
        const body = raw && !r.raw ? parseJson(raw) : undefined;
        const ctx: Ctx = {
          ...(r.raw ? { rawBody: raw ?? Buffer.alloc(0) } : {}),
          req,
          params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
          query: url.searchParams,
          body,
          baseUrl: `${proto}://${host}`,
          agentId: String(req.headers["merx-agent-id"] ?? "anonymous"),
        };
        const out = await r.handler(ctx);
        if (out instanceof RawResponse) return void res.writeHead(out.status, out.headers).end(out.body);
        return json(res, 200, out);
      } catch (e) {
        if (e instanceof MerxError) return json(res, STATUS[e.code], { error: { code: e.code, message: e.message } });
        if (e instanceof SyntaxError) return json(res, 400, { error: { code: "invalid", message: "body is not valid JSON" } });
        if (e instanceof WebhookVerificationError) return json(res, 400, { error: { code: "invalid", message: "webhook verification failed" } });
        console.error(e);
        return json(res, 500, { error: { code: "internal", message: "internal error" } });
      }
    }
    json(res, 404, { error: { code: "not_found", message: `no route ${req.method} ${url.pathname}`, hint: "GET /.well-known/merx.json" } });
  }
}

export class RawResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  constructor(status: number, body: string, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body, null, 2));
}

function parseJson(raw: Buffer): unknown {
  const s = raw.toString();
  return s ? JSON.parse(s) : {};
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new MerxError("invalid", "body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
