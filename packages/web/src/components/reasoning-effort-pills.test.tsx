// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, MODEL_REASONING_CONFIG, type ValidModel } from "@open-inspect/shared";
import { ReasoningEffortPills } from "./reasoning-effort-pills";

afterEach(cleanup);

describe("ReasoningEffortPills", () => {
  it("renders nothing for a catalog model with no thinking mode", () => {
    // The harness said this model has none, which is the one answer the
    // bundled table must not be allowed to override.
    const { container } = render(
      <ReasoningEffortPills
        selectedModel={DEFAULT_MODEL}
        reasoningEffort="high"
        onSelect={vi.fn()}
        disabled={false}
        catalogReasoning={null}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("cycles a catalog-only model through the efforts the harness reported", async () => {
    const onSelect = vi.fn();
    render(
      <ReasoningEffortPills
        selectedModel="opencode/qwen3.6-plus"
        reasoningEffort="low"
        onSelect={onSelect}
        disabled={false}
        catalogReasoning={{ efforts: ["none", "low", "medium"], default: "low" }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /Reasoning: low/ }));
    expect(onSelect).toHaveBeenCalledWith("medium");
  });

  it("wraps past the end of the catalog's own list, never past the bundled one", async () => {
    const onSelect = vi.fn();
    render(
      <ReasoningEffortPills
        selectedModel={DEFAULT_MODEL}
        reasoningEffort="high"
        onSelect={onSelect}
        disabled={false}
        // The harness stops at 'high'; the bundled table for this model goes
        // further, and cycling must not reach the levels it names.
        catalogReasoning={{ efforts: ["none", "low", "medium", "high"], default: "medium" }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /Reasoning: high/ }));
    expect(onSelect).toHaveBeenCalledWith("none");
  });

  it("shows the catalog's default when no effort is selected", () => {
    render(
      <ReasoningEffortPills
        selectedModel="opencode/qwen3.6-plus"
        reasoningEffort={undefined}
        onSelect={vi.fn()}
        disabled={false}
        catalogReasoning={{ efforts: ["none", "low"], default: "low" }}
      />
    );

    expect(screen.getByRole("button")).toHaveTextContent("low");
  });

  it("says 'default' when the catalog offers efforts but names no default", () => {
    render(
      <ReasoningEffortPills
        selectedModel="opencode/qwen3.6-plus"
        reasoningEffort={undefined}
        onSelect={vi.fn()}
        disabled={false}
        catalogReasoning={{ efforts: ["none", "low"], default: null }}
      />
    );

    expect(screen.getByRole("button")).toHaveTextContent("default");
  });

  it("falls back to the bundled table for a model no catalog names", async () => {
    const bundled = MODEL_REASONING_CONFIG[DEFAULT_MODEL as ValidModel];
    expect(bundled).toBeDefined();
    const onSelect = vi.fn();
    render(
      <ReasoningEffortPills
        selectedModel={DEFAULT_MODEL}
        reasoningEffort={bundled?.efforts[0]}
        onSelect={onSelect}
        disabled={false}
      />
    );

    await userEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(bundled?.efforts[1]);
  });

  it("renders nothing for a model neither the catalog nor the bundled table knows", () => {
    const { container } = render(
      <ReasoningEffortPills
        selectedModel="opencode/qwen3.6-plus"
        reasoningEffort={undefined}
        onSelect={vi.fn()}
        disabled={false}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
