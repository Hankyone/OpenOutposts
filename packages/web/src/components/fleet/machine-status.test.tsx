// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { MachineHeartbeat, MachineStatus } from "@/components/fleet/machine-status";
import { OUTPOST_HEARTBEAT_STALE_AFTER_MS } from "@/lib/session-execution-target";

expect.extend(matchers);

afterEach(cleanup);

describe("MachineStatus", () => {
  it("reports a machine with a fresh heartbeat as connected", () => {
    render(<MachineStatus connected lastSeenAt={new Date().toISOString()} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("does not call a machine connected once its heartbeat has gone quiet", () => {
    const wentQuietAt = new Date(Date.now() - OUTPOST_HEARTBEAT_STALE_AFTER_MS - 1_000);
    render(<MachineStatus connected lastSeenAt={wentQuietAt.toISOString()} />);
    expect(screen.getByText("No heartbeat")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("reports a disconnected machine as offline", () => {
    render(<MachineStatus connected={false} lastSeenAt={new Date().toISOString()} />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("says the connection is unknown when the timestamp is unusable", () => {
    render(<MachineStatus connected lastSeenAt="not-a-timestamp" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});

describe("MachineHeartbeat", () => {
  it("carries the exact timestamp for a coarse relative age", () => {
    const seenAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    render(<MachineHeartbeat lastSeenAt={seenAt.toISOString()} />);

    const rendered = screen.getByText("2h ago");
    expect(rendered).toHaveAttribute("title", seenAt.toLocaleString());
  });

  it("renders an unusable timestamp as never seen", () => {
    render(<MachineHeartbeat lastSeenAt="" />);
    expect(screen.getByText("Never")).toBeInTheDocument();
  });
});
