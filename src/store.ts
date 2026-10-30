import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Outcome = 'green' | 'red' | 'incomplete';

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
      CREATE TABLE IF NOT EXISTS contradictions (
        id INTEGER PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
        green_result INTEGER NOT NULL REFERENCES results(id),
        red_result INTEGER NOT NULL REFERENCES results(id), kind TEXT NOT NULL,
        deleted_proof INTEGER NOT NULL, recorded_at TEXT NOT NULL
      );
    `);
  }

  proof(project: string, task: string, key: string) {
    return this.db
      .query<
        {
          result_id: number;
          commit: string;
          host: string;
          finished_at: string;
          red_commit: string | null;
          red_host: string | null;
        },
        [string, string, string]
      >(`
      SELECT p.result_id, r."commit", r.host, r.finished_at,
        red."commit" AS red_commit, red.host AS red_host
      FROM proofs p JOIN results r
      ON r.id = p.result_id AND r.project = p.project AND r.task = p.task AND r.key = p.key
      LEFT JOIN contradictions c ON c.project = p.project AND c.task = p.task AND c.key = p.key
        AND c.green_result = p.result_id AND c.deleted_proof = 0
      LEFT JOIN results red ON red.id = c.red_result
      WHERE p.project = ? AND p.task = ? AND p.key = ?
    `)
      .get(project, task, key);
  }

  record(
    project: string,
    task: string,
    key: string,
    outcome: Outcome,
    seconds: number | null,
    host: string,
    commit: string,
    dirty: boolean,
  ) {
    this.db.transaction(() => {
      const result = this.db
        .query(`
        INSERT INTO results (project, task, key, outcome, seconds, host, "commit", dirty, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          project,
          task,
          key,
          outcome,
          seconds,
          host,
          commit,
          Number(dirty),
          new Date().toISOString(),
        );
      if (outcome === 'green' && !dirty)
        this.db
          .query(`
        INSERT INTO proofs (project, task, key, result_id) VALUES (?, ?, ?, ?)
        ON CONFLICT (project, task, key) DO UPDATE SET result_id = excluded.result_id
      `)
          .run(project, task, key, result.lastInsertRowid);
      if (outcome === 'red') {
        const proof = this.proof(project, task, key);
        if (!proof) return;
        this.db
          .query(`
          INSERT INTO contradictions
            (project, task, key, green_result, red_result, kind, deleted_proof, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'ordinary', 0, ?)
        `)
          .run(
            project,
            task,
            key,
            proof.result_id,
            result.lastInsertRowid,
            new Date().toISOString(),
          );
      }
    })();
  }

  close() {
    this.db.close();
  }
}
