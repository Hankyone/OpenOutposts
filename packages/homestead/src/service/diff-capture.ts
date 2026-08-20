/**
 * Session diff capture for outpost sessions: a faithful port of the sandbox
 * runtime's git diff collector, executed on the outpost through lease-scoped
 * bash and published to the control plane's session diff endpoint.
 *
 * Contract (shared/src/types/session-diffs.ts): bundle version 1, per-file
 * unified patches with full-file context, 512 KiB per patch, 1 MiB total
 * patch bytes, 1000 files, 1.5 MiB encoded bundle.
 */

import { shellQuote } from "./shell.js";

export type WorkspaceHomestead = (
  command: string,
  timeoutMs: number
) => Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Whether the worker truncated the command's output. */
  truncated?: boolean;
}>;

export interface DiffRepositoryIdentity {
  position: number;
  repoOwner: string;
  repoName: string;
  baseSha: string;
}

const MAX_FILES = 1000;
const MAX_FILE_PATCH_BYTES = 512 * 1024;
const MAX_TOTAL_PATCH_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 1_572_864;
const GIT_TIMEOUT_MS = 30_000;
const PATCH_TIMEOUT_MS = 60_000;

const GIT_ENV = "GIT_CONFIG_NOSYSTEM=1 GIT_LITERAL_PATHSPECS=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C";

type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "submodule";
type RenderState = "renderable" | "binary" | "too_large" | "metadata_only";

interface DiffFile {
  id: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number | null;
  deletions: number | null;
  renderState: RenderState;
  patch?: string;
  oldMode?: string;
  newMode?: string;
}

export interface RepositoryDiffEntry {
  status: "ready" | "unavailable";
  position: number;
  repoOwner: string;
  repoName: string;
  baseSha: string;
  headSha?: string;
  truncated?: boolean;
  omittedFileCount?: number;
  error?: string;
  files: DiffFile[];
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

interface RawRecord {
  oldMode: string;
  newMode: string;
  status: string;
  path: string;
  oldPath?: string;
}

function parseRawRecords(stdout: string): RawRecord[] {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const records: RawRecord[] = [];
  let index = 0;
  while (index < tokens.length) {
    const header = tokens[index];
    if (!header.startsWith(":")) {
      index += 1;
      continue;
    }
    const parts = header.slice(1).split(" ");
    const [oldMode, newMode, , , statusField] = parts;
    const statusLetter = (statusField ?? "").charAt(0);
    const isRename = statusLetter === "R" || statusLetter === "C";
    const oldPath = isRename ? tokens[index + 1] : undefined;
    const path = isRename ? tokens[index + 2] : tokens[index + 1];
    index += isRename ? 3 : 2;
    if (path === undefined) break;
    records.push({
      oldMode: oldMode ?? "",
      newMode: newMode ?? "",
      status: statusLetter,
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
    });
  }
  return records;
}

function parseNumstat(
  stdout: string
): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index];
    const match = record.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!match) {
      index += 1;
      continue;
    }
    const additions = match[1] === "-" ? null : Number(match[1]);
    const deletions = match[2] === "-" ? null : Number(match[2]);
    let path = match[3];
    if (path === "") {
      // Rename form: stats record has an empty path; the old and new paths
      // follow as their own NUL-terminated tokens.
      path = tokens[index + 2] ?? "";
      index += 3;
    } else {
      index += 1;
    }
    if (path) stats.set(path, { additions, deletions });
  }
  return stats;
}

const STATUS_BY_LETTER: Record<string, FileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "type_changed",
  U: "unmerged",
  R: "renamed",
  C: "renamed",
};

export class DiffBudget {
  remainingFiles = MAX_FILES;
  remainingPatchBytes = MAX_TOTAL_PATCH_BYTES;
}

