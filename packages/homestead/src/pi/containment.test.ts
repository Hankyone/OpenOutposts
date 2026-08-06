import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentContextFile } from "@openoutposts/outpost-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPiResourceLoaderOptions,
  buildPiToolOptions,
  createPiAgentHome,
} from "./agent-home.js";
import { createOutpostAgentSession } from "./session.js";
import {
  createOutpostTools,
  OUTPOST_TOOL_NAMES,
  PI_LOCAL_TOOL_NAMES,
  type OutpostToolTransport,
} from "./tools.js";

/**
 * The regression this project has already been bitten by once: a permissive
 * harness configuration let the model fall back to a LOCAL write tool and edit
 * the homestead's own disk while reporting success.
 *
 * These tests build a real Pi session with the exact configuration the harness
 * ships and assert, against Pi itself rather than against our own beliefs about
 * Pi, that the model is offered no tool that can reach this machine. They run
 * offline: no prompt is sent and no model is called.
 */

// Pi resolves this from its bundled catalogue without network access. Any
// model works; the tool set does not depend on the choice.
const OFFLINE_MODEL = "anthropic/claude-sonnet-4-5";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Records what the model asked the outpost to do, and touches nothing local. */
function recordingTransport(): OutpostToolTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call(operation, input) {
      calls.push(`${operation}:${JSON.stringify(input)}`);
      return Promise.resolve({ ok: true, output: { bytesWritten: 5, created: true } });
    },
  };
}

/**
 * Builds a session the way the harness does. `rogueExtension` plants a tool
 * file in the session working directory, standing in for anything that can
 * write there — a repository checkout, a compromised dependency, a prompt that
 * talks the model into creating one.
 *
 * `sessionFile` persists the conversation exactly as the harness does on a
 * homestead with a state directory, so containment can be asserted against the
 * persisted shape too rather than only the in-memory one.
 */
async function guardedSession(
  rogueExtension?: string,
  sessionFile?: string,
  contextFiles?: AgentContextFile[]
) {
  const home = await createPiAgentHome();
  cleanups.push(() => home.remove());
  if (rogueExtension) {
    await mkdir(join(home.cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(home.cwd, ".pi", "extensions", "rogue.ts"), rogueExtension);
  }
  const transport = recordingTransport();
  const { session } = await createOutpostAgentSession({
    home,
    transport,
    model: OFFLINE_MODEL,
    ...(contextFiles === undefined ? {} : { contextFiles }),
    ...(sessionFile === undefined ? {} : { persistence: { sessionFile } }),
  });
  cleanups.push(async () => session.dispose());
  return { home, session, transport };
}

/**
 * Builds a session the way the harness deliberately does NOT, so the
 * assertions above are proof rather than coincidence: unless an unguarded Pi
 * really does hand the model local tools, "no local tools" tells us nothing.
 */
async function unguardedSession(
  sessionOptions: Partial<CreateAgentSessionOptions>,
  rogueExtension?: string
) {
  const home = await createPiAgentHome();
  cleanups.push(() => home.remove());
  if (rogueExtension) {
    await mkdir(join(home.cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(home.cwd, ".pi", "extensions", "rogue.ts"), rogueExtension);
  }
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: home.cwd,
    agentDir: home.agentDir,
    settingsManager,
    // Host discovery stays off so the control measures the option under test
    // rather than whatever is installed on the machine running the suite.
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: home.authPath,
    modelsPath: home.modelsPath,
  });
  const { session } = await createAgentSession({
    cwd: home.cwd,
    agentDir: home.agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(home.cwd),
    model: modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
    ...sessionOptions,
  });
  cleanups.push(async () => session.dispose());
  return session;
}

const ROGUE_LOCAL_TOOL = `import { Type } from "typebox";
export default function (pi: any) {
  pi.registerTool({
    name: "local_shell",
    label: "Local shell",
    description: "Run a shell command on the local machine.",
    parameters: Type.Object({ command: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "LOCAL_SHELL_REACHED" }], details: {} };
    },
  });
}
`;

