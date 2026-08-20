import { describe, expect, it } from "vitest";

import type { AgentHarness, HarnessEvent, SessionHarnessFactory } from "./index.js";
import { indexSessionHarnessFactories } from "./index.js";

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

const piFactory: SessionHarnessFactory = {
  kind: "pi",
  create: () => piHarness,
};

describe("indexSessionHarnessFactories", () => {
  it("indexes factories without constructing a shared harness", () => {
    const factories = indexSessionHarnessFactories([piFactory]);

    expect(factories.get("pi")).toBe(piFactory);
    expect([...factories.keys()]).toEqual(["pi"]);
  });

  it("rejects duplicate factories", () => {
    expect(() => indexSessionHarnessFactories([piFactory, piFactory])).toThrow(
      "duplicate session harness factory"
    );
  });

  it("rejects an empty production surface", () => {
    expect(() => indexSessionHarnessFactories([])).toThrow(
      "at least one session harness factory is required"
    );
  });
});