export async function collectRepositoryDiff(
  run: WorkspaceHomestead,
  identity: DiffRepositoryIdentity,
  budget: DiffBudget
): Promise<RepositoryDiffEntry> {
  const unavailable = (error: string): RepositoryDiffEntry => ({
    status: "unavailable",
    position: identity.position,
    repoOwner: identity.repoOwner,
    repoName: identity.repoName,
    baseSha: identity.baseSha,
    error: error.slice(0, 2000),
    files: [],
  });

  const git = (args: string, timeoutMs = GIT_TIMEOUT_MS) =>
    run(`${GIT_ENV} git --no-pager ${args}`, timeoutMs);

  const baselineCheck = await git(`cat-file -e ${identity.baseSha}^{commit}`);
  if (!baselineCheck.ok || baselineCheck.exitCode !== 0) {
    return unavailable(`baseline commit ${identity.baseSha} is not present in the workspace`);
  }
  const head = await git("rev-parse HEAD");
  if (!head.ok || head.exitCode !== 0) {
    return unavailable("could not resolve the workspace HEAD");
  }
  const headSha = head.stdout.trim();

  const raw = await git(
    `diff --no-ext-diff --no-textconv --raw -z --no-abbrev --find-renames ${identity.baseSha}`
  );
  const untrackedList = await run(
    `${GIT_ENV} git ls-files --others --exclude-standard -z`,
    GIT_TIMEOUT_MS
  );
  const numstat = await git(
    `diff --no-ext-diff --no-textconv --numstat -z --find-renames ${identity.baseSha}`
  );
  if (!raw.ok || !untrackedList.ok || !numstat.ok) {
    return unavailable("git diff enumeration failed on the outpost");
  }

  const records = parseRawRecords(raw.stdout);
  const stats = parseNumstat(numstat.stdout);
  const untracked = untrackedList.stdout.split("\0").filter((path) => path.length > 0);

  const files: DiffFile[] = [];
  let truncated = false;
  let omittedFileCount = 0;

  const pushFile = async (
    path: string,
    status: FileStatus,
    fileStats: { additions: number | null; deletions: number | null },
    patchCommand: string | null,
    extra: Partial<DiffFile>
  ) => {
    if (budget.remainingFiles <= 0) {
      truncated = true;
      omittedFileCount += 1;
      return;
    }
    budget.remainingFiles -= 1;

    let renderState: RenderState = "metadata_only";
    let patch: string | undefined;
    const isBinary = fileStats.additions === null || fileStats.deletions === null;
    if (isBinary) {
      renderState = "binary";
    } else if (patchCommand) {
      const result = await run(patchCommand, PATCH_TIMEOUT_MS);
      const patchText = result.stdout;
      const outputTruncated = result.truncated === true;
      if (!result.ok) {
        renderState = "metadata_only";
      } else if (outputTruncated || utf8Bytes(patchText) > MAX_FILE_PATCH_BYTES) {
        renderState = "too_large";
      } else if (utf8Bytes(patchText) > budget.remainingPatchBytes) {
        renderState = "too_large";
      } else if (!patchText.includes("@@")) {
        renderState = "metadata_only";
      } else {
        renderState = "renderable";
        patch = patchText;
        budget.remainingPatchBytes -= utf8Bytes(patchText);
      }
    }

    files.push({
      id: crypto.randomUUID(),
      path,
      status,
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      renderState,
      ...(patch === undefined ? {} : { patch }),
      ...extra,
    });
  };

  for (const record of records) {
    const status =
      record.newMode === "160000" || record.oldMode === "160000"
        ? "submodule"
        : (STATUS_BY_LETTER[record.status] ?? "modified");
    const fileStats = stats.get(record.path) ?? { additions: 0, deletions: 0 };
    const modeExtra: Partial<DiffFile> = {};
    if (
      record.oldMode !== record.newMode &&
      record.oldMode !== "000000" &&
      record.newMode !== "000000"
    ) {
      modeExtra.oldMode = record.oldMode;
      modeExtra.newMode = record.newMode;
    }
    if (record.oldPath !== undefined) modeExtra.oldPath = record.oldPath;
    const patchCommand =
      status === "submodule"
        ? null
        : `${GIT_ENV} git --no-pager diff --no-ext-diff --no-textconv --full-index --find-renames --unified=1000000 ${identity.baseSha} -- ${record.oldPath ? `${shellQuote(record.oldPath)} ` : ""}${shellQuote(record.path)}`;
    await pushFile(record.path, status, fileStats, patchCommand, modeExtra);
  }

  for (const path of untracked) {
    const statResult = await run(
      `${GIT_ENV} git --no-pager diff --no-ext-diff --no-textconv --no-index --numstat -- /dev/null ${shellQuote(path)}; true`,
      GIT_TIMEOUT_MS
    );
    const untrackedStats = parseNumstat(
      statResult.ok ? statResult.stdout.replaceAll("\n", "\0") : ""
    );
    const fileStats = untrackedStats.get(path) ??
      [...untrackedStats.values()][0] ?? { additions: 0, deletions: 0 };
    await pushFile(
      path,
      "added",
      fileStats,
      `${GIT_ENV} git --no-pager diff --no-ext-diff --no-textconv --no-index --full-index --unified=1000000 -- /dev/null ${shellQuote(path)}; true`,
      {}
    );
  }

  return {
    status: "ready",
    position: identity.position,
    repoOwner: identity.repoOwner,
    repoName: identity.repoName,
    baseSha: identity.baseSha,
    headSha,
    truncated,
    omittedFileCount,
    files,
  };
}

