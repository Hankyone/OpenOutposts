import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared";
import { resolveEnabledModel, resolveModelPreference } from "./model-selection";

describe("resolveEnabledModel", () => {
  it("keeps the desired model when it is enabled", () => {
    expect(
      resolveEnabledModel("anthropic/claude-opus-4-8", ["anthropic/claude-opus-4-8", DEFAULT_MODEL])
    ).toBe("anthropic/claude-opus-4-8");
  });

  it("normalizes a bare model id before checking the enabled set", () => {
    expect(resolveEnabledModel("claude-opus-4-8", ["anthropic/claude-opus-4-8"])).toBe(
      "anthropic/claude-opus-4-8"
    );
  });

  it("falls back to the default when the desired model is not enabled", () => {
    expect(resolveEnabledModel("anthropic/claude-opus-4-8", [DEFAULT_MODEL])).toBe(DEFAULT_MODEL);
  });

  it("falls back to the first enabled model when neither desired nor default is enabled", () => {
    expect(resolveEnabledModel("anthropic/claude-opus-4-8", ["openai/gpt-5.5"])).toBe(
      "openai/gpt-5.5"
    );
  });

  it("coerces an unknown model id to the enabled default", () => {
    expect(resolveEnabledModel("not-a-real-model", [DEFAULT_MODEL, "openai/gpt-5.5"])).toBe(
      DEFAULT_MODEL
    );
  });

  it("falls back to the default when no models are enabled", () => {
    expect(resolveEnabledModel("anthropic/claude-opus-4-8", [])).toBe(DEFAULT_MODEL);
  });

  it("ignores removed models when choosing a fallback", () => {
    expect(
      resolveEnabledModel("anthropic/claude-opus-4-8", ["openai/gpt-5.2", "openai/gpt-5.5"])
    ).toBe("openai/gpt-5.5");
    expect(resolveEnabledModel("anthropic/claude-opus-4-8", ["openai/gpt-5.2"])).toBe(
      DEFAULT_MODEL
    );
  });
});

describe("resolveModelPreference", () => {
  it("keeps a valid model and reasoning effort", () => {
    expect(
      resolveModelPreference({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" }, [
        "anthropic/claude-opus-4-8",
      ])
    ).toEqual({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
  });

  it("normalizes the model before validating reasoning effort", () => {
    expect(
      resolveModelPreference({ model: "claude-opus-4-8", reasoningEffort: "high" }, [
        "anthropic/claude-opus-4-8",
      ])
    ).toEqual({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
  });

  it("preserves the upstream model while enabled models are loading", () => {
    expect(
      resolveModelPreference({ model: "claude-opus-4-8", reasoningEffort: "high" }, undefined)
    ).toEqual({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
  });

  it("uses the default when the loaded enabled-model list is empty", () => {
    expect(
      resolveModelPreference({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" }, [])
    ).toEqual({
      model: DEFAULT_MODEL,
      reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
    });
  });

  it("uses the fallback model default when reasoning is invalid", () => {
    expect(
      resolveModelPreference({ model: "anthropic/claude-opus-4-8", reasoningEffort: "not-valid" }, [
        DEFAULT_MODEL,
      ])
    ).toEqual({
      model: DEFAULT_MODEL,
      reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
    });
  });

  it("uses the selected model default when only reasoning is invalid", () => {
    const model = "anthropic/claude-opus-4-8";
    expect(resolveModelPreference({ model, reasoningEffort: "not-valid" }, [model])).toEqual({
      model,
      reasoningEffort: getDefaultReasoningEffort(model),
    });
  });

  it("keeps a catalog model the bundled list has never named", () => {
    expect(
      resolveModelPreference({ model: "opencode/qwen3.6-plus" }, ["opencode/qwen3.6-plus"], true)
    ).toEqual({ model: "opencode/qwen3.6-plus", reasoningEffort: undefined });
  });

  it("coerces to the catalog when the desired model is not reachable", () => {
    expect(
      resolveModelPreference(
        { model: "anthropic/claude-opus-4-8" },
        ["opencode/qwen3.6-plus"],
        true
      )
    ).toEqual({ model: "opencode/qwen3.6-plus", reasoningEffort: undefined });
  });

  it("prefers the bundled default when the catalog also offers it", () => {
    expect(
      resolveModelPreference(
        { model: "not-reachable" },
        ["opencode/qwen3.6-plus", DEFAULT_MODEL],
        true
      )
    ).toEqual({
      model: DEFAULT_MODEL,
      reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
    });
  });

  it("holds a catalog model unchanged while the catalog list is still loading", () => {
    expect(resolveModelPreference({ model: "opencode/qwen3.6-plus" }, undefined, true)).toEqual({
      model: "opencode/qwen3.6-plus",
      reasoningEffort: undefined,
    });
  });

  it("omits reasoning for models without reasoning controls", () => {
    expect(
      resolveModelPreference({ model: "opencode/kimi-k2.5", reasoningEffort: "high" }, [
        "opencode/kimi-k2.5",
      ])
    ).toEqual({ model: "opencode/kimi-k2.5", reasoningEffort: undefined });
  });

  it("keeps an effort the catalog reports for a model the bundled list never named", () => {
    // The bundled table has no entry for this id, so before the catalog could
    // speak the effort was cleared for being "invalid".
    expect(
      resolveModelPreference(
        { model: "opencode/qwen3.6-plus", reasoningEffort: "medium" },
        ["opencode/qwen3.6-plus"],
        true,
        new Map([["opencode/qwen3.6-plus", { efforts: ["none", "medium"], default: "none" }]])
      )
    ).toEqual({ model: "opencode/qwen3.6-plus", reasoningEffort: "medium" });
  });

  it("falls back to the catalog's default when the stored effort is unsupported", () => {
    expect(
      resolveModelPreference(
        { model: "opencode/qwen3.6-plus", reasoningEffort: "max" },
        ["opencode/qwen3.6-plus"],
        true,
        new Map([["opencode/qwen3.6-plus", { efforts: ["none", "medium"], default: "none" }]])
      )
    ).toEqual({ model: "opencode/qwen3.6-plus", reasoningEffort: "none" });
  });

  it("lets the catalog overrule the bundled table for a model both name", () => {
    // The bundled table lists 'max' for the default model; the harness here
    // does not, and the harness is the one that runs the turn.
    expect(
      resolveModelPreference(
        { model: DEFAULT_MODEL, reasoningEffort: "max" },
        [DEFAULT_MODEL],
        true,
        new Map([[DEFAULT_MODEL, { efforts: ["low", "medium", "high"], default: "high" }]])
      )
    ).toEqual({ model: DEFAULT_MODEL, reasoningEffort: "high" });
  });

  it("stores no effort for a model the catalog says has no thinking mode", () => {
    expect(
      resolveModelPreference(
        { model: DEFAULT_MODEL, reasoningEffort: "high" },
        [DEFAULT_MODEL],
        true,
        new Map([[DEFAULT_MODEL, null]])
      )
    ).toEqual({ model: DEFAULT_MODEL, reasoningEffort: undefined });
  });

  it("leaves a model the catalog does not name to the bundled table", () => {
    expect(
      resolveModelPreference(
        { model: DEFAULT_MODEL, reasoningEffort: "max" },
        [DEFAULT_MODEL],
        true,
        new Map([["opencode/qwen3.6-plus", { efforts: ["none"], default: "none" }]])
      )
    ).toEqual({ model: DEFAULT_MODEL, reasoningEffort: "max" });
  });
});
