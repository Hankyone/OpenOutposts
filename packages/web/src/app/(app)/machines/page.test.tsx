// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { OutpostSummary } from "@/hooks/use-outposts";
import MachinesPage from "./page";

expect.extend(matchers);

const { mockUseOutposts, mockUseOutpostBoundSessions, mockUseSidebarContext } = vi.hoisted(() => ({
  mockUseOutposts: vi.fn(),
  mockUseOutpostBoundSessions: vi.fn(),
  mockUseSidebarContext: vi.fn(),
}));

vi.mock("@/hooks/use-outposts", () => ({
  useOutposts: mockUseOutposts,
  useOutpostBoundSessions: mockUseOutpostBoundSessions,
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: mockUseSidebarContext,
  CollapsedSidebarControls: () => <div data-testid="collapsed-sidebar-controls" />,
}));

const workstation: OutpostSummary = {
  id: "workstation-01",
  name: "Studio Mac mini",
  platform: "darwin",
  architecture: "arm64",
  connected: true,
  lastSeenAt: new Date().toISOString(),
  workerVersion: "0.4.2",
  disconnectedAt: null,
};

const offlineBox: OutpostSummary = {
  id: "gpu-box",
  name: "GPU box",
  platform: "linux",
  architecture: "amd64",
  connected: false,
  lastSeenAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  workerVersion: "0.4.1",
  disconnectedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
};

const refresh = vi.fn();

function renderPage(
  overrides: {
    outposts?: OutpostSummary[];
    loading?: boolean;
    unavailable?: boolean;
    bound?: ReturnType<typeof mockUseOutpostBoundSessions>;
  } = {}
) {
  mockUseSidebarContext.mockReturnValue({ isOpen: true, toggle: vi.fn() });
  mockUseOutposts.mockReturnValue({
    outposts: overrides.outposts ?? [workstation, offlineBox],
    loading: overrides.loading ?? false,
    unavailable: overrides.unavailable ?? false,
    refresh,
  });
  mockUseOutpostBoundSessions.mockReturnValue(
    overrides.bound ?? { sessions: [], loading: false, unavailable: false }
  );

  return render(<MachinesPage />);
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ removed: true }), { status: 200 })
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("MachinesPage", () => {
  it("describes each machine's identity, reachability and build", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Studio Mac mini" })).toBeInTheDocument();
    expect(screen.getByText("workstation-01")).toBeInTheDocument();
    expect(screen.getByText("darwin/arm64")).toBeInTheDocument();
    expect(screen.getByText("0.4.2")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "GPU box" })).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("3h ago")).toBeInTheDocument();
  });

  it("lists the sessions currently bound to a machine", () => {
    renderPage({
      outposts: [workstation],
      bound: {
        sessions: [
          {
            leaseId: "lease-1",
            productSessionId: "session-abc",
            workspacePath: "/Users/dev/work/api",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
        loading: false,
        unavailable: false,
      },
    });

    const link = screen.getByRole("link", { name: "session-abc" });
    expect(link).toHaveAttribute("href", "/session/session-abc");
    expect(screen.getByText("/Users/dev/work/api")).toBeInTheDocument();
  });

  it("separates a machine running nothing from bindings it cannot read", () => {
    renderPage({ outposts: [workstation] });
    expect(screen.getByText(/nothing is running on this machine/i)).toBeInTheDocument();

    cleanup();

    renderPage({
      outposts: [workstation],
      bound: { sessions: [], loading: false, unavailable: true },
    });
    expect(screen.getByText(/does not report bindings/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing is running on this machine/i)).not.toBeInTheDocument();
  });

  it("removes a machine only after the warning is confirmed", async () => {
    const user = userEvent.setup();
    renderPage({ outposts: [workstation] });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/lose it and stop where they are/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/outposts/workstation-01", {
        method: "DELETE",
        mode: "same-origin",
        credentials: "same-origin",
      });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("cancelling the warning leaves the machine alone", async () => {
    const user = userEvent.setup();
    renderPage({ outposts: [workstation] });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces the control plane's own refusal when removal fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Managing outposts requires outpost ownership" }), {
        status: 403,
      })
    );
    renderPage({ outposts: [workstation] });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Managing outposts requires outpost ownership"
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says the listing was refused rather than claiming the fleet is empty", () => {
    renderPage({ outposts: [], unavailable: true });

    expect(screen.getByRole("alert")).toHaveTextContent(/unable to load your machines/i);
    expect(screen.queryByText(/no machines yet/i)).not.toBeInTheDocument();
  });

  it("enrolls a machine with a one-time command and machine code", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/outposts/enrollments" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            enrollmentId: "enroll-1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            commands: {
              macos: "openoutpost enroll --token one-time-mac",
              linux: "openoutpost enroll --token one-time-linux",
            },
          }),
          { status: 201 }
        );
      }
      if (url === "/api/outposts/enrollments/enroll-1" && !init?.method) {
        return new Response(
          JSON.stringify({
            enrollmentId: "enroll-1",
            outpostId: "outpost-new",
            state: "awaiting_confirmation",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })
        );
      }
      if (url === "/api/outposts/enrollments/enroll-1/confirm" && init?.method === "POST") {
        return new Response(JSON.stringify({ confirmed: true, outpostId: "outpost-new" }));
      }
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 500 });
    });
    renderPage({ outposts: [] });

    await user.type(screen.getByLabelText("Machine name (optional)"), "Studio Mac");
    await user.click(screen.getByRole("button", { name: "Generate command" }));

    expect(await screen.findByText("openoutpost enroll --token one-time-mac")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    const code = await screen.findByLabelText("Code shown on the machine");
    await user.type(code, "123-456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText(/machine enrolled/i)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/outposts/enrollments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Studio Mac" }),
      mode: "same-origin",
      credentials: "same-origin",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/outposts/enrollments/enroll-1/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123-456" }),
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("shows a working enrollment form", () => {
    renderPage({ outposts: [] });

    expect(screen.getByRole("heading", { name: "Add a machine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate command" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Operating system" })).toBeInTheDocument();
  });
});
