/**
 * Erasing everything one session left behind.
 *
 * Deleting a session used to remove its row from the index and nothing else:
 * the Durable Object kept its whole SQLite database, its alarm, and every
 * media object it had uploaded, unreachable but never released. A user who
 * asked for a session to be deleted got it hidden, not deleted.
 *
 * This is the other half. It is deliberately destructive and deliberately
 * idempotent — a DELETE that half-succeeded must be safe to retry, and a
 * session that was never initialized must purge as cleanly as a busy one.
 */

import type { Logger } from "../logger";
import type { ObjectStorage } from "../storage/object-storage";

/** WebSocket close code for a peer going away for good. */
const SESSION_DELETED_CLOSE_CODE = 1001;
const SESSION_DELETED_CLOSE_REASON = "session deleted";

export interface SessionPurgeDeps {
  storage: Pick<DurableObjectStorage, "deleteAll" | "deleteAlarm">;
  /** Sockets to hang up before the state behind them is gone. */
  sockets: {
    forEachClientSocket: (
      mode: "all_clients" | "authenticated_only",
      fn: (ws: WebSocket) => void
    ) => void;
    getSandboxSocket: () => WebSocket | null;
    close: (ws: WebSocket, code: number, reason: string) => void;
  };
  /**
   * Every stored object this session owns: chat attachments and the media
   * artifacts whose `url` is an object key rather than a link. Read before
   * anything is deleted, because the only record of them is the database this
   * function is about to wipe.
   */
  objectKeys: () => string[];
  /** Absent in a deployment with no media bucket bound; the rest still runs. */
  objects: Pick<ObjectStorage, "delete"> | null;
  log: Logger;
}

export interface SessionPurgeResult {
  purged: true;
  objectsDeleted: number;
  objectsFailed: number;
}

/**
 * Closes this session's sockets, releases its stored objects, and wipes its
 * Durable Object storage.
 *
 * Object deletion is best effort and never stops the purge. An object that
 * cannot be released is a leftover in a bucket; a purge that stopped there
 * would leave the session's whole database behind instead, which is the
 * larger of the two leaks and the one the user actually asked to be rid of.
 */
export async function purgeSessionStorage(deps: SessionPurgeDeps): Promise<SessionPurgeResult> {
  const keys = readObjectKeys(deps);

  hangUpEverySocket(deps);

  let objectsDeleted = 0;
  let objectsFailed = 0;
  if (deps.objects) {
    for (const key of keys) {
      try {
        await deps.objects.delete(key);
        objectsDeleted += 1;
      } catch (err) {
        objectsFailed += 1;
        deps.log.warn("session.purge.object_delete_failed", {
          object_key: key,
          error: err instanceof Error ? err : String(err),
        });
      }
    }
  }

  // The alarm goes before the rows it would have read. A surviving alarm on a
  // wiped database wakes the DO into a session that no longer exists.
  await deps.storage.deleteAlarm();
  await deps.storage.deleteAll();

  deps.log.info("session.purge.complete", {
    objects_deleted: objectsDeleted,
    objects_failed: objectsFailed,
  });
  return { purged: true, objectsDeleted, objectsFailed };
}

/**
 * A never-initialized DO has no tables at all, so reading its object keys
 * throws rather than returning nothing. That is not a reason to refuse the
 * purge: there is nothing to release, and the rest of the wipe still applies.
 */
function readObjectKeys(deps: SessionPurgeDeps): string[] {
  try {
    return deps.objectKeys();
  } catch (err) {
    deps.log.warn("session.purge.object_keys_unreadable", {
      error: err instanceof Error ? err : String(err),
    });
    return [];
  }
}

/**
 * Hangs up every client and the sandbox. A socket left open would go on
 * streaming from a session whose state is being erased underneath it, and its
 * next write would fail against tables that no longer exist.
 */
function hangUpEverySocket(deps: SessionPurgeDeps): void {
  deps.sockets.forEachClientSocket("all_clients", (ws) => {
    deps.sockets.close(ws, SESSION_DELETED_CLOSE_CODE, SESSION_DELETED_CLOSE_REASON);
  });
  const sandbox = deps.sockets.getSandboxSocket();
  if (sandbox) {
    deps.sockets.close(sandbox, SESSION_DELETED_CLOSE_CODE, SESSION_DELETED_CLOSE_REASON);
  }
}

/**
 * The object keys held in one session's tables.
 *
 * Media artifacts store their object key in `url` (see the sandbox handler's
 * createMediaArtifact); a pull request stores a link there instead, so
 * anything carrying a scheme is a reference to somewhere else and is left
 * alone.
 */
export function collectSessionObjectKeys(rows: {
  attachmentObjectKeys: string[];
  artifactUrls: (string | null)[];
}): string[] {
  const keys = new Set<string>();
  for (const key of rows.attachmentObjectKeys) {
    if (key) keys.add(key);
  }
  for (const url of rows.artifactUrls) {
    if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) keys.add(url);
  }
  return [...keys];
}
