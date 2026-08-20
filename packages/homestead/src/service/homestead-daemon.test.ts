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
import type { AgentHarness, HarnessEvent } from "../index.js";
import type { CreateSessionHarnessInput, SessionHarnessFactory } from "./harness-factory.js";
import { SessionStateStore } from "./state-store.js";

const doubles = vi.hoisted(() => ({
  recoveredAssignments: [] as SessionAssign[],
  harnessOptions: [] as { piSessionFile?: string }[],
  bridgeStartError: null as Error | null,
}));

vi.mock("../pi/harness.js", () => ({
  PiHarness: class {
    readonly kind = "pi" as const;
    constructor(options: { piSessionFile?: string }) {
      doubles.harnessOptions.push(options);
    }
    async createSession(options: { productSessionId: string }) {
      return {
        productSessionId: options.productSessionId,
        harnessSessionId: `pi-${options.productSessionId}`,
        harness: "pi",
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
      if (doubles.bridgeStartError) throw doubles.bridgeStartError;
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

/** Yields to the real event loop until a bridge has started for the session. */
async function waitForStartedSession(
  productSessionId: string,
  timeoutMs = CONNECTION_WAIT_TIMEOUT_MS
): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (
    !doubles.recoveredAssignments.some(
      (assignment) => assignment.productSessionId === productSessionId
    ) &&
    process.hrtime.bigint() < deadline
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Waits until the recovery record names the requested bridge generation. */
async function waitForPersistedGeneration(
  store: SessionStateStore,
  productSessionId: string,
  sandboxId: string,
  timeoutMs = CONNECTION_WAIT_TIMEOUT_MS
): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const persisted = await store.get(productSessionId);
    if (persisted?.assignment.sandboxId === sandboxId) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`session ${productSessionId} did not persist generation ${sandboxId}`);
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = CONNECTION_WAIT_TIMEOUT_MS
): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (!condition() && process.hrtime.bigint() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error(`timed out waiting for ${description}`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** An assignment this daemon accepts, for tests about what happens after. */
function assignmentMessage(productSessionId: string, generation = productSessionId): SessionAssign {
  return {
    type: "session.assign",
    protocolVersion: OUTPOST_PROTOCOL_VERSION,
    assignmentId: `assignment-${generation}`,
    productSessionId,
    sandboxId: `generation-${generation}`,
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

function startupFailureFetchCalls(): Array<[RequestInfo | URL, RequestInit | undefined]> {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([input]) => String(input).includes("/startup-failure"));
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
    doubles.bridgeStartError = null;
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

  it("advertises exactly the available session harness factories", async () => {
    const unavailableInThisTest = (): AgentHarness => {
      throw new Error("this registration test must not construct a harness");
    };
    const harnessFactories: SessionHarnessFactory[] = [
      { kind: "pi", create: unavailableInThisTest },
      { kind: "claude-code", create: unavailableInThisTest },
    ];
    const daemon = makeDaemon({ harnessFactories });
    await daemon.start();

    FakeWebSocket.instances[0].emit("open", {});
    const registration = homesteadToControlMessageSchema.parse(
      JSON.parse(FakeWebSocket.instances[0].sent[0])
    );

    expect(registration.type === "homestead.register" && registration.harnesses).toEqual([
      "pi",
      "claude-code",
    ]);
  });

  it("rejects an assignment whose harness has no factory", async () => {
    const daemon = makeDaemon();
    await daemon.start();
    const socket = FakeWebSocket.instances[0];

    socket.emit("message", {
      data: JSON.stringify({
        ...assignmentMessage("session-unsupported"),
        harness: "claude-code",
      }),
    });

    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "session.assign_rejected",
      assignmentId: "assignment-session-unsupported",
      reason: "harness claude-code is not available on this homestead",
    });
    expect(doubles.harnessOptions).toHaveLength(0);
  });

  it("creates a fresh session adapter through an injected deterministic factory", async () => {
    alwaysWillingControlPlane();
    const createSession = vi.fn(async (input: { productSessionId: string }) => ({
      productSessionId: input.productSessionId,
      harnessSessionId: `deterministic-${input.productSessionId}`,
      harness: "pi" as const,
    }));
    const harness: AgentHarness = {
      kind: "pi",
      createSession,
      async *sendPrompt() {
        yield { type: "turn.completed" } satisfies HarnessEvent;
      },
      async interrupt() {},
      async close() {},
    };
    const create = vi.fn((_input: CreateSessionHarnessInput) => harness);
    const harnessFactories: SessionHarnessFactory[] = [{ kind: "pi", create }];
    const daemon = makeDaemon({ harnessFactories });
    await daemon.start();
    const assignment = {
      ...assignmentMessage("session-deterministic"),
      model: "anthropic/claude-haiku-4-5",
    };

    FakeWebSocket.instances[0].emit("message", { data: JSON.stringify(assignment) });
    await waitForStartedSession(assignment.productSessionId);

    expect(create).toHaveBeenCalledWith({
      productSessionId: assignment.productSessionId,
      outpostId: assignment.outpostId,
      credentialFetchToken: assignment.credentialFetchToken,
      model: assignment.model,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("sandboxAuthToken");
    expect(createSession).toHaveBeenCalledWith({
      productSessionId: assignment.productSessionId,
      workspacePath: assignment.workspacePath,
      model: assignment.model,
    });
    expect(doubles.recoveredAssignments).toContainEqual(assignment);
  });

  it("reports a repository clone failure after accepting the assignment", async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (url.endsWith("/tool")) {
        const tool = body as { input?: { command?: string } } | null;
        if (tool?.input?.command?.includes("git clone")) {
          return Response.json({
            ok: true,
            output: { stdout: "", stderr: "repository not found", exitCode: 128 },
          });
        }
      }
      return Response.json({
        leaseId: "lease-1",
        expiresAt: "2099-01-01T00:00:00Z",
        ok: true,
        output: { stdout: "", stderr: "", exitCode: 0 },
      });
    }) as unknown as typeof fetch;
    const daemon = makeDaemon();
    await daemon.start();
    const socket = FakeWebSocket.instances[0];
    const assignment = {
      ...assignmentMessage("session-clone-failure"),
      repositories: [
        {
          repoOwner: "acme",
          repoName: "missing",
          baseBranch: "main",
          cloneUrl: "https://example.test/acme/missing.git",
        },
      ],
    };

    socket.emit("message", { data: JSON.stringify(assignment) });
    await waitForCondition(
      () => startupFailureFetchCalls().length === 1,
      "repository clone startup failure report"
    );

    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual(
      expect.objectContaining({
        type: "session.assign_accepted",
        assignmentId: assignment.assignmentId,
      })
    );
    const [, init] = startupFailureFetchCalls()[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer bridge-token");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stage: "repository_clone",
      error: "Repository clone failed: git clone exited 128: repository not found",
      sandboxId: assignment.sandboxId,
      timestamp: expect.any(Number),
    });
  });

  it("reports harness startup failure without ending the homestead", async () => {
    alwaysWillingControlPlane();
    const log = vi.fn();
    const harness: AgentHarness = {
      kind: "pi",
      createSession: vi.fn(async () => {
        throw new Error("Pi registry unavailable");
      }),
      async *sendPrompt() {
        yield { type: "turn.completed" } satisfies HarnessEvent;
      },
      async interrupt() {},
      async close() {},
    };
    const daemon = makeDaemon({
      log,
      harnessFactories: [{ kind: "pi", create: () => harness }],
    });
    await daemon.start();

    FakeWebSocket.instances[0].emit("message", {
      data: JSON.stringify(assignmentMessage("session-harness-failure")),
    });
    await waitForCondition(
      () => startupFailureFetchCalls().length === 1,
      "harness startup failure report"
    );

    const [, init] = startupFailureFetchCalls()[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stage: "harness_start",
      error: "Session harness failed to start: Pi registry unavailable",
    });
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("reports bridge startup failure and releases the failed session", async () => {
    alwaysWillingControlPlane();
    doubles.bridgeStartError = new Error("socket constructor failed");
    const daemon = makeDaemon();
    await daemon.start();

    FakeWebSocket.instances[0].emit("message", {
      data: JSON.stringify(assignmentMessage("session-bridge-failure")),
    });
    await waitForCondition(
      () => startupFailureFetchCalls().length === 1,
      "bridge startup failure report"
    );

    const [, init] = startupFailureFetchCalls()[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stage: "bridge_start",
      error: "Session bridge failed to start: socket constructor failed",
    });
    expect(daemon.activeSessionCount).toBe(0);
  });

  it("logs a refused startup failure report without crashing", async () => {
    const log = vi.fn();
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/startup-failure")) {
        return Response.json({ error: "generation replaced" }, { status: 409 });
      }
      return Response.json({
        leaseId: "lease-1",
        expiresAt: "2099-01-01T00:00:00Z",
        ok: true,
        output: { stdout: "", stderr: "", exitCode: 0 },
      });
    }) as unknown as typeof fetch;
    const harness: AgentHarness = {
      kind: "pi",
      createSession: vi.fn(async () => {
        throw new Error("harness unavailable");
      }),
      async *sendPrompt() {
        yield { type: "turn.completed" } satisfies HarnessEvent;
      },
      async interrupt() {},
      async close() {},
    };
    const daemon = makeDaemon({
      log,
      harnessFactories: [{ kind: "pi", create: () => harness }],
    });
    await daemon.start();

    FakeWebSocket.instances[0].emit("message", {
      data: JSON.stringify(assignmentMessage("session-report-refused")),
    });
    await waitForCondition(
      () =>
        log.mock.calls.some(
          ([message]) => message === "control plane refused session startup failure report"
        ),
      "refused startup failure log"
    );

    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("serializes concurrent assignments for the same product session", async () => {
    alwaysWillingControlPlane();
    const stateDir = await mkdtemp(join(tmpdir(), "homestead-assignment-order-"));
    stateDirs.push(stateDir);
    type CreatedSession = Awaited<ReturnType<AgentHarness["createSession"]>>;
    const starts: Array<{
      gate: ReturnType<typeof deferred<CreatedSession>>;
      createSession: ReturnType<typeof vi.fn>;
    }> = [];
    const create = vi.fn((): AgentHarness => {
      const gate = deferred<CreatedSession>();
      const createSession = vi.fn(() => gate.promise);
      starts.push({ gate, createSession });
      return {
        kind: "pi",
        createSession,
        async *sendPrompt() {
          yield { type: "turn.completed" } satisfies HarnessEvent;
        },
        async interrupt() {},
        async close() {},
      };
    });
    const daemon = makeDaemon({ stateDir, harnessFactories: [{ kind: "pi", create }] });
    await daemon.start();
    const socket = FakeWebSocket.instances[0];
    const first = assignmentMessage("session-ordered", "first");
    const replacement = assignmentMessage("session-ordered", "replacement");

    try {
      socket.emit("message", { data: JSON.stringify(first) });
      await waitForCondition(() => starts.length === 1, "first harness startup");

      socket.emit("message", { data: JSON.stringify(replacement) });
      await new Promise((resolve) => setImmediate(resolve));
      expect(starts).toHaveLength(1);

      starts[0].gate.resolve({
        productSessionId: first.productSessionId,
        harnessSessionId: "pi-first",
        harness: "pi",
      });
      await waitForCondition(() => starts.length === 2, "replacement harness startup");
      starts[1].gate.resolve({
        productSessionId: replacement.productSessionId,
        harnessSessionId: "pi-replacement",
        harness: "pi",
      });
      await waitForPersistedGeneration(
        new SessionStateStore(stateDir),
        replacement.productSessionId,
        replacement.sandboxId
      );

      expect(create).toHaveBeenCalledTimes(2);
      expect(daemon.activeSessionCount).toBe(1);
    } finally {
      for (const [index, start] of starts.entries()) {
        start.gate.resolve({
          productSessionId: first.productSessionId,
          harnessSessionId: `pi-cleanup-${index}`,
          harness: "pi",
        });
      }
    }
  });

  it("reserves capacity while a harness is still starting", async () => {
    alwaysWillingControlPlane();
    type CreatedSession = Awaited<ReturnType<AgentHarness["createSession"]>>;
    const gate = deferred<CreatedSession>();
    const create = vi.fn(
      (): AgentHarness => ({
        kind: "pi",
        createSession: vi.fn(() => gate.promise),
        async *sendPrompt() {
          yield { type: "turn.completed" } satisfies HarnessEvent;
        },
        async interrupt() {},
        async close() {},
      })
    );
    const daemon = makeDaemon({
      maxSessions: 1,
      harnessFactories: [{ kind: "pi", create }],
    });
    await daemon.start();
    const socket = FakeWebSocket.instances[0];
    const occupying = assignmentMessage("session-occupying");
    const rejected = assignmentMessage("session-over-capacity");

    try {
      socket.emit("message", { data: JSON.stringify(occupying) });
      await waitForCondition(() => create.mock.calls.length === 1, "reserved harness startup");
      socket.emit("message", { data: JSON.stringify(rejected) });
      await waitForCondition(
        () =>
          socket.sent.some((message) => {
            const decoded = JSON.parse(message) as { assignmentId?: string };
            return decoded.assignmentId === rejected.assignmentId;
          }),
        "capacity rejection"
      );

      expect(create).toHaveBeenCalledTimes(1);
      expect(
        socket.sent
          .map((message) => JSON.parse(message))
          .find((message) => message.assignmentId === rejected.assignmentId)
      ).toMatchObject({
        type: "session.assign_rejected",
        reason: "homestead is at capacity; retry when a session ends",
      });
    } finally {
      gate.resolve({
        productSessionId: occupying.productSessionId,
        harnessSessionId: "pi-occupying",
        harness: "pi",
      });
    }
  });

  it("keeps a replacement active when the old bridge closes late", async () => {
    alwaysWillingControlPlane();
    const stateDir = await mkdtemp(join(tmpdir(), "homestead-generation-race-"));
    stateDirs.push(stateDir);
    const store = new SessionStateStore(stateDir);
    const daemon = makeDaemon({ stateDir });
    await daemon.start();
    const socket = FakeWebSocket.instances[0];
    const oldAssignment = assignmentMessage("session-replaced", "old");
    const replacement = assignmentMessage("session-replaced", "new");

    socket.emit("message", { data: JSON.stringify(oldAssignment) });
    await waitForPersistedGeneration(
      store,
      oldAssignment.productSessionId,
      oldAssignment.sandboxId
    );

    const realMarkDormant = SessionStateStore.prototype.markDormant;
    let releaseDormancy = (): void => {};
    const dormantGate = new Promise<void>((resolve) => {
      releaseDormancy = resolve;
    });
    let finishDormancy = (): void => {};
    const dormantFinished = new Promise<void>((resolve) => {
      finishDormancy = resolve;
    });
    const markDormant = vi
      .spyOn(SessionStateStore.prototype, "markDormant")
      .mockImplementation(async function (productSessionId, expectedSandboxId) {
        if (expectedSandboxId !== oldAssignment.sandboxId) {
          return realMarkDormant.call(this, productSessionId, expectedSandboxId);
        }
        await dormantGate;
        try {
          await realMarkDormant.call(this, productSessionId, expectedSandboxId);
        } finally {
          finishDormancy();
        }
      });

    try {
      socket.emit("message", { data: JSON.stringify(replacement) });
      await waitForPersistedGeneration(store, replacement.productSessionId, replacement.sandboxId);

      expect(markDormant).toHaveBeenCalledWith(
        oldAssignment.productSessionId,
        oldAssignment.sandboxId
      );
      releaseDormancy();
      await dormantFinished;

      await expect(store.get(replacement.productSessionId)).resolves.toEqual({
        assignment: expect.objectContaining({
          assignmentId: replacement.assignmentId,
          sandboxId: replacement.sandboxId,
          workspacePath: replacement.workspacePath,
        }),
        repositories: [],
        status: "active",
      });
    } finally {
      releaseDormancy();
      markDormant.mockRestore();
    }
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
    await store.markDormant("session-expired", "generation-old");

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

  it("retries retention when one harness factory rejects cleanup", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "homestead-retention-retry-"));
    stateDirs.push(stateDir);
    const store = new SessionStateStore(stateDir);
    await store.save({
      status: "active",
      assignment: {
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-retention",
        productSessionId: "session-retention",
        sandboxId: "generation-retention",
        controlPlaneUrl: "https://control.example",
        harness: "pi",
        outpostId: "outpost-retention",
        workspacePath: "/workspace/session-retention",
      },
      repositories: [],
    });
    await store.markDormant("session-retention", "generation-retention");
    vi.setSystemTime(Date.now() + 91 * 24 * 60 * 60 * 1000);

    const piCleanup = vi
      .fn<(productSessionIds: readonly string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("cleanup unavailable"))
      .mockResolvedValue(undefined);
    const otherCleanup = vi.fn(async (_productSessionIds: readonly string[]) => {});
    const unavailable = (): AgentHarness => {
      throw new Error("dormant records must not create a harness");
    };
    const log = vi.fn();
    const daemon = makeDaemon({
      stateDir,
      log,
      harnessFactories: [
        { kind: "pi", create: unavailable, removePersistedSessions: piCleanup },
        { kind: "claude-code", create: unavailable, removePersistedSessions: otherCleanup },
      ],
    });

    await expect(daemon.start()).resolves.toBeUndefined();
    expect(piCleanup).toHaveBeenCalledWith(["session-retention"]);
    expect(otherCleanup).toHaveBeenCalledWith(["session-retention"]);
    await expect(store.get("session-retention")).resolves.toMatchObject({ status: "dormant" });
    expect(log).toHaveBeenCalledWith(
      "harness persisted-session cleanup failed; retaining recovery record",
      expect.objectContaining({ harness: "pi", error: "cleanup unavailable" })
    );

    await daemon.stop();
    await expect(daemon.start()).resolves.toBeUndefined();
    expect(piCleanup).toHaveBeenCalledTimes(2);
    expect(otherCleanup).toHaveBeenCalledTimes(2);
    await expect(store.get("session-retention")).resolves.toBeNull();
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