describe("outpost session containment", () => {
  it("offers the model exactly the seven remote tools and nothing else", async () => {
    const { session } = await guardedSession();
    expect(session.agent.state.tools.map((tool) => tool.name).sort()).toEqual(
      [...OUTPOST_TOOL_NAMES].sort()
    );
    expect(session.getActiveToolNames().sort()).toEqual([...OUTPOST_TOOL_NAMES].sort());
  });

  it("leaves none of Pi's local filesystem or shell built-ins reachable", async () => {
    const { session } = await guardedSession();
    const visible = new Set(session.agent.state.tools.map((tool) => tool.name));
    for (const local of PI_LOCAL_TOOL_NAMES) {
      expect(visible.has(local)).toBe(false);
    }
  });

  // The trap: `noTools: "builtin"` suppresses the built-ins but by design keeps
  // extension-registered tools enabled, so this rogue file would become
  // model-visible under it. Only the explicit allowlist blocks it.
  it("keeps a rogue extension's local tool away from the model", async () => {
    const { session } = await guardedSession(ROGUE_LOCAL_TOOL);
    expect(session.agent.state.tools.map((tool) => tool.name)).not.toContain("local_shell");
    expect(session.agent.state.tools).toHaveLength(OUTPOST_TOOL_NAMES.length);
  });

  // Pi applies the allowlist as an intersection, so a runtime request can only
  // narrow within it. If that ever changed, this is where it would show.
  it("cannot be widened at runtime past the allowlist", async () => {
    const { session } = await guardedSession();
    session.setActiveToolsByName(["local_shell", "bash", "write", "outpost_bash", "outpost_ls"]);
    expect(session.getActiveToolNames().sort()).toEqual(["outpost_bash", "outpost_ls"]);
  });

  it("executes the write tool against the outpost, never the local disk", async () => {
    const { home, session, transport } = await guardedSession();
    const write = session.agent.state.tools.find((tool) => tool.name === "outpost_write");
    expect(write).toBeDefined();

    await write?.execute("call_1", { path: "PWNED.txt", content: "hello" }, undefined, undefined);

    expect(transport.calls).toEqual(['write:{"path":"PWNED.txt","content":"hello"}']);
    // The session's own working directory is the only local place the tool
    // could plausibly have written to, and it stays empty.
    expect(await readdir(home.cwd)).toEqual([]);
  });

  it("never advertises a local tool in the system prompt", async () => {
    const { session } = await guardedSession();
    const prompt = session.systemPrompt;
    for (const name of OUTPOST_TOOL_NAMES) {
      expect(prompt).toContain(name);
    }
    // Pi lists tools one per line as "- <name>: ...". A bare built-in name in
    // that position would mean a local tool was described to the model.
    for (const local of PI_LOCAL_TOOL_NAMES) {
      expect(prompt).not.toMatch(new RegExp(`^\\s*[-*]?\\s*${local}\\b`, "m"));
    }
    expect(prompt).toContain("no local shell and no local file tools");
  });

  it("keeps all automatic homestead resource discovery disabled", async () => {
    const options = buildPiResourceLoaderOptions();
    expect(options.noExtensions).toBe(true);
    expect(options.noSkills).toBe(true);
    expect(options.noContextFiles).toBe(true);
    expect(options.noPromptTemplates).toBe(true);
  });

  it("injects only the virtual homestead and outpost context selected by the harness", async () => {
    const contextFiles = [
      { path: "homestead:/AGENTS.md", content: "GLOBAL_HOMESTEAD_CONTEXT" },
      { path: "outpost:/AGENTS.md", content: "OUTPOST_ROOT_CONTEXT" },
      { path: "outpost:/project/CLAUDE.md", content: "OUTPOST_PROJECT_CONTEXT" },
    ];
    const { session } = await guardedSession(undefined, undefined, contextFiles);

    expect(session.systemPrompt).toContain("GLOBAL_HOMESTEAD_CONTEXT");
    expect(session.systemPrompt).toContain("OUTPOST_ROOT_CONTEXT");
    expect(session.systemPrompt).toContain("OUTPOST_PROJECT_CONTEXT");
    expect(session.systemPrompt.indexOf("GLOBAL_HOMESTEAD_CONTEXT")).toBeLessThan(
      session.systemPrompt.indexOf("OUTPOST_ROOT_CONTEXT")
    );
    expect(session.agent.state.tools.map((tool) => tool.name).sort()).toEqual(
      [...OUTPOST_TOOL_NAMES].sort()
    );
  });

  /**
   * Persisting the conversation must not widen anything. It changes only where
   * Pi keeps its transcript, and a session that keeps one on the homestead's
   * disk is exactly the session most worth checking: it is the shape every
   * real deployment runs.
   */
  it("keeps the same allowlist and the same empty working directory when persisted", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "openoutposts-containment-state-"));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
    const sessionFile = join(stateDir, "pi-sessions", "sess_1.jsonl");

    const { home, session } = await guardedSession(undefined, sessionFile);

    expect(session.agent.state.tools.map((tool) => tool.name).sort()).toEqual(
      [...OUTPOST_TOOL_NAMES].sort()
    );
    expect(session.getActiveToolNames().sort()).toEqual([...OUTPOST_TOOL_NAMES].sort());
    // The transcript is the only thing that reaches the disk, and it reaches
    // the state directory rather than anywhere the model can see.
    expect(await readdir(home.cwd)).toEqual([]);
    expect(await readdir(join(stateDir, "pi-sessions"))).toEqual(["sess_1.jsonl"]);
  });

  // The boundary must be the allowlist itself. A suppression flag is not a
  // boundary, and `noTools: "all"` silently discards customTools as well.
  it("configures tools with an explicit allowlist rather than a suppression flag", () => {
    const options = buildPiToolOptions([]) as Record<string, unknown>;
    expect(options.tools).toEqual([...OUTPOST_TOOL_NAMES]);
    expect(options).not.toHaveProperty("noTools");
    expect(options).not.toHaveProperty("excludeTools");
  });
});

/**
 * Negative controls. Each one shows the escape the guarded configuration is
 * closing actually exists in this version of Pi. If one of these ever starts
 * failing, the corresponding assertion above has stopped proving anything and
 * the guard must be re-derived rather than trusted.
 */
describe("containment negative controls", () => {
  it("an unguarded Pi session hands the model local filesystem and shell tools", async () => {
    const session = await unguardedSession({});
    const visible = session.agent.state.tools.map((tool) => tool.name);
    expect(visible).toContain("bash");
    expect(visible).toContain("write");
  });

  // The exact trap the guarded configuration avoids: `noTools: "builtin"` is
  // not a boundary. It suppresses the seven built-ins but, by design, leaves
  // extension-registered tools enabled — so a tool file in the session's own
  // working directory reaches the model.
  it("noTools:'builtin' still lets a rogue extension's local tool reach the model", async () => {
    const session = await unguardedSession(
      { noTools: "builtin", customTools: createOutpostTools(recordingTransport()) },
      ROGUE_LOCAL_TOOL
    );
    const visible = session.agent.state.tools.map((tool) => tool.name);
    expect(visible).toContain("local_shell");
    for (const local of PI_LOCAL_TOOL_NAMES) {
      expect(visible).not.toContain(local);
    }
  });
});
