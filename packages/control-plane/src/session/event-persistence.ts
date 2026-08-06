/**
 * What the SessionDO keeps of a session's transcript, and what it lets go.
 *
 * A session is open-ended: it can run for months, wake and sleep, and produce
 * tool output the whole time. The events table was an archive with no ceiling,
 * so a long session's SQLite database grew without limit and its replay got
 * slower with every turn. This module makes it a bounded record instead, in
 * two independent ways:
 *
 * 1. One oversized event is trimmed before it is stored, keeping its head and
 *    saying plainly that the rest was dropped.
 * 2. Many ordinary events are pruned oldest-first once the table passes a
 *    generous budget, so the tail of the session always survives.
 *
 * Both apply to storage only. What is broadcast to connected clients is the
 * event as it arrived: a user watching a command run should see everything it
 * printed, and only the copy that has to last forever is bounded.
 */

import type { SandboxEvent } from "../types";

export function shouldPersistToolCallEvent(status: string | null | undefined): boolean {
  const normalizedStatus = typeof status === "string" ? status.trim() : status;
  return (
    normalizedStatus == null ||
    normalizedStatus === "" ||
    normalizedStatus === "completed" ||
    normalizedStatus === "error"
  );
}

/**
 * Largest stored payload for one event.
 *
 * The outpost worker already caps what it sends: 700 KB of stdout, 100 KB of
 * stderr, 256 KB per file read. 64 KB keeps the part of an output anybody
 * reads later — the head, where the command names what it did or how it
 * failed — while making a single event unable to dominate the session's whole
 * budget.
 */
export const DEFAULT_EVENT_PAYLOAD_MAX_BYTES = 65_536;

/**
 * How many events one session's transcript keeps.
 *
 * A busy session runs a few thousand events; twenty thousand is roughly an
 * order of magnitude beyond that, so pruning is something an unusually long
 * session meets and an ordinary one never does.
 */
export const DEFAULT_EVENTS_MAX_COUNT = 20_000;

/**
 * How many bytes of stored payload one session's transcript keeps.
 *
 * Typical sessions land between half a megabyte and two; fifty megabytes is
 * twenty five to a hundred times that. It is a ceiling on the pathological
 * case, not a budget an ordinary session is expected to spend.
 */
export const DEFAULT_EVENTS_MAX_BYTES = 50 * 1024 * 1024;

export interface EventRetentionConfig {
  /** Per-event payload ceiling; a larger event is trimmed before storage. */
  eventPayloadMaxBytes: number;
  /** Rows kept before the oldest are pruned. */
  eventsMaxCount: number;
  /** Stored payload bytes kept before the oldest are pruned. */
  eventsMaxBytes: number;
}

export const DEFAULT_EVENT_RETENTION: EventRetentionConfig = {
  eventPayloadMaxBytes: DEFAULT_EVENT_PAYLOAD_MAX_BYTES,
  eventsMaxCount: DEFAULT_EVENTS_MAX_COUNT,
  eventsMaxBytes: DEFAULT_EVENTS_MAX_BYTES,
};

/** The environment shape this policy reads. */
export interface EventRetentionEnv {
  SESSION_EVENT_PAYLOAD_MAX_BYTES?: string;
  SESSION_EVENTS_MAX_COUNT?: string;
  SESSION_EVENTS_MAX_BYTES?: string;
}

/**
 * Reads the retention budgets from the environment.
 *
 * A value that is absent, unparseable, or not a positive whole number falls
 * back to the default rather than failing: these are operational dials on a
 * path that writes a user's transcript, and a typo in one of them must not be
 * able to stop a session from recording what happened.
 */
