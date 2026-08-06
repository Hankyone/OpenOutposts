import type { OutpostOperation } from "@openoutposts/outpost-protocol";
import { describe, expect, it } from "vitest";

import type { ToolCallResult } from "../outpost-client.js";
import {
  createOutpostTools,
  OutpostToolError,
  OUTPOST_TOOL_NAMES,
  type OutpostToolTransport,
} from "./tools.js";

interface RecordedCall {
  operation: OutpostOperation;
  input: Record<string, unknown>;
  timeoutMs?: number;
}

function transportReturning(
  results: Partial<Record<OutpostOperation, ToolCallResult>>,
  calls: RecordedCall[] = []
): OutpostToolTransport & { calls: RecordedCall[] } {
  return {
    calls,
    call(operation, input, timeoutMs) {
      calls.push({ operation, input, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      return Promise.resolve(results[operation] ?? { ok: true, output: {} });
    },
  };
}

/** Runs a tool by name with the arguments a model would send. */
async function run(
  transport: OutpostToolTransport,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const tool = createOutpostTools(transport).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const result = await tool.execute("call_1", params, signal, undefined, undefined as never);
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

describe("createOutpostTools", () => {
  it("exposes exactly the seven bounded operations", () => {
    const names = createOutpostTools(transportReturning({})).map((tool) => tool.name);
    expect(names).toEqual([...OUTPOST_TOOL_NAMES]);
    expect(names).toHaveLength(7);
  });

  it("gives every tool a prompt snippet so it appears in the system prompt", () => {
    for (const tool of createOutpostTools(transportReturning({}))) {
      expect(tool.promptSnippet).toBeTruthy();
    }
  });

  it("sends bash through the lease with a request timeout above the command timeout", async () => {
    const transport = transportReturning({
      bash: {
        ok: true,
        output: { stdout: "hi\n", stderr: "", exitCode: 0, durationMs: 3, truncated: false },
      },
    });
    const text = await run(transport, "outpost_bash", {
      command: "echo hi",
      cwd: "src",
      timeoutMs: 5_000,
    });
    expect(transport.calls[0]).toEqual({
      operation: "bash",
      input: { command: "echo hi", cwd: "src", timeoutMs: 5_000 },
      timeoutMs: 20_000,
    });
    expect(text).toBe("hi\n\n[exit code 0]".trim());
  });

  it("reports stderr, truncation, and the exit code to the model", async () => {
    const transport = transportReturning({
      bash: {
        ok: true,
        output: { stdout: "out", stderr: "bad", exitCode: 2, durationMs: 1, truncated: true },
      },
    });
    const text = await run(transport, "outpost_bash", { command: "x" });
    expect(text).toBe("out\n[stderr]\nbad\n[output truncated]\n[exit code 2]");
  });

  it("maps read, write, and edit onto the protocol payload shapes", async () => {
    const transport = transportReturning({
      read: { ok: true, output: { content: "line", totalLines: 9, truncated: true } },
      write: { ok: true, output: { bytesWritten: 4, created: true } },
      edit: { ok: true, output: { replacements: 2 } },
    });
    expect(await run(transport, "outpost_read", { path: "a.ts", limitLines: 1 })).toBe(
      "line\n[truncated: file has 9 lines total]"
    );
    expect(await run(transport, "outpost_write", { path: "a.ts", content: "text" })).toBe(
      "Created a.ts (4 bytes)"
    );
    expect(
      await run(transport, "outpost_edit", {
        path: "a.ts",
        oldString: "x",
        newString: "y",
        replaceAll: true,
      })
    ).toBe("Applied 2 replacement(s) in a.ts");
    expect(transport.calls.map((call) => call.input)).toEqual([
      { path: "a.ts", limitLines: 1 },
      { path: "a.ts", content: "text" },
      { path: "a.ts", oldString: "x", newString: "y", replaceAll: true },
    ]);
  });

  it("maps grep, find, and ls onto the protocol payload shapes", async () => {
    const transport = transportReturning({
      grep: {
        ok: true,
        output: { matches: [{ path: "a.ts", line: 3, text: "hit" }], truncated: false },
      },
      find: { ok: true, output: { paths: ["a.ts", "b.ts"], truncated: true } },
      ls: {
        ok: true,
        output: {
          entries: [
            { name: "src", type: "dir" },
            { name: "a.ts", type: "file", sizeBytes: 12 },
          ],
        },
      },
    });
    expect(await run(transport, "outpost_grep", { pattern: "hit" })).toBe("a.ts:3: hit");
    expect(await run(transport, "outpost_find", { glob: "**/*.ts" })).toBe(
      "a.ts\nb.ts\n[result list truncated]"
    );
    expect(await run(transport, "outpost_ls", {})).toBe("src/\na.ts (12 bytes)");
    expect(transport.calls.map((call) => call.operation)).toEqual(["grep", "find", "ls"]);
    // `ls` with no path must not send an undefined key: the protocol schema
    // treats the field as absent-or-string, not nullable.
    expect(transport.calls[2]?.input).toEqual({});
  });

  it("tells the model when a directory listing was cut short", async () => {
    const transport = transportReturning({
      ls: {
        ok: true,
        output: {
          entries: [{ name: "a.ts", type: "file" }],
          truncated: true,
        },
      },
    });

    // A bounded listing that reads as complete would have the model conclude
    // the entries it cannot see are not there.
    expect(await run(transport, "outpost_ls", {})).toBe(
      "a.ts\n[truncated: the directory holds more entries]"
    );
  });

  it("reports empty results rather than nothing", async () => {
    const transport = transportReturning({
      grep: { ok: true, output: { matches: [], truncated: false } },
      find: { ok: true, output: { paths: [], truncated: false } },
      ls: { ok: true, output: { entries: [] } },
    });
    expect(await run(transport, "outpost_grep", { pattern: "x" })).toBe("No matches.");
    expect(await run(transport, "outpost_find", { glob: "x" })).toBe("No files matched.");
    expect(await run(transport, "outpost_ls", {})).toBe("Empty directory.");
  });

  // Pi flags a tool result as an error only when execute throws. Returning the
  // failure text would report a failed remote operation to the model as a
  // success, which is how an agent ends up "confirming" work it never did.
  it("throws on a failed remote operation so Pi marks the result as an error", async () => {
    const transport = transportReturning({
      write: { ok: false, error: "outside the workspace", errorCode: "path_denied" },
    });
    await expect(run(transport, "outpost_write", { path: "/etc/x", content: "y" })).rejects.toThrow(
      OutpostToolError
    );
    await expect(run(transport, "outpost_write", { path: "/etc/x", content: "y" })).rejects.toThrow(
      /Remote write failed \(path_denied\): outside the workspace/
    );
  });

  it("settles promptly when the turn is cancelled mid-operation", async () => {
    const controller = new AbortController();
    const transport: OutpostToolTransport = {
      call: () => new Promise<ToolCallResult>(() => {}),
    };
    const pending = run(transport, "outpost_bash", { command: "sleep 600" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it("refuses to start an operation whose turn was already cancelled", async () => {
    const transport = transportReturning({});
    await expect(run(transport, "outpost_ls", {}, AbortSignal.abort())).rejects.toThrow(
      /cancelled/
    );
    expect(transport.calls).toHaveLength(0);
  });
});
