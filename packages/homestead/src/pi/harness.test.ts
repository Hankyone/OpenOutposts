import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessEvent } from "../index.js";
import type { OutpostClient } from "../outpost-client.js";
import { IssuedCredentialStore, type ResolvedModelCredential } from "./credential-store.js";
import { ModelCredentialError } from "./model-credential.js";
import { PiHarness } from "./harness.js";
import { openPersistedSessionManager } from "./session-persistence.js";
import { createLeaseTransport } from "./tools.js";

vi.mock("./context.js", () => ({
  loadHomesteadContext: vi.fn().mockResolvedValue([]),
}));

/**
 * The lease machinery belongs to the outpost client and is exercised here only
 * through the Pi harness's own lifecycle. Sessions are built for
 * real but offline: Pi resolves the model from its bundled catalogue and no
 * prompt is ever sent.
 */
const OFFLINE_MODEL = "anthropic/claude-sonnet-4-5";

function fakeOutposts(overrides: Partial<Record<keyof OutpostClient, unknown>> = {}) {
  const client = {
    createLease: vi
      .fn()
      .mockResolvedValue({ leaseId: "lease_1", expiresAt: "2026-01-01T00:00:00Z" }),
    renewLease: vi
      .fn()
      .mockResolvedValue({ leaseId: "lease_1", expiresAt: "2026-01-01T00:00:00Z" }),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    cancelLeaseWork: vi.fn().mockResolvedValue(undefined),
    readContext: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ ok: true, output: {} }),
    ...overrides,
  };
  return client as unknown as OutpostClient & typeof client;
}

