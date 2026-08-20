import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutpostClient } from "../outpost-client.js";
import type { PiAgentHome } from "./agent-home.js";
import type * as AgentHomeModule from "./agent-home.js";
import type * as SessionModule from "./session.js";

interface SessionDouble {
  sessionId: string;
  getActiveToolNames(): string[];
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const doubles = vi.hoisted(() => ({
  session: null as unknown as SessionDouble,
  home: null as unknown as PiAgentHome,
}));

vi.mock("./session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    createOutpostAgentSession: () =>
      Promise.resolve({
        session: doubles.session,
        resumed: false,
        recovered: false,
        entryCount: 0,
        messageCount: 0,
      }),
  };
});

vi.mock("./agent-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentHomeModule>();
  return { ...actual, createPiAgentHome: () => Promise.resolve(doubles.home) };
});

const { PiHarness } = await import("./harness.js");

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeOutposts() {
  const client = {
    createLease: vi
      .fn()
      .mockResolvedValue({ leaseId: "lease_1", expiresAt: "2099-01-01T00:00:00Z" }),
    renewLease: vi.fn().mockResolvedValue(undefined),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    cancelLeaseWork: vi.fn().mockResolvedValue(undefined),
    readContext: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ ok: true, output: {} }),
  };
  return client as unknown as OutpostClient & typeof client;
}

async function openSession(outposts = fakeOutposts(), onLog = vi.fn()) {
  const harness = new PiHarness({
    outposts,
    outpostId: "outpost-1",
    defaultModel: "anthropic/claude-sonnet-4-5",
    loadGlobalContext: () => Promise.resolve([]),
    onLog,
  });
  const session = await harness.createSession({
    productSessionId: "session-1",
    workspacePath: "/workspace/session-1",
  });
  return { harness, session, outposts, onLog };
}

describe("PiHarness close lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const waitForIdle = vi.fn().mockResolvedValue(undefined);
    doubles.session = {
      sessionId: "pi-session-1",
      getActiveToolNames: () => ["outpost_bash"],
      waitForIdle,
      abort: vi.fn(async () => waitForIdle()),
      dispose: vi.fn(),
    };
    doubles.home = {
      agentDir: "/tmp/pi-home/agent",
      cwd: "/tmp/pi-home/scratch",
      authPath: "/tmp/pi-home/agent/auth.json",
      modelsPath: "/tmp/pi-home/agent/models.json",
      remove: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels Pi and outpost work before disposing and releasing", async () => {
    const idle = deferred();
    const cancelled = deferred();
    doubles.session.waitForIdle = vi.fn(() => idle.promise);
    doubles.session.abort = vi.fn(async () => doubles.session.waitForIdle());
    const outposts = fakeOutposts();
    outposts.cancelLeaseWork.mockImplementation(() => cancelled.promise);
    const { harness, session } = await openSession(outposts);

    const closing = harness.close(session);
    expect(doubles.session.abort).toHaveBeenCalledTimes(1);
    expect(doubles.session.waitForIdle).toHaveBeenCalledTimes(1);
    expect(outposts.cancelLeaseWork).toHaveBeenCalledWith("outpost-1", "lease_1");
    expect(doubles.session.dispose).not.toHaveBeenCalled();

    idle.resolve();
    await Promise.resolve();
    expect(doubles.session.dispose).not.toHaveBeenCalled();
    cancelled.resolve();
    await closing;

    expect(doubles.session.dispose).toHaveBeenCalledTimes(1);
    expect(outposts.releaseLease).toHaveBeenCalledOnce();
    expect(outposts.releaseLease).toHaveBeenCalledWith("outpost-1", "lease_1", "completed");
    expect(doubles.home.remove).toHaveBeenCalledTimes(1);
  });

  it("cleans up after the bounded drain expires", async () => {
    const neverIdle = deferred();
    doubles.session.waitForIdle = vi.fn(() => neverIdle.promise);
    doubles.session.abort = vi.fn(async () => doubles.session.waitForIdle());
    const { harness, session, outposts, onLog } = await openSession();

    const closing = harness.close(session);
    await vi.advanceTimersByTimeAsync(10_000);
    await closing;

    expect(doubles.session.dispose).toHaveBeenCalledTimes(1);
    expect(outposts.releaseLease).toHaveBeenCalledTimes(1);
    expect(doubles.home.remove).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("close drain timed out"));
  });

  it("does not skip later cleanup when lifecycle steps reject", async () => {
    doubles.session.abort = vi.fn().mockRejectedValue(new Error("abort failed"));
    doubles.session.dispose = vi.fn(() => {
      throw new Error("dispose failed");
    });
    const outposts = fakeOutposts();
    outposts.cancelLeaseWork.mockRejectedValue(new Error("cancel failed"));
    outposts.releaseLease.mockRejectedValue(new Error("release failed"));
    const { harness, session } = await openSession(outposts);

    await harness.close(session);

    expect(doubles.session.dispose).toHaveBeenCalledTimes(1);
    expect(outposts.releaseLease).toHaveBeenCalledTimes(1);
    expect(doubles.home.remove).toHaveBeenCalledTimes(1);
  });

  it("closes one runtime only once", async () => {
    const { harness, session, outposts } = await openSession();

    await harness.close(session);
    await harness.close(session);

    expect(doubles.session.abort).toHaveBeenCalledTimes(1);
    expect(outposts.cancelLeaseWork).toHaveBeenCalledTimes(1);
    expect(doubles.session.dispose).toHaveBeenCalledTimes(1);
    expect(outposts.releaseLease).toHaveBeenCalledTimes(1);
    expect(doubles.home.remove).toHaveBeenCalledTimes(1);
  });
});
