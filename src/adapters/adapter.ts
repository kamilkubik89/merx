import type { MerxEngine } from "../core/engine.ts";
import type { Router } from "../http/router.ts";

/**
 * A protocol adapter translates one wire protocol into engine calls.
 * Implement this interface to plug in any protocol (UCP, ACP, x402, your own).
 * See docs/ADAPTERS.md and src/adapters/_template.ts.
 */
export interface Adapter {
  name: string;
  /** Advertised in /.well-known/merx.json so agents know what they can speak. */
  describe(baseUrl: string): { protocol: string; endpoint: string; notes?: string };
  mount(router: Router, engine: MerxEngine): void;
}
