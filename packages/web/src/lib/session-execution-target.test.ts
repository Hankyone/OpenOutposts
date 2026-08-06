import { describe, expect, it } from "vitest";
import {
  OUTPOST_HEARTBEAT_STALE_AFTER_MS,
  describeExecutionTarget,
  deriveSessionExecutionTarget,
} from "./session-execution-target";
import type { OutpostSummary } from "@/hooks/use-outposts";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

function outpost(overrides: Partial<OutpostSummary> = {}): OutpostSummary {
  return {
    id: "workshop",
    name: "Workshop Mac",
    platform: "darwin",
    architecture: "arm64",
    connected: true,
    lastSeenAt: new Date(NOW - 1_000).toISOString(),
    workerVersion: "0.4.1",
    ...overrides,
  };
}

function sessionState(outpostId: string | null | undefined) {
  return { sandboxStatus: "ready" as const, outpostId };
}

describe("deriveSessionExecutionTarget", () => {
  it("reports nothing before session state arrives", () => {
    expect(deriveSessionExecutionTarget(null, [outpost()], NOW)).toEqual({ kind: "unknown" });
    expect(describeExecutionTarget({ kind: "unknown" })).toBeNull();
  });

  it("reports an outpost with no machine named yet, never a sandbox", () => {
    const target = deriveSessionExecutionTarget(sessionState(null), [outpost()], NOW);

    expect(target).toEqual({ kind: "unassigned", status: "ready" });

    const display = describeExecutionTarget(target);
    expect(display?.label).toBe("Outpost · ready");
    expect(display?.tone).toBe("success");
    expect(display?.detail).toBe(
      "Running on an outpost. This session has not named which machine yet."
    );
    // No machine is invented, and no sandbox is claimed.
    expect(`${display?.label} ${display?.detail}`).not.toMatch(/sandbox/i);
    expect(display?.label).not.toContain("Workshop Mac");
  });

  it("tones the session's own lifecycle while no machine is named", () => {
    const failed = deriveSessionExecutionTarget(
      { sandboxStatus: "failed", outpostId: null },
      [],
      NOW
    );
    expect(describeExecutionTarget(failed)).toMatchObject({
      label: "Outpost · failed",
      tone: "destructive",
    });

    // Statuses the old map omitted must still resolve to a real tone.
    const connecting = deriveSessionExecutionTarget(
      { sandboxStatus: "connecting", outpostId: null },
      [],
      NOW
    );
    expect(describeExecutionTarget(connecting)).toMatchObject({
      label: "Outpost · connecting",
      tone: "warning",
    });
    const snapshotting = deriveSessionExecutionTarget(
      { sandboxStatus: "snapshotting", outpostId: null },
      [],
      NOW
    );
    expect(describeExecutionTarget(snapshotting)?.tone).toBe("accent");
  });

  it("names the bound machine and reports a fresh heartbeat as connected", () => {
    const target = deriveSessionExecutionTarget(sessionState("workshop"), [outpost()], NOW);

    expect(target).toMatchObject({
      kind: "outpost",
      outpostId: "workshop",
      name: "Workshop Mac",
      described: true,
      reachability: "connected",
      workerVersion: "0.4.1",
    });
    expect(describeExecutionTarget(target)?.label).toBe("Workshop Mac · connected");
    expect(describeExecutionTarget(target)?.tone).toBe("success");
  });

  it("reports a machine whose heartbeat has lapsed as stale, not connected", () => {
    const lapsed = outpost({
      lastSeenAt: new Date(NOW - OUTPOST_HEARTBEAT_STALE_AFTER_MS - 1).toISOString(),
    });

    const target = deriveSessionExecutionTarget(sessionState("workshop"), [lapsed], NOW);

    expect(target).toMatchObject({ reachability: "stale" });
    expect(describeExecutionTarget(target)?.label).toBe("Workshop Mac · no heartbeat");
    expect(describeExecutionTarget(target)?.tone).toBe("warning");
  });

  it("reports a disconnected machine as offline", () => {
    const target = deriveSessionExecutionTarget(
      sessionState("workshop"),
      [outpost({ connected: false })],
      NOW
    );

    expect(target).toMatchObject({ reachability: "offline" });
    expect(describeExecutionTarget(target)?.tone).toBe("destructive");
  });

  it("still names the machine when the fleet listing cannot describe it", () => {
    // An empty listing means "no machines", "listing refused", or "machine
    // un-enrolled" — none of which make the session's own binding wrong.
    const target = deriveSessionExecutionTarget(sessionState("workshop"), [], NOW);

    expect(target).toMatchObject({
      kind: "outpost",
      outpostId: "workshop",
      name: "workshop",
      described: false,
      reachability: "unknown",
      lastSeenAt: null,
    });
    expect(describeExecutionTarget(target)?.label).toBe("workshop · connection unknown");
    expect(describeExecutionTarget(target)?.detail).toBe("Not in your machine list");
  });

  it("treats an unparseable heartbeat as unknown rather than fresh", () => {
    const target = deriveSessionExecutionTarget(
      sessionState("workshop"),
      [outpost({ lastSeenAt: "not-a-date" })],
      NOW
    );

    expect(target).toMatchObject({ reachability: "unknown", lastSeenAt: null });
  });

  it("tolerates a listing without the worker version field", () => {
    const { workerVersion: _omitted, ...withoutVersion } = outpost();

    const target = deriveSessionExecutionTarget(
      sessionState("workshop"),
      [withoutVersion as OutpostSummary],
      NOW
    );

    expect(target).toMatchObject({ described: true, workerVersion: null });
  });
});
