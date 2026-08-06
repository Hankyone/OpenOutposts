import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";
import type { SessionAssign } from "@openoutposts/outpost-protocol";

import { SessionStateStore, type PersistedSession } from "./state-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "homestead-state-"));
  dirs.push(dir);
  return { store: new SessionStateStore(dir), dir };
}

const entry: PersistedSession = {
  status: "active",
  assignment: {
    type: "session.assign",
    protocolVersion: OUTPOST_PROTOCOL_VERSION,
    assignmentId: "assignment-01",
    productSessionId: "session-01",
    sandboxId: "sandbox-01",
    controlPlaneUrl: "https://control.example",
    harness: "pi",
    outpostId: "workstation-01",
    workspacePath: "/workspace/sessions/session-01",
  },
  repositories: [{ position: 0, repoOwner: "octo", repoName: "demo", baseSha: "a".repeat(40) }],
};

describe("SessionStateStore", () => {
  it("persists only non-secret recovery metadata", async () => {
    const { store, dir } = await freshStore();
    const liveAssignment: SessionAssign = {
      ...entry.assignment,
      sandboxAuthToken: "bridge-token",
      credentialFetchToken: "fetch-token",
    };
    await store.save({ ...entry, assignment: liveAssignment });

    const reloaded = await new SessionStateStore(dir).loadAll();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].assignment.productSessionId).toBe("session-01");
    expect(reloaded[0].repositories[0].baseSha).toBe("a".repeat(40));

    const raw = await readFile(join(dir, "session-01.json"), "utf8");
    expect(raw).not.toContain("bridge-token");
    expect(raw).not.toContain("fetch-token");
    expect(raw).not.toContain("sandboxAuthToken");
    expect(raw).not.toContain("credentialFetchToken");
  });

  it("scrubs bearer fields from legacy state before returning it", async () => {
    const { store, dir } = await freshStore();
    await writeFile(
      join(dir, "session-01.json"),
      JSON.stringify({
        ...entry,
        assignment: {
          ...entry.assignment,
          sandboxAuthToken: "legacy-bridge-token",
          credentialFetchToken: "legacy-fetch-token",
        },
        savedAt: Date.now(),
      })
    );

    const reloaded = await store.loadAll();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].assignment.productSessionId).toBe("session-01");

    const scrubbed = await readFile(join(dir, "session-01.json"), "utf8");
    expect(scrubbed).not.toContain("legacy-bridge-token");
    expect(scrubbed).not.toContain("legacy-fetch-token");
    expect(scrubbed).not.toContain("sandboxAuthToken");
    expect(scrubbed).not.toContain("credentialFetchToken");
  });

  it("keeps a dormant session's baseline so a later wake diffs from session start", async () => {
    const { store } = await freshStore();
    await store.save(entry);

    // The session goes to sleep: the homestead stops serving it, but the
    // baseline it was cloned at must survive for the next wake.
    await store.markDormant("session-01");

    const dormant = await store.get("session-01");
    expect(dormant?.status).toBe("dormant");
    expect(dormant?.repositories[0].baseSha).toBe("a".repeat(40));

    // Restart recovery must not re-adopt sleeping sessions.
    const all = await store.loadAll();
    expect(all.filter((s) => s.status === "active")).toHaveLength(0);
  });

  it("prunes only dormant records past the retention window", async () => {
    const { store } = await freshStore();
    await store.save(entry);
    await store.markDormant("session-01");
    await store.save({
      ...entry,
      assignment: { ...entry.assignment, productSessionId: "session-live" },
    });

    const hour = 60 * 60 * 1000;
    expect(await store.pruneDormant(Date.now() + hour, 2 * hour)).toEqual([]);
    // Named, not counted: the caller has to delete each pruned session's Pi
    // conversation, which sits in a sibling directory under the same promise.
    expect(await store.pruneDormant(Date.now() + 3 * hour, 2 * hour)).toEqual(["session-01"]);

    const remaining = await store.loadAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].assignment.productSessionId).toBe("session-live");
  });

  it("creates the state directory owner-only", async () => {
    const { dir } = await freshStore();
    // The directory it makes for itself, not the one the test handed it: this
    // is where a session's Pi conversation lives too, so nobody else may read
    // it whatever the operator's umask happens to be.
    const nested = join(dir, "created-by-the-store");
    await new SessionStateStore(nested).save(entry);

    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it("removes sessions and tolerates a missing directory", async () => {
    const { store } = await freshStore();
    await store.save(entry);
    await store.remove("session-01");
    await expect(store.loadAll()).resolves.toHaveLength(0);

    const empty = new SessionStateStore(join(tmpdir(), "does-not-exist-homestead-state"));
    await expect(empty.loadAll()).resolves.toHaveLength(0);
  });

  it("drops corrupt state files instead of failing recovery", async () => {
    const { store, dir } = await freshStore();
    await store.save(entry);
    await writeFile(join(dir, "corrupt.json"), "{not json");
    await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ hello: 1 }));

    const reloaded = await store.loadAll();
    expect(reloaded).toHaveLength(1);
    await expect(store.loadAll()).resolves.toHaveLength(1);
  });
});
