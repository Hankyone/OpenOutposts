import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OUTPOST_PROTOCOL_VERSION, type SessionAssign } from "@openoutposts/outpost-protocol";

import type { AgentHarness, HarnessEvent, HarnessSessionReference, TurnRequest } from "../index.js";
import { BridgeSession, type BridgeSessionOptions } from "./bridge-session.js";

type Listener = (event: unknown) => void;

/** Stand-in for the session WebSocket the bridge opens back to the product. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.OPEN;
  readonly sent: Record<string, unknown>[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.#listeners.get(type) ?? [];
    existing.push(listener);
    this.#listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {}

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  deliver(command: unknown): void {
    this.emit("message", { data: JSON.stringify(command) });
  }
}

const originalWebSocket = globalThis.WebSocket;

const assignment: SessionAssign = {
  type: "session.assign",
  protocolVersion: OUTPOST_PROTOCOL_VERSION,
  assignmentId: "assignment-01",
  productSessionId: "session-01",
  sandboxId: "sandbox-01",
  sandboxAuthToken: "bridge-token",
  credentialFetchToken: "fetch-token",
  controlPlaneUrl: "https://control.example",
  harness: "pi",
  model: "anthropic/claude-sonnet-4-5",
  outpostId: "workstation-01",
  workspacePath: "/workspace/sessions/session-01",
};

const harnessSession: HarnessSessionReference = {
  productSessionId: "session-01",
  harnessSessionId: "pi-session-01",
  harness: "pi",
};

/** Records what each turn was actually asked to run. */
function recordingHarness() {
  const turns: TurnRequest[] = [];
  const harness: AgentHarness = {
    kind: "pi",
    createSession: () => Promise.resolve(harnessSession),
    async *sendPrompt(_session, turn) {
      turns.push(turn);
      yield { type: "turn.completed" } satisfies HarnessEvent;
    },
    interrupt: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return { harness, turns };
}

function startBridge(harness: AgentHarness, log: BridgeSessionOptions["log"] = () => {}) {
  const bridge = new BridgeSession({
    assignment,
    harness,
    harnessSession,
    log,
    onClosed: () => {},
  });
  bridge.start();
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error("the bridge opened no socket");
  socket.emit("open", {});
  socket.sent.length = 0;
  return { bridge, socket };
}

/** The bridge handles commands off the socket callback, without awaiting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function promptCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "prompt",
    messageId: "msg-1",
    content: "what changed?",
    model: "anthropic/claude-sonnet-4-5",
    reasoningEffort: "high",
    author: {
      userId: "user-1",
      gitIdentity: { mode: "attributed-user", name: "Ada", email: "ada@example.com" },
    },
    ...overrides,
  };
}

function refusal(socket: FakeWebSocket): string {
  const complete = socket.sent.find((event) => event.type === "execution_complete");
  expect(complete?.success).toBe(false);
  return String(complete?.error ?? "");
}

describe("BridgeSession prompts", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("carries the message's model, reasoning effort and author into the turn", async () => {
    const { harness, turns } = recordingHarness();
    const { socket } = startBridge(harness);

    socket.deliver(promptCommand());
    await settle();

    expect(turns).toEqual([
      {
        content: "what changed?",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
        author: {
          userId: "user-1",
          gitIdentity: { mode: "attributed-user", name: "Ada", email: "ada@example.com" },
        },
      },
    ]);
  });

  it("forwards a user stop to the active Pi harness session", async () => {
    const { harness } = recordingHarness();
    const interrupt = vi.fn().mockResolvedValue(undefined);
    harness.interrupt = interrupt;
    const { socket } = startBridge(harness);

    socket.deliver({ type: "stop" });
    await settle();

    expect(interrupt).toHaveBeenCalledWith(harnessSession);
  });

  /**
   * Changing a running session's model is a product feature; before the turn
   * carried one, the change reached the UI and the database while the
   * assignment-time model kept answering under the new model's name.
   */
  it("gives the next turn the model the user switched to", async () => {
    const { harness, turns } = recordingHarness();
    const { socket } = startBridge(harness);

    socket.deliver(promptCommand());
    await settle();
    socket.deliver(
      promptCommand({
        messageId: "msg-2",
        model: "anthropic/claude-opus-5",
        reasoningEffort: "max",
      })
    );
    await settle();

    expect(turns.map((turn) => turn.model)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-opus-5",
    ]);
    expect(turns[1]?.thinkingLevel).toBe("max");
  });

  /**
   * No operation in the outpost protocol carries bytes, so an attached image
   * cannot be given to the model. The product accepts, stores and sends them
   * regardless, and answering anyway would leave the user believing the model
   * had looked at their screenshot.
   */
  it("refuses a message with attachments and says the model was not given them", async () => {
    const { harness, turns } = recordingHarness();
    const { socket } = startBridge(harness);

    socket.deliver(
      promptCommand({
        attachments: [
          { attachmentId: "att-1", name: "screenshot.png", mimeType: "image/png" },
          { attachmentId: "att-2", name: "trace.jpg", mimeType: "image/jpeg" },
        ],
      })
    );
    await settle();

    expect(turns).toEqual([]);
    const error = refusal(socket);
    expect(error).toContain("screenshot.png");
    expect(error).toContain("trace.jpg");
    expect(error).toContain("not given them");
    // The refusal is a finished turn, not a stalled one.
    expect(socket.sent.filter((event) => event.type === "execution_complete")).toHaveLength(1);
  });

  it("refuses a reasoning effort it does not know, naming it", async () => {
    const { harness, turns } = recordingHarness();
    const { socket } = startBridge(harness);

    socket.deliver(promptCommand({ reasoningEffort: "ludicrous" }));
    await settle();

    expect(turns).toEqual([]);
    expect(refusal(socket)).toContain("ludicrous");
  });

  /**
   * A field the control plane sends and the homestead does not understand is the
   * shape of this whole defect. It stops the turn instead of being discarded.
   */
  it("refuses a prompt carrying a field this homestead does not understand", async () => {
    const { harness, turns } = recordingHarness();
    const { socket } = startBridge(harness);

    socket.deliver(promptCommand({ toolPolicy: "unrestricted" }));
    await settle();

    expect(turns).toEqual([]);
    expect(refusal(socket)).toContain("toolPolicy");
  });

  it("runs a prompt that carries neither model nor effort", async () => {
    const { harness, turns } = recordingHarness();
    const { socket } = startBridge(harness);

    socket.deliver({ type: "prompt", messageId: "msg-1", content: "hello" });
    await settle();

    expect(turns).toEqual([{ content: "hello" }]);
  });
});

