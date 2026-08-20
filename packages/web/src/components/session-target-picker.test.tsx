// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionTargetPickerProps } from "@/hooks/use-session-target-picker";
import { SessionTargetPicker } from "./session-target-picker";

expect.extend(matchers);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

function pickerProps(overrides: Partial<SessionTargetPickerProps> = {}): SessionTargetPickerProps {
  return {
    sessionTarget: { kind: "repo", repoFullName: "acme/web", outpostId: "workshop" },
    targetSelectValue: "acme/web",
    targetOptions: [{ value: "acme/web", label: "web", description: "acme" }],
    displayTargetName: "web",
    onTargetSelectValueChange: vi.fn(),
    onMultiSelectionChange: vi.fn(),
    selectedBranch: "main",
    setSelectedBranch: vi.fn(),
    branches: [{ name: "main" }],
    loadingBranches: false,
    repos: [],
    loadingRepos: false,
    selectedOutpostId: "workshop",
    outpostOptions: [
      {
        value: "workshop",
        label: "Workshop",
        description: "darwin/arm64, connected",
      },
      { value: "laptop", label: "Laptop", description: "darwin/arm64, connected" },
    ],
    displayOutpostName: "Workshop",
    onOutpostSelectValueChange: vi.fn(),
    loadingOutposts: false,
    outpostsUnavailable: false,
    ...overrides,
  };
}

describe("SessionTargetPicker", () => {
  it("renders repository and machine as separate controls", async () => {
    const user = userEvent.setup();
    const onOutpostSelectValueChange = vi.fn();
    render(
      <SessionTargetPicker {...pickerProps({ onOutpostSelectValueChange })} disabled={false} />
    );

    expect(screen.getByRole("button", { name: /web/i })).toBeEnabled();
    const machineButton = screen.getByRole("button", { name: /workshop/i });
    expect(machineButton).toBeEnabled();

    await user.click(machineButton);
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: /laptop/i }));

    expect(onOutpostSelectValueChange).toHaveBeenCalledWith("laptop");
  });

  it("shows honest loading and unavailable machine states", () => {
    const { rerender } = render(
      <SessionTargetPicker
        {...pickerProps({
          selectedOutpostId: null,
          outpostOptions: [],
          displayOutpostName: "Loading machines...",
          loadingOutposts: true,
        })}
        disabled={false}
      />
    );

    expect(screen.getByRole("button", { name: /loading machines/i })).toBeDisabled();

    rerender(
      <SessionTargetPicker
        {...pickerProps({
          selectedOutpostId: null,
          outpostOptions: [],
          displayOutpostName: "Machines unavailable",
          outpostsUnavailable: true,
        })}
        disabled={false}
      />
    );

    expect(screen.getByRole("button", { name: /machines unavailable/i })).toBeDisabled();
  });

  it("hides machine placement when the deployment has no fleet", () => {
    render(
      <SessionTargetPicker
        {...pickerProps({
          selectedOutpostId: null,
          outpostOptions: [],
          displayOutpostName: "No machines",
        })}
        disabled={false}
      />
    );

    expect(screen.queryByRole("button", { name: /machine/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /web/i })).toBeEnabled();
  });
});
