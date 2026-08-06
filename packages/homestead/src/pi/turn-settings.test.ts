import { describe, expect, it, vi } from "vitest";

import type { ModelThinkingLevel } from "@openoutposts/outpost-protocol";

import {
  applyTurnModel,
  applyTurnThinkingLevel,
  currentModelSpec,
  type ConfigurableSession,
} from "./turn-settings.js";

interface FakeModel {
  provider: string;
  id: string;
}

/**
 * Stands in for Pi's AgentSession. It reproduces the two behaviours these
 * rules exist to contain: `setModel` refuses a model with no credential, and
 * `setThinkingLevel` silently clamps a level the model does not support.
 */
function fakeSession(options: {
  model?: FakeModel;
  known?: FakeModel[];
  thinkingLevel?: ModelThinkingLevel;
  supportedLevels?: ModelThinkingLevel[];
  authorizedProviders?: string[];
}) {
  const known = options.known ?? [];
  const supported = options.supportedLevels ?? ["off", "low", "medium", "high", "xhigh", "max"];
  const state = {
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? ("off" as ModelThinkingLevel),
  };
  const setModel = vi.fn(async (model: FakeModel) => {
    if (options.authorizedProviders && !options.authorizedProviders.includes(model.provider)) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }
    state.model = model;
    return Promise.resolve();
  });
  const session: ConfigurableSession<FakeModel> & { setModel: typeof setModel } = {
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.thinkingLevel;
    },
    modelRuntime: {
      getModel: (providerId, modelId) =>
        known.find((entry) => entry.provider === providerId && entry.id === modelId),
    },
    setModel,
    setThinkingLevel: (level) => {
      // Pi's clamp: an unsupported level becomes the highest supported one.
      state.thinkingLevel = supported.includes(level)
        ? level
        : (supported[supported.length - 1] ?? "off");
    },
  };
  return session;
}

const SONNET: FakeModel = { provider: "anthropic", id: "claude-sonnet-4-5" };
const HAIKU: FakeModel = { provider: "anthropic", id: "claude-haiku-4-5" };

describe("applyTurnModel", () => {
  it("switches the session to the model this turn asked for", async () => {
    const session = fakeSession({ model: SONNET, known: [SONNET, HAIKU] });

    await applyTurnModel(session, "anthropic/claude-haiku-4-5", "anthropic");

    expect(session.setModel).toHaveBeenCalledWith(HAIKU);
    expect(currentModelSpec(session)).toBe("anthropic/claude-haiku-4-5");
  });

  it("leaves the session alone when the turn asks for the model it is already on", async () => {
    const session = fakeSession({ model: SONNET, known: [SONNET] });

    await applyTurnModel(session, "anthropic/claude-sonnet-4-5", "anthropic");

    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("stops the turn, naming the model, when the agent does not have it", async () => {
    const session = fakeSession({ model: SONNET, known: [SONNET] });

    await expect(applyTurnModel(session, "anthropic/claude-opus-9", "anthropic")).rejects.toThrow(
      /anthropic\/claude-opus-9/
    );
    expect(currentModelSpec(session)).toBe("anthropic/claude-sonnet-4-5");
  });

  /**
   * The session holds one provider's credential. A model from another provider
   * is refused before Pi is asked, because Pi reads "nothing stored for this
   * provider" as permission to fall back to the process environment.
   */
  it("stops the turn when the model's provider is not the one this session holds a credential for", async () => {
    const session = fakeSession({
      model: SONNET,
      known: [SONNET, { provider: "openai", id: "gpt-5.4" }],
    });

    await expect(applyTurnModel(session, "openai/gpt-5.4", "anthropic")).rejects.toThrow(
      /openai\/gpt-5\.4.*anthropic/s
    );
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("stops the turn, naming the model, when the agent refuses to switch to it", async () => {
    const session = fakeSession({
      model: SONNET,
      known: [SONNET, HAIKU],
      authorizedProviders: [],
    });

    await expect(
      applyTurnModel(session, "anthropic/claude-haiku-4-5", "anthropic")
    ).rejects.toThrow(/anthropic\/claude-haiku-4-5.*No API key/s);
  });

  it("stops the turn when the model is not a provider/model-id", async () => {
    const session = fakeSession({ model: SONNET, known: [SONNET] });

    await expect(applyTurnModel(session, "claude-haiku-4-5", "anthropic")).rejects.toThrow(
      /claude-haiku-4-5/
    );
  });
});

describe("applyTurnThinkingLevel", () => {
  it("sets the reasoning level this turn asked for", () => {
    const session = fakeSession({ model: SONNET, thinkingLevel: "off" });

    applyTurnThinkingLevel(session, "high");

    expect(session.thinkingLevel).toBe("high");
  });

  /**
   * Pi clamps down to what the model supports without saying so. The product
   * shows the effort the user chose next to the answer, so an answer produced
   * at a different one would be mislabelled everywhere it appears.
   */
  it("stops the turn rather than let the agent quietly run at a lower level", () => {
    const session = fakeSession({
      model: SONNET,
      thinkingLevel: "off",
      supportedLevels: ["off", "low", "medium", "high"],
    });

    expect(() => applyTurnThinkingLevel(session, "max")).toThrow(/max.*high/s);
  });
});
