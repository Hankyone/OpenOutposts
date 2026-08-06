// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SettingsNav } from "./settings-nav";

expect.extend(matchers);

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => false,
}));

afterEach(() => {
  cleanup();
});

describe("SettingsNav", () => {
  it("hides settings the outpost execution path does not consume", async () => {
    const onSelect = vi.fn();
    render(<SettingsNav activeCategory="environments" onSelect={onSelect} />);

    expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sandbox" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "MCP Servers" })).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Environments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Providers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keyboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data Controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Integrations" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(onSelect).toHaveBeenCalledWith("providers");
  });
});
