import type { HarnessEvent } from "../index.js";
import { PiEventTranslator } from "./events.js";

/** Longest a turn may go without producing any event before it is failed. */
export const PROMPT_INACTIVITY_TIMEOUT_MS = 300_000;
/**
 * Pi's `prompt()` resolves at, or a beat before, the terminal `agent_settled`
 * event. This is how long to wait for that event once the promise has settled
 * before synthesising a terminal event.
 */
export const TERMINAL_GRACE_MS = 250;

/** The part of Pi's AgentSession a single turn needs. */
export interface PromptableSession {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
}

export interface StreamTurnOptions {
  inactivityTimeoutMs?: number;
  terminalGraceMs?: number;
}

/**
 * Runs one turn and yields harness events until exactly one terminal event.
 *
 * Pi delivers everything, including failures, through the subscription and
 * resolves `prompt()` normally even when the run failed — so a rejection from
 * `prompt()` means the turn never started (no model, no credential) rather
 * than that it failed.
 */
export async function* streamTurn(
  session: PromptableSession,
  prompt: string,
  options: StreamTurnOptions = {}
): AsyncIterable<HarnessEvent> {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? PROMPT_INACTIVITY_TIMEOUT_MS;
  const terminalGraceMs = options.terminalGraceMs ?? TERMINAL_GRACE_MS;
  const translator = new PiEventTranslator();
  const pending: HarnessEvent[] = [];
  let wake: (() => void) | null = null;

  const unsubscribe = session.subscribe((event) => {
    pending.push(...translator.translate(event as Record<string, unknown>));
    wake?.();
  });

  // The run state lives in an object because it is written from a callback.
  const run: { settled: boolean; error: string | null } = { settled: false, error: null };
  // The catch is attached immediately so an early rejection can never escape
  // as an unhandled rejection, even if the consumer abandons the iterator.
  void session
    .prompt(prompt)
    .catch((error: unknown) => {
      run.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      run.settled = true;
      wake?.();
    });

  try {
    for (;;) {
      while (pending.length > 0) {
        const event = pending.shift() as HarnessEvent;
        yield event;
        if (event.type === "turn.completed" || event.type === "turn.failed") return;
      }

      const woken = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(
          () => resolve(false),
          run.settled ? terminalGraceMs : inactivityTimeoutMs
        );
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve(true);
        };
      });
      if (woken) continue;

      // A turn that never reached `agent_settled` still spent everything it
      // spent, so the terminal event synthesised here carries the totals the
      // translator has accumulated rather than reporting the turn as free.
      const usage = translator.usage();
      const carried = usage === undefined ? {} : { usage };
      if (run.settled) {
        yield run.error === null
          ? { type: "turn.completed", ...carried }
          : { type: "turn.failed", message: run.error, ...carried };
        return;
      }
      yield {
        type: "turn.failed",
        message: `Pi produced no events for ${inactivityTimeoutMs / 1000}s`,
        ...carried,
      };
      return;
    }
  } finally {
    wake = null;
    unsubscribe();
  }
}
