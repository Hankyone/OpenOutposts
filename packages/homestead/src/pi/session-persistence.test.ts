import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPiAgentHome } from "./agent-home.js";
import { IssuedCredentialStore } from "./credential-store.js";
import { openPersistedSessionManager } from "./session-persistence.js";
import { createOutpostAgentSession } from "./session.js";
import type { OutpostToolTransport } from "./tools.js";

/**
 * The agent lives on the homestead machine, so a homestead restart must find
 * the conversation where it left it. These tests build real Pi sessions
 * through the harness's own factory — no prompt is sent and no model is
 * called — and assert against the file that is actually written.
 */

const OFFLINE_MODEL = "anthropic/claude-sonnet-4-5";

/**
 * A key that would be unmistakable in the transcript if anything ever wrote a
 * credential there. It is the negative control for "nothing secret lands on
 * disk": the session is given a real credential store and the file is then
 * searched for what it holds.
 */
const FAKE_PROVIDER_KEY = "sk-ant-persistence-canary-do-not-store";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const idleTransport: OutpostToolTransport = {
  call: () => Promise.resolve({ ok: true, output: {} }),
};

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openoutposts-pi-state-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Starts a session persisting to `sessionFile`, exactly as the harness does. */
async function persistedSession(sessionFile: string) {
  const home = await createPiAgentHome();
  cleanups.push(() => home.remove());
  const created = await createOutpostAgentSession({
    home,
    transport: idleTransport,
    model: OFFLINE_MODEL,
    credentials: new IssuedCredentialStore({
      providerId: "anthropic",
      issue: () => Promise.resolve({ apiKey: FAKE_PROVIDER_KEY }),
    }),
    persistence: { sessionFile },
  });
  cleanups.push(async () => created.session.dispose());
  return created;
}

describe("openPersistedSessionManager", () => {
  it("creates the conversation owner-only, in an owner-only directory", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");

    const opened = await openPersistedSessionManager(sessionFile, dir);

    expect(opened.resumed).toBe(false);
    expect(opened.recovered).toBe(false);
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(sessionFile))).mode & 0o777).toBe(0o700);
  });

  it("keeps the file owner-only after the agent has written to it", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");

    // Pi rewrites the header and then appends; both must preserve the mode the
    // empty file was created with, because Pi has no mode option of its own.
    await persistedSession(sessionFile);

    expect((await readFile(sessionFile, "utf8")).length).toBeGreaterThan(0);
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
  });

  it("does not truncate a conversation it is opening again", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");

    await persistedSession(sessionFile);
    const first = await readFile(sessionFile, "utf8");
    expect(first).toContain('"type":"session"');

    const reopened = await openPersistedSessionManager(sessionFile, dir);
    expect(reopened.recovered).toBe(false);
    expect(reopened.entryCount).toBeGreaterThan(0);
    expect(await readFile(sessionFile, "utf8")).toBe(first);
  });

  /**
   * An agent that refuses to start because of its own history is worse than
   * one that starts fresh, so an unreadable file is set aside rather than
   * repaired or deleted: it is the only copy of what was said.
   */
  it("sets an unreadable conversation aside and starts a new one", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");
    await openPersistedSessionManager(sessionFile, dir);
    await writeFile(sessionFile, "this is not a pi session at all\n");

    const opened = await openPersistedSessionManager(sessionFile, dir);

    expect(opened.recovered).toBe(true);
    expect(opened.resumed).toBe(false);
    expect(opened.entryCount).toBe(0);
    const files = await readdir(dirname(sessionFile));
    const setAside = files.filter((file) => file.startsWith("sess_1.jsonl.corrupt-"));
    expect(setAside).toHaveLength(1);
    expect(await readFile(join(dirname(sessionFile), setAside[0]), "utf8")).toBe(
      "this is not a pi session at all\n"
    );
  });

  it("reports a conversation whose working directory no longer exists", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");
    // The scratch home is recreated per session start, so the cwd recorded in
    // the header always names a directory that is gone by the next restart.
    await persistedSession(sessionFile);

    const opened = await openPersistedSessionManager(sessionFile, "/nonexistent-scratch");
    expect(opened.manager.getCwd()).toBe("/nonexistent-scratch");
  });
});

describe("a persisted outpost agent session", () => {
  it("comes back with the conversation it was having", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");

    const first = await persistedSession(sessionFile);
    expect(first.resumed).toBe(false);
    expect(first.messageCount).toBe(0);
    // Stand in for a turn: the agent appends its own messages, so writing one
    // through the session manager is the same path a real turn takes.
    first.session.sessionManager.appendMessage({
      role: "user",
      content: "what did we decide about the retry budget?",
      timestamp: Date.now(),
    });

    // The homestead restarts: new process, new scratch home, same file.
    const second = await persistedSession(sessionFile);

    expect(second.resumed).toBe(true);
    expect(second.messageCount).toBe(1);
    expect(second.recovered).toBe(false);
    expect(second.session.agent.state.messages).toHaveLength(1);
    expect(JSON.stringify(second.session.agent.state.messages)).toContain("retry budget");
  });

  it("starts fresh rather than failing when the stored conversation is corrupt", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");
    await persistedSession(sessionFile);
    await writeFile(sessionFile, "{ half a line");

    const restarted = await persistedSession(sessionFile);

    expect(restarted.recovered).toBe(true);
    expect(restarted.resumed).toBe(false);
    expect(restarted.session.agent.state.messages).toHaveLength(0);
  });

  /**
   * Negative control for keeping conversations on disk at all. The session is
   * given a live credential store; if Pi ever fell back to a file-backed one,
   * or if an entry carried the key it was answered with, both would show up
   * here — the first as an extra file, the second in the transcript itself.
   */
  it("writes the conversation and nothing else, with no credential in it", async () => {
    const dir = await stateDir();
    const sessionFile = join(dir, "pi-sessions", "sess_1.jsonl");

    const created = await persistedSession(sessionFile);
    created.session.sessionManager.appendMessage({
      role: "user",
      content: "use the key you were given",
      timestamp: Date.now(),
    });

    expect(await readdir(dirname(sessionFile))).toEqual(["sess_1.jsonl"]);
    const transcript = await readFile(sessionFile, "utf8");
    expect(transcript).not.toContain(FAKE_PROVIDER_KEY);
    expect(transcript).not.toContain("sk-ant");
    expect(transcript).not.toContain("apiKey");
  });
});
