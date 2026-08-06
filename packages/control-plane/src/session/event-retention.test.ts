/**
 * Retention of a session's transcript, exercised against a store that really
 * holds rows.
 *
 * The repository's other tests assert which SQL was issued, which is the right
 * shape for a single statement. Retention is not one statement: it is an
 * insert, a running total, and a prune loop that has to agree with each other
 * over many writes. A store that answers those statements truthfully is the
 * only way to catch the failure that matters — totals drifting from the table,
 * so a session prunes the wrong amount or never prunes at all.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_EVENT_RETENTION, type EventRetentionConfig } from "./event-persistence";
import { SessionRepository } from "./repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

interface EventRow {
  id: string;
  type: string;
  data: string;
  message_id: string | null;
  created_at: number;
}

interface MetaRow {
  total_count: number;
  total_bytes: number;
  pruned_count: number;
  pruned_through: number | null;
}

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;

/**
 * The slice of SQLite the events path uses, implemented over arrays. It
 * recognizes statements by shape rather than by exact text, so a reformatted
 * query keeps working while a changed one fails loudly.
 */
function createEventStore() {
  const events: EventRow[] = [];
  let meta: MetaRow | null = null;

  function result(rows: unknown[]): SqlResult {
    return {
      toArray: () => rows,
      one: () => rows[0] ?? null,
      rowsWritten: 0,
    } as SqlResult;
  }

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      const q = query.replace(/\s+/g, " ").trim();

      if (q.startsWith("INSERT INTO events (")) {
        const [id, type, data, messageId, createdAt] = params as [
          string,
          string,
          string,
          string | null,
          number,
        ];
        const existing = events.find((row) => row.id === id);
        if (!existing) {
          events.push({ id, type, data, message_id: messageId, created_at: createdAt });
        } else if (q.includes("DO UPDATE SET")) {
          existing.data = data;
          existing.message_id = messageId;
        }
        return result([]);
      }

      if (q.startsWith("SELECT length(CAST(data AS BLOB)) AS bytes FROM events WHERE id = ?")) {
        const row = events.find((event) => event.id === params[0]);
        return result(row ? [{ bytes: byteLength(row.data) }] : []);
      }

      if (q.startsWith("SELECT id, length(CAST(data AS BLOB)) AS bytes, created_at FROM events")) {
        const limit = params[0] as number;
        return result(
          [...events]
            .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
            .slice(0, limit)
            .map((row) => ({
              id: row.id,
              bytes: byteLength(row.data),
              created_at: row.created_at,
            }))
        );
      }

      if (q.startsWith("DELETE FROM events WHERE id IN")) {
        const ids = new Set(params as string[]);
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (ids.has(events[i].id)) events.splice(i, 1);
        }
        return result([]);
      }

      if (q.startsWith("SELECT total_count, total_bytes, pruned_count, pruned_through")) {
        return result(meta ? [{ ...meta }] : []);
      }

      if (q.startsWith("INSERT INTO events_meta")) {
        const [count, bytes, , countDelta, bytesDelta] = params as [
          number,
          number,
          number,
          number,
          number,
        ];
        if (!meta) {
          meta = { total_count: count, total_bytes: bytes, pruned_count: 0, pruned_through: null };
        } else {
          meta.total_count = Math.max(0, meta.total_count + countDelta);
          meta.total_bytes = Math.max(0, meta.total_bytes + bytesDelta);
        }
        return result([]);
      }

      if (q.startsWith("UPDATE events_meta SET total_count = MAX(0, total_count - ?)")) {
        const [countDelta, bytesDelta, prunedDelta, prunedThrough] = params as [
          number,
          number,
          number,
          number,
        ];
        if (meta) {
          meta.total_count = Math.max(0, meta.total_count - countDelta);
          meta.total_bytes = Math.max(0, meta.total_bytes - bytesDelta);
          meta.pruned_count += prunedDelta;
          meta.pruned_through = Math.max(meta.pruned_through ?? 0, prunedThrough);
        }
        return result([]);
      }

      throw new Error(`Unexpected statement in the events store fake: ${q}`);
    },
  };

  return {
    sql,
    events,
    ids: () => events.map((row) => row.id),
  };
}

function makeRepository(retention: EventRetentionConfig = DEFAULT_EVENT_RETENTION) {
  const store = createEventStore();
  const repo = new SessionRepository(
    store.sql,
    (closure) => closure(),
    new SessionAttachmentRepository(store.sql),
    retention
  );
  return { store, repo };
}

function payload(bytes: number): string {
  return JSON.stringify({ type: "tool_result", result: "x".repeat(Math.max(0, bytes - 30)) });
}

