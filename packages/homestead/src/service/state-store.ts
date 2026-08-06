import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionAssignSchema } from "@openoutposts/outpost-protocol";
import { z } from "zod";

import type { ClonedRepository } from "./homestead-daemon.js";

const repositorySchema = z.object({
  position: z.number().int().nonnegative(),
  repoOwner: z.string(),
  repoName: z.string(),
  baseSha: z.string(),
});

/**
 * The assignment fields restart recovery may keep on disk.
 *
 * This is a positive list, not an omit list. If a future assignment grows
 * another credential, it stays out of recovery state until somebody
 * deliberately classifies it as safe metadata.
 */
export const recoverySessionAssignmentSchema = sessionAssignSchema.pick({
  type: true,
  protocolVersion: true,
  assignmentId: true,
  productSessionId: true,
  sandboxId: true,
  controlPlaneUrl: true,
  harness: true,
  model: true,
  outpostId: true,
  workspacePath: true,
  repositories: true,
});

const stateSchema = z.object({
  assignment: recoverySessionAssignmentSchema,
  repositories: z.array(repositorySchema),
  // Sessions the homestead is actively serving are re-adopted after a restart.
  // Dormant entries are kept only for their diff baselines: a session that
  // wakes months later must diff against the commit it started from, not
  // against whatever HEAD happens to be at wake time.
  status: z.enum(["active", "dormant"]).default("active"),
  savedAt: z.number(),
});

export interface PersistedSession {
  assignment: RecoverySessionAssignment;
  repositories: ClonedRepository[];
  status: "active" | "dormant";
}

export type RecoverySessionAssignment = z.infer<typeof recoverySessionAssignmentSchema>;

/** Dormant records outlive their usefulness eventually; 90 days is generous. */
const DORMANT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Durable record of the sessions this homestead knows about, one JSON file per
 * session. Serves two purposes across a session's indefinite lifetime:
 *
 * 1. Restart recovery — active sessions keep enough non-secret metadata for
 *    the control plane to rotate their credentials and re-adopt the workspace.
 * 2. Baseline continuity — a session that sleeps and wakes keeps the diff
 *    baseline it was cloned at, so its Changes view still shows the whole
 *    session's work rather than resetting at every wake.
 */
export class SessionStateStore {
  constructor(private readonly dir: string) {}

  async save(entry: PersistedSession): Promise<void> {
    // Owner-only: this directory also holds the Pi session files, which carry
    // the conversations themselves.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Parse before serializing. Callers hand this method the live assignment,
    // which contains both bearers at runtime; the positive-list schema strips
    // them before a byte reaches disk.
    const safe = stateSchema.parse({ ...entry, savedAt: Date.now() });
    await writeFile(this.#path(entry.assignment.productSessionId), JSON.stringify(safe), {
      mode: 0o600,
    });
  }

  /**
   * Records that a session stopped serving without discarding what the next
   * wake needs. Absent entries are ignored — a session can end before it was
   * ever persisted.
   */
  async markDormant(productSessionId: string): Promise<void> {
    const existing = await this.get(productSessionId);
    if (!existing || existing.status === "dormant") return;
    await this.save({ ...existing, status: "dormant" });
  }

  async get(productSessionId: string): Promise<PersistedSession | null> {
    return this.#read(this.#path(productSessionId));
  }

  async remove(productSessionId: string): Promise<void> {
    await rm(this.#path(productSessionId), { force: true });
  }

  async loadAll(): Promise<PersistedSession[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const sessions: PersistedSession[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const entry = await this.#read(join(this.dir, file));
      if (entry) sessions.push(entry);
    }
    return sessions;
  }

  /**
   * Drops dormant records older than the retention window and reports whose
   * they were.
   *
   * The ids matter to the caller: a pruned session's Pi conversation is kept
   * in a sibling directory under the same retention promise, and only the
   * record being dropped says which one it is.
   */
  async pruneDormant(now = Date.now(), maxAgeMs = DORMANT_RETENTION_MS): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const pruned: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.dir, file);
      const entry = await this.#readRaw(path);
      if (entry && entry.status === "dormant" && now - entry.savedAt > maxAgeMs) {
        await rm(path, { force: true });
        pruned.push(entry.assignment.productSessionId);
      }
    }
    return pruned;
  }

  async #read(path: string): Promise<PersistedSession | null> {
    const raw = await this.#readRaw(path);
    if (!raw) return null;
    return {
      assignment: raw.assignment,
      repositories: raw.repositories,
      status: raw.status,
    };
  }

  async #readRaw(path: string): Promise<z.infer<typeof stateSchema> | null> {
    try {
      const decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
      const parsed = stateSchema.safeParse(decoded);
      if (parsed.success) {
        const assignment =
          decoded && typeof decoded === "object" && "assignment" in decoded
            ? (decoded as { assignment?: unknown }).assignment
            : null;
        const carriedLegacyBearer =
          assignment !== null &&
          typeof assignment === "object" &&
          ("sandboxAuthToken" in assignment || "credentialFetchToken" in assignment);
        if (carriedLegacyBearer) {
          // Existing installations may have v1 files with both live bearers.
          // Scrub those files before returning recovery metadata to the daemon.
          await writeFile(path, JSON.stringify(parsed.data), { mode: 0o600 });
        }
        return parsed.data;
      }
      // Unreadable or outdated state is dropped: the product's lifecycle
      // watchdogs own any session we cannot reconstruct.
      await rm(path, { force: true });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      await rm(path, { force: true });
      return null;
    }
  }

  #path(productSessionId: string): string {
    // Session ids are hex/uuid-like; encode defensively anyway.
    return join(this.dir, `${encodeURIComponent(productSessionId)}.json`);
  }
}
