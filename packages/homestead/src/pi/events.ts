import type { HarnessEvent, HarnessTurnUsage } from "../index.js";

/**
 * Translates Pi's session event stream into harness-neutral events for one
 * turn.
 *
 * Pi emits true incremental deltas rather than growing snapshots, so this
 * translator keeps no per-part length bookkeeping. Two shapes of the stream do
 * need care:
 *
 * - `turn_end` fires once per LLM round trip, not once per user turn. A turn
 *   with tool calls emits several, so the terminal event is `agent_settled`.
 * - Tool calls run in parallel, so tool state is keyed by tool call id.
 *
 * Failures arrive attached to the assistant message *before* the terminal
 * events, so the translator records the last stop reason and decides between
 * completion and failure when the turn settles. That also means a failure Pi
 * intends to retry does not end the turn early.
 */

interface PiAssistantMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: unknown;
}

/** Pi's per-message usage record, as it arrives on the wire. */
interface PiUsage {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown };
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export class PiEventTranslator {
  #failureMessage: string | null = null;
  readonly #startedToolCalls = new Set<string>();
  #usage = emptyUsage();
  #sawUsage = false;
  /**
   * Pi delivers the same assistant message object on both `message_end` and
   * `turn_end`. Counting by object identity is what keeps one round trip's
   * tokens from being billed twice, whichever of the two arrives.
   */
  readonly #countedMessages = new WeakSet<object>();

  translate(event: Record<string, unknown>): HarnessEvent[] {
    const type = event.type;

    if (type === "message_update") {
      const inner = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
      const delta = typeof inner.delta === "string" ? inner.delta : "";
      if (delta === "") return [];
      if (inner.type === "text_delta") return [{ type: "assistant.delta", text: delta }];
      if (inner.type === "thinking_delta") return [{ type: "reasoning.delta", text: delta }];
      return [];
    }

    if (type === "tool_execution_start") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!toolCallId || this.#startedToolCalls.has(toolCallId)) return [];
      this.#startedToolCalls.add(toolCallId);
      return [
        {
          type: "tool.started",
          toolCallId,
          name: typeof event.toolName === "string" ? event.toolName : "unknown",
          input: event.args,
        },
      ];
    }

    if (type === "tool_execution_end") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!toolCallId) return [];
      this.#startedToolCalls.delete(toolCallId);
      return [
        {
          type: "tool.completed",
          toolCallId,
          output: event.result,
          isError: event.isError === true,
        },
      ];
    }

    if (type === "message_end" || type === "turn_end") {
      this.#recordOutcome(event.message as PiAssistantMessage | undefined);
      this.#recordUsage(event.message);
      return [];
    }

    if (type === "agent_settled") {
      const message = this.#failureMessage;
      const usage = this.usage();
      this.#failureMessage = null;
      this.#startedToolCalls.clear();
      this.#usage = emptyUsage();
      this.#sawUsage = false;
      const carried = usage === undefined ? {} : { usage };
      return message === null
        ? [{ type: "turn.completed", ...carried }]
        : [{ type: "turn.failed", message, ...carried }];
    }

    return [];
  }

  /**
   * What the turn has consumed so far. Read by the turn runner when it has to
   * synthesise a terminal event, which happens when Pi's own `agent_settled`
   * never arrives and would otherwise take the turn's whole cost with it.
   */
  usage(): HarnessTurnUsage | undefined {
    if (!this.#sawUsage) return undefined;
    const totals = this.#usage;
    return {
      // Pi prices every message from its own model table and reports zero for a
      // model it has no price for. Zero is therefore "unpriced", not "free",
      // and is reported as no cost figure at all.
      ...(totals.cost > 0 ? { cost: totals.cost } : {}),
      input: totals.input,
      output: totals.output,
      ...(totals.reasoning > 0 ? { reasoning: totals.reasoning } : {}),
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      total: totals.total,
    };
  }

  /** Adds one assistant message's tokens and price to the turn's running total. */
  #recordUsage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const assistant = message as PiAssistantMessage;
    if (assistant.role !== "assistant") return;
    if (this.#countedMessages.has(message)) return;
    this.#countedMessages.add(message);
    const usage = assistant.usage;
    if (typeof usage !== "object" || usage === null) return;
    const reported = usage as PiUsage;
    this.#sawUsage = true;
    this.#usage.input += positiveNumber(reported.input);
    this.#usage.output += positiveNumber(reported.output);
    this.#usage.reasoning += positiveNumber(reported.reasoning);
    this.#usage.cacheRead += positiveNumber(reported.cacheRead);
    this.#usage.cacheWrite += positiveNumber(reported.cacheWrite);
    this.#usage.total += positiveNumber(reported.totalTokens);
    this.#usage.cost += positiveNumber(reported.cost?.total);
  }

  /**
   * Remembers whether the most recent assistant message ended in an error. A
   * later clean message clears it, so a failed round trip Pi recovered from
   * does not fail the whole turn.
   */
  #recordOutcome(message: PiAssistantMessage | undefined): void {
    if (!message || message.role !== "assistant") return;
    if (message.stopReason === "error") {
      this.#failureMessage =
        typeof message.errorMessage === "string" && message.errorMessage !== ""
          ? message.errorMessage
          : "The model run failed";
      return;
    }
    // An aborted turn is a cancellation, not a failure: it is reported as a
    // completed turn so the product session returns to idle cleanly.
    this.#failureMessage = null;
  }
}

interface UsageTotals {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

function emptyUsage(): UsageTotals {
  return { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
