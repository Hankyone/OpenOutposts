import { describe, expect, it } from "vitest";

import { BridgeTurnTranslator } from "./bridge-events.js";

describe("BridgeTurnTranslator", () => {
  it("emits cumulative token content, not deltas", () => {
    const translator = new BridgeTurnTranslator("msg-1");
    expect(translator.translate({ type: "assistant.delta", text: "Hel" })).toEqual([
      { type: "token", content: "Hel", messageId: "msg-1" },
    ]);
    expect(translator.translate({ type: "assistant.delta", text: "lo" })).toEqual([
      { type: "token", content: "Hello", messageId: "msg-1" },
    ]);
  });

  it("tracks tool names and args across the call lifecycle", () => {
    const translator = new BridgeTurnTranslator("msg-1");
    translator.translate({
      type: "tool.started",
      toolCallId: "call-1",
      name: "remote_bash",
      input: { command: "ls" },
    });
    const completed = translator.translate({
      type: "tool.completed",
      toolCallId: "call-1",
      output: "file.txt",
      isError: false,
    });
    expect(completed).toEqual([
      {
        type: "tool_call",
        tool: "remote_bash",
        args: { command: "ls" },
        callId: "call-1",
        status: "completed",
        output: "file.txt",
        messageId: "msg-1",
      },
    ]);
  });

  it("finishes a successful turn with a deterministic critical ack id", () => {
    const translator = new BridgeTurnTranslator("msg-9");
    expect(translator.translate({ type: "turn.completed" })).toEqual([
      { type: "step_finish", messageId: "msg-9" },
      {
        type: "execution_complete",
        messageId: "msg-9",
        success: true,
        ackId: "execution_complete:msg-9",
      },
    ]);
  });

  it("reports failures as an error event plus a failed completion", () => {
    const translator = new BridgeTurnTranslator("msg-9");
    const events = translator.translate({ type: "turn.failed", message: "boom" });
    expect(events[0]).toEqual({ type: "error", error: "boom", messageId: "msg-9" });
    expect(events[1]).toMatchObject({
      type: "execution_complete",
      success: false,
      error: "boom",
    });
  });

  /**
   * `step_finish` is where the session's running cost comes from. Sending it
   * bare left `total_cost` at zero for every session the product ever ran.
   */
  it("carries the turn's cost and token counts into step_finish", () => {
    const translator = new BridgeTurnTranslator("msg-9");
    const events = translator.translate({
      type: "turn.completed",
      usage: {
        cost: 1.75,
        input: 400,
        output: 60,
        reasoning: 6,
        cacheRead: 2,
        cacheWrite: 4,
        total: 460,
      },
    });

    expect(events[0]).toEqual({
      type: "step_finish",
      messageId: "msg-9",
      cost: 1.75,
      tokens: {
        total: 460,
        input: 400,
        output: 60,
        reasoning: 6,
        cache: { read: 2, write: 4 },
      },
    });
  });

  it("reports token counts with no cost when the harness could not price the turn", () => {
    const translator = new BridgeTurnTranslator("msg-9");
    const events = translator.translate({
      type: "turn.completed",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    });

    expect(events[0]).toEqual({
      type: "step_finish",
      messageId: "msg-9",
      tokens: { total: 15, input: 10, output: 5, cache: { read: 0, write: 0 } },
    });
  });

  it("accounts for a turn that failed part-way", () => {
    const translator = new BridgeTurnTranslator("msg-9");
    const events = translator.translate({
      type: "turn.failed",
      message: "boom",
      usage: { cost: 0.25, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    });

    expect(events[0]).toMatchObject({ type: "step_finish", cost: 0.25 });
    expect(events[1]).toMatchObject({ type: "error", error: "boom" });
    expect(events[2]).toMatchObject({ type: "execution_complete", success: false });
  });

  it("drops reasoning, which has no bridge wire type", () => {
    const translator = new BridgeTurnTranslator("msg-1");
    expect(translator.translate({ type: "reasoning.delta", text: "thinking" })).toEqual([]);
  });
});
