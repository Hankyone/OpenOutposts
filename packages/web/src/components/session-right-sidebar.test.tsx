// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SessionState } from "@open-inspect/shared";
import { SessionRightSidebarContent } from "./session-right-sidebar";

expect.extend(matchers);

vi.mock("./sidebar/child-sessions-section", () => ({
  ChildSessionsSection: () => null,
}));

afterEach(() => {
  cleanup();
});

describe("SessionRightSidebarContent", () => {
  it("does not expose inherited sandbox access links", () => {
    const sessionState: SessionState = {
      id: "session-1",
      title: null,
      repoOwner: null,
      repoName: null,
      baseBranch: null,
      branchName: null,
      status: "active",
      sandboxStatus: "ready",
      messageCount: 0,
      createdAt: Date.now(),
      outpostId: "outpost-1",
      codeServerUrl: "https://editor.example.com",
      codeServerPassword: "password",
      ttydUrl: "https://terminal.example.com",
      ttydToken: "token",
      tunnelUrls: { "3000": "https://port.example.com" },
    };

    render(
      <SessionRightSidebarContent
        sessionId="session-1"
        sessionState={sessionState}
        executionTarget={{
          kind: "outpost",
          outpostId: "outpost-1",
          name: "Test machine",
          described: true,
          reachability: "connected",
          lastSeenAt: Date.now(),
          platform: "darwin",
          workerVersion: "1.0.0",
        }}
        participants={[]}
        events={[]}
        artifacts={[]}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.queryByText("Open Editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Port 3000")).not.toBeInTheDocument();
    expect(screen.getByText("Test machine")).toBeInTheDocument();
  });
});
