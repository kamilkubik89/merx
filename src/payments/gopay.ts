import { assertMoney } from "../core/money.ts";
import type { PaymentStatus } from "../core/payment-state.ts";
import { WebhookVerificationError } from "../core/payments.ts";
import type { PaymentProvider, PaymentSetup, ProviderPaymentStatus, RefundRequest, RefundResult, VerifiedPaymentEvent, WebhookRequest } from "../core/payments.ts";
import { assertHttpsUrl, requestJson } from "./http.ts";
import type { FetchLike } from "./http.ts";

/**
 * Optional GoPay adapter for Czech and Slovak merchants (REST API, OAuth2
 * client credentials). No SDK, no dependency.
 *
 * GoPay notifications are an HTTP GET carrying only the payment `id` and no
 * signature. This adapter therefore never trusts the notification itself: it
 * performs an authenticated server-to-server status lookup and returns that
 * authoritative state, which the engine checks against the order (amount,
 * currency, order number) before any transition.
 *
 * GoPay's API has no idempotency keys. Merx persists the attempt before calling
 * the API and serializes setup per order; an orphan payment created by a timed-out
 * request expires unpaid, and if it is paid anyway the engine adopts it after the
 * same verification. Merx is not affiliated with GoPay; check the current
 * documentation (https://doc.gopay.com/) before going live.
 */
export type GoPayConfig = {
  clientId: string;
  clientSecret: string;
  /** Merchant GoPay ID (GoID). */
  goid: string | number;
  /** Where GoPay returns the human. Not proof of payment. */
  returnUrl: string;
  /** Public URL of Merx's webhook route: `https://your-store/v1/webhooks/payments/<id>`. */
  notificationUrl: string;
  /** Default "sandbox". "production" is an explicit opt-in. */
  environment?: "sandbox" | "production";
  id?: string;
  label?: string;
  currencies?: string[];
  countries?: string[];
  /** Gateway language, e.g. "SK", "CS", "EN". */
  lang?: string;
  fetch?: FetchLike;
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
};

type GoPayPayment = { id: number | string; order_number?: string; state?: string; amount?: number; currency?: string; gw_url?: string };

const STATES: Record<string, PaymentStatus> = {
  CREATED: "requires_action",
  PAYMENT_METHOD_CHOSEN: "requires_action",
  AUTHORIZED: "payment_pending",
  PAID: "paid",
  CANCELED: "canceled",
  TIMEOUTED: "canceled",
  PARTIALLY_REFUNDED: "partially_refunded",
  REFUNDED: "refunded",
};

