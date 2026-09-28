import { DatabaseSync } from 'node:sqlite';

/** Executes production D1 SQL in SQLite, including transaction rollback. */
export function commsDatabase(schema: string) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const prepare = (sql: string) => {
    const make = (args: any[] = []): any => ({
      bind: (...values: any[]) => make(values.map(value => typeof value === 'boolean' ? Number(value) : value)),
      run: async () => { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    });
    return make();
  };
  let previous = Promise.resolve();
  const db = { prepare, batch: async (statements: any[]) => {
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const wait = previous; previous = turn; await wait;
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; } finally { release(); }
  } };
  return { sqlite, db };
}
