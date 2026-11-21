import { createHmac, timingSafeEqual } from "node:crypto";
import { assertMoney } from "../core/money.ts";
import type { PaymentStatus } from "../core/payment-state.ts";
import { WebhookVerificationError } from "../core/payments.ts";
import type { PaymentProvider, PaymentRequest, PaymentSetup, ProviderPaymentStatus, RefundRequest, RefundResult, VerifiedPaymentEvent, WebhookRequest } from "../core/payments.ts";
import { assertHttpsUrl, formEncode, header, requestJson } from "./http.ts";
import type { FetchLike } from "./http.ts";

/**
 * Optional Stripe Checkout adapter (hosted payment page).
 *
 * - No Stripe SDK: uses Node's `fetch` and `crypto`, so Merx keeps zero runtime dependencies.
 * - Test mode by default. Live keys are refused unless `allowLiveMode: true`.
 * - Amount and currency come from the server-validated order, never from the agent.
 * - Webhooks are verified over the raw body (Stripe-Signature, HMAC-SHA256, timestamp tolerance).
 * - A browser redirect to `successUrl` is not proof of payment; only verified events or
 *   reconciliation change the payment status.
 *
 * Merx is not affiliated with Stripe. Check Stripe's current documentation and your
 * account's API version before going live.
 */
export type StripeCheckoutConfig = {
  /** `sk_test_…` / `rk_test_…` (restricted keys recommended). Load from the environment or a secret manager. */
  secretKey: string;
  /** `whsec_…` signing secret of the webhook endpoint. Required to accept webhooks. */
  webhookSecret?: string;
  /** Where Stripe sends the human after payment. It may contain `{CHECKOUT_SESSION_ID}`. */
  successUrl: string;
  cancelUrl: string;
  id?: string;
  label?: string;
  currencies?: string[];
  countries?: string[];
  /** Refuse live keys unless explicitly enabled. Default false. */
  allowLiveMode?: boolean;
  /** Checkout Session lifetime: 1800–86400 seconds (Stripe limits). Default 1800. */
  sessionTtlSeconds?: number;
  /** Maximum webhook timestamp skew. Default 300 seconds. */
  toleranceSeconds?: number;
  /** Stripe Connect: act on and accept events only for this connected account. */
  accountId?: string;
  /** Pin a Stripe API version header, e.g. "2024-06-20". Default: the account's version. */
  apiVersion?: string;
  productName?: (request: PaymentRequest) => string;
  fetch?: FetchLike;
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
};

type StripeSession = {
  id: string;
  object?: string;
  url?: string | null;
  status?: "open" | "complete" | "expired" | null;
  payment_status?: "paid" | "unpaid" | "no_payment_required";
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  payment_intent?: string | { id: string } | null;
  livemode?: boolean;
  expires_at?: number;
};

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;

