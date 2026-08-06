import { describe, expect, it, vi } from "vitest";

import type { PromptAuthor } from "@openoutposts/outpost-protocol";

import type { OutpostClient } from "../outpost-client.js";
import { IssuedCredentialStore } from "./credential-store.js";
import type * as SessionModule from "./session.js";
import type { OutpostToolTransport } from "./tools.js";

/**
 * The transport the harness hands Pi, captured at session creation. It is the
 * only place a turn's git identity can be observed: the identity is applied to
 * outpost operations, not to anything the harness returns.
 */
const captured = vi.hoisted(() => ({
  transport: null as OutpostToolTransport | null,
  listeners: [] as ((event: unknown) => void)[],
}));

vi.mock("./session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    createOutpostAgentSession: (options: { transport: OutpostToolTransport }) => {
      captured.transport = options.transport;
      captured.listeners = [];
      return Promise.resolve({
        session: {
          sessionId: "pi-session-fake",
          getActiveToolNames: () => ["outpost_bash"],
          subscribe: (listener: (event: unknown) => void) => {
            captured.listeners.push(listener);
            return () => {};
          },
          prompt: () => {
            for (const listener of captured.listeners) listener({ type: "agent_settled" });
            return Promise.resolve();
          },
          abort: () => Promise.resolve(),
          dispose: () => {},
        },
        resumed: false,
        recovered: false,
        entryCount: 0,
        messageCount: 0,
      });
    },
  };
});

const { PiHarness } = await import("./harness.js");

function fakeOutposts() {
  const client = {
    createLease: vi
      .fn()
      .mockResolvedValue({ leaseId: "lease_1", expiresAt: "2026-01-01T00:00:00Z" }),
    renewLease: vi.fn().mockResolvedValue(undefined),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    cancelLeaseWork: vi.fn().mockResolvedValue(undefined),
    readContext: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ ok: true, output: {} }),
  };
  return client as unknown as OutpostClient & typeof client;
}

async function sessionAfterTurn(author?: PromptAuthor) {
  const outposts = fakeOutposts();
  const harness = new PiHarness({
    outposts,
    outpostId: "outpost-1",
    defaultModel: "anthropic/claude-sonnet-4-5",
    loadGlobalContext: () => Promise.resolve([]),
    credentials: new IssuedCredentialStore({
      providerId: "anthropic",
      issue: () => Promise.resolve({ apiKey: "sk-ant-test" }),
    }),
  });
  const session = await harness.createSession({
    productSessionId: "sess_1",
    workspacePath: "/repos/demo",
  });
  if (author !== undefined) {
    for await (const _event of harness.sendPrompt(session, { content: "commit it", author })) {
      // The turn's events are irrelevant here; running it is what sets the author.
    }
  }
  return { harness, session, outposts };
}

/** The command as it actually reached the outpost. */
function lastCommand(outposts: ReturnType<typeof fakeOutposts>): string {
  const call = outposts.callTool.mock.calls.at(-1);
  return String((call?.[3] as { command?: unknown } | undefined)?.command ?? "");
}

describe("git identity on outpost operations", () => {
  /**
   * The control plane resolves the author's git identity per message and the
   * product shows the resulting commit under that person's name. Before this
   * was applied, every commit carried whatever identity the outpost machine
   * happened to have configured.
   */
  it("stamps the message author onto shell commands the turn runs", async () => {
    const { harness, session, outposts } = await sessionAfterTurn({
      userId: "user-1",
      gitIdentity: { mode: "attributed-user", name: "Ada Lovelace", email: "ada@example.com" },
    });

    await captured.transport?.call("bash", { command: "git commit -m fix" });

    const command = lastCommand(outposts);
    expect(command).toContain("GIT_AUTHOR_NAME='Ada Lovelace'");
    expect(command).toContain("GIT_AUTHOR_EMAIL='ada@example.com'");
    expect(command).toContain("GIT_COMMITTER_NAME='Ada Lovelace'");
    expect(command).toContain("GIT_COMMITTER_EMAIL='ada@example.com'");
    expect(command).toContain("git commit -m fix");

    await harness.close(session);
  });

  /**
   * An unattributed turn must still commit as somebody chosen on purpose.
   * Leaving the variables unset hands the commit to the machine's own git
   * configuration, which is the outpost owner rather than the agent.
   */
  it("commits under a deliberate agent identity when no user is attributed", async () => {
    const { harness, session, outposts } = await sessionAfterTurn({
      userId: "user-1",
      gitIdentity: { mode: "agent-only" },
    });

    await captured.transport?.call("bash", { command: "git commit -m fix" });

    const command = lastCommand(outposts);
    expect(command).toContain("GIT_AUTHOR_NAME='OpenOutposts'");
    expect(command).toContain("GIT_AUTHOR_EMAIL='openoutposts@noreply.github.com'");

    await harness.close(session);
  });

  it("uses the agent identity before any turn has run", async () => {
    const { harness, session, outposts } = await sessionAfterTurn();

    await captured.transport?.call("bash", { command: "git log -1" });

    expect(lastCommand(outposts)).toContain("GIT_AUTHOR_NAME='OpenOutposts'");

    await harness.close(session);
  });

  /** The name and email come from a source control profile: user-written text. */
  it("escapes an identity that contains shell syntax", async () => {
    const { harness, session, outposts } = await sessionAfterTurn({
      userId: "user-1",
      gitIdentity: {
        mode: "attributed-user",
        name: "Ada'; rm -rf /tmp/x #",
        email: "ada@example.com",
      },
    });

    await captured.transport?.call("bash", { command: "git commit -m fix" });

    const command = lastCommand(outposts);
    expect(command).toContain(`GIT_AUTHOR_NAME='Ada'\\''; rm -rf /tmp/x #'`);
    expect(command).not.toMatch(/GIT_AUTHOR_NAME='Ada'; rm/);

    await harness.close(session);
  });

  it("leaves operations that are not a shell untouched", async () => {
    const { harness, session, outposts } = await sessionAfterTurn({
      userId: "user-1",
      gitIdentity: { mode: "attributed-user", name: "Ada", email: "ada@example.com" },
    });

    await captured.transport?.call("read", { path: "README.md" });

    expect(outposts.callTool.mock.calls.at(-1)?.[3]).toEqual({ path: "README.md" });

    await harness.close(session);
  });
});
