// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { ModelPicker, PROVIDER_SETTINGS_HREF } from "./model-picker";

expect.extend(matchers);

afterEach(cleanup);

const ITEMS = [
  {
    category: "OpenCode Zen",
    options: [{ value: "opencode/qwen3.6-plus", label: "Qwen3.6 Plus" }],
  },
];

describe("ModelPicker", () => {
  it("labels a model the bundled display-name map has never heard of", () => {
    render(
      <ModelPicker
        selectedModel="opencode/qwen3.6-plus"
        onSelect={vi.fn()}
        items={ITEMS}
        needsProviderConnection={false}
      />
    );

    expect(screen.getByText("qwen3.6 plus")).toBeInTheDocument();
  });

  it("points at provider settings instead of offering an empty dropdown", () => {
    render(
      <ModelPicker
        selectedModel="opencode/qwen3.6-plus"
        onSelect={vi.fn()}
        items={[]}
        needsProviderConnection
      />
    );

    const link = screen.getByRole("link", { name: /connect a provider/ });
    expect(link).toHaveAttribute("href", PROVIDER_SETTINGS_HREF);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
