import { DatabaseSync } from 'node:sqlite';

type Faults = {
  failPrepare?: (sql: string) => boolean;
  failRun?: (sql: string, args: unknown[]) => Error | null;
  failFirst?: (sql: string, args: unknown[]) => Error | null;
  failAll?: (sql: string, args: unknown[]) => Error | null;
  failBatch?: (statements: Array<{ sql: string; args: unknown[] }>) => Error | null;
};

type StatementRecord = { sql: string; args: unknown[] };

const normalizeArgs = (args: unknown[]) => args.map((value) => {
  if (typeof value === 'boolean') return Number(value);
  return value;
});

/** Executes production D1 SQL in SQLite, including FK enforcement and serialized rollback transactions. */
export function commsDatabase(schema: string, faults: Faults = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(schema);

  let previous = Promise.resolve();

  const makeStatement = (sql: string, args: unknown[] = []) => {
    if (faults.failPrepare?.(sql)) {
      throw new Error(`prepare fault injected for SQL: ${sql}`);
    }

    const execute = <T>(mode: 'run' | 'first' | 'all', fn: () => T): T => {
      const injector = mode === 'run'
        ? faults.failRun?.(sql, args)
        : mode === 'first'
          ? faults.failFirst?.(sql, args)
          : faults.failAll?.(sql, args);
      if (injector) throw injector;
      return fn();
    };

    return {
      sql,
      args,
      bind: (...values: unknown[]) => makeStatement(sql, normalizeArgs(values)),
      async run() {
        return execute('run', () => {
          const result = sqlite.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(result.changes) } };
        });
      },
      async first<T = any>() {
        return execute('first', () => (sqlite.prepare(sql).get(...args) as T) ?? null);
      },
      async all<T = any>() {
        return execute('all', () => ({
          results: sqlite.prepare(sql).all(...args) as T[],
          success: true,
        }));
      },
    };
  };

  const db = {
    prepare(sql: string) {
      return makeStatement(sql);
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { success: true };
    },
    async batch(statements: Array<{ run(): Promise<any>; sql?: string; args?: unknown[] }>) {
      let release!: () => void;
      const turn = new Promise<void>((resolve) => { release = resolve; });
      const wait = previous;
      previous = turn;
      await wait;

      const records = statements.map((statement) => ({
        sql: String(statement.sql || ''),
        args: Array.isArray(statement.args) ? statement.args : [],
      })) as StatementRecord[];

      let transactionStarted = false;

      try {
        const batchFault = faults.failBatch?.(records);
        if (batchFault) throw batchFault;

        sqlite.exec('BEGIN');
        transactionStarted = true;
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        transactionStarted = false;
        return results;
      } catch (error) {
        if (transactionStarted) sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        release();
      }
    },
  };

  return { sqlite, db };
}
