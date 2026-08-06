import { describe, expect, it } from "vitest";

import type { HarnessEvent } from "../index.js";
import { streamTurn, type PromptableSession } from "./turn.js";

/**
 * A stand-in for Pi's AgentSession: `prompt()` hands control back to the test,
 * which then emits events the way Pi would.
 */
class FakeSession implements PromptableSession {
  #listeners: ((event: unknown) => void)[] = [];
  #resolvePrompt: (() => void) | null = null;
  #rejectPrompt: ((error: Error) => void) | null = null;
  promptedWith: string | null = null;
  unsubscribed = false;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.unsubscribed = true;
      this.#listeners = this.#listeners.filter((candidate) => candidate !== listener);
    };
  }

  prompt(text: string): Promise<void> {
    this.promptedWith = text;
    return new Promise<void>((resolve, reject) => {
      this.#resolvePrompt = resolve;
      this.#rejectPrompt = reject;
    });
  }

  emit(event: Record<string, unknown>): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  finishPrompt(): void {
    this.#resolvePrompt?.();
  }

  failPrompt(message: string): void {
    this.#rejectPrompt?.(new Error(message));
  }
}

const assistantMessage = (stopReason: string, errorMessage?: string) => ({
  role: "assistant",
  content: [],
  stopReason,
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("streamTurn", () => {
  it("streams a full turn and stops at the terminal event", async () => {
    const session = new FakeSession();
    const collected = collect(streamTurn(session, "do the thing"));

    // Let the generator subscribe before Pi starts emitting.
    await Promise.resolve();
    expect(session.promptedWith).toBe("do the thing");

    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "on it" },
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "outpost_ls",
      args: {},
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "outpost_ls",
      result: { content: [] },
      isError: false,
    });
    session.emit({ type: "turn_end", message: assistantMessage("stop") });
    session.emit({ type: "agent_settled" });
    // Anything after the terminal event must not reach the consumer.
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "late" },
    });
    session.finishPrompt();

    expect(await collected).toEqual([
      { type: "assistant.delta", text: "on it" },
      { type: "tool.started", toolCallId: "c1", name: "outpost_ls", input: {} },
      { type: "tool.completed", toolCallId: "c1", output: { content: [] }, isError: false },
      { type: "turn.completed" },
    ]);
    expect(session.unsubscribed).toBe(true);
  });

  it("reports the failure Pi attached to the message", async () => {
    const session = new FakeSession();
    const collected = collect(streamTurn(session, "hi"));
    await Promise.resolve();

    session.emit({ type: "message_end", message: assistantMessage("error", "401 unauthorized") });
    session.emit({ type: "agent_settled" });
    session.finishPrompt();

    expect(await collected).toEqual([{ type: "turn.failed", message: "401 unauthorized" }]);
  });

  // Pi resolves prompt() on provider failure, tool failure, and abort, so a
  // rejection means the turn was refused before it started.
  it("fails the turn when the prompt is refused outright", async () => {
    const session = new FakeSession();
    const collected = collect(streamTurn(session, "hi", { terminalGraceMs: 5 }));
    await Promise.resolve();

    session.failPrompt("No API key available");

    expect(await collected).toEqual([{ type: "turn.failed", message: "No API key available" }]);
  });

  // agent_settled is the real terminal event; if it never arrives the turn
  // must still end rather than hanging the product session forever.
  it("completes the turn if the run settles without a terminal event", async () => {
    const session = new FakeSession();
    const collected = collect(streamTurn(session, "hi", { terminalGraceMs: 5 }));
    await Promise.resolve();

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "done" },
    });
    session.finishPrompt();

    expect(await collected).toEqual([
      { type: "assistant.delta", text: "done" },
      { type: "turn.completed" },
    ]);
  });

  it("fails the turn when Pi goes silent", async () => {
    const session = new FakeSession();
    const collected = collect(
      streamTurn(session, "hi", { inactivityTimeoutMs: 10, terminalGraceMs: 5 })
    );
    expect(await collected).toEqual([
      { type: "turn.failed", message: "Pi produced no events for 0.01s" },
    ]);
  });

  /**
   * A turn that ends without `agent_settled` still spent whatever it spent, so
   * the synthesised terminal event has to carry the totals rather than report
   * the turn as free.
   */
  it("keeps the turn's usage on a synthesised terminal event", async () => {
    const session = new FakeSession();
    const collected = collect(streamTurn(session, "hi", { terminalGraceMs: 5 }));
    await Promise.resolve();

    session.emit({
      type: "message_end",
      message: {
        ...assistantMessage("stop"),
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { total: 0.25 },
        },
      },
    });
    session.finishPrompt();

    const events = await collected;
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      usage: { cost: 0.25, input: 10, output: 5, total: 15 },
    });
  });

  it("unsubscribes when the consumer abandons the turn early", async () => {
    const session = new FakeSession();
    const turn = streamTurn(session, "hi")[Symbol.asyncIterator]();
    // The generator body does not run until the first next(); subscription
    // happens synchronously inside that call.
    const first = turn.next();
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    });
    expect(await first).toEqual({
      value: { type: "assistant.delta", text: "partial" },
      done: false,
    });

    await turn.return?.(undefined);
    expect(session.unsubscribed).toBe(true);
  });
});