describe("transcript retention", () => {
  it("keeps a running total as events are written", () => {
    const { repo } = makeRepository();

    repo.createEvent({ id: "e1", type: "tool_call", data: "abc", messageId: null, createdAt: 1 });
    repo.createEvent({ id: "e2", type: "tool_call", data: "de", messageId: null, createdAt: 2 });

    expect(repo.getEventsMeta()).toMatchObject({ totalCount: 2, totalBytes: 5 });
  });

  it("counts a multibyte payload in bytes, not characters", () => {
    const { repo } = makeRepository();
    repo.createEvent({ id: "e1", type: "token", data: "日本", messageId: null, createdAt: 1 });
    expect(repo.getEventsMeta().totalBytes).toBe(6);
  });

  /**
   * A streamed token rewrites the same row on every chunk. Accounting it as an
   * addition rather than a delta would inflate the running total by the whole
   * history of the stream, and the session would prune itself while nearly
   * empty.
   */
  it("accounts a rewritten token event as a delta, not an addition", () => {
    const { repo } = makeRepository();
    const token = {
      type: "token" as const,
      content: "hi",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1,
    };

    repo.upsertTokenEvent("msg-1", token, 1000);
    const afterFirst = repo.getEventsMeta();
    repo.upsertTokenEvent("msg-1", { ...token, content: "hi there, at length" }, 1000);
    const afterSecond = repo.getEventsMeta();

    expect(afterFirst.totalCount).toBe(1);
    expect(afterSecond.totalCount).toBe(1);
    expect(afterSecond.totalBytes).toBeGreaterThan(afterFirst.totalBytes);
    expect(afterSecond.totalBytes).toBe(
      JSON.stringify({ ...token, content: "hi there, at length" }).length
    );
  });

  it("does not account a completion it declined to write", () => {
    const { repo } = makeRepository();
    const completion = {
      type: "execution_complete" as const,
      messageId: "msg-1",
      success: false,
      sandboxId: "sb-1",
      timestamp: 1,
    };

    repo.recordExecutionCompleteEventIfAbsent("msg-1", completion, 1000);
    const afterFirst = repo.getEventsMeta();
    repo.recordExecutionCompleteEventIfAbsent("msg-1", { ...completion, success: true }, 2000);

    expect(repo.getEventsMeta()).toEqual(afterFirst);
    expect(afterFirst.totalCount).toBe(1);
  });

  it("leaves an ordinary session entirely alone", () => {
    const { store, repo } = makeRepository();
    for (let i = 0; i < 50; i += 1) {
      repo.createEvent({
        id: `e${i}`,
        type: "tool_call",
        data: payload(1000),
        messageId: null,
        createdAt: i,
      });
    }

    expect(store.events).toHaveLength(50);
    expect(repo.getEventsMeta()).toMatchObject({ prunedCount: 0, prunedThrough: null });
  });

  it("prunes the oldest events once the count budget is passed", () => {
    const { store, repo } = makeRepository({
      ...DEFAULT_EVENT_RETENTION,
      eventsMaxCount: 3,
    });

    for (let i = 1; i <= 6; i += 1) {
      repo.createEvent({
        id: `e${i}`,
        type: "tool_call",
        data: "x",
        messageId: null,
        createdAt: i,
      });
    }

    // The tail is what anyone reads: the end of a session is where its outcome
    // is, so the beginning is what goes.
    expect(store.ids()).toEqual(["e4", "e5", "e6"]);
    expect(repo.getEventsMeta()).toMatchObject({ totalCount: 3, prunedCount: 3, prunedThrough: 3 });
  });

  it("prunes once the byte budget is passed, whatever the count", () => {
    const { store, repo } = makeRepository({
      ...DEFAULT_EVENT_RETENTION,
      eventsMaxBytes: 2500,
    });

    for (let i = 1; i <= 5; i += 1) {
      repo.createEvent({
        id: `e${i}`,
        type: "tool_result",
        data: payload(1000),
        messageId: null,
        createdAt: i,
      });
    }

    expect(store.events.length).toBeLessThan(5);
    expect(store.ids()[store.ids().length - 1]).toBe("e5");
    expect(repo.getEventsMeta().totalBytes).toBeLessThanOrEqual(2500);
  });

  /**
   * The watermark is the seam a later deep-history fetch-through needs: a
   * replay that reaches past it knows it has hit the retention boundary rather
   * than the beginning of the session.
   */
  it("records how far the pruning reached", () => {
    const { repo } = makeRepository({ ...DEFAULT_EVENT_RETENTION, eventsMaxCount: 2 });

    for (const createdAt of [10, 20, 30, 40]) {
      repo.createEvent({
        id: `e${createdAt}`,
        type: "tool_call",
        data: "x",
        messageId: null,
        createdAt,
      });
    }

    const meta = repo.getEventsMeta();
    expect(meta.prunedCount).toBe(2);
    expect(meta.prunedThrough).toBe(20);
  });

  it("keeps the totals in step with the table across many writes", () => {
    const { store, repo } = makeRepository({ ...DEFAULT_EVENT_RETENTION, eventsMaxCount: 10 });

    for (let i = 1; i <= 40; i += 1) {
      repo.createEvent({
        id: `e${i}`,
        type: "tool_call",
        data: payload(200 + i),
        messageId: null,
        createdAt: i,
      });
    }

    const meta = repo.getEventsMeta();
    expect(meta.totalCount).toBe(store.events.length);
    expect(meta.totalBytes).toBe(store.events.reduce((sum, row) => sum + byteLength(row.data), 0));
  });

  it("reports zeroes for a session that has never written an event", () => {
    const { repo } = makeRepository();
    expect(repo.getEventsMeta()).toEqual({
      totalCount: 0,
      totalBytes: 0,
      prunedCount: 0,
      prunedThrough: null,
    });
  });
});
