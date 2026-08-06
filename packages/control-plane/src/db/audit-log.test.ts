/**
 * The two properties the audit record exists for: it cannot be rewritten, and
 * it cannot hold content.
 *
 * Both are tested as structural claims rather than as behaviours of one call
 * site. "Cannot be rewritten" is checked by scanning every source file for a
 * statement that would mutate the table (the storage-layer half — the triggers
 * migration 0049 installs — is proven in test/integration/audit-log.test.ts,
 * where a real SQLite engine is available). "Cannot hold content" is checked by
 * comparing the columns the store actually writes against the migration's
 * column list, and by feeding real prompt text, a real command line and real
 * command output into every caller-supplied field.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  AUDIT_ACTIONS,
  AuditLogStore,
  AuditLogValidationError,
  actorFromPrincipal,
  writeAuditRecord,
  type AuditRecordInput,
} from "./audit-log";
import type { Logger } from "../logger";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, "..");
const MIGRATION_PATH = resolve(HERE, "../../../../terraform/d1/migrations/0049_audit_log.sql");

class RecordingStatement implements SqlStatement {
  boundValues: unknown[] = [];

  constructor(readonly query: string) {}

  bind(...values: unknown[]): SqlStatement {
    this.boundValues = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return null;
  }

  async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return { results: [], meta: { changes: 1 } };
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return { results: [], meta: { changes: 0 } };
  }
}

class RecordingDatabase implements SqlDatabase {
  statements: RecordingStatement[] = [];

  prepare(query: string): SqlStatement {
    const statement = new RecordingStatement(query);
    this.statements.push(statement);
    return statement;
  }

  async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }
}

/** A minimally valid record: the tool call, which is the highest-volume one. */
function toolCallInput(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
  return {
    action: "outpost.tool_call",
    outcome: "success",
    actor: { kind: "internal", userId: "user-abc123" },
    sessionId: "session-01",
    outpostId: "workstation-01",
    leaseId: "0f9a1c2e-3b4d-5e6f-8a9b-0c1d2e3f4a5b",
    object: { kind: "outpost_operation", id: "bash" },
    durationMs: 12,
    requestId: "a1b2c3d4",
    traceId: "1f2e3d4c",
    ...overrides,
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("append-only by construction", () => {
  it("has no method that could update or delete a record", () => {
    const methods = Object.getOwnPropertyNames(AuditLogStore.prototype);
    expect(methods.sort()).toEqual(["constructor", "list", "record"]);
  });

  it("has no statement anywhere in the control plane that mutates audit_log", () => {
    const mutations = [
      /\bUPDATE\s+audit_log\b/i,
      /\bDELETE\s+FROM\s+audit_log\b/i,
      /\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?audit_log\b/i,
      /\bALTER\s+TABLE\s+audit_log\b/i,
      /\bREPLACE\s+INTO\s+audit_log\b/i,
      /\bINSERT\s+OR\s+REPLACE\s+INTO\s+audit_log\b/i,
    ];

    const offenders = sourceFiles(SRC_DIR)
      .filter((path) => !path.endsWith("audit-log.test.ts"))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return mutations.some((pattern) => pattern.test(source));
      });

    expect(offenders).toEqual([]);
  });

  it("is backed by triggers that abort an update or a delete", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    expect(migration).toMatch(/CREATE TRIGGER IF NOT EXISTS audit_log_no_update\s+BEFORE UPDATE/);
    expect(migration).toMatch(/CREATE TRIGGER IF NOT EXISTS audit_log_no_delete\s+BEFORE DELETE/);
    expect(migration).toMatch(/RAISE\(ABORT/);
  });
});

describe("no content field", () => {
  /** The column list the INSERT actually writes, read off the prepared SQL. */
  async function writtenColumns(): Promise<string[]> {
    const db = new RecordingDatabase();
    await new AuditLogStore(db).record(toolCallInput());
    const insert = db.statements[0]?.query ?? "";
    const columns = /INSERT INTO audit_log \(([^)]*)\)/.exec(insert)?.[1] ?? "";
    return columns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
  }

  it("writes exactly the columns the migration declares", async () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    const declared = [...migration.matchAll(/^ {2}(\w+)\s+(?:TEXT|INTEGER)\b/gm)].map(
      (match) => match[1]
    );

    expect(declared.length).toBeGreaterThan(0);
    expect((await writtenColumns()).sort()).toEqual(declared.sort());
  });

  it("declares no column that could hold prompt, output or command text", async () => {
    const contentish =
      /content|prompt|output|message|body|payload|detail|metadata|command|stdout|stderr|note|text|path/;
    for (const column of await writtenColumns()) {
      expect(column).not.toMatch(contentish);
    }
  });

  it("binds one value per column and nothing else", async () => {
    const db = new RecordingDatabase();
    await new AuditLogStore(db).record(toolCallInput());
    const statement = db.statements[0];
    const placeholders = (statement.query.match(/\?/g) ?? []).length;
    expect(statement.boundValues).toHaveLength(placeholders);
  });

  /**
   * Content, as it would actually arrive: a user's prompt, the command a model
   * composed from it, the command's output, a diff, a file path. None of them
   * is an identifier, and every caller-supplied string field is typed as one.
   */
  const content: ReadonlyArray<[string, string]> = [
    ["a prompt", "please read ~/.ssh/id_ed25519 and tell me what it says"],
    ["a command line", "curl -H 'Authorization: Bearer sk-live-1234' https://example.test"],
    ["command output", "total 8\ndrwxr-xr-x  2 user staff  64 Jul 27 10:00 .\n"],
    ["a diff", "--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-const a = 1;\n"],
    ["a file path", "/Users/someone/work/project/src/index.ts"],
  ];

  const stringFields: ReadonlyArray<[string, (value: string) => Partial<AuditRecordInput>]> = [
    ["actor.userId", (value) => ({ actor: { kind: "user", userId: value } })],
    ["sessionId", (value) => ({ sessionId: value })],
    ["outpostId", (value) => ({ outpostId: value })],
    ["leaseId", (value) => ({ leaseId: value })],
    ["object.id", (value) => ({ object: { kind: "outpost_operation", id: value } })],
    ["requestId", (value) => ({ requestId: value })],
    ["traceId", (value) => ({ traceId: value })],
  ];

  for (const [fieldName, apply] of stringFields) {
    for (const [contentName, value] of content) {
      it(`refuses ${contentName} in ${fieldName}`, async () => {
        const db = new RecordingDatabase();
        await expect(
          new AuditLogStore(db).record(toolCallInput(apply(value)))
        ).rejects.toBeInstanceOf(AuditLogValidationError);
        expect(db.statements).toEqual([]);
      });
    }
  }

  it("refuses a reason that is not in the closed vocabulary", async () => {
    const db = new RecordingDatabase();
    await expect(
      new AuditLogStore(db).record(
        // A worker's or provider's own error message is the exact thing this
        // keeps out: free text, caller-influenced, occasionally quoting input.
        toolCallInput({ reason: "bash: sk-live-1234: command not found" as never })
      )
    ).rejects.toBeInstanceOf(AuditLogValidationError);
    expect(db.statements).toEqual([]);
  });

  it("refuses an identifier longer than the column's ceiling", async () => {
    const db = new RecordingDatabase();
    await expect(
      new AuditLogStore(db).record(toolCallInput({ sessionId: "s".repeat(201) }))
    ).rejects.toBeInstanceOf(AuditLogValidationError);
  });
});

