import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { collectSessionObjectKeys, purgeSessionStorage, type SessionPurgeDeps } from "./purge";

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function createDeps(overrides: Partial<SessionPurgeDeps> = {}) {
  const closed: Array<{ id: string; code: number; reason: string }> = [];
  const clientSockets = [{ id: "client-1" }, { id: "client-2" }] as unknown as WebSocket[];
  const sandboxSocket = { id: "sandbox" } as unknown as WebSocket;
  const deleted: string[] = [];

  const deps: SessionPurgeDeps = {
    storage: {
      deleteAll: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    } as unknown as SessionPurgeDeps["storage"],
    sockets: {
      forEachClientSocket: (_mode, fn) => clientSockets.forEach(fn),
      getSandboxSocket: () => sandboxSocket,
      close: (ws, code, reason) => {
        closed.push({ id: (ws as unknown as { id: string }).id, code, reason });
      },
    },
    objectKeys: () => ["sessions/sess-1/attachments/a-1", "sessions/sess-1/media/art-1.png"],
    objects: {
      delete: vi.fn(async (key: string) => {
        deleted.push(key);
      }),
    },
    log: testLogger(),
    ...overrides,
  };

  return { deps, closed, deleted };
}

describe("purgeSessionStorage", () => {
  it("hangs up every client and the sandbox before wiping anything", async () => {
    const { deps, closed } = createDeps();

    await purgeSessionStorage(deps);

    expect(closed).toEqual([
      { id: "client-1", code: 1001, reason: "session deleted" },
      { id: "client-2", code: 1001, reason: "session deleted" },
      { id: "sandbox", code: 1001, reason: "session deleted" },
    ]);
  });

  it("releases the session's stored objects", async () => {
    const { deps, deleted } = createDeps();

    const result = await purgeSessionStorage(deps);

    expect(deleted).toEqual(["sessions/sess-1/attachments/a-1", "sessions/sess-1/media/art-1.png"]);
    expect(result).toEqual({ purged: true, objectsDeleted: 2, objectsFailed: 0 });
  });

  it("cancels the alarm and wipes the durable storage", async () => {
    const { deps } = createDeps();

    await purgeSessionStorage(deps);

    // The alarm goes first: one left armed on a wiped database wakes the DO
    // into a session that no longer exists.
    expect(deps.storage.deleteAlarm).toHaveBeenCalled();
    expect(deps.storage.deleteAll).toHaveBeenCalled();
  });

  /**
   * An object that cannot be released is a leftover in a bucket. A purge that
   * stopped there would leave the whole database behind instead, which is the
   * larger leak and the one the user asked to be rid of.
   */
  it("finishes the purge when an object cannot be released", async () => {
    const { deps } = createDeps({
      objects: {
        delete: vi.fn(async (key: string) => {
          if (key.endsWith(".png")) throw new Error("R2 is unhappy");
        }),
      },
    });

    const result = await purgeSessionStorage(deps);

    expect(result).toEqual({ purged: true, objectsDeleted: 1, objectsFailed: 1 });
    expect(deps.storage.deleteAll).toHaveBeenCalled();
  });

  it("wipes the storage even with no media bucket bound", async () => {
    const { deps } = createDeps({ objects: null });

    const result = await purgeSessionStorage(deps);

    expect(result).toEqual({ purged: true, objectsDeleted: 0, objectsFailed: 0 });
    expect(deps.storage.deleteAll).toHaveBeenCalled();
  });

  /**
   * A DELETE that half-succeeded must be safe to retry, and a session that
   * never finished starting has no tables to read at all.
   */
  it("purges a session whose storage was never initialized", async () => {
    const { deps, closed } = createDeps({
      objectKeys: () => {
        throw new Error("no such table: attachments");
      },
    });

    const result = await purgeSessionStorage(deps);

    expect(result).toEqual({ purged: true, objectsDeleted: 0, objectsFailed: 0 });
    expect(deps.storage.deleteAll).toHaveBeenCalled();
    expect(closed).toHaveLength(3);
  });

  it("is safe to run twice", async () => {
    const { deps } = createDeps();

    await purgeSessionStorage(deps);
    const second = await purgeSessionStorage(deps);

    expect(second.purged).toBe(true);
    expect(deps.storage.deleteAll).toHaveBeenCalledTimes(2);
  });

  it("does not try to close a sandbox that is not connected", async () => {
    const { deps, closed } = createDeps();
    deps.sockets.getSandboxSocket = () => null;

    await purgeSessionStorage(deps);

    expect(closed.map((entry) => entry.id)).toEqual(["client-1", "client-2"]);
  });
});

describe("collectSessionObjectKeys", () => {
  it("takes every attachment's object key", () => {
    expect(
      collectSessionObjectKeys({
        attachmentObjectKeys: ["sessions/s/attachments/a", "sessions/s/attachments/b"],
        artifactUrls: [],
      })
    ).toEqual(["sessions/s/attachments/a", "sessions/s/attachments/b"]);
  });

  /**
   * A media artifact stores its object key in `url`; a pull request stores a
   * link there. Anything carrying a scheme points somewhere this session does
   * not own and must be left alone.
   */
  it("takes media artifact keys and leaves external links alone", () => {
    expect(
      collectSessionObjectKeys({
        attachmentObjectKeys: [],
        artifactUrls: [
          "sessions/s/media/art-1.png",
          "https://github.com/acme/web/pull/12",
          "http://example.com/preview",
          null,
          "",
        ],
      })
    ).toEqual(["sessions/s/media/art-1.png"]);
  });

  it("names each object once", () => {
    expect(
      collectSessionObjectKeys({
        attachmentObjectKeys: ["sessions/s/media/art-1.png"],
        artifactUrls: ["sessions/s/media/art-1.png"],
      })
    ).toEqual(["sessions/s/media/art-1.png"]);
  });
});
