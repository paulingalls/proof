import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  private readonly db: Database;

  constructor() {
    const { PROOF_STATE_DIR, XDG_STATE_HOME, HOME } = process.env;
    const base =
      PROOF_STATE_DIR ||
      (XDG_STATE_HOME
        ? join(XDG_STATE_HOME, 'proof')
        : HOME
          ? join(HOME, '.local/state/proof')
          : undefined);
    if (!base) throw new Error('set PROOF_STATE_DIR, XDG_STATE_HOME or HOME for the proof store');
    mkdirSync(base, { recursive: true });
    this.db = new Database(join(base, 'proof.db'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
        outcome TEXT NOT NULL, seconds REAL, host TEXT NOT NULL, "commit" TEXT NOT NULL,
        dirty INTEGER NOT NULL, finished_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proofs (
        project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
        result_id INTEGER NOT NULL REFERENCES results(id),
        PRIMARY KEY (project, task, key)
      );
    `);
  }

  proof(project: string, task: string, key: string) {
    return this.db
      .query<{ commit: string; host: string; finished_at: string }, [string, string, string]>(`
      SELECT r."commit", r.host, r.finished_at FROM proofs p JOIN results r
      ON r.id = p.result_id AND r.project = p.project AND r.task = p.task AND r.key = p.key
      WHERE p.project = ? AND p.task = ? AND p.key = ?
    `)
      .get(project, task, key);
  }

  close() {
    this.db.close();
  }
}
