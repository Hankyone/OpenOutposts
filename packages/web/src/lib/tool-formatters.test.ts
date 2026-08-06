import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { formatToolCall, formatToolGroup } from "./tool-formatters";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

function toolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    tool: "outpost_bash",
    args: {},
    callId: "call-1",
    status: "completed",
    output: "",
    messageId: "msg-1",
    sandboxId: "sb-1",
    timestamp: 1,
    ...overrides,
  };
}

describe("formatToolCall", () => {
  it("formats the harness's prefixed operations, not their internal names", () => {
    const bash = formatToolCall(
      toolCall({ tool: "outpost_bash", args: { command: "npm test" }, output: "ok" })
    );

    expect(bash.toolName).toBe("Bash");
    expect(bash.summary).toBe("npm test");
    expect(bash.icon).toBe("terminal");
  });

  it("reads the outpost operations' workspace-relative path argument", () => {
    expect(
      formatToolCall(toolCall({ tool: "outpost_read", args: { path: "src/app/page.tsx" } }))
    ).toMatchObject({ toolName: "Read", summary: "page.tsx", icon: "file" });
    expect(
      formatToolCall(toolCall({ tool: "outpost_edit", args: { path: "src/lib/format.ts" } }))
    ).toMatchObject({ toolName: "Edit", summary: "format.ts", icon: "pencil" });
    expect(
      formatToolCall(toolCall({ tool: "outpost_write", args: { path: "docs/NOTES.md" } }))
    ).toMatchObject({ toolName: "Write", summary: "NOTES.md", icon: "plus" });
  });

  it("formats find and ls, which had no case at all", () => {
    const find = formatToolCall(
      toolCall({
        tool: "outpost_find",
        args: { glob: "**/*.ts" },
        output: "src/a.ts\nsrc/b.ts\n[result list truncated]",
      })
    );
    expect(find).toMatchObject({ toolName: "Find", summary: "**/*.ts (2 files)", icon: "folder" });

    const ls = formatToolCall(
      toolCall({ tool: "outpost_ls", args: { path: "src" }, output: "a.ts\nb/" })
    );
    expect(ls).toMatchObject({ toolName: "List", summary: "src (2 items)", icon: "folder" });
  });

  it("names the workspace root when ls is given no path", () => {
    expect(formatToolCall(toolCall({ tool: "outpost_ls", args: {} })).summary).toBe(
      "workspace root"
    );
  });

  it("does not count an empty result as one result", () => {
    expect(
      formatToolCall(
        toolCall({ tool: "outpost_grep", args: { pattern: "TODO" }, output: "No matches." })
      ).summary
    ).toBe('"TODO"');
    expect(
      formatToolCall(
        toolCall({ tool: "outpost_find", args: { glob: "*.md" }, output: "No files matched." })
      ).summary
    ).toBe("*.md");
    expect(
      formatToolCall(
        toolCall({ tool: "outpost_ls", args: { path: "empty" }, output: "Empty directory." })
      ).summary
    ).toBe("empty");
  });

  it("keeps unprefixed names working for inherited sessions", () => {
    expect(formatToolCall(toolCall({ tool: "bash", args: { command: "ls" } })).toolName).toBe(
      "Bash"
    );
    expect(
      formatToolCall(toolCall({ tool: "Read", args: { filePath: "/tmp/a.txt" } })).toolName
    ).toBe("Read");
  });

  it("still falls back for a tool it does not know", () => {
    const unknown = formatToolCall(toolCall({ tool: "mystery", args: { a: 1 } }));

    expect(unknown).toMatchObject({ toolName: "mystery", icon: null, failed: false });
  });

  it("marks a failed call as failed from the status already on the wire", () => {
    const failed = formatToolCall(
      toolCall({ tool: "outpost_edit", args: { path: "a.ts" }, status: "error" })
    );

    expect(failed.failed).toBe(true);
    expect(formatToolCall(toolCall({ status: "completed" })).failed).toBe(false);
    expect(formatToolCall(toolCall({ status: "running" })).failed).toBe(false);
    expect(formatToolCall(toolCall({ status: undefined })).failed).toBe(false);
  });
});

describe("formatToolGroup", () => {
  it("names a group of prefixed operations", () => {
    const group = formatToolGroup([
      toolCall({ tool: "outpost_read", callId: "a" }),
      toolCall({ tool: "outpost_read", callId: "b" }),
    ]);

    expect(group).toMatchObject({ toolName: "Read", count: 2, summary: "2 files" });
  });

  it("counts the failures inside a collapsed group", () => {
    const group = formatToolGroup([
      toolCall({ tool: "outpost_bash", callId: "a", status: "completed" }),
      toolCall({ tool: "outpost_bash", callId: "b", status: "error" }),
      toolCall({ tool: "outpost_bash", callId: "c", status: "error" }),
    ]);

    expect(group).toMatchObject({ toolName: "Bash", count: 3, failedCount: 2 });
  });
});
