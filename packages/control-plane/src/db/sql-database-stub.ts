/**
 * A minimal SqlDatabase good enough for router unit tests. Test-only: nothing
 * in the worker bundle imports it.
 *
 * It exists because hand-rolled stubs kept being invalid in ways no test
 * noticed — `prepare` returning undefined, `batch` returning undefined instead
 * of the positional result array the instrumented wrapper iterates. They passed
 * only for as long as no authenticated path happened to touch the database, and
 * broke a dozen files at once the moment one did. A stub that satisfies the
 * port keeps that from being a recurring surprise.
 *
 * Uniqueness is modelled, because a store that accepts every insert cannot tell
 * a first write from a replay, and code that depends on the primary key would
 * be tested against a database that does not have one.
 */
import type { SqlDatabase, SqlStatement, SqlResult } from "./sql-database";

export interface SqlDatabaseStub extends SqlDatabase {
  /** Primary keys the stub has seen, keyed by table name. */
  readonly inserted: Map<string, Set<string>>;
}

export function createSqlDatabaseStub(
  options: {
    /** Row returned by `first()`, for callers that read before they write. */
    firstRow?: Record<string, unknown> | null;
    /** Rows returned by `all()`. */
    rows?: Record<string, unknown>[];
  } = {}
): SqlDatabaseStub {
  const inserted = new Map<string, Set<string>>();

  function makeStatement(query: string): SqlStatement {
    let bound: unknown[] = [];
    const apply = () => {
      const insert = /^\s*INSERT INTO\s+(\w+)/i.exec(query);
      if (!insert) return;
      const table = insert[1];
      const keys = inserted.get(table) ?? new Set<string>();
      const key = String(bound[0]);
      if (keys.has(key)) throw new Error("UNIQUE constraint failed");
      keys.add(key);
      inserted.set(table, keys);
    };

    const statement: SqlStatement & { __apply?: () => void } = {
      bind(...values: unknown[]): SqlStatement {
        bound = values;
        return statement;
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        return (options.firstRow ?? null) as T | null;
      },
      async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
        return { results: (options.rows ?? []) as T[], meta: { changes: 0 } };
      },
      async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
        apply();
        return { results: [] as T[], meta: { changes: 0 } };
      },
    };
    statement.__apply = apply;
    return statement;
  }

  return {
    inserted,
    prepare: makeStatement,
    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      // Atomic in the port's contract: apply every statement, or none.
      for (const s of statements) (s as { __apply?: () => void }).__apply?.();
      return statements.map(() => ({ results: [] as T[], meta: { changes: 0 } }));
    },
  };
}
