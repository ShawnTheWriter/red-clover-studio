// Replicate driver — interface stub.
//
// Present so the driver roster matches the researched architecture and a third
// cloud backend can be added without changing anything above it. Not
// implemented: fal already covers every video model Red Clover uses, and a
// second billing surface with no workflow behind it is cost risk for nothing.

import { BaseDriver } from "./base.js";

export class ReplicateDriver extends BaseDriver {
  constructor(config = {}) {
    super("replicate", config);
    this.key = config.key || process.env.REPLICATE_API_TOKEN || "";
  }

  status() {
    return {
      ready: false,
      reason: this.key
        ? "driver not implemented — fal covers the current model roster"
        : "REPLICATE_API_TOKEN not set (and driver not implemented)",
    };
  }
}
