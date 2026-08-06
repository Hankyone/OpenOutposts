import { describe, expect, it } from "vitest";

import type { AgentHarness, HarnessEvent } from "./index.js";
import { HarnessRegistry } from "./index.js";

const piHarness: AgentHarness = {
  kind: "pi",
  async createSession(input) {
    return {
      productSessionId: input.productSessionId,
      harnessSessionId: "pi-session-01",
      harness: "pi",
    };
  },
  async *sendPrompt() {
    yield { type: "turn.completed" } satisfies HarnessEvent;
  },
  async interrupt() {},
  async close() {},
};

describe("HarnessRegistry", () => {
  it("registers and resolves a harness", () => {
    const registry = new HarnessRegistry();
    registry.register(piHarness);

    expect(registry.get("pi")).toBe(piHarness);
    expect(registry.list()).toEqual(["pi"]);
  });

  it("rejects duplicate harnesses", () => {
    const registry = new HarnessRegistry();
    registry.register(piHarness);

    expect(() => registry.register(piHarness)).toThrow("Harness already registered");
  });
});
