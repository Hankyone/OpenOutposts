import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OutpostOperation } from "@openoutposts/outpost-protocol";
import { Type } from "typebox";

import type { OutpostClient, ToolCallResult } from "../outpost-client.js";

/**
 * The seven bounded outpost operations, exposed to the model as Pi custom
 * tools. Every one of them proxies through the control plane's lease to the
 * outpost; none of them touches the homestead's own filesystem or shell.
 *
 * Names carry an `outpost_` prefix rather than reusing Pi's built-in names
 * (`bash`, `read`, ...). Same-naming would also work — a custom tool replaces
 * the built-in of the same name — but the prefix makes the containment
 * property readable straight off the tool list instead of requiring someone to
 * execute a tool to discover which implementation won.
 */

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** Headroom over the worker's own timeout so the outpost reports first. */
const BASH_REQUEST_HEADROOM_MS = 15_000;
const MAX_BASH_REQUEST_TIMEOUT_MS = 300_000;

/** Carries one operation to the leased outpost. Implemented by the harness. */
export interface OutpostToolTransport {
  call(
    operation: OutpostOperation,
    input: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<ToolCallResult>;
}

/**
 * Binds the tools to one lease on one outpost. The lease id lives here, in the
 * homestead, and never travels in a tool argument or reaches the model.
 */
export function createLeaseTransport(
  outposts: OutpostClient,
  outpostId: string,
  leaseId: string
): OutpostToolTransport {
  return {
    call: (operation, input, timeoutMs) =>
      outposts.callTool(outpostId, leaseId, operation, input, timeoutMs),
  };
}

export class OutpostToolError extends Error {
  constructor(
    message: string,
    readonly operation: OutpostOperation,
    readonly errorCode: string
  ) {
    super(message);
    this.name = "OutpostToolError";
  }
}

/**
 * Pi flags a tool result as an error only when `execute` throws; an
 * error-shaped return value is delivered to the model as an ordinary success.
 */
function failure(operation: OutpostOperation, result: ToolCallResult): never {
  const code = result.errorCode ?? "error";
  throw new OutpostToolError(
    `Remote ${operation} failed (${code}): ${result.error ?? "unknown error"}`,
    operation,
    code
  );
}

/**
 * Settles as soon as the turn is cancelled instead of waiting out a remote
 * operation. The control-plane request itself is not withdrawn — the harness
 * cancels in-flight outpost work through the lease on interrupt — so this only
 * stops the agent blocking on a result nobody will read.
 */
async function untilAborted<T>(
  operation: OutpostOperation,
  signal: AbortSignal | undefined,
  start: () => Promise<T>
): Promise<T> {
  if (signal?.aborted) {
    throw new OutpostToolError(`Remote ${operation} cancelled`, operation, "cancelled");
  }
  if (!signal) return start();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      start(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(new OutpostToolError(`Remote ${operation} cancelled`, operation, "cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const WORKSPACE_NOTE = "Workspace-relative path; absolute paths are rejected.";

function textResult(text: string, operation: OutpostOperation, output: unknown) {
  return { content: [{ type: "text" as const, text }], details: { operation, output } };
}

export function createOutpostTools(transport: OutpostToolTransport): ToolDefinition[] {
  const bash = defineTool({
    name: "outpost_bash",
    label: "Outpost bash",
    description:
      "Run a shell command on the user's outpost machine, in the leased workspace. This is the only shell available; the agent has no local shell.",
    promptSnippet: "outpost_bash: run a shell command in the remote outpost workspace",
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to run." }),
      cwd: Type.Optional(Type.String({ description: `Directory to run in. ${WORKSPACE_NOTE}` })),
      timeoutMs: Type.Optional(
        Type.Integer({ description: "Timeout in milliseconds (default 120000)." })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const input: Record<string, unknown> = { command: params.command };
      if (params.cwd) input.cwd = params.cwd;
      if (params.timeoutMs) input.timeoutMs = params.timeoutMs;
      const requestTimeoutMs = Math.min(
        (params.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS) + BASH_REQUEST_HEADROOM_MS,
        MAX_BASH_REQUEST_TIMEOUT_MS
      );
      const result = await untilAborted("bash", signal, () =>
        transport.call("bash", input, requestTimeoutMs)
      );
      if (!result.ok) failure("bash", result);
      const output = result.output as {
        stdout: string;
        stderr: string;
        exitCode: number;
        truncated: boolean;
      };
      const sections: string[] = [];
      if (output.stdout) sections.push(output.stdout);
      if (output.stderr) sections.push(`[stderr]\n${output.stderr}`);
      if (output.truncated) sections.push("[output truncated]");
      sections.push(`[exit code ${output.exitCode}]`);
      return textResult(sections.join("\n"), "bash", output);
    },
  });

  const read = defineTool({
    name: "outpost_read",
    label: "Outpost read",
    description:
      "Read a file from the outpost workspace. This is the only filesystem available; the agent cannot read local files.",
    promptSnippet: "outpost_read: read a file from the remote outpost workspace",
    parameters: Type.Object({
      path: Type.String({ description: `File to read. ${WORKSPACE_NOTE}` }),
      offsetLines: Type.Optional(
        Type.Integer({ description: "Skip this many lines from the start." })
      ),
      limitLines: Type.Optional(Type.Integer({ description: "Return at most this many lines." })),
    }),
    async execute(_toolCallId, params, signal) {
      const input: Record<string, unknown> = { path: params.path };
      if (params.offsetLines) input.offsetLines = params.offsetLines;
      if (params.limitLines) input.limitLines = params.limitLines;
      const result = await untilAborted("read", signal, () => transport.call("read", input));
      if (!result.ok) failure("read", result);
      const output = result.output as { content: string; totalLines: number; truncated: boolean };
      const text = output.truncated
        ? `${output.content}\n[truncated: file has ${output.totalLines} lines total]`
        : output.content;
      return textResult(text, "read", output);
    },
  });

  const write = defineTool({
    name: "outpost_write",
    label: "Outpost write",
    description:
      "Create or overwrite a file in the outpost workspace. Parent directories are created automatically. This is the only way to persist a file.",
    promptSnippet: "outpost_write: write a file in the remote outpost workspace",
    parameters: Type.Object({
      path: Type.String({ description: `File to write. ${WORKSPACE_NOTE}` }),
      content: Type.String({ description: "The full file content to write." }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await untilAborted("write", signal, () =>
        transport.call("write", { path: params.path, content: params.content })
      );
      if (!result.ok) failure("write", result);
      const output = result.output as { bytesWritten: number; created: boolean };
      return textResult(
        `${output.created ? "Created" : "Updated"} ${params.path} (${output.bytesWritten} bytes)`,
        "write",
        output
      );
    },
  });

  const edit = defineTool({
    name: "outpost_edit",
    label: "Outpost edit",
    description:
      "Replace an exact string in an outpost workspace file. oldString must match exactly one location unless replaceAll is set.",
    promptSnippet: "outpost_edit: replace exact text in a remote outpost workspace file",
    parameters: Type.Object({
      path: Type.String({ description: `File to edit. ${WORKSPACE_NOTE}` }),
      oldString: Type.String({ description: "Exact text to replace." }),
      newString: Type.String({ description: "Replacement text." }),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence." })),
    }),
    async execute(_toolCallId, params, signal) {
      const input: Record<string, unknown> = {
        path: params.path,
        oldString: params.oldString,
        newString: params.newString,
      };
      if (params.replaceAll) input.replaceAll = true;
      const result = await untilAborted("edit", signal, () => transport.call("edit", input));
      if (!result.ok) failure("edit", result);
      const output = result.output as { replacements: number };
      return textResult(
        `Applied ${output.replacements} replacement(s) in ${params.path}`,
        "edit",
        output
      );
    },
  });

  const grep = defineTool({
    name: "outpost_grep",
    label: "Outpost grep",
    description:
      "Search outpost workspace files with a regular expression. Returns matching lines with paths and line numbers.",
    promptSnippet: "outpost_grep: search the remote outpost workspace by regular expression",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression (RE2 syntax)." }),
      path: Type.Optional(
        Type.String({ description: `Directory or file to search in. ${WORKSPACE_NOTE}` })
      ),
      maxMatches: Type.Optional(
        Type.Integer({ description: "Cap on returned matches (default 200)." })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const input: Record<string, unknown> = { pattern: params.pattern };
      if (params.path) input.path = params.path;
      if (params.maxMatches) input.maxMatches = params.maxMatches;
      const result = await untilAborted("grep", signal, () => transport.call("grep", input));
      if (!result.ok) failure("grep", result);
      const output = result.output as {
        matches: { path: string; line: number; text: string }[];
        truncated: boolean;
      };
      if (output.matches.length === 0) return textResult("No matches.", "grep", output);
      const lines = output.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
      if (output.truncated) lines.push("[match list truncated]");
      return textResult(lines.join("\n"), "grep", output);
    },
  });

  const find = defineTool({
    name: "outpost_find",
    label: "Outpost find",
    description:
      "Find outpost workspace files by glob pattern. * and ? stay within a directory; ** crosses directories; a bare filename matches anywhere.",
    promptSnippet: "outpost_find: find files in the remote outpost workspace by glob",
    parameters: Type.Object({
      glob: Type.String({ description: "Glob pattern, e.g. **/*.ts or README.md." }),
      maxResults: Type.Optional(
        Type.Integer({ description: "Cap on returned paths (default 500)." })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const input: Record<string, unknown> = { glob: params.glob };
      if (params.maxResults) input.maxResults = params.maxResults;
      const result = await untilAborted("find", signal, () => transport.call("find", input));
      if (!result.ok) failure("find", result);
      const output = result.output as { paths: string[]; truncated: boolean };
      if (output.paths.length === 0) return textResult("No files matched.", "find", output);
      const lines = [...output.paths];
      if (output.truncated) lines.push("[result list truncated]");
      return textResult(lines.join("\n"), "find", output);
    },
  });

  const ls = defineTool({
    name: "outpost_ls",
    label: "Outpost ls",
    description: "List a directory in the outpost workspace.",
    promptSnippet: "outpost_ls: list a directory in the remote outpost workspace",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: `Directory to list, defaulting to the root. ${WORKSPACE_NOTE}` })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const input: Record<string, unknown> = {};
      if (params.path) input.path = params.path;
      const result = await untilAborted("ls", signal, () => transport.call("ls", input));
      if (!result.ok) failure("ls", result);
      const output = result.output as {
        entries: { name: string; type: string; sizeBytes?: number }[];
        truncated?: boolean;
      };
      if (output.entries.length === 0) return textResult("Empty directory.", "ls", output);
      const lines = output.entries.map((entry) => {
        if (entry.type === "dir") return `${entry.name}/`;
        if (entry.type === "symlink") return `${entry.name}@`;
        return entry.sizeBytes === undefined
          ? entry.name
          : `${entry.name} (${entry.sizeBytes} bytes)`;
      });
      // A bounded listing that reads as complete is worse than a short one: the
      // model would conclude the missing files are not there.
      if (output.truncated) lines.push("[truncated: the directory holds more entries]");
      return textResult(lines.join("\n"), "ls", output);
    },
  });

  return [bash, read, write, edit, grep, find, ls];
}

/**
 * The tool allowlist handed to Pi. This list — not a suppression flag — is the
 * containment boundary: Pi applies it as an intersection, so nothing loaded
 * later (an extension, a runtime `setActiveTools` call) can widen past it.
 */
export const OUTPOST_TOOL_NAMES = [
  "outpost_bash",
  "outpost_read",
  "outpost_write",
  "outpost_edit",
  "outpost_grep",
  "outpost_find",
  "outpost_ls",
] as const;

/** Pi's built-in local tools. None of these may ever reach the model. */
export const PI_LOCAL_TOOL_NAMES = ["bash", "read", "write", "edit", "grep", "find", "ls"] as const;
