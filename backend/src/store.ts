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
  const WRITE_RETRIES = 6;
  const FLUSH_DEBOUNCE_MS = 350;
  const filePath = resolve(path);
  mkdirSync(dirname(filePath), { recursive: true });
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
  const db: Database = existsSync(filePath) ? new SQL.Database(readFileSync(filePath)) : new SQL.Database();
  db.run('CREATE TABLE IF NOT EXISTS paper_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL)');
  const result = db.exec('SELECT state_json FROM paper_state WHERE id = 1');
  if (result.length === 0) {
    const initial = createInitialState();
    persistSerialized(JSON.stringify(initial));
  }
  let pendingSerialized: string | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function sleep(ms: number) {
    const channel = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(channel, 0, 0, ms);
  }

  function retryableWriteError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'UNKNOWN';
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

  function persistSerialized(serialized: string) {
    db.run('INSERT INTO paper_state (id, state_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json', [serialized]);
    const bytes = Buffer.from(db.export());
    for (let attempt = 1; attempt <= WRITE_RETRIES; attempt += 1) {
      try {
        writeFileSync(filePath, bytes);
        return;
      } catch (error) {
        if (!retryableWriteError(error) || attempt === WRITE_RETRIES) throw error;
        sleep(20 * attempt);
      }
    }
  }

  function flushPending() {
    if (closed || pendingSerialized === null) return;
    const serialized = pendingSerialized;
    pendingSerialized = null;
    try {
      persistSerialized(serialized);
    } catch (error) {
      pendingSerialized = serialized;
      console.error('Paper store flush failed; keeping in-memory state and retrying on next save.', error);
    }
  }

  function scheduleFlush() {
    if (closed || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, FLUSH_DEBOUNCE_MS);
  }

  function persist(state: PaperState) {
    if (closed) return;
    pendingSerialized = JSON.stringify(state);
    scheduleFlush();
  }

  return {
    load: loadState,
    save: persist,
    close() {
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (pendingSerialized !== null) {
        persistSerialized(pendingSerialized);
        pendingSerialized = null;
      }
      db.close();
    },
  };
}
