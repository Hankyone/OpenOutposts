/**
 * The audit record against a real engine.
 *
 * Two things can only be proven here. First, append-only: migration 0049
 * installs `BEFORE UPDATE` and `BEFORE DELETE` triggers, and only a real SQLite
 * engine can be asked to violate them. Second, that the write points are
 * actually wired — a record nobody writes is worth exactly as much as no table
 * at all, so the flows below drive the real worker path (enroll a machine, take
 * a lease for a session with a real owner, run a command, release, remove) and
 * read back what the deployment recorded.
 *
 * `cleanD1Tables` deliberately does not clear `audit_log`, and could not: the
 * delete trigger would abort it. Every test therefore scopes its reads to its
 * own machine, session or user.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";

import { AuditLogStore, type AuditQuery, type AuditRecord } from "../../src/db/audit-log";
import { SessionIndexStore } from "../../src/db/session-index";
import { UserProviderCredentialStore } from "../../src/db/user-provider-credentials";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  connectConfirmedOutpost,
  createSignedInUser,
  initNamedSession,
  seedConfirmedOutpost,
  seedSandboxAuth,
  homesteadFetch,
} from "./helpers";

const MODEL = "anthropic/claude-haiku-4-5";

/** A command with a secret in it — the exact thing the record must not keep. */
const SECRET_COMMAND = "curl -H 'Authorization: Bearer sk-live-supersecret' https://example.test";

function audit(): AuditLogStore {
  return new AuditLogStore(env.DB);
}

/**
 * Durable Object audit writes ride on `waitUntil`, so they settle after the
 * response the test already has. Polling is how a test observes them without
 * pretending the write is synchronous.
 */
async function waitForRecords(
  query: AuditQuery,
  count: number,
  timeoutMs = 3000
): Promise<AuditRecord[]> {
  const deadline = Date.now() + timeoutMs;
  let records: AuditRecord[] = [];
  while (Date.now() < deadline) {
    records = await audit().list(query);
    if (records.length >= count) return records;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Expected at least ${count} audit records for ${JSON.stringify(query)}, saw ${records.length}: ` +
      records.map((record) => record.action).join(", ")
  );
}

function actions(records: AuditRecord[]): string[] {
  // list() is newest first; an auditor reads a timeline forwards.
  return [...records].reverse().map((record) => record.action);
}

/** Every string a record holds, for "this text is nowhere in the row" checks. */
function textOf(record: AuditRecord): string {
  return Object.values(record)
    .filter((value): value is string => typeof value === "string")
    .join("\u0000");
}

async function createOwnedSession(sessionId: string, ownerUserId: string | null): Promise<void> {
  const now = Date.now();
  await new SessionIndexStore(env.DB).create({
    id: sessionId,
    title: "Audited session",
    repoOwner: "acme",
    repoName: "web-app",
    model: MODEL,
    reasoningEffort: null,
    baseBranch: "main",
    status: "created",
    userId: ownerUserId,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Connect a machine and act as its worker: accept every lease offer, answer
 * every tool request. Mirrors outpost-websocket.test.ts.
 */
async function connectWorker(
  outpostId: string,
  owner?: { userId: string; accessToken: string }
): Promise<WebSocket> {
  const machine = await seedConfirmedOutpost(outpostId, owner);
  const { ws } = await connectConfirmedOutpost(machine);
  if (!ws) throw new Error("WebSocket upgrade failed");

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
      string,
      unknown
    >;
    if (message.type === "lease.offer") {
      ws.send(
        JSON.stringify({
          type: "lease.accepted",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          leaseId: message.leaseId,
        })
      );
    }
    if (message.type === "tool.request") {
      ws.send(
        JSON.stringify({
          type: "tool.result",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          requestId: message.requestId,
          leaseId: message.leaseId,
          ok: true,
          output: {
            stdout: "sk-live-supersecret leaked into stdout\n",
            stderr: "",
            exitCode: 0,
            durationMs: 5,
            truncated: false,
          },
        })
      );
    }
  });

  const registered = collectMessages(ws, {
    until: (message) => message.type === "outpost.registered",
  });
  ws.send(
    JSON.stringify({
      type: "outpost.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      outpostId,
      name: "Audited workstation",
      workerVersion: "0.1.0-test",
      capabilities: {
        platform: "darwin",
        architecture: "arm64",
        operations: ["bash", "read", "write", "edit", "grep", "find", "ls"],
        workspaceRoots: ["/workspace"],
      },
    })
  );
  await registered;
  return ws;
}

function userFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: string }
): Promise<Response> {
  return SELF.fetch(`https://test.local${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init?.body,
  });
}

