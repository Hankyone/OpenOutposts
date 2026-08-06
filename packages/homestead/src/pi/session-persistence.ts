import { chmod, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * The agent lives on the homestead machine, so its conversation must outlive
 * the homestead process. Pi keeps a session as an append-only JSONL file, one
 * entry per message; opening that file again is how a restarted homestead
 * carries on the same conversation instead of meeting the user as a stranger.
 *
 * What lands here is the harness transcript, not the product transcript: the
 * user-facing event stream still belongs to the control plane. Nothing secret
 * is written. The session's provider key is held in memory by its credential
 * store and handed to Pi per model request, so no entry in this file can carry
 * one — which is what makes it safe to keep the conversation on disk at all.
 *
 * Both the directory and the file are owner-only. Pi has no mode option of its
 * own, so the file is created here first, empty and at 0600, and Pi is pointed
 * at it: its empty-file path rewrites the header in place with `open(..., "w")`
 * and appends every later entry, and both preserve an existing file's mode.
 */

/** Owner-only, like the state files these sit beside. */
const SESSION_DIR_MODE = 0o700;
const SESSION_FILE_MODE = 0o600;

export interface PersistedPiSession {
  /** Pointed at the session file, with any prior conversation already loaded. */
  manager: SessionManager;
  /** A prior transcript was found and this session continues it. */
  resumed: boolean;
  /** The stored transcript could not be read and was set aside. */
  recovered: boolean;
  sessionFile: string;
  /** Entries loaded from disk, including Pi's model and thinking-level records. */
  entryCount: number;
  /** Conversation messages restored into the agent's context. */
  messageCount: number;
}

/**
 * Opens the session file this harness session persists to, resuming whatever
 * conversation it already holds.
 *
 * A file that cannot be read never stops a session: an agent that refuses to
 * start because of its own history is worse than one that starts fresh, so the
 * unreadable file is renamed aside for inspection and an empty one takes its
 * place. `cwd` overrides the working directory recorded in the stored header,
 * which named a scratch directory that no longer exists.
 */
export async function openPersistedSessionManager(
  sessionFile: string,
  cwd: string
): Promise<PersistedPiSession> {
  const dir = dirname(sessionFile);
  await mkdir(dir, { recursive: true, mode: SESSION_DIR_MODE });
  // `mkdir` sets the mode only on directories it creates; an existing one from
  // an older homestead keeps whatever mode it was made with.
  await chmod(dir, SESSION_DIR_MODE).catch(() => {});
  await ensureOwnerOnlyFile(sessionFile);

  let recovered = false;
  let manager: SessionManager;
  try {
    manager = SessionManager.open(sessionFile, dir, cwd);
  } catch {
    await rename(sessionFile, `${sessionFile}.corrupt-${Date.now()}`);
    await ensureOwnerOnlyFile(sessionFile);
    manager = SessionManager.open(sessionFile, dir, cwd);
    recovered = true;
  }

  const entryCount = manager.getEntries().length;
  const messageCount = manager.buildSessionContext().messages.length;
  return { manager, resumed: entryCount > 0, recovered, sessionFile, entryCount, messageCount };
}

/**
 * Leaves an empty owner-only file at `path` if nothing is there, and tightens
 * the mode of one that is. The exclusive create is what makes this safe to run
 * against a file holding a live conversation: it fails rather than truncating.
 */
async function ensureOwnerOnlyFile(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", SESSION_FILE_MODE);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await chmod(path, SESSION_FILE_MODE);
  }
}
