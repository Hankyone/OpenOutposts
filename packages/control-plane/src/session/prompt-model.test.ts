import { describe, expect, it } from "vitest";

import { PromptModelError, validatePromptModel } from "./prompt-model";

describe("validatePromptModel", () => {
  it("accepts a listed model and returns it canonically", () => {
    expect(validatePromptModel("anthropic/claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
    expect(validatePromptModel("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
  });

  it("accepts a model the hardcoded list has never named", () => {
    // The homestead's harness catalog is the authority, and it deliberately
    // carries models this package never named. Refusing them here is what
    // silently rerouted a prompt to the session's previous model.
    expect(validatePromptModel("anthropic/claude-tiny-experimental")).toBe(
      "anthropic/claude-tiny-experimental"
    );
    expect(validatePromptModel("some-provider/some-model")).toBe("some-provider/some-model");
  });

  it("refuses an id that names no provider", () => {
    expect(() => validatePromptModel("not-a-model-reference")).toThrow(PromptModelError);
  });

  it("names the model in every refusal, and says the prompt was not sent", () => {
    try {
      validatePromptModel("bare-id");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptModelError);
      expect((error as Error).message).toContain("bare-id");
      expect((error as Error).message).toContain("not sent");
    }
  });
});
