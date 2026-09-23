import { MerxError } from "./negotiate.ts";

/** Metadata describes configured adapters, not a claim of protocol certification. */
export type PaymentDescriptor = {
  id: string;
  label: string;
  flow: "manual" | "redirect" | "wallet" | "http" | "custom";
  protocols: string[];
  currencies?: string[];
  countries?: string[];
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

/** Implementations own provider credentials and must honor idempotency_key. */
export interface PaymentProvider {
  id: string;
  descriptor?: Omit<PaymentDescriptor, "id">;
  createPayment(order: PaymentRequest): Promise<Record<string, unknown>>;
}

export const manualTransfer: PaymentProvider = {
  id: "bank_transfer",
  descriptor: { label: "Example bank transfer (no settlement)", flow: "manual", protocols: ["merx-manual/1"] },
  async createPayment(o) {
    return { iban: "SK00 0000 0000 0000 0000 0000", variable_symbol: o.order_id.replace(/\D/g, "").slice(0, 10) || "0", amount: o.total, currency: o.currency, due_in_days: 3 };
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
      return { id: provider.id, label: d?.label ?? provider.id, flow: d?.flow ?? "custom", protocols: [...(d?.protocols ?? [])], ...(d?.currencies ? { currencies: [...d.currencies] } : {}), ...(d?.countries ? { countries: [...d.countries] } : {}) };
    });
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
