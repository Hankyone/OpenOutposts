import type { HarnessEvent, HarnessTurnUsage } from "../index.js";

/**
 * Sandbox-bridge wire events for one prompt turn. The session Durable Object
 * expects cumulative `token` content (not deltas), `tool_call` lifecycle
 * updates keyed by callId, and a critical `execution_complete` carrying a
 * deterministic ackId.
 */
export type BridgeEvent = Record<string, unknown> & { type: string };

/**
 * The `cost` and `tokens` halves of a `step_finish`, in the wire's own shape.
 * The session's running total is fed from these and reads zero for as long as
 * they are missing.
 */
function usageFields(usage: HarnessTurnUsage | undefined): Record<string, unknown> {
  if (usage === undefined) return {};
  return {
    ...(usage.cost === undefined ? {} : { cost: usage.cost }),
    tokens: {
      total: usage.total,
      input: usage.input,
      output: usage.output,
      ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
      cache: { read: usage.cacheRead, write: usage.cacheWrite },
    },
  };
}

export class BridgeTurnTranslator {
  readonly #messageId: string;
  #assistantText = "";
  readonly #toolNames = new Map<string, string>();
  readonly #toolArgs = new Map<string, unknown>();

  constructor(messageId: string) {
    this.#messageId = messageId;
  }

  start(): BridgeEvent[] {
    return [{ type: "step_start", messageId: this.#messageId }];
  }

  translate(event: HarnessEvent): BridgeEvent[] {
    switch (event.type) {
      case "assistant.delta": {
        this.#assistantText += event.text;
        return [{ type: "token", content: this.#assistantText, messageId: this.#messageId }];
      }
      case "reasoning.delta":
        // The bridge wire has no distinct reasoning channel.
        return [];
      case "tool.started": {
        this.#toolNames.set(event.toolCallId, event.name);
        this.#toolArgs.set(event.toolCallId, event.input ?? {});
        return [
          {
            type: "tool_call",
            tool: event.name,
            args: event.input ?? {},
            callId: event.toolCallId,
            status: "running",
            output: "",
            messageId: this.#messageId,
          },
        ];
      }
      case "tool.completed": {
        return [
          {
            type: "tool_call",
            tool: this.#toolNames.get(event.toolCallId) ?? "unknown",
            args: this.#toolArgs.get(event.toolCallId) ?? {},
            callId: event.toolCallId,
            status: event.isError ? "error" : "completed",
            output: typeof event.output === "string" ? event.output : JSON.stringify(event.output),
            messageId: this.#messageId,
          },
        ];
      }
      case "turn.completed": {
        return [
          { type: "step_finish", messageId: this.#messageId, ...usageFields(event.usage) },
          {
            type: "execution_complete",
            messageId: this.#messageId,
            success: true,
            ackId: `execution_complete:${this.#messageId}`,
          },
        ];
      }
      case "turn.failed": {
        // A turn that failed part-way still spent what it spent, so its
        // accounting event goes out too — but only when there is something to
        // report, since a turn refused before it started spent nothing.
        const usage = usageFields(event.usage);
        return [
          ...(event.usage === undefined
            ? []
            : [{ type: "step_finish", messageId: this.#messageId, ...usage }]),
          { type: "error", error: event.message, messageId: this.#messageId },
          {
            type: "execution_complete",
            messageId: this.#messageId,
            success: false,
            error: event.message,
            ackId: `execution_complete:${this.#messageId}`,
          },
        ];
      }
      case "approval.requested":
        return [];
    }
  }
}
