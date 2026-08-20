import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "../types";
import {
  boundSandboxEventForStorage,
  DEFAULT_EVENT_RETENTION,
  resolveEventRetentionConfig,
  shouldPersistToolCallEvent,
  storedEventByteLength,
  utf8ByteLength,
} from "./event-persistence";

describe("shouldPersistToolCallEvent", () => {
  it("persists terminal statuses", () => {
    expect(shouldPersistToolCallEvent("completed")).toBe(true);
    expect(shouldPersistToolCallEvent("error")).toBe(true);
  });

  it("persists missing statuses", () => {
    expect(shouldPersistToolCallEvent(undefined)).toBe(true);
    expect(shouldPersistToolCallEvent(null)).toBe(true);
  });

  it("persists empty and whitespace statuses", () => {
    expect(shouldPersistToolCallEvent("")).toBe(true);
    expect(shouldPersistToolCallEvent("   ")).toBe(true);
  });

  it("does not persist non-terminal statuses", () => {
    expect(shouldPersistToolCallEvent("pending")).toBe(false);
    expect(shouldPersistToolCallEvent("running")).toBe(false);
  });
});

describe("resolveEventRetentionConfig", () => {
  it("falls back to the defaults when nothing is configured", () => {
    expect(resolveEventRetentionConfig({})).toEqual(DEFAULT_EVENT_RETENTION);
  });

  it("reads positive whole numbers", () => {
    expect(
      resolveEventRetentionConfig({
        SESSION_EVENT_PAYLOAD_MAX_BYTES: "1024",
        SESSION_EVENTS_MAX_COUNT: "50",
        SESSION_EVENTS_MAX_BYTES: " 2048 ",
      })
    ).toEqual({ eventPayloadMaxBytes: 1024, eventsMaxCount: 50, eventsMaxBytes: 2048 });
  });

  /**
   * These dials sit on the path that records a user's transcript. A typo in
   * one of them must cost the default, never the session.
   */
  it("falls back rather than failing on a value that is not a positive whole number", () => {
    expect(
      resolveEventRetentionConfig({
        SESSION_EVENT_PAYLOAD_MAX_BYTES: "sixty four kilobytes",
        SESSION_EVENTS_MAX_COUNT: "0",
        SESSION_EVENTS_MAX_BYTES: "-1",
      })
    ).toEqual(DEFAULT_EVENT_RETENTION);
  });

  it("falls back on a fractional value", () => {
    expect(resolveEventRetentionConfig({ SESSION_EVENTS_MAX_COUNT: "12.5" }).eventsMaxCount).toBe(
      DEFAULT_EVENT_RETENTION.eventsMaxCount
    );
  });
});

