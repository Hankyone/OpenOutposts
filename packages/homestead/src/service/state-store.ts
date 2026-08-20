import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { sessionAssignSchema } from "@openoutposts/outpost-protocol";
import { z } from "zod";

import type { ClonedRepository } from "./homestead-daemon.js";

const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

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

export interface PruneDormantOptions {
  now?: number;
  maxAgeMs?: number;
  /**
   * Removes adapter-owned state before its recovery record disappears. A
   * false result leaves the record in place so cleanup can be retried on the
   * next startup.
   */
  beforeRemove?: (productSessionIds: readonly string[]) => Promise<boolean>;
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
  readonly #operationTails = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  async save(entry: PersistedSession): Promise<void> {
    return this.#queueFileOperation(this.#path(entry.assignment.productSessionId), () =>
      this.#saveUnqueued(entry)
    );
  }

  async #saveUnqueued(entry: PersistedSession): Promise<void> {
    // Owner-only: this directory also holds the Pi session files, which carry
    // the conversations themselves.
    await mkdir(this.dir, { recursive: true, mode: STATE_DIR_MODE });
    // Parse before serializing. Callers hand this method the live assignment,
    // which contains both bearers at runtime; the positive-list schema strips
    // them before a byte reaches disk.
    const safe = stateSchema.parse({ ...entry, savedAt: Date.now() });
    await writeStateAtomically(this.#path(entry.assignment.productSessionId), JSON.stringify(safe));
  }

  /**
   * Records that a session stopped serving without discarding what the next
   * wake needs. Absent entries are ignored — a session can end before it was
   * ever persisted.
   */
  async markDormant(productSessionId: string, expectedSandboxId: string): Promise<void> {
    const path = this.#path(productSessionId);
    return this.#queueFileOperation(path, async () => {
      const existing = await this.#read(path);
      if (!existing || existing.status === "dormant") return;
      if (existing.assignment.sandboxId !== expectedSandboxId) return;
      await this.#saveUnqueued({ ...existing, status: "dormant" });
    });
  }

  async get(productSessionId: string): Promise<PersistedSession | null> {
    const path = this.#path(productSessionId);
    return this.#queueFileOperation(path, () => this.#read(path));
  }

  async remove(productSessionId: string): Promise<void> {
    const path = this.#path(productSessionId);
    await this.#queueFileOperation(path, () => rm(path, { force: true }));
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
      const path = join(this.dir, file);
      const entry = await this.#queueFileOperation(path, () => this.#read(path));
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
  async pruneDormant(options: PruneDormantOptions = {}): Promise<string[]> {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? DORMANT_RETENTION_MS;
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
      const removed = await this.#queueFileOperation(path, async () => {
        const entry = await this.#readRaw(path);
        if (!entry || entry.status !== "dormant" || now - entry.savedAt <= maxAgeMs) return null;
        const productSessionId = entry.assignment.productSessionId;
        if (options.beforeRemove && !(await options.beforeRemove([productSessionId]))) return null;
        await rm(path, { force: true });
        return productSessionId;
      });
      if (removed) pruned.push(removed);
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
    let serialized: string;
    try {
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized) as unknown;
    } catch {
      await quarantineCorruptState(path);
      return null;
    }

    const parsed = stateSchema.safeParse(decoded);
    if (!parsed.success) {
      await quarantineCorruptState(path);
      return null;
    }

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
      await writeStateAtomically(path, JSON.stringify(parsed.data));
    }
    return parsed.data;
  }

  #path(productSessionId: string): string {
    // Session ids are hex/uuid-like; encode defensively anyway.
    return join(this.dir, `${encodeURIComponent(productSessionId)}.json`);
  }

  /**
   * Runs reads and mutations for one state file in invocation order without
   * making unrelated sessions wait. The stored tail always handles rejection,
   * while callers receive the real operation promise and its real result.
   */
  #queueFileOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTails.get(path) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result
      .then(
        () => {},
        () => {}
      )
      .finally(() => {
        if (this.#operationTails.get(path) === tail) {
          this.#operationTails.delete(path);
        }
      });
    this.#operationTails.set(path, tail);
    return result;
  }
}

/** Publishes a complete, synced record without ever truncating the live file. */
async function writeStateAtomically(finalPath: string, serialized: string): Promise<void> {
  const dir = dirname(finalPath);
  const temporaryPath = join(dir, `${basename(finalPath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;

  try {
    handle = await open(temporaryPath, "wx", STATE_FILE_MODE);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    await rename(temporaryPath, finalPath);
    renamed = true;
    await syncDirectory(dir);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!renamed) await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Preserves an invalid record for inspection while keeping it out of normal
 * `.json` session scans. Recovery remains best-effort if quarantine itself
 * cannot be completed.
 */
async function quarantineCorruptState(path: string): Promise<void> {
  const dir = dirname(path);
  let quarantinePath: string;

  while (true) {
    quarantinePath = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      const reservation = await open(quarantinePath, "wx", STATE_FILE_MODE);
      await reservation.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return;
    }
  }

  let renamed = false;
  try {
    await chmod(path, STATE_FILE_MODE);
    await rename(path, quarantinePath);
    renamed = true;
    await chmod(quarantinePath, STATE_FILE_MODE);
    await syncDirectory(dir);
  } catch {
    if (renamed) {
      await rename(quarantinePath, path).catch(() => {});
      await syncDirectory(dir).catch(() => {});
    } else {
      await rm(quarantinePath, { force: true }).catch(() => {});
    }
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
