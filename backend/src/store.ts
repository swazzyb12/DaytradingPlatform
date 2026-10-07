import initSqlJs, { type Database } from 'sql.js';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInitialState, type PaperState } from './domain.js';

const require = createRequire(import.meta.url);

export interface PaperStore {
  load(): PaperState;
  save(state: PaperState): void;
  close(): void;
}

export async function openPaperStore(path = process.env.PAPER_DB_PATH ?? 'data/paper-trading.sqlite'): Promise<PaperStore> {
  const filePath = resolve(path);
  mkdirSync(dirname(filePath), { recursive: true });
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
  const db: Database = existsSync(filePath) ? new SQL.Database(readFileSync(filePath)) : new SQL.Database();
  db.run('CREATE TABLE IF NOT EXISTS paper_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL)');
  const result = db.exec('SELECT state_json FROM paper_state WHERE id = 1');
  if (result.length === 0) {
    const initial = createInitialState();
    persist(initial);
  }

  function loadState(): PaperState {
    const rows = db.exec('SELECT state_json FROM paper_state WHERE id = 1');
    const serialized = rows[0]?.values[0]?.[0];
    if (typeof serialized !== 'string') return createInitialState();
    try {
      return JSON.parse(serialized) as PaperState;
    } catch {
      return createInitialState();
    }
  }

  function persist(state: PaperState) {
    db.run('INSERT INTO paper_state (id, state_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json', [JSON.stringify(state)]);
    writeFileSync(filePath, Buffer.from(db.export()));
  }

  return {
    load: loadState,
    save: persist,
    close() {
      persist(loadState());
      db.close();
    },
  };
}
