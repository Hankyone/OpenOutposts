import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_CATALOG_VERSION,
  OUTPOST_PROTOCOL_VERSION,
  HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE,
  homesteadToControlMessageSchema,
  type SessionAssign,
} from "@openoutposts/outpost-protocol";

import {
  HomesteadDaemon,
  resolveMaxSessions,
  type HomesteadDaemonOptions,
} from "./homestead-daemon.js";
import { SessionStateStore } from "./state-store.js";

const doubles = vi.hoisted(() => ({
  recoveredAssignments: [] as SessionAssign[],
  harnessOptions: [] as { piSessionFile?: string }[],
}));

vi.mock("../pi/harness.js", () => ({
  PiHarness: class {
    constructor(options: { piSessionFile?: string }) {
      doubles.harnessOptions.push(options);
    }
    async createSession(options: { productSessionId: string }) {
      return {
        productSessionId: options.productSessionId,
        harnessSessionId: `pi-${options.productSessionId}`,
      };
    }
    async close() {}
  },
}));

vi.mock("./bridge-session.js", () => ({
  BridgeSession: class {
    readonly sandboxId: string;
    constructor(
      private readonly options: {
        assignment: SessionAssign;
        onClosed: (productSessionId: string) => void;
      }
    ) {
      this.sandboxId = options.assignment.sandboxId;
    }
    start() {
      doubles.recoveredAssignments.push(this.options.assignment);
    }
    async shutdown() {
      this.options.onClosed(this.options.assignment.productSessionId);
    }
  },
}));

/**
 * The daemon mints an internal token before every connection attempt. Real
 * WebCrypto resolves off the threadpool, not the microtask queue, so a test
 * asserting "another attempt was made" had to wait an unbounded amount of
 * real time for it — which is a race, and it is what made these tests pass
 * locally and fail on a loaded CI homestead. Stubbing the token makes each
 * attempt land in a bounded number of microtask turns instead.
 */
type Listener = (event: unknown) => void;