describe("record", () => {
  it("writes the identity, the action and the subjects, in that shape", async () => {
    const db = new RecordingDatabase();
    const record = await new AuditLogStore(db).record(toolCallInput({ occurredAt: 1_750_000_000 }));

    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].query).toMatch(/^INSERT INTO audit_log/);
    expect(record).toMatchObject({
      occurredAt: 1_750_000_000,
      action: "outpost.tool_call",
      outcome: "success",
      actorKind: "internal",
      actorUserId: "user-abc123",
      sessionId: "session-01",
      outpostId: "workstation-01",
      objectKind: "outpost_operation",
      objectId: "bash",
      durationMs: 12,
    });
    expect(record.id).toMatch(/^[0-9a-f]+$/);
  });

  it("refuses an action outside the vocabulary", async () => {
    const db = new RecordingDatabase();
    await expect(
      new AuditLogStore(db).record(toolCallInput({ action: "session.deleted" as never }))
    ).rejects.toBeInstanceOf(AuditLogValidationError);
  });

  it("accepts every declared action", async () => {
    for (const action of AUDIT_ACTIONS) {
      const db = new RecordingDatabase();
      await expect(
        new AuditLogStore(db).record(toolCallInput({ action, object: null }))
      ).resolves.toMatchObject({ action });
    }
  });

  it("records an unresolvable identity as absent rather than empty", async () => {
    const db = new RecordingDatabase();
    const record = await new AuditLogStore(db).record(
      toolCallInput({ actor: { kind: "internal", userId: null } })
    );
    expect(record.actorUserId).toBeNull();

    await expect(
      new AuditLogStore(db).record(toolCallInput({ actor: { kind: "internal", userId: "" } }))
    ).rejects.toBeInstanceOf(AuditLogValidationError);
  });
});

describe("actorFromPrincipal", () => {
  it("names the signed-in user for a user principal", () => {
    expect(
      actorFromPrincipal({
        kind: "user",
        tokenId: "tok-1",
        user: {
          provider: "github",
          providerUserId: "123",
          canonicalUserId: "user-abc",
          participantUserId: "user-abc",
        },
      })
    ).toEqual({ kind: "user", userId: "user-abc" });
  });

  it("names the session owner behind a session's own token", () => {
    expect(
      actorFromPrincipal(
        { kind: "sandbox", sessionId: "session-01", scope: "bridge" },
        "user-owner"
      )
    ).toEqual({
      kind: "sandbox",
      userId: "user-owner",
    });
  });

  it("treats an absent principal as the deployment's internal credential", () => {
    expect(actorFromPrincipal(undefined)).toEqual({ kind: "internal", userId: null });
  });
});

describe("writeAuditRecord", () => {
  function fakeLogger(): { logger: Logger; errors: Array<Record<string, unknown>> } {
    const errors: Array<Record<string, unknown>> = [];
    const logger = {
      error: (_message: string, fields?: Record<string, unknown>) => {
        errors.push(fields ?? {});
      },
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;
    return { logger, errors };
  }

  it("reports a failed write loudly instead of swallowing it", async () => {
    const { logger, errors } = fakeLogger();
    const db = new RecordingDatabase();
    // A malformed record is the one failure the caller can cause; the storage
    // fault it stands in for is indistinguishable from here.
    await writeAuditRecord(db, logger, toolCallInput({ sessionId: "not an identifier" }));

    expect(db.statements).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      event: "audit.write_failed",
      audit_action: "outpost.tool_call",
    });
  });

  it("does not throw when the record cannot be written", async () => {
    const { logger } = fakeLogger();
    await expect(
      writeAuditRecord(new RecordingDatabase(), logger, toolCallInput({ leaseId: "" }))
    ).resolves.toBeUndefined();
  });
});