describe("PiHarness", () => {
  it("leases the workspace before starting the agent and releases it on close", async () => {
    const outposts = fakeOutposts();
    const harness = new PiHarness({
      outposts,
      outpostId: "outpost-1",
      defaultModel: OFFLINE_MODEL,
      leaseTtlMs: 60_000,
    });

    const session = await harness.createSession({
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
    });
    expect(session.harness).toBe("pi");
    expect(session.productSessionId).toBe("sess_1");
    expect(outposts.createLease).toHaveBeenCalledWith({
      outpostId: "outpost-1",
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
      ttlMs: 60_000,
    });
    expect(outposts.readContext).toHaveBeenCalledWith("outpost-1", "lease_1");

    await harness.close(session);
    expect(outposts.releaseLease).toHaveBeenCalledWith("outpost-1", "lease_1", "completed");
    // Closing twice must not release a lease that is already gone.
    await harness.close(session);
    expect(outposts.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("gives the lease back when the agent fails to start", async () => {
    const outposts = fakeOutposts();
    const harness = new PiHarness({
      outposts,
      outpostId: "outpost-1",
      defaultModel: "anthropic/no-such-model",
    });

    await expect(
      harness.createSession({ productSessionId: "sess_1", workspacePath: "/repos/demo" })
    ).rejects.toThrow(/no-such-model/);
    expect(outposts.releaseLease).toHaveBeenCalledWith("outpost-1", "lease_1", "cancelled");
  });

  it("gives the lease back when workspace context cannot be loaded", async () => {
    const outposts = fakeOutposts({
      readContext: vi.fn().mockRejectedValue(new Error("context unavailable")),
    });
    const harness = new PiHarness({
      outposts,
      outpostId: "outpost-1",
      defaultModel: OFFLINE_MODEL,
    });

    await expect(
      harness.createSession({ productSessionId: "sess_1", workspacePath: "/repos/demo" })
    ).rejects.toThrow("context unavailable");
    expect(outposts.releaseLease).toHaveBeenCalledWith("outpost-1", "lease_1", "cancelled");
  });

  // Aborting the model does not stop a command already running on the outpost.
  it("cancels in-flight outpost work when a turn is interrupted", async () => {
    const outposts = fakeOutposts();
    const harness = new PiHarness({
      outposts,
      outpostId: "outpost-1",
      defaultModel: OFFLINE_MODEL,
    });
    const session = await harness.createSession({
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
    });

    await harness.interrupt(session);
    expect(outposts.cancelLeaseWork).toHaveBeenCalledWith("outpost-1", "lease_1");
    await harness.close(session);
  });

  /**
   * The product lets a user change a running session's model, and the change
   * has to reach the model that answers. A model the homestead cannot reach must
   * stop the turn by name — the failure it replaces was the assignment-time
   * model quietly answering under the new one's label.
   */
  describe("when a turn asks for a different model", () => {
    function harnessWithLiveCredential() {
      return new PiHarness({
        outposts: fakeOutposts(),
        outpostId: "outpost-1",
        defaultModel: OFFLINE_MODEL,
        credentials: new IssuedCredentialStore({
          providerId: "anthropic",
          issue: () => Promise.resolve({ apiKey: "sk-ant-test" }),
        }),
      });
    }

    it("stops the turn when the agent does not have that model", async () => {
      const harness = harnessWithLiveCredential();
      const session = await harness.createSession({
        productSessionId: "sess_1",
        workspacePath: "/repos/demo",
      });

      const events: HarnessEvent[] = [];
      for await (const event of harness.sendPrompt(session, {
        content: "carry on",
        model: "anthropic/no-such-model",
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("turn.failed");
      const message = events[0]?.type === "turn.failed" ? events[0].message : "";
      expect(message).toContain("anthropic/no-such-model");
      expect(message).toContain("stopped");

      await harness.close(session);
    });

    /**
     * The session holds one provider's credential. Handing Pi a model from
     * another provider would find no stored credential for it, and Pi reads a
     * missing credential as permission to use the process environment — the
     * homestead operator's own key, standing in for the session owner's.
     */
    it("stops the turn when the model belongs to a provider this session has no credential for", async () => {
      const harness = harnessWithLiveCredential();
      const session = await harness.createSession({
        productSessionId: "sess_1",
        workspacePath: "/repos/demo",
      });

      const events: HarnessEvent[] = [];
      for await (const event of harness.sendPrompt(session, {
        content: "carry on",
        model: "openai/gpt-5.4",
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      const message = events[0]?.type === "turn.failed" ? events[0].message : "";
      expect(message).toContain("openai/gpt-5.4");
      expect(message).toContain("anthropic");

      await harness.close(session);
    });
  });

  it("rejects prompts for a session it does not own", () => {
    const harness = new PiHarness({ outposts: fakeOutposts(), outpostId: "outpost-1" });
    expect(() =>
      harness.sendPrompt(
        { productSessionId: "sess_1", harnessSessionId: "nope", harness: "pi" },
        { content: "hi" }
      )
    ).toThrow(/Unknown harness session/);
  });

  /**
   * The credential is re-issued at every turn boundary, which is what gives
   * revoking one any effect on a session that is already running. The session
   * below starts on a working credential and then has it revoked, exactly as a
   * user removing a vault entry between two prompts would.
   */
  describe("when the session's credential is revoked after it starts", () => {
    /** An issuer that works once — the session start — and then refuses. */
    function issuerRevokedAfterFirstUse() {
      const state = { calls: 0 };
      const issue = (): Promise<ResolvedModelCredential> => {
        state.calls += 1;
        if (state.calls === 1) {
          return Promise.resolve({
            apiKey: "sk-ant-live",
            expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
          });
        }
        return Promise.reject(
          new ModelCredentialError(
            "control plane refused to issue a credential (HTTP 404): No credential is connected for provider 'anthropic'",
            { retryable: false, status: 404 }
          )
        );
      };
      return { state, issue };
    }

    it("stops the next turn instead of running it on the credential it already holds", async () => {
      const issuer = issuerRevokedAfterFirstUse();
      const harness = new PiHarness({
        outposts: fakeOutposts(),
        outpostId: "outpost-1",
        defaultModel: OFFLINE_MODEL,
        credentials: new IssuedCredentialStore({ providerId: "anthropic", issue: issuer.issue }),
      });
      const session = await harness.createSession({
        productSessionId: "sess_1",
        workspacePath: "/repos/demo",
      });

      const events: HarnessEvent[] = [];
      for await (const event of harness.sendPrompt(session, { content: "what changed?" }))
        events.push(event);

      // The turn never reached Pi: one terminal event and nothing else.
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("turn.failed");
      // Attributable, not generic: the provider, the control plane's own words,
      // and what the session's owner has to do about it.
      const message = events[0]?.type === "turn.failed" ? events[0].message : "";
      expect(message).toContain("anthropic");
      expect(message).toContain("No credential is connected");
      expect(message).toContain("account that owns this session");
      // Once at session start, once at the turn boundary that refused.
      expect(issuer.state.calls).toBe(2);

      await harness.close(session);
    });
  });

  it("still starts a session whose credential cannot be resolved, and refuses every turn", async () => {
    const logs: string[] = [];
    const harness = new PiHarness({
      outposts: fakeOutposts(),
      outpostId: "outpost-1",
      defaultModel: OFFLINE_MODEL,
      credentials: new IssuedCredentialStore({
        providerId: "anthropic",
        issue: () =>
          Promise.reject(
            new ModelCredentialError("could not reach the control plane: ECONNREFUSED", {
              retryable: true,
            })
          ),
      }),
      onLog: (line) => logs.push(line),
    });

    // The product session and its history are worth more than a clean refusal,
    // so the session starts — but it says why every turn will refuse.
    const session = await harness.createSession({
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
    });
    expect(logs.join("\n")).toContain("no usable provider credential");

    const events: HarnessEvent[] = [];
    for await (const event of harness.sendPrompt(session, { content: "hello" })) events.push(event);
    expect(events).toEqual([
      {
        type: "turn.failed",
        message: expect.stringContaining("could not be refreshed") as unknown as string,
      },
    ]);

    await harness.close(session);
  });
});

/**
 * The agent lives on the homestead machine, so a restart must find the
 * conversation rather than a stranger. The harness's only part in that is
 * pointing Pi at one file per product session and saying which of the two
 * things happened.
 */
describe("PiHarness session persistence", () => {
  const stateDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function freshStateDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "homestead-pi-sessions-"));
    stateDirs.push(dir);
    return dir;
  }

  function persistingHarness(piSessionFile: string, logs: string[]) {
    return new PiHarness({
      outposts: fakeOutposts(),
      outpostId: "outpost-1",
      defaultModel: OFFLINE_MODEL,
      piSessionFile,
      onLog: (line) => logs.push(line),
    });
  }

  it("writes the session to the file it was given and reports it as fresh", async () => {
    const dir = await freshStateDir();
    const piSessionFile = join(dir, "sess_1.jsonl");
    const logs: string[] = [];
    const harness = persistingHarness(piSessionFile, logs);

    const session = await harness.createSession({
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
    });

    expect(logs.join("\n")).toContain(
      `no stored pi session; starting fresh and persisting to ${piSessionFile}`
    );
    expect(await readFile(piSessionFile, "utf8")).toContain('"type":"session"');
    expect((await stat(piSessionFile)).mode & 0o777).toBe(0o600);

    await harness.close(session);
  });

  it("resumes the conversation a previous homestead left on disk", async () => {
    const dir = await freshStateDir();
    const piSessionFile = join(dir, "sess_1.jsonl");
    // What the homestead that stopped would have left behind.
    const previous = await openPersistedSessionManager(piSessionFile, dir);
    previous.manager.appendMessage({
      role: "user",
      content: "carry on from where we were",
      timestamp: Date.now(),
    });

    const logs: string[] = [];
    const harness = persistingHarness(piSessionFile, logs);
    const session = await harness.createSession({
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
    });

    expect(logs.join("\n")).toContain(
      "resumed the pi session from disk with 1 entries and 1 prior messages"
    );

    await harness.close(session);
  });

  /**
   * A session can sleep for months and must wake into the conversation it was
   * having, so closing keeps the file for the same reason the state store keeps
   * a dormant record.
   */
  it("leaves the conversation on disk when the session closes", async () => {
    const dir = await freshStateDir();
    const piSessionFile = join(dir, "sess_1.jsonl");
    const harness = persistingHarness(piSessionFile, []);

    const session = await harness.createSession({
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
    });
    await harness.close(session);

    await expect(readFile(piSessionFile, "utf8")).resolves.toContain('"type":"session"');
  });

  it("says so when it was given nowhere to persist", async () => {
    const logs: string[] = [];
    const harness = new PiHarness({
      outposts: fakeOutposts(),
      outpostId: "outpost-1",
      defaultModel: OFFLINE_MODEL,
      onLog: (line) => logs.push(line),
    });

    const session = await harness.createSession({
      productSessionId: "sess_1",
      workspacePath: "/repos/demo",
    });

    expect(logs.join("\n")).toContain("not persisted and will not survive a restart");
    await harness.close(session);
  });
});

describe("createLeaseTransport", () => {
  it("carries the outpost and lease identity the model never sees", async () => {
    const outposts = fakeOutposts();
    const transport = createLeaseTransport(outposts, "outpost-1", "lease_1");

    await transport.call("bash", { command: "ls" }, 30_000);

    expect(outposts.callTool).toHaveBeenCalledWith(
      "outpost-1",
      "lease_1",
      "bash",
      { command: "ls" },
      30_000
    );
  });
});