export function stripeCheckout(config: StripeCheckoutConfig): PaymentProvider {
  const key = config.secretKey;
  const live = /^(sk|rk)_live_/.test(key ?? "");
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key ?? "")) throw new Error("Stripe secretKey must be a secret or restricted API key");
  if (live && !config.allowLiveMode) throw new Error("Stripe live key refused: set allowLiveMode: true after completing a production review");
  if (config.webhookSecret !== undefined && !/^whsec_[A-Za-z0-9+/=_-]+$/.test(config.webhookSecret)) throw new Error("Stripe webhookSecret must start with whsec_");
  assertHttpsUrl(config.successUrl.replace("{CHECKOUT_SESSION_ID}", "SESSION"), "successUrl", !live);
  const successUrl = config.successUrl;
  const cancelUrl = assertHttpsUrl(config.cancelUrl, "cancelUrl", !live);
  const ttl = config.sessionTtlSeconds ?? 1800;
  if (!Number.isInteger(ttl) || ttl < 1800 || ttl > 86400) throw new Error("sessionTtlSeconds must be between 1800 and 86400");
  const tolerance = config.toleranceSeconds ?? 300;
  const doFetch: FetchLike = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (config.apiBase ?? "https://api.stripe.com").replace(/\/$/, "");
  const timeout = config.timeoutMs ?? 15_000;
  const now = config.now ?? Date.now;
  const id = config.id ?? "stripe_checkout";

  const headers = (idempotencyKey?: string): Record<string, string> => ({
    authorization: `Bearer ${key}`,
    "content-type": "application/x-www-form-urlencoded",
    ...(idempotencyKey ? { "idempotency-key": `merx:${idempotencyKey}` } : {}),
    ...(config.apiVersion ? { "stripe-version": config.apiVersion } : {}),
    ...(config.accountId ? { "stripe-account": config.accountId } : {}),
  });
  const call = <T>(method: string, path: string, body?: Record<string, unknown>, idempotencyKey?: string) =>
    requestJson<T>("Stripe", doFetch, `${base}${path}`, { method, headers: headers(idempotencyKey), ...(body ? { body: formEncode(body) } : {}) }, timeout);

  const retrieve = (sessionId: string) => {
    if (!SESSION_ID.test(sessionId)) throw new Error("invalid Stripe Checkout Session ID");
    return call<StripeSession>("GET", `/v1/checkout/sessions/${sessionId}`);
  };

  const provider: PaymentProvider = {
    id,
    descriptor: {
      label: config.label ?? "Card and wallets (Stripe Checkout)",
      flow: "redirect",
      protocols: ["stripe-checkout"],
      currencies: config.currencies ?? ["EUR"],
      ...(config.countries ? { countries: config.countries } : {}),
      verifies_settlement: true,
      capabilities: ["webhook", "status", "refund", "cancel"],
    },

    async initiatePayment(req): Promise<PaymentSetup> {
      assertMoney(req.total, req.currency, { positive: true });
      const session = await call<StripeSession>("POST", "/v1/checkout/sessions", {
        mode: "payment",
        client_reference_id: req.order_id,
        success_url: successUrl,
        cancel_url: cancelUrl,
        expires_at: Math.floor(now() / 1000) + ttl,
        line_items: [{ quantity: 1, price_data: { currency: req.currency.toLowerCase(), unit_amount: req.total, product_data: { name: (config.productName ?? ((r) => `Order ${r.order_id}`))(req).slice(0, 250) } } }],
        metadata: { merx_order_id: req.order_id, merx_quote_id: req.quote_id, merx_quote_hash: req.quote_hash },
        payment_intent_data: { metadata: { merx_order_id: req.order_id } },
      }, req.idempotency_key);
      if (!session || !SESSION_ID.test(session.id) || typeof session.url !== "string") throw new Error("Stripe returned an unexpected Checkout Session");
      if (session.livemode !== undefined && session.livemode !== live) throw new Error("Stripe Checkout Session mode does not match the configured key");
      if (session.amount_total != null && (session.amount_total !== req.total || session.currency?.toUpperCase() !== req.currency)) throw new Error("Stripe Checkout Session amount does not match the order");
      return {
        status: "requires_action",
        provider_payment_id: session.id,
        instructions: {
          type: "redirect",
          provider: "stripe",
          checkout_url: assertHttpsUrl(session.url, "checkout_url"),
          ...(session.expires_at ? { expires_at: new Date(session.expires_at * 1000).toISOString() } : {}),
          notice: "The human completes payment on the Stripe-hosted page. Returning to the success URL does not prove payment; check payment_status.",
        },
      };
    },

    async createPayment(req) {
      return (await provider.initiatePayment!(req)).instructions;
    },

    async getPaymentStatus(sessionId): Promise<ProviderPaymentStatus> {
      return mapSession(await retrieve(sessionId));
    },

    async verifyWebhook(req: WebhookRequest): Promise<VerifiedPaymentEvent | null> {
      if (!config.webhookSecret) throw new WebhookVerificationError("Stripe webhook secret is not configured");
      if (req.method !== "POST") throw new WebhookVerificationError("Stripe webhooks use POST");
      verifyStripeSignature(req.rawBody, header(req.headers, "stripe-signature"), config.webhookSecret, tolerance, now());
      let event: any;
      try {
        event = JSON.parse(req.rawBody.toString("utf8"));
      } catch {
        throw new WebhookVerificationError("Stripe webhook body is not JSON");
      }
      if (typeof event?.id !== "string" || typeof event?.type !== "string") throw new WebhookVerificationError("malformed Stripe event");
      if (event.livemode !== live) throw new WebhookVerificationError("Stripe event mode does not match the configured key");
      if (config.accountId && event.account !== config.accountId) throw new WebhookVerificationError("Stripe event belongs to a different account");
      const session = event.data?.object as StripeSession | undefined;
      const handled = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"];
      if (!handled.includes(event.type)) return null;
      if (!session || session.object !== "checkout.session" || typeof session.id !== "string") throw new WebhookVerificationError("Stripe event has no Checkout Session");
      const mapped = mapSession(session);
      if (event.type === "checkout.session.async_payment_failed") mapped.status = "payment_failed";
      if (event.type === "checkout.session.async_payment_succeeded" && mapped.status !== "paid") mapped.status = "payment_pending";
      return { event_id: event.id, provider_payment_id: session.id, ...mapped };
    },

    async refund(req: RefundRequest): Promise<RefundResult> {
      assertMoney(req.amount, req.currency, { positive: true });
      const session = await retrieve(req.provider_payment_id);
      const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (!pi) throw new Error("Stripe Checkout Session has no PaymentIntent to refund");
      const reason = ["duplicate", "fraudulent", "requested_by_customer"].includes(req.reason ?? "") ? req.reason : undefined;
      const refund = await call<{ id: string; status: string }>("POST", "/v1/refunds", {
        payment_intent: pi,
        amount: req.amount,
        ...(reason ? { reason } : {}),
        metadata: { merx_order_id: req.order_id, ...(req.reason && !reason ? { merx_reason: req.reason.slice(0, 200) } : {}) },
      }, req.idempotency_key);
      if (refund?.status === "succeeded" || refund?.status === "pending") return { refund_id: refund.id, status: refund.status };
      throw new Error("Stripe did not accept the refund");
    },

    async cancelPayment(sessionId) {
      if (!SESSION_ID.test(sessionId)) throw new Error("invalid Stripe Checkout Session ID");
      await call("POST", `/v1/checkout/sessions/${sessionId}/expire`, undefined, `expire:${sessionId}`);
    },
  };
  return provider;
}

