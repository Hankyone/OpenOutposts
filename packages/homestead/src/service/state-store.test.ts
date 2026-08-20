import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";
import type { SessionAssign } from "@openoutposts/outpost-protocol";

import { SessionStateStore, type PersistedSession } from "./state-store.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

const replacementEntry: PersistedSession = {
  status: "active",
  assignment: {
    ...entry.assignment,
    assignmentId: "assignment-02",
    sandboxId: "sandbox-02",
    outpostId: "workstation-02",
    workspacePath: "/workspace/sessions/session-02-generation",
  },
  repositories: [
    { position: 0, repoOwner: "octo-two", repoName: "replacement", baseSha: "b".repeat(40) },
  ],
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

  it("atomically replaces an existing state file without leaving temporary files", async () => {
    const { store, dir } = await freshStore();
    await store.save(entry);
    await expect(store.get("session-01")).resolves.toMatchObject({ status: "active" });

    await store.save({ ...entry, status: "dormant" });

    await expect(store.get("session-01")).resolves.toMatchObject({ status: "dormant" });
    expect(await readdir(dir)).toEqual(["session-01.json"]);
  });

  it("marks only the matching assignment generation dormant", async () => {
    const { store } = await freshStore();
    await store.save(entry);

    await store.markDormant("session-01", "sandbox-01");

    await expect(store.get("session-01")).resolves.toEqual({
      ...entry,
      status: "dormant",
    });
  });

  it("does not let a stale generation demote its active replacement", async () => {
    const { store } = await freshStore();
    await store.save(entry);
    await store.save(replacementEntry);

    await store.markDormant("session-01", "sandbox-01");

    await expect(store.get("session-01")).resolves.toEqual(replacementEntry);
  });

  it("orders a dormant transition before a replacement save invoked after it", async () => {
    const { store } = await freshStore();
    await store.save(entry);

    const dormant = store.markDormant("session-01", "sandbox-01");
    const replacement = store.save(replacementEntry);
    await Promise.all([dormant, replacement]);

    await expect(store.get("session-01")).resolves.toEqual(replacementEntry);
  });

  it("continues a session mutation queue after a rejected save", async () => {
    const { store } = await freshStore();
    const invalid = {
      ...entry,
      repositories: [{ ...entry.repositories[0], position: -1 }],
    } as PersistedSession;

    const rejected = store.save(invalid);
    const valid = store.save(entry);

    await expect(rejected).rejects.toThrow();
    await expect(valid).resolves.toBeUndefined();
    await expect(store.get("session-01")).resolves.toEqual(entry);
  });

  it("persists unrelated product sessions concurrently", async () => {
    const { store } = await freshStore();
    const other: PersistedSession = {
      ...entry,
      assignment: {
        ...entry.assignment,
        assignmentId: "assignment-other",
        productSessionId: "session-other",
        sandboxId: "sandbox-other",
        outpostId: "workstation-other",
        workspacePath: "/workspace/sessions/session-other",
      },
      repositories: [
        { position: 0, repoOwner: "other", repoName: "other", baseSha: "c".repeat(40) },
      ],
    };

    await Promise.all([store.save(entry), store.save(other)]);

    await expect(store.get("session-01")).resolves.toEqual(entry);
    await expect(store.get("session-other")).resolves.toEqual(other);
  });

  it("scrubs bearer fields from legacy state before returning it", async () => {
    const { store, dir } = await freshStore();
    const savedAt = 1_721_234_567_890;
    await writeFile(
      join(dir, "session-01.json"),
      JSON.stringify({
        ...entry,
        assignment: {
          ...entry.assignment,
          sandboxAuthToken: "legacy-bridge-token",
          credentialFetchToken: "legacy-fetch-token",
        },
        savedAt,
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
    expect((JSON.parse(scrubbed) as { savedAt: number }).savedAt).toBe(savedAt);
    expect((await stat(join(dir, "session-01.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["session-01.json"]);
  });

  it("orders a replacement save before a legacy scrub read invoked after it", async () => {
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
        savedAt: 1_721_234_567_890,
      })
    );

    const saving = store.save(replacementEntry);
    const reading = store.get("session-01");
    const [, observed] = await Promise.all([saving, reading]);

    expect(observed).toEqual(replacementEntry);
    await expect(store.get("session-01")).resolves.toEqual(replacementEntry);
    const raw = await readFile(join(dir, "session-01.json"), "utf8");
    expect(raw).not.toContain("legacy-bridge-token");
    expect(raw).not.toContain("legacy-fetch-token");
  });

  it("orders a replacement save before a corrupt-state read invoked after it", async () => {
    const { store, dir } = await freshStore();
    const path = join(dir, "session-01.json");
    await writeFile(path, "{torn recovery record");

    const saving = store.save(replacementEntry);
    const reading = store.get("session-01");
    const [, observed] = await Promise.all([saving, reading]);

    expect(observed).toEqual(replacementEntry);
    await expect(store.get("session-01")).resolves.toEqual(replacementEntry);
    expect((await readdir(dir)).filter((file) => file.includes(".corrupt-"))).toEqual([]);
  });

  it("keeps a dormant session's baseline so a later wake diffs from session start", async () => {
    const { store } = await freshStore();
    await store.save(entry);

    // The session goes to sleep: the homestead stops serving it, but the
    // baseline it was cloned at must survive for the next wake.
    await store.markDormant("session-01", "sandbox-01");

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
    await store.markDormant("session-01", "sandbox-01");
    await store.save({
      ...entry,
      assignment: { ...entry.assignment, productSessionId: "session-live" },
    });

    const hour = 60 * 60 * 1000;
    expect(await store.pruneDormant({ now: Date.now() + hour, maxAgeMs: 2 * hour })).toEqual([]);
    // Named, not counted: the caller has to delete each pruned session's Pi
    // conversation, which sits in a sibling directory under the same promise.
    expect(await store.pruneDormant({ now: Date.now() + 3 * hour, maxAgeMs: 2 * hour })).toEqual([
      "session-01",
    ]);

    const remaining = await store.loadAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].assignment.productSessionId).toBe("session-live");
  });

  it("retains an expired record when adapter cleanup asks to retry", async () => {
    const { store } = await freshStore();
    await store.save(entry);
    await store.markDormant("session-01", "sandbox-01");
    const cleanup = vi.fn(async () => false);

    await expect(
      store.pruneDormant({
        now: Date.now() + 3 * 60 * 60 * 1000,
        maxAgeMs: 2 * 60 * 60 * 1000,
        beforeRemove: cleanup,
      })
    ).resolves.toEqual([]);

    expect(cleanup).toHaveBeenCalledWith(["session-01"]);
    await expect(store.get("session-01")).resolves.toMatchObject({ status: "dormant" });
  });

  it("creates the state directory owner-only", async () => {
    const { dir } = await freshStore();
    // The directory it makes for itself, not the one the test handed it: this
    // is where a session's Pi conversation lives too, so nobody else may read
    // it whatever the operator's umask happens to be.
    const nested = join(dir, "created-by-the-store");
    await new SessionStateStore(nested).save(entry);

    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    expect((await stat(join(nested, "session-01.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(nested)).toEqual(["session-01.json"]);
  });

  it("removes sessions and tolerates a missing directory", async () => {
    const { store } = await freshStore();
    await store.save(entry);
    await store.remove("session-01");
    await expect(store.loadAll()).resolves.toHaveLength(0);

    const empty = new SessionStateStore(join(tmpdir(), "does-not-exist-homestead-state"));
    await expect(empty.loadAll()).resolves.toHaveLength(0);
  });

  it("quarantines corrupt state files without losing their contents", async () => {
    const { store, dir } = await freshStore();
    await store.save(entry);
    const malformed = "{not json";
    const wrongShape = JSON.stringify({ hello: 1 });
    await writeFile(join(dir, "corrupt.json"), malformed);
    await writeFile(join(dir, "wrong-shape.json"), wrongShape);
    vi.spyOn(Date, "now").mockReturnValue(1_721_234_567_890);

    const reloaded = await store.loadAll();
    expect(reloaded).toHaveLength(1);

    const secondMalformed = "still not json";
    await writeFile(join(dir, "corrupt.json"), secondMalformed);
    await expect(store.loadAll()).resolves.toHaveLength(1);

    const files = await readdir(dir);
    const malformedQuarantines = files.filter((file) => file.startsWith("corrupt.json.corrupt-"));
    const wrongShapeQuarantines = files.filter((file) =>
      file.startsWith("wrong-shape.json.corrupt-")
    );
    expect(malformedQuarantines).toHaveLength(2);
    expect(new Set(malformedQuarantines).size).toBe(2);
    expect(wrongShapeQuarantines).toHaveLength(1);

    const malformedPaths = malformedQuarantines.map((file) => join(dir, file));
    const wrongShapePath = join(dir, wrongShapeQuarantines[0]);
    await expect(
      Promise.all(malformedPaths.map((path) => readFile(path, "utf8")))
    ).resolves.toEqual(expect.arrayContaining([malformed, secondMalformed]));
    expect(await readFile(wrongShapePath, "utf8")).toBe(wrongShape);
    for (const quarantinePath of [...malformedPaths, wrongShapePath]) {
      expect((await stat(quarantinePath)).mode & 0o777).toBe(0o600);
    }

    await expect(store.loadAll()).resolves.toHaveLength(1);
    expect((await readdir(dir)).sort()).toEqual(files.sort());
  });

  it("treats a missing state file as absent without creating a quarantine", async () => {
    const { store, dir } = await freshStore();

    await expect(store.get("missing-session")).resolves.toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});
