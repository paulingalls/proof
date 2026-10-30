import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { statePath, storeUrl } from './config';
import { postgres } from './postgres';

export type Outcome = 'green' | 'red' | 'incomplete';
type Value = string | number | null;
export type Query = <T = Record<string, unknown>>(sql: string, ...values: Value[]) => Promise<T[]>;
export interface Backend {
  query: Query;
  transaction<T>(lock: string, work: (query: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  remote: boolean;
}
type Proof = {
  result_id: number | string;
  commit: string;
  host: string;
  finished_at: string;
  red_commit: string | null;
  red_host: string | null;
};

function sqlite(): Backend {
  const base = statePath();
  mkdirSync(base, { recursive: true });
  const db = new Database(join(base, 'proof.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  } catch (error) {
    db.close();
    throw error;
  }
  const query: Query = async <T>(sql: string, ...values: Value[]) =>
    db.query(sql).all(...values) as T[];
  return {
    query,
    remote: false,
    async transaction(_lock, work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(query);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}

export class Store {
  private closed = false;
  private constructor(private readonly backend: Backend) {}

  static async open() {
    const url = storeUrl();
    const backend = url === undefined ? sqlite() : postgres(url);
    try {
      await backend.transaction('proof:schema', async (query) => {
        await query(`CREATE TABLE IF NOT EXISTS schema_version (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
        )`);
        const [row] = await query<{ version: number }>('SELECT version FROM schema_version');
        if (row && row.version !== 1)
          throw new Error(`store schema version ${row.version}; supported version 1`);
        const id = backend.remote
          ? 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
          : 'INTEGER PRIMARY KEY';
        const reference = backend.remote ? 'BIGINT' : 'INTEGER';
        await query(`CREATE TABLE IF NOT EXISTS results (
          id ${id}, project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
          outcome TEXT NOT NULL, seconds DOUBLE PRECISION, host TEXT NOT NULL, "commit" TEXT NOT NULL,
          dirty INTEGER NOT NULL, finished_at TEXT NOT NULL
        )`);
        await query(`CREATE TABLE IF NOT EXISTS proofs (
          project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
          result_id ${reference} NOT NULL REFERENCES results(id),
          PRIMARY KEY (project, task, key)
        )`);
        await query(`CREATE TABLE IF NOT EXISTS contradictions (
          id ${id}, project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
          green_result ${reference} NOT NULL REFERENCES results(id),
          red_result ${reference} NOT NULL REFERENCES results(id), kind TEXT NOT NULL,
          deleted_proof INTEGER NOT NULL, recorded_at TEXT NOT NULL
        )`);
        if (!row) await query('INSERT INTO schema_version (singleton, version) VALUES (1, 1)');
      });
      return new Store(backend);
    } catch (error) {
      try {
        await backend.close();
      } catch {
        /* Preserve the initialization failure. */
      }
      throw error;
    }
  }

  async proof(project: string, task: string, key: string, query = this.backend.query) {
    const [proof] = await query<Proof>(
      `
      SELECT p.result_id, r."commit", r.host, r.finished_at,
        red."commit" AS red_commit, red.host AS red_host
      FROM proofs p JOIN results r
      ON r.id = p.result_id AND r.project = p.project AND r.task = p.task AND r.key = p.key
      LEFT JOIN contradictions c ON c.project = p.project AND c.task = p.task AND c.key = p.key
        AND c.green_result = p.result_id AND c.deleted_proof = 0
      LEFT JOIN results red ON red.id = c.red_result
      WHERE p.project = ? AND p.task = ? AND p.key = ?
    `,
      project,
      task,
      key,
    );
    return proof;
  }

  async record(
    project: string,
    task: string,
    key: string,
    outcome: Outcome,
    seconds: number | null,
    host: string,
    commit: string,
    dirty: boolean,
    dirtyInputs: boolean,
  ) {
    await this.backend.transaction(JSON.stringify([project, task, key]), async (query) => {
      const [result] = await query<{ id: number | string }>(
        `
        INSERT INTO results (project, task, key, outcome, seconds, host, "commit", dirty, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `,
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
      if (!result) throw new Error('store did not return the inserted result');
      if (outcome === 'green' && !dirty)
        await query(
          `
          INSERT INTO proofs (project, task, key, result_id) VALUES (?, ?, ?, ?)
          ON CONFLICT (project, task, key) DO UPDATE SET result_id = excluded.result_id
        `,
          project,
          task,
          key,
          result.id,
        );
      if (outcome === 'red' && !dirtyInputs) {
        const proof = await this.proof(project, task, key, query);
        if (!proof) return;
        await query(
          `
          INSERT INTO contradictions
            (project, task, key, green_result, red_result, kind, deleted_proof, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'ordinary', ?, ?)
        `,
          project,
          task,
          key,
          proof.result_id,
          result.id,
          Number(proof.red_commit !== null),
          new Date().toISOString(),
        );
        if (proof.red_commit !== null)
          await query(
            `DELETE FROM proofs WHERE project = ? AND task = ? AND key = ? AND result_id = ?`,
            project,
            task,
            key,
            proof.result_id,
          );
      }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.backend.close();
  }
}