function mapSession(s: StripeSession): ProviderPaymentStatus {
  let status: PaymentStatus;
  if (s.status === "expired") status = "canceled";
  else if (s.status === "complete") status = s.payment_status === "paid" || s.payment_status === "no_payment_required" ? "paid" : "payment_pending";
  else status = "requires_action";
  const orderId = s.metadata?.merx_order_id ?? s.client_reference_id ?? undefined;
  return {
    status,
    ...(typeof s.amount_total === "number" ? { amount: s.amount_total } : {}),
    ...(typeof s.currency === "string" ? { currency: s.currency.toUpperCase() } : {}),
    ...(orderId ? { order_id: orderId } : {}),
  };
}

/**
 * Stripe-Signature: `t=<unix>,v1=<hex hmac>[,v1=…]`. The HMAC-SHA256 is computed
 * over `${t}.${rawBody}` with the endpoint secret. Exported for reuse and tests.
 */
export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string, toleranceSeconds: number, nowMs: number): void {
  if (!signatureHeader || signatureHeader.length > 4096) throw new WebhookVerificationError("missing Stripe-Signature header");
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x?.trim());
    if (k === "t" && /^\d{1,12}$/.test(v ?? "")) t = Number(v);
    if (k === "v1" && /^[a-f0-9]{64}$/.test(v ?? "")) v1.push(v!);
  }
  if (t === undefined || !v1.length) throw new WebhookVerificationError("malformed Stripe-Signature header");
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) throw new WebhookVerificationError("Stripe webhook timestamp outside tolerance");
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  if (!v1.some((sig) => timingSafeEqual(Buffer.from(sig, "hex"), expected))) throw new WebhookVerificationError("Stripe webhook signature mismatch");
}

/** Build a Stripe-Signature header for local tests and fixtures. Never needed in production. */
export function signStripePayload(rawBody: string | Buffer, secret: string, timestampSeconds: number): string {
  const sig = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody).digest("hex");
  return `t=${timestampSeconds},v1=${sig}`;
}