describe("audit log", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  afterEach(async () => {
    await cleanD1Tables();
  });

  describe("append-only", () => {
    it("refuses to update a record that has been written", async () => {
      const record = await audit().record({
        action: "outpost.enrolled",
        outcome: "success",
        actor: { kind: "outpost" },
        outpostId: "immutable-01",
      });

      await expect(
        env.DB.prepare("UPDATE audit_log SET action = ? WHERE id = ?")
          .bind("outpost.removed", record.id)
          .run()
      ).rejects.toThrow(/append-only/);

      const [stored] = await audit().list({ outpostId: "immutable-01" });
      expect(stored.action).toBe("outpost.enrolled");
    });

    it("refuses to delete a record", async () => {
      const record = await audit().record({
        action: "outpost.enrolled",
        outcome: "success",
        actor: { kind: "outpost" },
        outpostId: "undeletable-01",
      });

      await expect(
        env.DB.prepare("DELETE FROM audit_log WHERE id = ?").bind(record.id).run()
      ).rejects.toThrow(/append-only/);
      await expect(env.DB.prepare("DELETE FROM audit_log").run()).rejects.toThrow(/append-only/);

      expect(await audit().list({ outpostId: "undeletable-01" })).toHaveLength(1);
    });

    it("aborts a bulk delete as a unit rather than partially applying it", async () => {
      await audit().record({
        action: "outpost.enrolled",
        outcome: "success",
        actor: { kind: "outpost" },
        outpostId: "bulk-a",
      });
      await audit().record({
        action: "outpost.removed",
        outcome: "success",
        actor: { kind: "outpost" },
        outpostId: "bulk-b",
      });

      await expect(
        env.DB.prepare("DELETE FROM audit_log WHERE outpost_id IN ('bulk-a', 'bulk-b')").run()
      ).rejects.toThrow(/append-only/);

      expect(await audit().list({ outpostId: "bulk-a" })).toHaveLength(1);
      expect(await audit().list({ outpostId: "bulk-b" })).toHaveLength(1);
    });
  });

  describe("machines, leases and commands", () => {
    it("records the lifecycle with the identity the authority descends from", async () => {
      const owner = await createSignedInUser("audit-owner-1");
      const outpostId = `audited-${Date.now()}`;
      const sessionId = `audit-session-${Date.now()}`;
      await createOwnedSession(sessionId, owner.userId);

      const ws = await connectWorker(outpostId, owner);

      const leaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpostId}/leases`,
        {
          method: "POST",
          body: JSON.stringify({
            productSessionId: sessionId,
            workspacePath: "/workspace/project",
          }),
        }
      );
      expect(leaseResponse.status).toBe(201);
      const lease = (await leaseResponse.json()) as { leaseId: string };

      const toolResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
        method: "POST",
        body: JSON.stringify({
          leaseId: lease.leaseId,
          operation: "bash",
          input: { command: SECRET_COMMAND },
        }),
      });
      expect(toolResponse.status).toBe(200);

      const releaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpostId}/leases/${lease.leaseId}`,
        { method: "DELETE", body: JSON.stringify({ reason: "completed" }) }
      );
      expect(releaseResponse.status).toBe(200);

      const records = await waitForRecords({ outpostId }, 4);
      expect(actions(records)).toEqual([
        "outpost.enrolled",
        "lease.granted",
        "outpost.tool_call",
        "lease.released",
      ]);

      const byAction = new Map(records.map((record) => [record.action, record]));

      // Enrollment has no person behind it yet: today it is possession of the
      // deployment-wide credential, and the machine is its own actor.
      expect(byAction.get("outpost.enrolled")).toMatchObject({
        actorKind: "outpost",
        actorUserId: null,
        outpostId,
      });

      // The grant, and everything under it, names the session's owner. The
      // kind is `service` because the homestead now signs as itself: the
      // record says which service acted and for whom, where the retired
      // deployment-wide bearer could only say "internal".
      expect(byAction.get("lease.granted")).toMatchObject({
        actorKind: "service",
        actorUserId: owner.userId,
        sessionId,
        outpostId,
        leaseId: lease.leaseId,
        outcome: "success",
      });
      expect(byAction.get("outpost.tool_call")).toMatchObject({
        actorUserId: owner.userId,
        sessionId,
        outpostId,
        leaseId: lease.leaseId,
        objectKind: "outpost_operation",
        objectId: "bash",
        outcome: "success",
      });
      expect(byAction.get("outpost.tool_call")?.durationMs).toBeGreaterThanOrEqual(0);
      expect(byAction.get("lease.released")).toMatchObject({
        actorUserId: owner.userId,
        leaseId: lease.leaseId,
        reason: "completed",
      });

      ws.close(1000, "test complete");
    });

    it("keeps the command and its output out of the record", async () => {
      const owner = await createSignedInUser("audit-owner-2");
      const outpostId = `noleak-${Date.now()}`;
      const sessionId = `noleak-session-${Date.now()}`;
      await createOwnedSession(sessionId, owner.userId);

      const ws = await connectWorker(outpostId, owner);

      const leaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpostId}/leases`,
        {
          method: "POST",
          body: JSON.stringify({
            productSessionId: sessionId,
            workspacePath: "/workspace/project",
          }),
        }
      );
      const lease = (await leaseResponse.json()) as { leaseId: string };

      await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
        method: "POST",
        body: JSON.stringify({
          leaseId: lease.leaseId,
          operation: "bash",
          input: { command: SECRET_COMMAND },
        }),
      });

      const [toolCall] = await waitForRecords({ outpostId, action: "outpost.tool_call" }, 1);
      const text = textOf(toolCall);
      expect(text).not.toContain("sk-live-supersecret");
      expect(text).not.toContain("curl");
      expect(text).not.toContain("leaked into stdout");
      expect(text).not.toContain("/workspace/project");
      // What it does carry is the operation, which is the attributable part.
      expect(toolCall.objectId).toBe("bash");

      ws.close(1000, "test complete");
    });

    it("records an attempt to use a lease that is no longer active", async () => {
      const owner = await createSignedInUser("audit-owner-3");
      const outpostId = `denied-${Date.now()}`;
      const sessionId = `denied-session-${Date.now()}`;
      await createOwnedSession(sessionId, owner.userId);

      const ws = await connectWorker(outpostId, owner);

      const leaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpostId}/leases`,
        {
          method: "POST",
          body: JSON.stringify({
            productSessionId: sessionId,
            workspacePath: "/workspace/project",
          }),
        }
      );
      const lease = (await leaseResponse.json()) as { leaseId: string };

      await homesteadFetch(`https://test.local/outposts/${outpostId}/leases/${lease.leaseId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: "completed" }),
      });

      const afterRelease = await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
        method: "POST",
        body: JSON.stringify({
          leaseId: lease.leaseId,
          operation: "bash",
          input: { command: "echo hello" },
        }),
      });
      await expect(afterRelease.json()).resolves.toMatchObject({ errorCode: "lease_unknown" });

      const [denied] = await waitForRecords({ outpostId, action: "outpost.tool_call" }, 1);
      expect(denied).toMatchObject({
        outcome: "denied",
        reason: "lease_unknown",
        objectId: "bash",
        leaseId: lease.leaseId,
      });

      ws.close(1000, "test complete");
    });

    it("refuses a lease for a session with no recorded owner, and records the refusal", async () => {
      const outpostId = `unowned-${Date.now()}`;
      const sessionId = `unowned-session-${Date.now()}`;
      await createOwnedSession(sessionId, null);

      const ws = await connectWorker(outpostId);

      const leaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpostId}/leases`,
        {
          method: "POST",
          body: JSON.stringify({ productSessionId: sessionId, workspacePath: "/workspace" }),
        }
      );

      // A lease is shell access. A session nobody owns cannot establish that
      // anybody is entitled to this machine, so the grant is refused rather
      // than recorded as unattributed.
      expect(leaseResponse.status).toBe(403);

      const [rejected] = await waitForRecords({ sessionId, action: "lease.rejected" }, 1);
      expect(rejected).toMatchObject({
        outcome: "denied",
        reason: "session_unowned",
        actorKind: "service",
        actorUserId: null,
      });

      ws.close(1000, "test complete");
    });

    it("records a refusal to grant a lease on a machine that is not connected", async () => {
      const outpostId = `offline-${Date.now()}`;
      const sessionId = `offline-session-${Date.now()}`;
      const owner = await createSignedInUser("audit-owner-4");
      await createOwnedSession(sessionId, owner.userId);
      // Owned but never connected, so the refusal under test is the Durable
      // Object's rather than the ownership gate in front of it.
      await seedConfirmedOutpost(outpostId, owner);

      const response = await homesteadFetch(`https://test.local/outposts/${outpostId}/leases`, {
        method: "POST",
        body: JSON.stringify({ productSessionId: sessionId, workspacePath: "/workspace" }),
      });
      expect(response.status).toBe(409);

      const [rejected] = await waitForRecords({ sessionId, action: "lease.rejected" }, 1);
      expect(rejected).toMatchObject({
        outcome: "denied",
        reason: "outpost_disconnected",
        actorUserId: owner.userId,
      });
    });

    it("names the person who removed a machine, and ends every grant on it", async () => {
      const owner = await createSignedInUser("audit-remover");
      const outpostId = `removed-${Date.now()}`;
      const sessionId = `removed-session-${Date.now()}`;
      await createOwnedSession(sessionId, owner.userId);

      const ws = await connectWorker(outpostId, owner);
      const leaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpostId}/leases`,
        {
          method: "POST",
          body: JSON.stringify({ productSessionId: sessionId, workspacePath: "/workspace" }),
        }
      );
      const lease = (await leaseResponse.json()) as { leaseId: string };

      const removal = await userFetch(owner.accessToken, `/outposts/${outpostId}`, {
        method: "DELETE",
      });
      expect(removal.status).toBe(200);

      const records = await waitForRecords({ outpostId }, 4);
      // Enrolment and the grant genuinely precede the removal. The removal and
      // the release it causes are written together and have no guaranteed
      // order between them, so pinning one would be pinning a race.
      expect(actions(records).slice(0, 2)).toEqual(["outpost.enrolled", "lease.granted"]);
      expect(actions(records).slice(2).sort()).toEqual(["lease.released", "outpost.removed"]);

      const byAction = new Map(records.map((record) => [record.action, record]));
      expect(byAction.get("outpost.removed")).toMatchObject({
        actorKind: "user",
        actorUserId: owner.userId,
        outpostId,
      });
      expect(byAction.get("lease.released")).toMatchObject({
        reason: "cancelled",
        leaseId: lease.leaseId,
        actorUserId: owner.userId,
      });

      ws.close(1000, "test complete");
    });
  });

  describe("credentials", () => {
    it("records a vault entry being added, replaced and removed, never its material", async () => {
      const owner = await createSignedInUser("audit-vault-owner");

      const created = await userFetch(owner.accessToken, "/provider-credentials/anthropic", {
        method: "PUT",
        body: JSON.stringify({ apiKey: "sk-ant-original-0001", label: "laptop" }),
      });
      expect(created.status).toBe(201);

      const replaced = await userFetch(owner.accessToken, "/provider-credentials/anthropic", {
        method: "PUT",
        body: JSON.stringify({ apiKey: "sk-ant-rotated-0002" }),
      });
      expect(replaced.status).toBe(200);

      const deleted = await userFetch(owner.accessToken, "/provider-credentials/anthropic", {
        method: "DELETE",
      });
      expect(deleted.status).toBe(200);

      const records = await waitForRecords({ actorUserId: owner.userId }, 3);
      expect(actions(records)).toEqual([
        "credential.created",
        "credential.replaced",
        "credential.deleted",
      ]);
      for (const record of records) {
        expect(record).toMatchObject({
          actorKind: "user",
          objectKind: "provider_credential",
          objectId: "anthropic",
        });
        expect(textOf(record)).not.toContain("sk-ant");
      }
    });

    it("records an issuance to a session against the owner it was resolved from", async () => {
      const owner = await createSignedInUser("audit-issue-owner");
      const sessionId = `issue-session-${Date.now()}`;
      await createOwnedSession(sessionId, owner.userId);
      const { stub } = await initNamedSession(sessionId, { model: MODEL, userId: owner.userId });
      const fetchToken = `cf-tok-${sessionId}`;
      await seedSandboxAuth(stub, {
        authToken: `sb-tok-${sessionId}`,
        credentialFetchToken: fetchToken,
        sandboxId: `sb-${sessionId}`,
      });

      await new UserProviderCredentialStore(env.DB, env.TOKEN_ENCRYPTION_KEY).putApiKey({
        userId: owner.userId,
        provider: "anthropic",
        apiKey: "sk-ant-issued-0003",
      });

      const issued = await SELF.fetch(
        `https://test.local/sessions/${sessionId}/model-credentials`,
        { method: "POST", headers: { Authorization: `Bearer ${fetchToken}` } }
      );
      expect(issued.status).toBe(200);

      const [record] = await waitForRecords({ sessionId, action: "credential.issued" }, 1);
      expect(record).toMatchObject({
        outcome: "success",
        actorKind: "sandbox",
        actorUserId: owner.userId,
        objectKind: "provider_credential",
        objectId: "anthropic",
      });
      expect(textOf(record)).not.toContain("sk-ant");
    });

    it("records a refused issuance with why it was refused", async () => {
      const owner = await createSignedInUser("audit-refuse-owner");
      const sessionId = `refuse-session-${Date.now()}`;
      await createOwnedSession(sessionId, owner.userId);
      const { stub } = await initNamedSession(sessionId, { model: MODEL, userId: owner.userId });
      const fetchToken = `cf-tok-${sessionId}`;
      await seedSandboxAuth(stub, {
        authToken: `sb-tok-${sessionId}`,
        credentialFetchToken: fetchToken,
        sandboxId: `sb-${sessionId}`,
      });

      // No vault entry for the session's owner.
      const refused = await SELF.fetch(
        `https://test.local/sessions/${sessionId}/model-credentials`,
        { method: "POST", headers: { Authorization: `Bearer ${fetchToken}` } }
      );
      expect(refused.status).toBe(404);

      const [record] = await waitForRecords({ sessionId, action: "credential.issue_denied" }, 1);
      expect(record).toMatchObject({
        outcome: "denied",
        reason: "no_credential",
        actorUserId: owner.userId,
        objectId: "anthropic",
      });
    });
  });
});
