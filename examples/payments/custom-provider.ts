import type { PaymentProvider, PaymentRequest } from "../../src/core/payments.ts";

/** Inject your provider's official SDK here; do not put credentials in metadata. */
export function hostedCheckoutProvider(config: {
  id: string;
  label: string;
  protocols: string[];
  currencies: string[];
  countries?: string[];
  createSession: (request: PaymentRequest) => Promise<{ id: string; url: string }>;
}): PaymentProvider {
  return {
    id: config.id,
    descriptor: { label: config.label, flow: "redirect", protocols: config.protocols, currencies: config.currencies, countries: config.countries },
    async createPayment(request) {
      const session = await config.createSession(request);
      const url = new URL(session.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Checkout session requires an HTTPS URL without embedded credentials");
      if (!session.id) throw new Error("Checkout session ID is required");
      return { session_id: session.id, checkout_url: url.href };
    },
  };
}
