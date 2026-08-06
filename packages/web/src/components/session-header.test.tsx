// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SessionState } from "@open-inspect/shared";
import type { SessionExecutionTarget } from "@/lib/session-execution-target";
import { SessionHeader } from "./session-header";
import type { SessionActionProps } from "./session-actions";

expect.extend(matchers);

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({
    isOpen: true,
    toggle: vi.fn(),
  }),
}));

function sessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Incident sweep",
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    branchName: null,
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: Date.now(),
    model: "anthropic/claude-sonnet-4-5",
    ...overrides,
  };
}

const connectedOutpost: SessionExecutionTarget = {
  kind: "outpost",
  outpostId: "workshop",
  name: "Workshop Mac",
  described: true,
  reachability: "connected",
  lastSeenAt: Date.now(),
  platform: "darwin",
  workerVersion: "0.4.1",
};

const actions: SessionActionProps = {
  sessionId: "session-1",
  sessionStatus: "active",
  artifacts: [],
};

describe("SessionHeader", () => {
  afterEach(cleanup);

  it("renders no-repository fallback data as loaded while socket state is absent", () => {
    render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: "Incident sweep" }}
        executionTarget={{ kind: "unknown" }}
        connected={false}
        connecting={true}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Incident sweep" })).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.queryByText("Loading session...")).not.toBeInTheDocument();
  });

  it("names the bound machine, its heartbeat, and the model instead of a sandbox status", () => {
    render(
      <SessionHeader
        sessionState={sessionState()}
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: null }}
        executionTarget={connectedOutpost}
        connected={true}
        connecting={false}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByText("Workshop Mac · connected")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(screen.queryByText(/Sandbox:/)).not.toBeInTheDocument();
  });

  it("reports an unreachable machine even while the browser socket is live", () => {
    render(
      <SessionHeader
        sessionState={sessionState()}
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: null }}
        executionTarget={{ ...connectedOutpost, reachability: "offline" }}
        connected={true}
        connecting={false}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByText("Workshop Mac · offline")).toBeInTheDocument();
    // The compact (phone) indicator carries the same verdict.
    expect(screen.getByTitle("Connected · Workshop Mac · offline")).toBeInTheDocument();
  });

  it("reports an outpost session that names no machine without inventing one", () => {
    render(
      <SessionHeader
        sessionState={sessionState()}
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: null }}
        executionTarget={{ kind: "unassigned", status: "ready" }}
        connected={true}
        connecting={false}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        onOpenMobileDetails={vi.fn()}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByText("Outpost · ready")).toBeInTheDocument();
    expect(screen.queryByText(/[Ss]andbox/)).not.toBeInTheDocument();
    expect(
      screen.getByTitle("Running on an outpost. This session has not named which machine yet.")
    ).toBeInTheDocument();
  });

  it("replaces the phone Details control with the unified actions menu", () => {
    const onToggleDetails = vi.fn();
    const onOpenMobileDetails = vi.fn();
    render(
      <SessionHeader
        sessionState={null}
        fallbackSessionInfo={{ repoOwner: "acme", repoName: "web", title: "Mobile menu" }}
        executionTarget={{ kind: "unknown" }}
        connected
        connecting={false}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        actionsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={onToggleDetails}
        onOpenMobileDetails={onOpenMobileDetails}
        actions={actions}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Toggle session details" })).toHaveClass(
      "hidden",
      "md:block",
      "lg:hidden"
    );
    const trigger = screen.getByRole("button", { name: "Session actions" });
    expect(trigger.parentElement).toHaveClass("md:hidden");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    expect(onOpenMobileDetails).toHaveBeenCalledOnce();
    expect(onToggleDetails).not.toHaveBeenCalled();
  });
});