/** A harness that plays a fixed script of events for its one turn. */
function scriptedHarness(events: HarnessEvent[]): AgentHarness {
  return {
    kind: "pi",
    createSession: () => Promise.resolve(harnessSession),
    async *sendPrompt() {
      for (const event of events) yield event;
    },
    interrupt: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

describe("BridgeSession event delivery", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    // Date stays real: these tests assert on the timestamps events carry.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  /** Drops the bridge and lets it come back on the socket it opens next. */
  async function reconnect(socket: FakeWebSocket): Promise<FakeWebSocket> {
    socket.emit("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeWebSocket.instances.at(-1);
    if (!next || next === socket) throw new Error("the bridge did not reconnect");
    next.emit("open", {});
    return next;
  }

  /**
   * A disconnect used to erase everything the turn produced during it: only
   * ack-carrying events survived, and the assistant's answer and every tool
   * call in the gap were gone from the live view and from storage alike.
   */
  it("replays a turn's events in order when the bridge reconnects mid-turn", async () => {
    const { socket } = startBridge(
      scriptedHarness([
        { type: "assistant.delta", text: "Hel" },
        { type: "assistant.delta", text: "lo" },
        {
          type: "tool.started",
          toolCallId: "call-1",
          name: "outpost_bash",
          input: { command: "ls" },
        },
        { type: "tool.completed", toolCallId: "call-1", output: "file.txt", isError: false },
        { type: "turn.completed" },
      ])
    );

    socket.readyState = FakeWebSocket.CLOSED;
    socket.deliver(promptCommand());
    await settle();
    expect(socket.sent).toEqual([]);

    const next = await reconnect(socket);

    expect(next.sent.map((event) => event.type)).toEqual([
      "ready",
      "step_start",
      "token",
      "tool_call",
      "tool_call",
      "step_finish",
      "execution_complete",
    ]);
    // A critical event is held in two places; it must still be delivered once.
    expect(next.sent.filter((event) => event.type === "execution_complete")).toHaveLength(1);
  });

  it("collapses superseded token events instead of queueing every one", async () => {
    const deltas: HarnessEvent[] = Array.from({ length: 200 }, () => ({
      type: "assistant.delta" as const,
      text: "x",
    }));
    const { socket } = startBridge(scriptedHarness([...deltas, { type: "turn.completed" }]));

    socket.readyState = FakeWebSocket.CLOSED;
    socket.deliver(promptCommand());
    await settle();
    const next = await reconnect(socket);

    const tokens = next.sent.filter((event) => event.type === "token");
    expect(tokens).toHaveLength(1);
    // Cumulative content: the surviving event says everything the dropped ones did.
    expect(tokens[0]?.content).toBe("x".repeat(200));
  });

  it("tells the user about the gap when the buffer overflows", async () => {
    const calls: HarnessEvent[] = Array.from({ length: 600 }, (_value, index) => ({
      type: "tool.started" as const,
      toolCallId: `call-${index}`,
      name: "outpost_bash",
      input: {},
    }));
    const { socket } = startBridge(scriptedHarness([...calls, { type: "turn.completed" }]));

    socket.readyState = FakeWebSocket.CLOSED;
    socket.deliver(promptCommand());
    await settle();
    const next = await reconnect(socket);

    const gap = next.sent.find((event) => event.type === "error");
    expect(gap).toBeDefined();
    expect(gap?.messageId).toBe("msg-1");
    expect(String(gap?.error)).toContain("could not be held");
    // The gap marker leads the replay, so the transcript reads in order.
    expect(next.sent.indexOf(gap as Record<string, unknown>)).toBe(1);
    // What survived still ends the turn.
    expect(next.sent.filter((event) => event.type === "execution_complete")).toHaveLength(1);
  });

  /**
   * The control plane records event times in seconds and the web client
   * multiplies by 1000 to render them. Milliseconds here dated every event the
   * agent produced roughly 55,000 years into the future.
   */
  it("stamps events in seconds, not milliseconds", async () => {
    const { socket } = startBridge(scriptedHarness([{ type: "turn.completed" }]));

    socket.deliver(promptCommand());
    await settle();

    const nowSeconds = Date.now() / 1000;
    expect(socket.sent.length).toBeGreaterThan(0);
    for (const event of socket.sent) {
      expect(typeof event.timestamp).toBe("number");
      expect(Math.abs((event.timestamp as number) - nowSeconds)).toBeLessThan(5);
    }
  });

  /**
   * `snapshot_ready` is not a member of the control plane's event union, so the
   * reply was dropped on arrival — and because it carried an ack id it was
   * refiled and re-sent on every reconnect for the life of the session.
   */
  it("ignores a snapshot command instead of replying with an event nothing reads", async () => {
    const { socket } = startBridge(scriptedHarness([{ type: "turn.completed" }]));

    socket.deliver({ type: "snapshot" });
    await settle();
    expect(socket.sent).toEqual([]);

    const next = await reconnect(socket);
    expect(next.sent.map((event) => event.type)).toEqual(["ready"]);
  });
});
