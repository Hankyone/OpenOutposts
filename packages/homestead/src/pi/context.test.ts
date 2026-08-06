import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CONTEXT_MAX_BYTES } from "@openoutposts/outpost-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { loadHomesteadContext } from "./context.js";

const cleanups: string[] = [];

afterEach(async () => {
  for (const directory of cleanups.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function agentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openoutposts-global-context-"));
  cleanups.push(directory);
  return directory;
}

describe("homestead Pi context", () => {
  it("uses Pi's candidate priority and returns a virtual path", async () => {
    const directory = await agentDir();
    await writeFile(join(directory, "AGENTS.md"), "preferred", "utf8");
    await writeFile(join(directory, "CLAUDE.md"), "fallback", "utf8");

    await expect(loadHomesteadContext({ agentDir: directory })).resolves.toEqual([
      { path: "homestead:/AGENTS.md", content: "preferred" },
    ]);
  });

  it("falls through an unreadable candidate without exposing its real path", async () => {
    const directory = await agentDir();
    const warnings: string[] = [];
    await mkdir(join(directory, "AGENTS.md"));
    await writeFile(join(directory, "CLAUDE.md"), "fallback", "utf8");

    await expect(
      loadHomesteadContext({ agentDir: directory, onWarning: (message) => warnings.push(message) })
    ).resolves.toEqual([{ path: "homestead:/CLAUDE.md", content: "fallback" }]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((warning) => !warning.includes(directory))).toBe(true);
  });

  it("skips a global context file that exceeds the prompt budget", async () => {
    const directory = await agentDir();
    await writeFile(join(directory, "AGENTS.md"), "x".repeat(AGENT_CONTEXT_MAX_BYTES + 1), "utf8");

    await expect(loadHomesteadContext({ agentDir: directory })).resolves.toEqual([]);
  });
});