export function resolveEventRetentionConfig(env: EventRetentionEnv): EventRetentionConfig {
  return {
    eventPayloadMaxBytes: positiveInteger(
      env.SESSION_EVENT_PAYLOAD_MAX_BYTES,
      DEFAULT_EVENT_PAYLOAD_MAX_BYTES
    ),
    eventsMaxCount: positiveInteger(env.SESSION_EVENTS_MAX_COUNT, DEFAULT_EVENTS_MAX_COUNT),
    eventsMaxBytes: positiveInteger(env.SESSION_EVENTS_MAX_BYTES, DEFAULT_EVENTS_MAX_BYTES),
  };
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

const encoder = new TextEncoder();

/** Byte length of a string once serialized, which is what the budget counts. */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Stored byte length of an event, as the accounting counts it. */
export function storedEventByteLength(event: unknown): number {
  return utf8ByteLength(JSON.stringify(event));
}

/**
 * An event as it is written to the transcript.
 *
 * `truncated` is the visible half of the promise: a reader must be able to
 * tell "the command printed this" from "the command printed this and more".
 * Without the marker the shortened output would read as the whole output,
 * which is worse than storing nothing.
 */
export type StoredSandboxEvent = SandboxEvent & { truncated?: boolean };

/**
 * Returns the event to store, trimmed if it is over the ceiling.
 *
 * The original object is returned untouched when it fits, so the common case
 * costs one serialization and no copy. Over the ceiling, the event's dominant
 * string field is shortened and every other field is kept: the fields that say
 * WHICH command ran, on which call, at what time are tiny and are exactly what
 * makes the surviving fragment interpretable.
 *
 * Types with no dominant field — user messages, artifacts, push and lifecycle
 * events — pass through unchanged. Each is small by construction, and guessing
 * at which of an unfamiliar event's fields is safe to destroy is worse than
 * storing it whole.
 */
export function boundSandboxEventForStorage(
  event: SandboxEvent,
  maxBytes: number
): StoredSandboxEvent {
  const originalBytes = storedEventByteLength(event);
  if (originalBytes <= maxBytes) return event;

  const trimmed = shrinkDominantField(event, maxBytes, originalBytes);
  if (trimmed === null) return event;
  return { ...trimmed, truncated: true } as StoredSandboxEvent;
}

/**
 * Shortens whichever field is carrying the weight, largest first, until the
 * event fits. Returns null when this type has no field worth shortening.
 */
function shrinkDominantField(
  event: SandboxEvent,
  maxBytes: number,
  originalBytes: number
): SandboxEvent | null {
  // The marker costs bytes of its own, and so does `"truncated":true`. Budget
  // for both so the result really lands under the ceiling.
  const overhead = originalBytes - maxBytes;

  switch (event.type) {
    case "tool_call": {
      if (typeof event.output === "string" && event.output.length > 0) {
        return { ...event, output: shorten(event.output, overhead) };
      }
      return shrinkLargestArgument(event, overhead);
    }
    case "tool_result": {
      if (event.result.length > 0) {
        return { ...event, result: shorten(event.result, overhead) };
      }
      if (typeof event.error === "string" && event.error.length > 0) {
        return { ...event, error: shorten(event.error, overhead) };
      }
      return null;
    }
    case "token":
      return { ...event, content: shorten(event.content, overhead) };
    case "error":
      return { ...event, error: shorten(event.error, overhead) };
    default:
      return null;
  }
}

/** A tool call with no output but oversized arguments — a large written file. */
function shrinkLargestArgument(
  event: Extract<SandboxEvent, { type: "tool_call" }>,
  overhead: number
): SandboxEvent | null {
  let largestKey: string | null = null;
  let largestBytes = 0;
  for (const [key, value] of Object.entries(event.args)) {
    if (typeof value !== "string") continue;
    const bytes = utf8ByteLength(value);
    if (bytes > largestBytes) {
      largestKey = key;
      largestBytes = bytes;
    }
  }
  if (largestKey === null) return null;
  return {
    ...event,
    args: { ...event.args, [largestKey]: shorten(event.args[largestKey] as string, overhead) },
  };
}

/**
 * Cuts `text` down by at least `overhead` bytes and says what was lost.
 *
 * The cut lands on a code-point boundary, never between the halves of a
 * surrogate pair: a lone half is not valid text, and it would travel through
 * JSON, through the event stream, and into the browser as a replacement
 * character in the middle of somebody's output.
 */
function shorten(text: string, overhead: number): string {
  const originalBytes = utf8ByteLength(text);
  // Room for the notice itself plus the `"truncated":true` field, with slack
  // for the notice's own digits.
  const marginBytes = 128;
  const keepBytes = Math.max(0, originalBytes - overhead - marginBytes);
  const kept = takeUtf8Prefix(text, keepBytes);
  return `${kept}\n… [truncated for storage: kept ${utf8ByteLength(kept)} of ${originalBytes} bytes]`;
}

/**
 * The longest prefix of `text` that fits in `maxBytes` when UTF-8 encoded,
 * cut between code points.
 */
function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(text) <= maxBytes) return text;

  let bytes = 0;
  let end = 0;
  // Iterating the string yields whole code points, so a surrogate pair is
  // taken or left as one unit and never split.
  for (const codePoint of text) {
    const size = utf8ByteLength(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return text.slice(0, end);
}
