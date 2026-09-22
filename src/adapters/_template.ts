import type { Adapter } from "./adapter.ts";
import { findOp } from "./operations.ts";

/**
 * Copy this file to write an adapter for any protocol (UCP, ACP, x402, a
 * marketplace's private API...). Translate their wire format → an operation
 * name + input, call op.run(), translate the result back. That's it.
 */
export const myProtocolAdapter: Adapter = {
  name: "my-protocol",
  describe: (base) => ({ protocol: "my-protocol/1.0", endpoint: `${base}/my-protocol` }),
  mount(router, engine) {
    router.post("/my-protocol/search", async (c) => {
      const out = await findOp("find_products")!.run(engine, { need: c.body.query, constraints: { max_unit_price: c.body.budget } }, c.agentId);
      return { results: out }; // reshape into the protocol's response format
    });
  },
};