export function gopay(config: GoPayConfig): PaymentProvider {
  if (!config.clientId || !config.clientSecret) throw new Error("GoPay clientId and clientSecret are required");
  if (!/^\d{1,20}$/.test(String(config.goid))) throw new Error("GoPay goid must be numeric");
  const production = config.environment === "production";
  const returnUrl = assertHttpsUrl(config.returnUrl, "returnUrl", !production);
  const notificationUrl = assertHttpsUrl(config.notificationUrl, "notificationUrl", !production);
  const base = (config.apiBase ?? (production ? "https://gate.gopay.cz" : "https://gw.sandbox.gopay.com")).replace(/\/$/, "");
  const doFetch: FetchLike = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeout = config.timeoutMs ?? 15_000;
  const now = config.now ?? Date.now;
  let token: { value: string; expires: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token && token.expires > now()) return token.value;
    const res = await requestJson<{ access_token?: string; expires_in?: number }>("GoPay", doFetch, `${base}/api/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "grant_type=client_credentials&scope=payment-all",
    }, timeout);
    if (typeof res?.access_token !== "string" || !res.access_token) throw new Error("GoPay returned no access token");
    token = { value: res.access_token, expires: now() + Math.max(60, (res.expires_in ?? 1800) - 60) * 1000 };
    return token.value;
  }

  async function api<T>(method: string, path: string, body?: { json?: unknown; form?: string }): Promise<T> {
    const auth = `Bearer ${await accessToken()}`;
    const headers: Record<string, string> = { authorization: auth, accept: "application/json" };
    if (body?.json !== undefined) headers["content-type"] = "application/json";
    if (body?.form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    return requestJson<T>("GoPay", doFetch, `${base}${path}`, { method, headers, ...(body?.json !== undefined ? { body: JSON.stringify(body.json) } : body?.form !== undefined ? { body: body.form } : {}) }, timeout);
  }

  const paymentId = (id: string) => {
    if (!/^\d{1,20}$/.test(id)) throw new Error("invalid GoPay payment ID");
    return id;
  };

  const provider: PaymentProvider = {
    id: config.id ?? "gopay",
    descriptor: {
      label: config.label ?? "GoPay (cards, bank buttons, wallets)",
      flow: "redirect",
      protocols: ["gopay-rest"],
      currencies: config.currencies ?? ["CZK", "EUR"],
      countries: config.countries ?? ["CZ", "SK"],
      verifies_settlement: true,
      capabilities: ["webhook", "status", "refund"],
    },

    async initiatePayment(req): Promise<PaymentSetup> {
      assertMoney(req.total, req.currency, { positive: true });
      const payment = await api<GoPayPayment>("POST", "/api/payments/payment", {
        json: {
          target: { type: "ACCOUNT", goid: Number(config.goid) },
          amount: req.total,
          currency: req.currency,
          order_number: req.idempotency_key.slice(0, 128),
          order_description: `Order ${req.order_id}`.slice(0, 256),
          items: [{ type: "ITEM", name: `Order ${req.order_id}`.slice(0, 256), amount: req.total, count: 1 }],
          callback: { return_url: returnUrl, notification_url: notificationUrl },
          additional_params: [{ name: "merx_order_id", value: req.order_id }, { name: "merx_quote_hash", value: req.quote_hash }],
          ...(config.lang ? { lang: config.lang } : {}),
        },
      });
      const id = String(payment?.id ?? "");
      if (!/^\d{1,20}$/.test(id) || typeof payment.gw_url !== "string") throw new Error("GoPay returned an unexpected payment");
      if (payment.amount !== undefined && (payment.amount !== req.total || payment.currency !== req.currency)) throw new Error("GoPay payment amount does not match the order");
      return {
        status: "requires_action",
        provider_payment_id: id,
        instructions: {
          type: "redirect",
          provider: "gopay",
          checkout_url: assertHttpsUrl(payment.gw_url, "gw_url"),
          notice: "The human completes payment on the GoPay gateway. Returning to the store does not prove payment; check payment_status.",
        },
      };
    },

    async createPayment(req) {
      return (await provider.initiatePayment!(req)).instructions;
    },

    async getPaymentStatus(id): Promise<ProviderPaymentStatus> {
      const p = await api<GoPayPayment>("GET", `/api/payments/payment/${paymentId(id)}`);
      return mapPayment(p);
    },

    async verifyWebhook(req: WebhookRequest): Promise<VerifiedPaymentEvent | null> {
      if (req.method !== "GET" && req.method !== "POST") throw new WebhookVerificationError("unsupported GoPay notification method");
      const id = req.query.get("id") ?? "";
      if (!/^\d{1,20}$/.test(id)) throw new WebhookVerificationError("GoPay notification has no valid payment id");
      // The notification is unauthenticated; the status lookup below is the verification.
      const p = await api<GoPayPayment>("GET", `/api/payments/payment/${id}`);
      if (String(p?.id) !== id || typeof p.state !== "string") throw new WebhookVerificationError("GoPay status lookup did not match the notification");
      return { event_id: `${id}:${p.state}`, provider_payment_id: id, ...mapPayment(p) };
    },

    async refund(req: RefundRequest): Promise<RefundResult> {
      assertMoney(req.amount, req.currency, { positive: true });
      const res = await api<{ id?: number | string; result?: string }>("POST", `/api/payments/payment/${paymentId(req.provider_payment_id)}/refund`, { form: `amount=${req.amount}` });
      if (res?.result === "FINISHED") return { refund_id: String(res.id ?? req.provider_payment_id), status: "succeeded" };
      if (res?.result === "ACCEPTED") return { refund_id: String(res.id ?? req.provider_payment_id), status: "pending" };
      throw new Error("GoPay did not accept the refund");
    },
  };
  return provider;
}

function mapPayment(p: GoPayPayment): ProviderPaymentStatus {
  const status = STATES[p?.state ?? ""];
  if (!status) throw new Error("GoPay returned an unknown payment state");
  const orderId = typeof p.order_number === "string" ? p.order_number.split(":")[0] : undefined;
  return {
    status,
    ...(typeof p.amount === "number" ? { amount: p.amount } : {}),
    ...(typeof p.currency === "string" ? { currency: p.currency } : {}),
    ...(orderId ? { order_id: orderId } : {}),
  };
}
