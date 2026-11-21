import { manualTransfer } from "./core/payments.ts";
import type { PaymentProvider } from "./core/payments.ts";
import { MemoryStore } from "./core/storage.ts";
import type { MerxStore } from "./core/storage.ts";
import { stripeCheckout } from "./payments/stripe.ts";
import { gopay } from "./payments/gopay.ts";

/**
 * Environment-driven configuration for the reference server. Every external
 * provider is opt-in: with no variables set, Merx runs offline with the
 * in-memory store and the fictional bank-transfer demo.
 */
export type Env = Record<string, string | undefined>;

export function paymentsFromEnv(env: Env): { payments: PaymentProvider[]; defaultPaymentMethod?: string; enabled: string[] } {
  const payments: PaymentProvider[] = [];
  const publicUrl = env.MERX_PUBLIC_URL?.replace(/\/$/, "");
  if (env.MERX_DISABLE_DEMO_TRANSFER !== "1") payments.push(manualTransfer);

  if (env.STRIPE_SECRET_KEY) {
    payments.push(stripeCheckout({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      successUrl: required(env.STRIPE_SUCCESS_URL ?? (publicUrl && `${publicUrl}/payment/return?session_id={CHECKOUT_SESSION_ID}`), "STRIPE_SUCCESS_URL or MERX_PUBLIC_URL"),
      cancelUrl: required(env.STRIPE_CANCEL_URL ?? (publicUrl && `${publicUrl}/payment/cancelled`), "STRIPE_CANCEL_URL or MERX_PUBLIC_URL"),
      currencies: list(env.STRIPE_CURRENCIES) ?? ["EUR"],
      countries: list(env.STRIPE_COUNTRIES),
      allowLiveMode: env.STRIPE_ALLOW_LIVE === "1",
      ...(env.STRIPE_ACCOUNT_ID ? { accountId: env.STRIPE_ACCOUNT_ID } : {}),
      ...(env.STRIPE_API_VERSION ? { apiVersion: env.STRIPE_API_VERSION } : {}),
    }));
  }

  if (env.GOPAY_CLIENT_ID) {
    const id = "gopay";
    payments.push(gopay({
      id,
      clientId: env.GOPAY_CLIENT_ID,
      clientSecret: required(env.GOPAY_CLIENT_SECRET, "GOPAY_CLIENT_SECRET"),
      goid: required(env.GOPAY_GOID, "GOPAY_GOID"),
      returnUrl: required(env.GOPAY_RETURN_URL ?? (publicUrl && `${publicUrl}/payment/return`), "GOPAY_RETURN_URL or MERX_PUBLIC_URL"),
      notificationUrl: required(env.GOPAY_NOTIFICATION_URL ?? (publicUrl && `${publicUrl}/v1/webhooks/payments/${id}`), "GOPAY_NOTIFICATION_URL or MERX_PUBLIC_URL"),
      environment: env.GOPAY_ENVIRONMENT === "production" ? "production" : "sandbox",
      currencies: list(env.GOPAY_CURRENCIES),
      countries: list(env.GOPAY_COUNTRIES),
      ...(env.GOPAY_LANG ? { lang: env.GOPAY_LANG } : {}),
    }));
  }

  if (!payments.length) throw new Error("No payment provider enabled: configure Stripe or GoPay, or keep the demo transfer");
  return { payments, defaultPaymentMethod: env.MERX_DEFAULT_PAYMENT_METHOD || undefined, enabled: payments.map((p) => p.id) };
}

/** `MERX_STORE=memory` (default) or `MERX_STORE=sqlite:/path/to/merx.db`. */
export async function storeFromEnv(env: Env): Promise<MerxStore> {
  const spec = env.MERX_STORE ?? "memory";
  if (spec === "memory") return new MemoryStore();
  if (spec.startsWith("sqlite:")) {
    const { SqliteStore } = await import("./storage/sqlite.ts");
    return new SqliteStore(spec.slice("sqlite:".length) || ".merx/merx.db");
  }
  throw new Error(`Unsupported MERX_STORE ${spec}; use "memory" or "sqlite:<path>"`);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(value: string | undefined): string[] | undefined {
  return value ? value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined;
}
