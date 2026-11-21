/** Minimal HTTP helpers shared by the optional provider adapters. No dependencies. */

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text?(): Promise<string> }>;

/** Error from a provider API. `message` never contains response bodies, which may include personal data. */
export class ProviderApiError extends Error {
  readonly status: number;
  readonly providerCode?: string;
  constructor(provider: string, status: number, providerCode?: string) {
    super(`${provider} API request failed with HTTP ${status}${providerCode ? ` (${providerCode})` : ""}`);
    this.name = "ProviderApiError";
    this.status = status;
    this.providerCode = providerCode;
  }
}

export async function requestJson<T>(provider: string, fetchImpl: FetchLike, url: string, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs: number): Promise<T> {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProviderApiError(provider, 0, "network_error");
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code : typeof body?.errors?.[0]?.error_name === "string" ? body.errors[0].error_name : undefined;
    throw new ProviderApiError(provider, res.status, code);
  }
  return body as T;
}

/** application/x-www-form-urlencoded with bracket notation for nested objects (Stripe style). */
export function formEncode(data: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") {
      const nested = Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), x])) : (v as Record<string, unknown>);
      const enc = formEncode(nested, key);
      if (enc) parts.push(enc);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function assertHttpsUrl(value: string, field: string, allowHttpLocalhost = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(allowHttpLocalhost && local && url.protocol === "http:")) || url.username || url.password) throw new Error(`${field} must be an HTTPS URL without credentials`);
  return url.href;
}
