import { describe, expect, it } from "vitest";

import { PiEventTranslator } from "./events.js";

const assistantMessage = (
  stopReason: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  role: "assistant",
  content: [],
  stopReason,
  ...extra,
});

describe("PiEventTranslator", () => {
  it("passes Pi's incremental text and thinking deltas straight through", () => {
    const translator = new PiEventTranslator();
    const delta = (type: string, value: string) => ({
      type: "message_update",
      assistantMessageEvent: { type, delta: value, contentIndex: 0 },
      message: assistantMessage("stop"),
    });

    expect(translator.translate(delta("thinking_delta", "hmm"))).toEqual([
      { type: "reasoning.delta", text: "hmm" },
    ]);
    expect(translator.translate(delta("text_delta", "Hel"))).toEqual([
      { type: "assistant.delta", text: "Hel" },
    ]);
    // True deltas, not growing snapshots: no per-part bookkeeping needed.
    expect(translator.translate(delta("text_delta", "lo"))).toEqual([
      { type: "assistant.delta", text: "lo" },
    ]);
  });

  it("ignores the start/end bracket events and empty deltas", () => {
    const translator = new PiEventTranslator();
    for (const type of ["text_start", "text_end", "thinking_start", "thinking_end"]) {
      expect(
        translator.translate({
          type: "message_update",
          assistantMessageEvent: { type, contentIndex: 0 },
        })
      ).toEqual([]);
    }
    expect(
      translator.translate({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "" },
      })
    ).toEqual([]);
  });

  it("never echoes the user's own message", () => {
    const translator = new PiEventTranslator();
    const userMessage = { role: "user", content: [{ type: "text", text: "my prompt" }] };
    expect(translator.translate({ type: "message_start", message: userMessage })).toEqual([]);
    expect(translator.translate({ type: "message_end", message: userMessage })).toEqual([]);
  });

  // Pi runs tool calls in parallel: two can start before either ends, so state
  // must be keyed by tool call id and never by position.
  it("tracks interleaved parallel tool calls by id", () => {
    const translator = new PiEventTranslator();
    expect(
      translator.translate({
        type: "tool_execution_start",
        toolCallId: "call_a",
        toolName: "outpost_ls",
        args: { path: "." },
      })
    ).toEqual([
      { type: "tool.started", toolCallId: "call_a", name: "outpost_ls", input: { path: "." } },
    ]);
    expect(
      translator.translate({
        type: "tool_execution_start",
        toolCallId: "call_b",
        toolName: "outpost_read",
        args: { path: "README.md" },
      })
    ).toEqual([
      {
        type: "tool.started",
        toolCallId: "call_b",
        name: "outpost_read",
        input: { path: "README.md" },
      },
    ]);
    expect(
      translator.translate({
        type: "tool_execution_end",
        toolCallId: "call_b",
        toolName: "outpost_read",
        result: { content: [{ type: "text", text: "# demo" }] },
        isError: false,
      })
    ).toEqual([
      {
        type: "tool.completed",
        toolCallId: "call_b",
        output: { content: [{ type: "text", text: "# demo" }] },
        isError: false,
      },
    ]);
    expect(
      translator.translate({
        type: "tool_execution_end",
        toolCallId: "call_a",
        toolName: "outpost_ls",
        result: { content: [] },
        isError: true,
      })
    ).toEqual([
      { type: "tool.completed", toolCallId: "call_a", output: { content: [] }, isError: true },
    ]);
  });

  // turn_end fires once per LLM round trip, not once per user turn. Mapping it
  // to turn completion would report the turn finished with tool calls pending.
  it("completes the turn only when the agent settles", () => {
    const translator = new PiEventTranslator();
    expect(
      translator.translate({ type: "turn_end", message: assistantMessage("toolUse") })
    ).toEqual([]);
    expect(translator.translate({ type: "agent_end", messages: [] })).toEqual([]);
    expect(translator.translate({ type: "agent_settled" })).toEqual([{ type: "turn.completed" }]);
  });

  it("fails the turn with the error the failing message carried", () => {
    const translator = new PiEventTranslator();
    translator.translate({
      type: "message_end",
      message: assistantMessage("error", { errorMessage: "401 no credit balance" }),
    });
    expect(translator.translate({ type: "agent_settled" })).toEqual([
      { type: "turn.failed", message: "401 no credit balance" },
    ]);
  });

  it("does not fail the turn for a round trip the agent recovered from", () => {
    const translator = new PiEventTranslator();
    translator.translate({
      type: "turn_end",
      message: assistantMessage("error", { errorMessage: "transient" }),
    });
    translator.translate({ type: "turn_end", message: assistantMessage("stop") });
    expect(translator.translate({ type: "agent_settled" })).toEqual([{ type: "turn.completed" }]);
  });

  it("treats an aborted turn as completed, not failed", () => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "turn_end", message: assistantMessage("aborted") });
    expect(translator.translate({ type: "agent_settled" })).toEqual([{ type: "turn.completed" }]);
  });

  /**
   * Cost and token counts feed the session's running total, which read zero for
   * every session until the harness carried what Pi reports.
   */
  describe("usage accounting", () => {
    const usage = (input: number, output: number, cost: number): Record<string, unknown> => ({
      input,
      output,
      cacheRead: 1,
      cacheWrite: 2,
      reasoning: 3,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    });

    it("sums every round trip the turn took", () => {
      const translator = new PiEventTranslator();
      translator.translate({
        type: "message_end",
        message: assistantMessage("toolUse", { usage: usage(100, 20, 0.5) }),
      });
      translator.translate({
        type: "message_end",
        message: assistantMessage("stop", { usage: usage(300, 40, 1.25) }),
      });

      expect(translator.translate({ type: "agent_settled" })).toEqual([
        {
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
        },
      ]);
    });

    // Pi delivers one assistant message on both message_end and turn_end.
    it("counts a message once when it arrives on two events", () => {
      const translator = new PiEventTranslator();
      const message = assistantMessage("stop", { usage: usage(10, 5, 0.25) });
      translator.translate({ type: "turn_end", message });
      translator.translate({ type: "message_end", message });

      const settled = translator.translate({ type: "agent_settled" });
      expect(settled[0]).toMatchObject({ usage: { input: 10, output: 5, cost: 0.25 } });
    });

    it("reports a failed turn's spend too", () => {
      const translator = new PiEventTranslator();
      translator.translate({
        type: "message_end",
        message: assistantMessage("error", { errorMessage: "boom", usage: usage(10, 5, 0.25) }),
      });

      expect(translator.translate({ type: "agent_settled" })).toEqual([
        {
          type: "turn.failed",
          message: "boom",
          usage: {
            cost: 0.25,
            input: 10,
            output: 5,
            reasoning: 3,
            cacheRead: 1,
            cacheWrite: 2,
            total: 15,
          },
        },
      ]);
    });

    // Pi prices from its own model table and reports zero for a model it has no
    // price for, which is not the same as a turn that was free.
    it("leaves cost absent when the model has no price, keeping the token counts", () => {
      const translator = new PiEventTranslator();
      translator.translate({
        type: "message_end",
        message: assistantMessage("stop", { usage: usage(10, 5, 0) }),
      });

      const settled = translator.translate({ type: "agent_settled" });
      expect(settled[0]).toMatchObject({ usage: { input: 10, total: 15 } });
      expect((settled[0] as { usage: Record<string, unknown> }).usage.cost).toBeUndefined();
    });

    it("starts the next turn's accounting from nothing", () => {
      const translator = new PiEventTranslator();
      translator.translate({
        type: "message_end",
        message: assistantMessage("stop", { usage: usage(10, 5, 0.25) }),
      });
      translator.translate({ type: "agent_settled" });

      expect(translator.translate({ type: "agent_settled" })).toEqual([{ type: "turn.completed" }]);
    });
  });

  it("emits exactly one terminal event per turn", () => {
    const translator = new PiEventTranslator();
    translator.translate({
      type: "message_end",
      message: assistantMessage("error", { errorMessage: "boom" }),
    });
    expect(translator.translate({ type: "agent_settled" })).toEqual([
      { type: "turn.failed", message: "boom" },
    ]);
    // The next turn starts clean rather than inheriting the previous failure.
    expect(translator.translate({ type: "agent_settled" })).toEqual([{ type: "turn.completed" }]);
  });
});
