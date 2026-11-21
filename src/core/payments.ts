import { MerxError } from "./negotiate.ts";
import type { PaymentStatus } from "./payment-state.ts";

/** Metadata describes configured adapters, not a claim of protocol certification. */
export type PaymentDescriptor = {
  id: string;
  label: string;
  flow: "manual" | "redirect" | "wallet" | "http" | "custom";
  protocols: string[];
  currencies?: string[];
  countries?: string[];
  /** True only when the adapter verifies settlement through signed webhooks or server-to-server status checks. */
  verifies_settlement?: boolean;
  /** Optional capabilities the adapter implements: "webhook", "status", "refund". */
  capabilities?: string[];
};

export type PaymentRequest = {
  order_id: string;
  total: number;
  currency: string;
  country: string;
  quote_id: string;
  quote_hash: string;
  idempotency_key: string;
};

/** Result of starting a verifiable payment with a provider. */
export type PaymentSetup = {
  /** Usually `requires_action` (buyer must complete a hosted page) or `payment_pending`. */
  status: PaymentStatus;
  /** Provider reference used to match webhooks and status checks. Not a secret, never a credential. */
  provider_payment_id?: string;
  /** Returned to the buyer agent: e.g. `{ type: "redirect", checkout_url }`. Must not contain secrets. */
  instructions: Record<string, unknown>;
};

/** Provider status as reported by a trusted, authenticated provider API call. */
export type ProviderPaymentStatus = {
  status: PaymentStatus;
  amount?: number;
  currency?: string;
  /** Merx order ID the provider stored with the payment (metadata / order number). */
  order_id?: string;
  refunded_amount?: number;
};

/** A provider event whose authenticity the adapter has already verified. */
export type VerifiedPaymentEvent = ProviderPaymentStatus & {
  /** Stable provider event ID used for replay protection. */
  event_id: string;
  provider_payment_id: string;
};

export type WebhookRequest = {
  method: string;
  /** Exact bytes received. Signature schemes are computed over the raw body, never over re-serialized JSON. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  query: URLSearchParams;
};

export type RefundRequest = {
  order_id: string;
  provider_payment_id: string;
  amount: number;
  currency: string;
  idempotency_key: string;
  reason?: string;
};

export type RefundResult = { refund_id: string; status: "succeeded" | "pending" };

/** Thrown by `verifyWebhook` when a request is not authentic. The HTTP layer answers 400 without details. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Implementations own provider credentials and must honor idempotency_key.
 *
 * Only `createPayment` is required, so 0.2 providers keep working. Verified
 * providers implement the optional capabilities below; see docs/PAYMENTS.md.
 */
export interface PaymentProvider {
  id: string;
  descriptor?: Omit<PaymentDescriptor, "id">;
  /** Legacy/simple flow: return buyer-facing instructions. The engine treats the payment as unverified. */
  createPayment(order: PaymentRequest): Promise<Record<string, unknown>>;
  /** Verified flow: start a payment and return the provider reference used for webhooks and reconciliation. */
  initiatePayment?(request: PaymentRequest): Promise<PaymentSetup>;
  /** Authoritative server-to-server status lookup, used for reconciliation and for callback-only providers. */
  getPaymentStatus?(providerPaymentId: string): Promise<ProviderPaymentStatus>;
  /** Authenticate an incoming provider notification. Return null for authentic events that Merx should ignore. */
  verifyWebhook?(request: WebhookRequest): Promise<VerifiedPaymentEvent | null>;
  /** Server-side refund. Never exposed to buyer agents. */
  refund?(request: RefundRequest): Promise<RefundResult>;
  /** Cancel/expire an open provider session so it can no longer be paid. */
  cancelPayment?(providerPaymentId: string): Promise<void>;
}

export const manualTransfer: PaymentProvider = {
  id: "bank_transfer",
  descriptor: { label: "Example bank transfer (no settlement)", flow: "manual", protocols: ["merx-manual/1"], verifies_settlement: false },
  async createPayment(o) {
    return {
      type: "manual_transfer",
      demo: true,
      settlement: "not_verified",
      notice: "Fictional demonstration instructions. Merx will not detect or settle this payment.",
      iban: "SK00 0000 0000 0000 0000 0000",
      variable_symbol: o.order_id.replace(/\D/g, "").slice(0, 10) || "0",
      amount: o.total,
      currency: o.currency,
      due_in_days: 3,
    };
  },
};

export class PaymentRegistry {
  private providers = new Map<string, PaymentProvider>();
  readonly defaultId: string;

  constructor(providers: PaymentProvider[], defaultId?: string) {
    if (!providers.length) throw new Error("At least one payment provider is required");
    for (const provider of providers) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(provider.id) || this.providers.has(provider.id)) throw new Error("Payment provider IDs must be valid and unique");
      this.providers.set(provider.id, provider);
    }
    this.defaultId = defaultId ?? providers[0].id;
    if (!this.providers.has(this.defaultId)) throw new Error("Default payment provider is not registered");
  }

  list(filter: { currency?: string; country?: string } = {}): PaymentDescriptor[] {
    return [...this.providers.values()].filter((provider) => this.supports(provider, filter)).map((provider) => {
      const d = provider.descriptor;
      return {
        id: provider.id,
        label: d?.label ?? provider.id,
        flow: d?.flow ?? "custom",
        protocols: [...(d?.protocols ?? [])],
        ...(d?.currencies ? { currencies: [...d.currencies] } : {}),
        ...(d?.countries ? { countries: [...d.countries] } : {}),
        verifies_settlement: d?.verifies_settlement ?? false,
        capabilities: d?.capabilities ? [...d.capabilities] : capabilitiesOf(provider),
      };
    });
  }

  get(id: string): PaymentProvider | undefined {
    return this.providers.get(id);
  }

  select(id: string | undefined, filter: { currency: string; country: string }): PaymentProvider {
    const provider = this.providers.get(id ?? this.defaultId);
    if (!provider || !this.supports(provider, filter)) throw new MerxError("invalid", "payment method is unavailable for this currency or destination");
    return provider;
  }

  private supports(provider: PaymentProvider, filter: { currency?: string; country?: string }): boolean {
    const d = provider.descriptor;
    return (!filter.currency || !d?.currencies || d.currencies.includes(filter.currency)) && (!filter.country || !d?.countries || d.countries.includes(filter.country));
  }
}

function capabilitiesOf(p: PaymentProvider): string[] {
  return [p.verifyWebhook && "webhook", p.getPaymentStatus && "status", p.refund && "refund"].filter((c): c is string => !!c);
}
