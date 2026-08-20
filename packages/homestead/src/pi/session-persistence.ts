import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
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
const TRANSCRIPT_SCAN_CHUNK_BYTES = 64 * 1024;

type TranscriptRepairOutcome = "unchanged" | "tail-repaired" | "whole-file-recovered";

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
  const repairOutcome = await repairTornTranscript(sessionFile);

  let recovered = repairOutcome === "whole-file-recovered";
  let manager: SessionManager;
  try {
    manager = SessionManager.open(sessionFile, dir, cwd);
  } catch {
    await recoverWholeTranscript(sessionFile);
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

/** Repairs only an uncommitted final JSONL fragment, never a malformed middle line. */
async function repairTornTranscript(sessionFile: string): Promise<TranscriptRepairOutcome> {
  const handle = await open(sessionFile, "r+");
  let lastNewline: number | null = null;
  let size = 0;

  try {
    size = (await handle.stat()).size;
    if (size === 0) return "unchanged";

    const finalByte = Buffer.allocUnsafe(1);
    await readExactly(handle, finalByte, size - 1);
    if (finalByte[0] === 0x0a) return "unchanged";

    lastNewline = await findLastNewline(handle, size);
    if (lastNewline !== null) {
      await preserveAndTruncateTail(handle, sessionFile, lastNewline + 1, size);
      return "tail-repaired";
    }
  } finally {
    await handle.close();
  }

  await recoverWholeTranscript(sessionFile);
  return "whole-file-recovered";
}

async function findLastNewline(handle: FileHandle, endExclusive: number): Promise<number | null> {
  let chunkEnd = endExclusive;
  while (chunkEnd > 0) {
    const chunkStart = Math.max(0, chunkEnd - TRANSCRIPT_SCAN_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(chunkEnd - chunkStart);
    await readExactly(handle, chunk, chunkStart);
    const newlineOffset = chunk.lastIndexOf(0x0a);
    if (newlineOffset !== -1) return chunkStart + newlineOffset;
    chunkEnd = chunkStart;
  }
  return null;
}

async function preserveAndTruncateTail(
  transcript: FileHandle,
  sessionFile: string,
  tailStart: number,
  transcriptSize: number
): Promise<void> {
  const { path: sidecarPath, handle: sidecar } = await createTailSidecar(sessionFile);
  let sidecarHandle: FileHandle | null = sidecar;
  let sidecarComplete = false;

  try {
    await copyBytes(transcript, sidecarHandle, tailStart, transcriptSize);
    await sidecarHandle.sync();
    await sidecarHandle.close();
    sidecarHandle = null;
    await chmod(sidecarPath, SESSION_FILE_MODE);
    sidecarComplete = true;
    // Make the preserved suffix durable before removing it from the transcript.
    await syncDirectory(dirname(sessionFile));

    await transcript.truncate(tailStart);
    await transcript.sync();
    await syncDirectory(dirname(sessionFile));
  } finally {
    await sidecarHandle?.close().catch(() => {});
    if (!sidecarComplete) await rm(sidecarPath, { force: true }).catch(() => {});
  }
}

async function createTailSidecar(
  sessionFile: string
): Promise<{ path: string; handle: FileHandle }> {
  while (true) {
    const path = `${sessionFile}.corrupt-tail-${Date.now()}-${randomUUID()}`;
    try {
      return { path, handle: await open(path, "wx", SESSION_FILE_MODE) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function copyBytes(
  source: FileHandle,
  destination: FileHandle,
  start: number,
  endExclusive: number
): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_SCAN_CHUNK_BYTES, endExclusive - start));
  let sourcePosition = start;
  let destinationPosition = 0;

  while (sourcePosition < endExclusive) {
    const length = Math.min(buffer.length, endExclusive - sourcePosition);
    const view = buffer.subarray(0, length);
    await readExactly(source, view, sourcePosition);

    let written = 0;
    while (written < length) {
      const result = await destination.write(
        view,
        written,
        length - written,
        destinationPosition + written
      );
      if (result.bytesWritten === 0) throw new Error("failed to preserve torn transcript tail");
      written += result.bytesWritten;
    }
    sourcePosition += length;
    destinationPosition += length;
  }
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("transcript changed while it was being repaired");
    offset += result.bytesRead;
  }
}

async function recoverWholeTranscript(sessionFile: string): Promise<void> {
  const setAsidePath = `${sessionFile}.corrupt-${Date.now()}-${randomUUID()}`;
  await rename(sessionFile, setAsidePath);
  await chmod(setAsidePath, SESSION_FILE_MODE);
  await syncDirectory(dirname(sessionFile));
  await ensureOwnerOnlyFile(sessionFile);
  await syncDirectory(dirname(sessionFile));
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
