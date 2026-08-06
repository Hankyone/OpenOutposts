// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { ToolCallItem } from "./tool-call-item";
import { ToolCallGroup } from "./tool-call-group";

expect.extend(matchers);

afterEach(cleanup);

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

function toolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    tool: "outpost_edit",
    args: { path: "src/lib/format.ts" },
    callId: "call-1",
    status: "completed",
    output: "Applied 1 replacement(s)",
    messageId: "msg-1",
    sandboxId: "sb-1",
    timestamp: 1,
    ...overrides,
  };
}

describe("ToolCallItem", () => {
  it("names the operation instead of the internal tool id", () => {
    render(<ToolCallItem event={toolCall()} isExpanded={false} onToggle={vi.fn()} />);

    const row = screen.getByRole("button");
    expect(row).toHaveTextContent("Edit format.ts");
    expect(row).not.toHaveTextContent("outpost_edit");
  });

  it("reads as failed while collapsed", () => {
    render(
      <ToolCallItem event={toolCall({ status: "error" })} isExpanded={false} onToggle={vi.fn()} />
    );

    const row = screen.getByRole("button");
    expect(row).toHaveTextContent("failed");
    expect(row).toHaveClass("text-destructive");
  });

  it("does not call a successful operation failed", () => {
    render(<ToolCallItem event={toolCall()} isExpanded={false} onToggle={vi.fn()} />);

    const row = screen.getByRole("button");
    expect(row).not.toHaveTextContent("failed");
    expect(row).not.toHaveClass("text-destructive");
  });

  /**
   * The control plane shortens an oversized output before storing it. A
   * fragment shown without saying so reads as the whole output, which is worse
   * than showing none of it.
   */
  it("says so when the stored output was shortened", () => {
    render(
      <ToolCallItem
        event={toolCall({ output: "first lines…", truncated: true })}
        isExpanded
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("Output truncated for storage")).toBeVisible();
  });

  it("says nothing when the output was stored whole", () => {
    render(<ToolCallItem event={toolCall()} isExpanded onToggle={vi.fn()} />);

    expect(screen.queryByText("Output truncated for storage")).toBeNull();
    expect(screen.getByText("Applied 1 replacement(s)")).toBeVisible();
  });

  it("keeps the note inside the panel the user opened", () => {
    render(
      <ToolCallItem
        event={toolCall({ output: "first lines…", truncated: true })}
        isExpanded={false}
        onToggle={vi.fn()}
      />
    );

    expect(screen.queryByText("Output truncated for storage")).toBeNull();
  });
});

describe("ToolCallGroup", () => {
  it("counts failures on the collapsed group header", () => {
    render(
      <ToolCallGroup
        groupId="group-1"
        events={[
          toolCall({ callId: "a", tool: "outpost_bash", args: { command: "npm test" } }),
          toolCall({
            callId: "b",
            tool: "outpost_bash",
            args: { command: "npm run lint" },
            status: "error",
          }),
        ]}
      />
    );

    const header = screen.getByRole("button");
    expect(header).toHaveTextContent("Bash");
    expect(header).toHaveTextContent("2 commands");
    expect(header).toHaveTextContent("1 failed");
  });
});
