// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { EventItem, dedupeAndGroupEvents } from "./session-timeline";

expect.extend(matchers);

afterEach(cleanup);

function toolCall(callId: string, tool: string, timestamp: number): SandboxEvent {
  return {
    type: "tool_call",
    tool,
    args: {},
    callId,
    status: "completed",
    output: "",
    messageId: `msg-${callId}`,
    sandboxId: "sb-1",
    timestamp,
  };
}

function userMessage(messageId: string, timestamp: number): SandboxEvent {
  return { type: "user_message", content: "hello", messageId, timestamp };
}

function keysOf(events: SandboxEvent[]): string[] {
  return dedupeAndGroupEvents(events).map((group) => group.id);
}

describe("dedupeAndGroupEvents", () => {
  it("keeps group keys stable when older history is prepended", () => {
    const live: SandboxEvent[] = [
      userMessage("m1", 100),
      toolCall("c1", "outpost_read", 101),
      toolCall("c2", "outpost_read", 102),
      toolCall("c3", "outpost_bash", 103),
    ];
    const older: SandboxEvent[] = [userMessage("m0", 10), toolCall("c0", "outpost_bash", 11)];

    const before = keysOf(live);
    const after = keysOf([...older, ...live]);

    // The prepended page adds its own groups in front and leaves every
    // pre-existing group's identity untouched, so React keeps them mounted.
    expect(after.slice(after.length - before.length)).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
  });

  it("derives group keys from event identity, not position", () => {
    const events: SandboxEvent[] = [userMessage("m1", 100), toolCall("c1", "outpost_read", 101)];

    expect(keysOf(events)).toEqual(["single-user_message:m1:100", "tool-group-call:c1"]);
  });

  it("still distinguishes two events that share an identity", () => {
    const twins: SandboxEvent[] = [userMessage("m1", 100), userMessage("m1", 100)];

    const keys = keysOf(twins);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("EventItem", () => {
  function renderEvent(event: SandboxEvent) {
    return render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
      />
    );
  }

  it("renders a completed branch push", () => {
    renderEvent({
      type: "push_complete",
      branchName: "feature/x",
      repoOwner: "acme",
      repoName: "web",
      timestamp: 1,
    });

    expect(screen.getByText("Pushed acme/web feature/x")).toBeInTheDocument();
  });

  it("renders a failed branch push instead of dropping it", () => {
    renderEvent({
      type: "push_error",
      branchName: "feature/x",
      error: "no upstream configured",
      timestamp: 1,
    });

    expect(
      screen.getByText("Push failed for feature/x: no upstream configured")
    ).toBeInTheDocument();
  });

  it("renders a push event that names no repository or branch", () => {
    renderEvent({ type: "push_error", error: "no repository found", timestamp: 1 });

    expect(screen.getByText("Push failed: no repository found")).toBeInTheDocument();
  });
});