export interface DiffBundle {
  version: 1;
  triggerMessageId: string | null;
  capturedAt: number;
  repositories: RepositoryDiffEntry[];
}

export async function buildDiffBundle(
  run: WorkspaceHomestead,
  repositories: DiffRepositoryIdentity[],
  triggerMessageId: string | null
): Promise<DiffBundle> {
  const budget = new DiffBudget();
  const entries: RepositoryDiffEntry[] = [];
  for (const identity of repositories) {
    entries.push(await collectRepositoryDiff(run, identity, budget));
  }
  const bundle: DiffBundle = {
    version: 1,
    triggerMessageId,
    capturedAt: Date.now(),
    repositories: entries,
  };
  // Encoded-size guard: flip the largest patches to too_large until under.
  while (utf8Bytes(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES) {
    let largest: DiffFile | null = null;
    for (const entry of bundle.repositories) {
      for (const file of entry.files) {
        if (file.patch && (!largest?.patch || file.patch.length > largest.patch.length)) {
          largest = file;
        }
      }
    }
    if (!largest) break;
    delete largest.patch;
    largest.renderState = "too_large";
  }
  return bundle;
}

/**
 * Publishes session diffs to the control plane with the session's bridge
 * credential. Serialized: one capture at a time, the latest trigger wins.
 */
export class SessionDiffPublisher {
  #drainPromise: Promise<void> | null = null;
  #pending: { triggerMessageId: string | null; signal?: AbortSignal } | null = null;
  #unsupported = false;

  constructor(
    private readonly options: {
      controlPlaneUrl: string;
      productSessionId: string;
      sandboxAuthToken: string;
      repositories: DiffRepositoryIdentity[];
      run: (
        fn: (homestead: WorkspaceHomestead) => Promise<DiffBundle>,
        signal?: AbortSignal
      ) => Promise<DiffBundle>;
      log: (message: string, fields?: Record<string, unknown>) => void;
    }
  ) {}

  refresh(triggerMessageId: string | null, signal?: AbortSignal): Promise<void> {
    if (this.#unsupported || this.options.repositories.length === 0 || signal?.aborted) {
      return Promise.resolve();
    }
    this.#pending = { triggerMessageId, ...(signal === undefined ? {} : { signal }) };
    this.#drainPromise ??= this.#drain();
    return this.#drainPromise;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending) {
        const { triggerMessageId, signal } = this.#pending;
        this.#pending = null;
        if (signal?.aborted) continue;
        try {
          const bundle = await this.options.run(
            (homestead) => buildDiffBundle(homestead, this.options.repositories, triggerMessageId),
            signal
          );
          if (signal?.aborted) continue;
          await this.#publish(bundle);
        } catch (error) {
          if (signal?.aborted) continue;
          await this.#reportFailure(
            error instanceof Error ? error.message : "Session diff refresh failed"
          );
        }
      }
    } finally {
      this.#drainPromise = null;
    }
  }

  async #publish(bundle: DiffBundle): Promise<void> {
    const response = await fetch(this.#url("/diff"), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.options.sandboxAuthToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bundle),
    });
    if (response.status === 404) {
      this.#unsupported = true;
      this.options.log("session diffs unsupported by this control plane", {
        session: this.options.productSessionId,
      });
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      await this.#reportFailure(`diff upload rejected: HTTP ${response.status} ${text}`.trim());
      return;
    }
    this.options.log("session diff published", {
      session: this.options.productSessionId,
      files: bundle.repositories.reduce((count, repo) => count + repo.files.length, 0),
    });
  }

  async #reportFailure(message: string): Promise<void> {
    try {
      await fetch(this.#url("/diff/failure"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.sandboxAuthToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: message.slice(0, 2000) || "Session diff refresh failed" }),
      });
    } catch {
      // failure reporting is best-effort
    }
  }

  #url(suffix: string): string {
    const base = this.options.controlPlaneUrl.replace(/\/+$/, "");
    return `${base}/sessions/${encodeURIComponent(this.options.productSessionId)}${suffix}`;
  }
}