describe("boundSandboxEventForStorage", () => {
  const base = { sandboxId: "sb-1", messageId: "msg-1", timestamp: 1 };

  it("returns an event that fits exactly as it arrived", () => {
    const event: SandboxEvent = {
      ...base,
      type: "tool_result",
      callId: "call-1",
      result: "ok",
    };
    expect(boundSandboxEventForStorage(event, 1024)).toBe(event);
  });

  it("keeps the head of an oversized tool call's output and says what was dropped", () => {
    const stored = boundSandboxEventForStorage(
      {
        ...base,
        type: "tool_call",
        tool: "bash",
        args: { command: "cat big.log" },
        callId: "call-1",
        output: `HEAD-OF-OUTPUT${"x".repeat(5000)}`,
      },
      512
    ) as Extract<SandboxEvent, { type: "tool_call" }> & { truncated?: boolean };

    expect(stored.truncated).toBe(true);
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(512);
    // The head survives, because that is where a command says what it did.
    expect(stored.output?.startsWith("HEAD-OF-OUTPUT")).toBe(true);
    expect(stored.output).toContain("truncated for storage");
    // Everything that identifies the call is tiny and is what makes the
    // surviving fragment readable at all.
    expect(stored.tool).toBe("bash");
    expect(stored.callId).toBe("call-1");
    expect(stored.args.command).toBe("cat big.log");
  });

  it("shrinks a tool call's largest string argument when it has no output", () => {
    const stored = boundSandboxEventForStorage(
      {
        ...base,
        type: "tool_call",
        tool: "write",
        args: { path: "src/big.ts", content: "y".repeat(5000) },
        callId: "call-1",
      },
      512
    ) as Extract<SandboxEvent, { type: "tool_call" }> & { truncated?: boolean };

    expect(stored.truncated).toBe(true);
    // The path is what tells a reader which file this was; only the body goes.
    expect(stored.args.path).toBe("src/big.ts");
    expect(String(stored.args.content)).toContain("truncated for storage");
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(512);
  });

  it("shrinks every large tool call field needed to meet the cap", () => {
    const event: SandboxEvent = {
      ...base,
      type: "tool_call",
      tool: "bash",
      args: { command: "C".repeat(5000), note: "small" },
      callId: "call-1",
      output: "O".repeat(1000),
    };
    const original = structuredClone(event);

    const stored = boundSandboxEventForStorage(event, 512);

    expect(stored).not.toBeNull();
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(512);
    expect(stored).toMatchObject({ type: "tool_call", tool: "bash", callId: "call-1" });
    expect(event).toEqual(original);
  });

  it("shrinks a tool result's result, and its error when there is no result", () => {
    const withResult = boundSandboxEventForStorage(
      { ...base, type: "tool_result", callId: "call-1", result: "z".repeat(5000) },
      512
    ) as Extract<SandboxEvent, { type: "tool_result" }> & { truncated?: boolean };
    expect(withResult.result).toContain("truncated for storage");
    expect(withResult.truncated).toBe(true);

    const errorOnly = boundSandboxEventForStorage(
      { ...base, type: "tool_result", callId: "call-1", result: "", error: "e".repeat(5000) },
      512
    ) as Extract<SandboxEvent, { type: "tool_result" }>;
    expect(errorOnly.error).toContain("truncated for storage");
    expect(errorOnly.result).toBe("");
  });

  it("shrinks both large tool result fields when one reduction is insufficient", () => {
    const stored = boundSandboxEventForStorage(
      {
        ...base,
        type: "tool_result",
        callId: "call-1",
        result: "R".repeat(1000),
        error: "E".repeat(5000),
      },
      512
    );

    expect(stored).not.toBeNull();
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(512);
  });

  it("shrinks execution completion errors without losing completion identity", () => {
    const stored = boundSandboxEventForStorage(
      {
        ...base,
        type: "execution_complete",
        success: false,
        error: "failure ".repeat(1000),
      },
      512
    );

    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({
      type: "execution_complete",
      success: false,
      messageId: "msg-1",
      sandboxId: "sb-1",
      truncated: true,
    });
    expect(stored?.error).toContain("truncated for storage");
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(512);
  });

  it("shrinks token content and error text", () => {
    const token = boundSandboxEventForStorage(
      { ...base, type: "token", content: "t".repeat(5000) },
      512
    ) as Extract<SandboxEvent, { type: "token" }>;
    expect(token.content).toContain("truncated for storage");

    const error = boundSandboxEventForStorage(
      { ...base, type: "error", error: "boom ".repeat(2000) },
      512
    ) as Extract<SandboxEvent, { type: "error" }>;
    expect(error.error).toContain("truncated for storage");
  });

  /** Nothing is guessed at: unfamiliar payload fields are not safe to destroy. */
  it("skips an oversized event type that has no safe payload rule", () => {
    const event: SandboxEvent = {
      type: "user_message",
      content: "u".repeat(5000),
      messageId: "msg-1",
      timestamp: 1,
    };
    const stored = boundSandboxEventForStorage(event, 512);
    expect(stored).toBeNull();
  });

  it("returns null when required structural metadata cannot fit", () => {
    const event: SandboxEvent = {
      ...base,
      type: "execution_complete",
      success: false,
      error: "failure",
    };

    expect(boundSandboxEventForStorage(event, 8)).toBeNull();
  });

  it("hard-bounds every representative non-null stored copy", () => {
    const events: SandboxEvent[] = [
      { ...base, type: "token", content: "T".repeat(5000) },
      { ...base, type: "error", error: "E".repeat(5000) },
      {
        ...base,
        type: "tool_call",
        tool: "write",
        args: { path: "large.txt", content: "C".repeat(5000) },
        callId: "call-1",
      },
      {
        ...base,
        type: "tool_result",
        callId: "call-1",
        result: "R".repeat(5000),
      },
      {
        ...base,
        type: "execution_complete",
        success: false,
        error: "X".repeat(5000),
      },
    ];

    for (const event of events) {
      const stored = boundSandboxEventForStorage(event, 512);
      if (stored !== null) {
        expect(storedEventByteLength(stored)).toBeLessThanOrEqual(512);
      }
    }
  });

  it("stays valid JSON at the ceiling", () => {
    const stored = boundSandboxEventForStorage(
      { ...base, type: "token", content: "t".repeat(200_000) },
      1024
    );
    const roundTripped = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    expect(roundTripped.type).toBe("token");
    expect(roundTripped.truncated).toBe(true);
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(1024);
  });

  /**
   * A cut between the halves of a surrogate pair produces text that is not
   * valid, and it travels all the way to the browser as a replacement
   * character sitting in the middle of somebody's output.
   */
  it("never splits a surrogate pair", () => {
    const stored = boundSandboxEventForStorage(
      { ...base, type: "token", content: "🙂".repeat(4000) },
      600
    ) as Extract<SandboxEvent, { type: "token" }>;

    const kept = stored.content.slice(0, stored.content.indexOf("\n…"));
    expect(kept).not.toMatch(/[\uD800-\uDFFF]/u);
    expect([...kept].every((codePoint) => codePoint === "🙂")).toBe(true);
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(600);
  });

  it("counts bytes rather than characters when deciding what fits", () => {
    // Every character here is three bytes, so a character-based ceiling would
    // let an event through at three times its real size.
    const multibyte = "日".repeat(400);
    expect(utf8ByteLength(multibyte)).toBe(1200);

    const stored = boundSandboxEventForStorage(
      { ...base, type: "token", content: multibyte },
      600
    ) as Extract<SandboxEvent, { type: "token" }> & { truncated?: boolean };

    expect(stored.truncated).toBe(true);
    expect(storedEventByteLength(stored)).toBeLessThanOrEqual(600);
  });

  it("reports the byte counts it kept and started with", () => {
    const stored = boundSandboxEventForStorage(
      { ...base, type: "token", content: "t".repeat(5000) },
      512
    ) as Extract<SandboxEvent, { type: "token" }>;

    const marker = /kept (\d+) of (\d+) bytes/.exec(stored.content);
    expect(marker).not.toBeNull();
    const [, kept, original] = marker as RegExpExecArray;
    expect(Number(original)).toBe(5000);
    expect(Number(kept)).toBeGreaterThan(0);
    expect(Number(kept)).toBeLessThan(Number(original));
  });
});