/**
 * Minimal stand-in for the global WebSocket the daemon constructs. Records
 * every construction so a test can assert that another attempt was made, and
 * can be told to throw from its constructor to simulate a connect that fails
 * before any socket exists to emit "close".
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static urls: string[] = [];
  static throwOnConstruct = false;
  /** Reproduces a socket that closed between the readyState check and `send`. */
  static throwOnSend = false;

  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    FakeWebSocket.urls.push(url);
    if (FakeWebSocket.throwOnConstruct) {
      throw new Error("connect failed");
    }
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.#listeners.get(type) ?? [];
    existing.push(listener);
    this.#listeners.set(type, existing);
  }

  send(data: string): void {
    if (FakeWebSocket.throwOnSend) {
      throw new DOMException("Invalid state", "InvalidStateError");
    }
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", { code: 1000 });
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const stateDirs: string[] = [];

/** Generous upper bound on how long WebCrypto may take on a loaded CI homestead. */
const CONNECTION_WAIT_TIMEOUT_MS = 10_000;

/**
 * Yields to the real event loop until the daemon has attempted `count`
 * connections. Advancing fake timers only flushes microtasks, and the daemon
 * awaits the internal token — WebCrypto, which resolves off the microtask
 * queue — before it constructs a socket.
 *
 * Bounded by wall clock rather than by a tick count: a fixed number of ticks
 * is a race, not a synchronization, and a slower machine simply runs out of
 * budget before the token resolves. hrtime is used because `Date` is faked.
 *
 * A caller proving a NEGATIVE — that no further attempt arrives — always pays
 * the whole budget, so it passes a short one.
 */
async function waitForConnectionAttempts(
  count: number,
  timeoutMs = CONNECTION_WAIT_TIMEOUT_MS
): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (FakeWebSocket.urls.length < count && process.hrtime.bigint() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Yields to the real event loop until a harness has been constructed. */
async function waitForHarnessOptions(timeoutMs = CONNECTION_WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (doubles.harnessOptions.length === 0 && process.hrtime.bigint() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** An assignment this daemon accepts, for tests about what happens after. */
function assignmentMessage(productSessionId: string): SessionAssign {
  return {
    type: "session.assign",
    protocolVersion: OUTPOST_PROTOCOL_VERSION,
    assignmentId: `assignment-${productSessionId}`,
    productSessionId,
    sandboxId: `generation-${productSessionId}`,
    sandboxAuthToken: "bridge-token",
    credentialFetchToken: "fetch-token",
    controlPlaneUrl: "https://control.example",
    harness: "pi",
    outpostId: "outpost-1",
    workspacePath: `/workspace/${productSessionId}`,
  };
}

/**
 * A control plane that grants every lease and reports every command as having
 * succeeded, so a test about what the daemon does after accepting can get
 * there.
 */
function alwaysWillingControlPlane(): void {
  globalThis.fetch = vi.fn(async () =>
    Response.json({
      leaseId: "lease-1",
      expiresAt: "2099-01-01T00:00:00Z",
      ok: true,
      output: { stdout: "", stderr: "", exitCode: 0 },
    })
  ) as unknown as typeof fetch;
}

/**
 * Daemons are tracked so teardown can stop any a test left running. The
 * FakeWebSocket counters are static, so a daemon that outlives its test keeps
 * appending connection attempts to the next test's tally — which is invisible
 * on a fast machine and intermittent on a slow one.
 */
const liveDaemons: HomesteadDaemon[] = [];

function makeDaemon(overrides: Partial<HomesteadDaemonOptions> = {}): HomesteadDaemon {
  const daemon = new HomesteadDaemon({
    controlPlaneUrl: "http://127.0.0.1:8788",
    internalSecret: "test-secret",
    homesteadId: "test-homestead",
    homesteadVersion: "0.0.0-test",
    ...overrides,
  });
  liveDaemons.push(daemon);
  return daemon;
}

describe("HomesteadDaemon reconnect", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.urls = [];
    FakeWebSocket.throwOnConstruct = false;
    FakeWebSocket.throwOnSend = false;
    doubles.recoveredAssignments = [];
    doubles.harnessOptions = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    // setImmediate stays real so the test can wait for WebCrypto.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });

  afterEach(async () => {
    await Promise.all(liveDaemons.splice(0).map((daemon) => daemon.stop()));
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps rescheduling after a reconnect attempt throws", async () => {
    const daemon = makeDaemon();
    await daemon.start();
    expect(FakeWebSocket.urls).toHaveLength(1);
    expect(FakeWebSocket.urls[0]).toBe("ws://127.0.0.1:8788/homesteads/connect");

    // The control plane goes away.
    FakeWebSocket.instances[0].emit("close", { code: 1006 });

    // The first retry throws before a socket exists, so nothing will ever
    // emit "close" to arm the next one. The daemon itself must re-arm.
    FakeWebSocket.throwOnConstruct = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForConnectionAttempts(2);
    expect(FakeWebSocket.urls).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Second retry, at the doubled delay, succeeds.
    FakeWebSocket.throwOnConstruct = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await waitForConnectionAttempts(3);
    expect(FakeWebSocket.urls).toHaveLength(3);
    expect(FakeWebSocket.instances).toHaveLength(2);

    await daemon.stop();
  });

  it("stops reconnecting once stopped", async () => {
    const daemon = makeDaemon();
    await daemon.start();
    FakeWebSocket.instances[0].emit("close", { code: 1006 });

    await daemon.stop();

    // The property under test is that stopping ends the retry loop, so assert
    // against the count at the moment of stop rather than an absolute number.
    // An absolute count also asserts that nothing else in the process ever
    // connected, which the shared FakeWebSocket counters cannot guarantee.
    const attemptsAtStop = FakeWebSocket.urls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    // Waits out the loop rather than expecting it: a late attempt would show
    // up here, not on the next tick.
    await waitForConnectionAttempts(attemptsAtStop + 1, 500);
    expect(FakeWebSocket.urls).toHaveLength(attemptsAtStop);
  });

  it("waits out the ceiling when the control plane refuses this homestead id", async () => {
    const daemon = makeDaemon();
    await daemon.start();
    expect(FakeWebSocket.urls).toHaveLength(1);

    // Another process holds this homestead id. Retrying at the base delay would
    // be a hot loop against a refusal that cannot change until it goes away.
    FakeWebSocket.instances[0].emit("close", { code: HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE });

    await vi.advanceTimersByTimeAsync(29_000);
    await waitForConnectionAttempts(2, 500);
    expect(FakeWebSocket.urls).toHaveLength(1);

    // Still retrying, though: the holder may be the dying half of a rollover.
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForConnectionAttempts(2);
    expect(FakeWebSocket.urls).toHaveLength(2);
  });

  it("reports the harness model catalog on every registration", async () => {
    const catalog = {
      catalogVersion: MODEL_CATALOG_VERSION,
      providers: [{ id: "anthropic", name: "Anthropic" }],
      models: [
        {
          providerId: "anthropic",
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
          input: ["text"] as ("text" | "image")[],
        },
      ],
    };
    const daemon = makeDaemon({ catalog });
    await daemon.start();

    FakeWebSocket.instances[0].emit("open", {});
    const registration = homesteadToControlMessageSchema.parse(
      JSON.parse(FakeWebSocket.instances[0].sent[0])
    );
    expect(registration.type === "homestead.register" && registration.catalog).toEqual(catalog);

    // A reconnect re-registers from scratch, so the catalog has to ride along
    // every time rather than once per process.
    FakeWebSocket.instances[0].emit("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForConnectionAttempts(2);
    FakeWebSocket.instances[1].emit("open", {});
    expect(JSON.parse(FakeWebSocket.instances[1].sent[0]).catalog).toEqual(catalog);
  });

  it("registers without a catalog when the harness could not be read", async () => {
    const daemon = makeDaemon();
    await daemon.start();
    FakeWebSocket.instances[0].emit("open", {});

    const registration = JSON.parse(FakeWebSocket.instances[0].sent[0]) as Record<string, unknown>;
    expect(registration.catalog).toBeUndefined();
    expect(homesteadToControlMessageSchema.safeParse(registration).success).toBe(true);
  });

  it("holds the event loop open while running and releases it on stop", async () => {
    const daemon = makeDaemon();
    await daemon.start();
    // A keepalive handle is the difference between a homestead that waits out a
    // control-plane restart and a process that exits 0 mid-outage.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await daemon.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rotates credentials before recovering persisted sessions", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "homestead-recovery-"));
    stateDirs.push(stateDir);
    await new SessionStateStore(stateDir).save({
      status: "active",
      assignment: {
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-before-restart",
        productSessionId: "session-recover",
        sandboxId: "generation-recover",
        controlPlaneUrl: "https://control.example",
        harness: "pi",
        model: "anthropic/claude-haiku-4-5",
        outpostId: "outpost-recover",
        workspacePath: "/workspace/session-recover",
      },
      repositories: [],
    });

    const fetchImpl = vi.fn(async () =>
      Response.json({
        recoveryVersion: 1,
        productSessionId: "session-recover",
        sandboxId: "generation-recover",
        sandboxAuthToken: "rotated-bridge",
        credentialFetchToken: "rotated-fetch",
      })
    );
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const log = vi.fn();
    const daemon = makeDaemon({ stateDir, log });

    await daemon.start();
    const deadline = process.hrtime.bigint() + 5_000_000_000n;
    while (doubles.recoveredAssignments.length === 0 && process.hrtime.bigint() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(doubles.recoveredAssignments).toHaveLength(1);
    expect(doubles.recoveredAssignments[0]).toMatchObject({
      productSessionId: "session-recover",
      sandboxId: "generation-recover",
      sandboxAuthToken: "rotated-bridge",
      credentialFetchToken: "rotated-fetch",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("session credentials rotated; recovering after restart", {
      session: "session-recover",
    });
    const rawState = await readFile(join(stateDir, "session-recover.json"), "utf8");
    expect(rawState).not.toContain("rotated-bridge");
    expect(rawState).not.toContain("rotated-fetch");
  });

  /**
   * The assignment handler's first act is a reply on the control socket, and
   * `send` throws once that socket is closing. Floated, that rejection reached
   * the process's fatal unhandled-rejection handler, which answers by exiting —
   * so one badly timed assignment ended every session on the machine.
   */
  it("logs and drops an assignment whose reply cannot be sent", async () => {
    const log = vi.fn();
    const daemon = makeDaemon({ log });
    await daemon.start();

    FakeWebSocket.throwOnSend = true;
    FakeWebSocket.instances[0].emit("message", {
      data: JSON.stringify({
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-late",
        productSessionId: "session-late",
        sandboxId: "generation-late",
        sandboxAuthToken: "bridge-token",
        credentialFetchToken: "fetch-token",
        controlPlaneUrl: "https://control.example",
        // Refused on sight, so the reply is the only thing this assignment does.
        harness: "claude-code",
        outpostId: "outpost-late",
        workspacePath: "/workspace/session-late",
      }),
    });

    // The rejection has to be observable as a log line and nothing worse: a
    // shutdown that drains it must still succeed.
    const deadline = process.hrtime.bigint() + 5_000_000_000n;
    while (
      !log.mock.calls.some((call) => call[0] === "background work failed") &&
      process.hrtime.bigint() < deadline
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(log).toHaveBeenCalledWith(
      "background work failed",
      expect.objectContaining({ work: expect.stringContaining("assignment-late") })
    );

    FakeWebSocket.throwOnSend = false;
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("keeps running when a control message cannot be written", async () => {
    const log = vi.fn();
    const daemon = makeDaemon({ log });
    await daemon.start();

    // A throw inside a socket listener escapes into the process's fatal
    // uncaught-exception handler rather than being reported anywhere useful.
    FakeWebSocket.throwOnSend = true;
    expect(() => FakeWebSocket.instances[0].emit("open", {})).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "control message could not be sent",
      expect.objectContaining({ message: "registration" })
    );
  });

  it("refuses to start with a session cap that is not a positive whole number", () => {
    expect(() => makeDaemon({ maxSessions: Number("eigth") })).toThrow(/positive whole number/);
  });

  it("does not recover a session when credential rotation is refused", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "homestead-recovery-refused-"));
    stateDirs.push(stateDir);
    await new SessionStateStore(stateDir).save({
      status: "active",
      assignment: {
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-before-restart",
        productSessionId: "session-refused",
        sandboxId: "generation-refused",
        controlPlaneUrl: "https://control.example",
        harness: "pi",
        model: "anthropic/claude-haiku-4-5",
        outpostId: "outpost-refused",
        workspacePath: "/workspace/session-refused",
      },
      repositories: [],
    });

    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: "Session generation is not active" }, { status: 409 })
    ) as unknown as typeof fetch;
    const log = vi.fn();
    const daemon = makeDaemon({ stateDir, log });

    await daemon.start();

    expect(doubles.recoveredAssignments).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      "session restart recovery failed; no stored or stale credential will be used",
      expect.objectContaining({
        session: "session-refused",
        error: expect.stringContaining("HTTP 409"),
      })
    );
  });

  /**
   * The agent lives on the homestead machine, so the conversation has to have
   * a home there. It is one file per product session under the state
   * directory, at the same path every time the session starts — which is what
   * makes a restart, or a wake months later, continue rather than begin.
   */
  it("gives a recovered session the same conversation file it had before", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "homestead-pi-session-path-"));
    stateDirs.push(stateDir);
    await new SessionStateStore(stateDir).save({
      status: "active",
      assignment: {
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-before-restart",
        productSessionId: "session/with-awkward-id",
        sandboxId: "generation-recover",
        controlPlaneUrl: "https://control.example",
        harness: "pi",
        model: "anthropic/claude-haiku-4-5",
        outpostId: "outpost-recover",
        workspacePath: "/workspace/session-recover",
      },
      repositories: [],
    });

    globalThis.fetch = vi.fn(async () =>
      Response.json({
        recoveryVersion: 1,
        productSessionId: "session/with-awkward-id",
        sandboxId: "generation-recover",
        sandboxAuthToken: "rotated-bridge",
        credentialFetchToken: "rotated-fetch",
      })
    ) as unknown as typeof fetch;

    const daemon = makeDaemon({ stateDir });
    await daemon.start();
    const deadline = process.hrtime.bigint() + 5_000_000_000n;
    while (doubles.harnessOptions.length === 0 && process.hrtime.bigint() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(doubles.harnessOptions[0]?.piSessionFile).toBe(
      join(stateDir, "pi-sessions", `${encodeURIComponent("session/with-awkward-id")}.jsonl`)
    );
  });

  /**
   * A homestead with nowhere durable to keep state — the local demo — must not
   * pick a directory of its own to leave a user's conversation in.
   */
  it("keeps conversations in memory when it has no state directory", async () => {
    alwaysWillingControlPlane();
    const daemon = makeDaemon();
    await daemon.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit("message", { data: JSON.stringify(assignmentMessage("session-no-state")) });
    await waitForHarnessOptions();

    expect(doubles.harnessOptions[0]).not.toHaveProperty("piSessionFile");
  });

  /**
   * The conversation is kept under the same retention promise as the record
   * that points at it, so both go at the same moment. Anything set aside as
   * unreadable belongs to the same session and goes with it.
   */
  it("deletes the conversations of dormant sessions it prunes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "homestead-pi-session-prune-"));
    stateDirs.push(stateDir);
    const store = new SessionStateStore(stateDir);
    await store.save({
      status: "active",
      assignment: {
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-old",
        productSessionId: "session-expired",
        sandboxId: "generation-old",
        controlPlaneUrl: "https://control.example",
        harness: "pi",
        outpostId: "outpost-old",
        workspacePath: "/workspace/session-expired",
      },
      repositories: [],
    });
    await store.markDormant("session-expired");

    const piSessions = join(stateDir, "pi-sessions");
    await mkdir(piSessions, { recursive: true });
    await writeFile(join(piSessions, "session-expired.jsonl"), "{}\n");
    await writeFile(join(piSessions, "session-expired.jsonl.corrupt-1"), "junk\n");
    await writeFile(join(piSessions, "session-still-here.jsonl"), "{}\n");

    // Past the 90-day dormant retention window.
    vi.setSystemTime(Date.now() + 91 * 24 * 60 * 60 * 1000);
    const daemon = makeDaemon({ stateDir });
    await daemon.start();

    expect((await readdir(piSessions)).sort()).toEqual(["session-still-here.jsonl"]);
  });
});

/**
 * A typo used to read as NaN, which is not a small cap but no cap at all:
 * `size >= NaN` is always false, so the guard admitted sessions without limit,
 * and `slice(0, NaN)` recovered none of the sessions that had been running.
 */
describe("resolveMaxSessions", () => {
  it("defaults when nothing is configured", () => {
    expect(resolveMaxSessions(undefined)).toBe(8);
    expect(resolveMaxSessions("")).toBe(8);
  });

  it("reads a positive whole number", () => {
    expect(resolveMaxSessions("3")).toBe(3);
    expect(resolveMaxSessions(3)).toBe(3);
  });

  it("rejects a value that is not a positive whole number", () => {
    expect(() => resolveMaxSessions("eigth")).toThrow(/positive whole number/);
    expect(() => resolveMaxSessions("0")).toThrow(/positive whole number/);
    expect(() => resolveMaxSessions("-2")).toThrow(/positive whole number/);
    expect(() => resolveMaxSessions("2.5")).toThrow(/positive whole number/);
  });
});
