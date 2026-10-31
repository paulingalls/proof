import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redacted, statePath, storeUrl } from './config';
import { postgres, UnreachableStore } from './postgres';

export type Sharing = 'local' | 'shared' | 'not shared' | 'sharing uncertain';
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

function sqlitePath() {
  return join(statePath(), 'proof.db');
}

function sqlite(): Backend {
  const base = statePath();
  mkdirSync(base, { recursive: true });
  const db = new Database(sqlitePath());
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

async function initialize(backend: Backend) {
  return await backend.transaction('proof:schema', async (query) => {
    await query(`CREATE TABLE IF NOT EXISTS schema_version (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
        )`);
    const [row] = await query<{ version: number }>('SELECT version FROM schema_version');
    if (row && row.version !== 1 && row.version !== 2)
      throw new Error(`store schema version ${row.version}; supported version 2`);
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
    if (!row || row.version === 1) await query('ALTER TABLE proofs ADD COLUMN env_hashes TEXT');
    await query(`CREATE TABLE IF NOT EXISTS contradictions (
          id ${id}, project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
          green_result ${reference} NOT NULL REFERENCES results(id),
          red_result ${reference} NOT NULL REFERENCES results(id), kind TEXT NOT NULL,
          deleted_proof INTEGER NOT NULL, recorded_at TEXT NOT NULL
        )`);
    if (!backend.remote)
      await query(`CREATE TABLE IF NOT EXISTS observed_contests (
        result_id INTEGER PRIMARY KEY REFERENCES results(id),
        red_commit TEXT NOT NULL, red_host TEXT NOT NULL
      )`);
    if (!backend.remote)
      await query(`CREATE TABLE IF NOT EXISTS unshared_reds (
        project TEXT NOT NULL, task TEXT NOT NULL, key TEXT NOT NULL,
        result_id INTEGER NOT NULL REFERENCES results(id), PRIMARY KEY (project, task, key)
      )`);
    if (!row) await query('INSERT INTO schema_version (singleton, version) VALUES (1, 2)');
    else if (row.version === 1) await query('UPDATE schema_version SET version = 2');
    return 2;
  });
}

export class Store {
  private closed = false;
  private offline = false;
  private constructor(
    private readonly local: Backend,
    private readonly remote?: Backend,
  ) {}

  static async diagnose() {
    const url = storeUrl();
    const backend = url ? postgres(url) : sqlite();
    let version: number | undefined;
    let reason: string | undefined;
    try {
      version = await initialize(backend);
    } catch (error) {
      if (error instanceof UnreachableStore) reason = error.message;
      else {
        try {
          await backend.close();
        } catch {
          /* Preserve the diagnostic failure. */
        }
        throw error;
      }
    }
    try {
      await backend.close();
    } catch (error) {
      if (!(reason && error instanceof UnreachableStore)) throw error;
    }
    return { store: url ? redacted(url) : sqlitePath(), replica: sqlitePath(), version, reason };
  }

  static async open() {
    const url = storeUrl();
    const local = sqlite();
    const store = new Store(local, url === undefined ? undefined : postgres(url));
    try {
      await initialize(local);
      if (store.remote) {
        try {
          await initialize(store.remote);
        } catch (error) {
          store.fallback(error);
        }
      }
      return store;
    } catch (error) {
      try {
        await store.close();
      } catch {
        /* Preserve the initialization failure. */
      }
      throw error;
    }
  }

  private fallback(error: unknown) {
    if (!(error instanceof UnreachableStore)) throw error;
    this.offline = true;
    console.error(`store unreachable (${error.message}); using this machine's own proofs`);
  }

  async proof(project: string, task: string, key: string) {
    if (this.remote && !this.offline) {
      try {
        const proof = await this.lookup(project, task, key, this.remote.query, false);
        await this.observe(project, task, key, this.remote.query, proof);
        const [red] = await this.local.query<{ red_commit: string; red_host: string }>(
          `SELECT r."commit" AS red_commit, r.host AS red_host
          FROM unshared_reds u JOIN results r ON r.id = u.result_id
          WHERE u.project = ? AND u.task = ? AND u.key = ?`,
          project,
          task,
          key,
        );
        return proof && red ? { ...proof, ...red } : proof;
      } catch (error) {
        this.fallback(error);
      }
    }
    return this.lookup(project, task, key, this.local.query, true);
  }

  async newestProof(project: string, task: string) {
    if (this.remote && !this.offline) {
      try {
        return await this.lookupNewest(project, task, this.remote.query);
      } catch (error) {
        this.fallback(error);
      }
    }
    return this.lookupNewest(project, task, this.local.query);
  }

  private async lookupNewest(project: string, task: string, query: Query) {
    const [proof] = await query<{
      key: string;
      env_hashes: string | null;
      commit: string;
      host: string;
      finished_at: string;
    }>(
      `SELECT p.key, p.env_hashes, r."commit", r.host, r.finished_at FROM proofs p JOIN results r
      ON r.id = p.result_id AND r.project = p.project AND r.task = p.task AND r.key = p.key
      WHERE p.project = ? AND p.task = ?
      ORDER BY r.finished_at DESC, p.result_id DESC LIMIT 1`,
      project,
      task,
    );
    return proof;
  }

  private async observe(project: string, task: string, key: string, query: Query, proof?: Proof) {
    let red = proof;
    if (!proof) {
      [red] = await query<Proof>(
        `SELECT r."commit" AS red_commit, r.host AS red_host
        FROM contradictions c JOIN results r ON r.id = c.red_result
        WHERE c.project = ? AND c.task = ? AND c.key = ? AND c.deleted_proof = 1 LIMIT 1`,
        project,
        task,
        key,
      );
    }
    if (red?.red_commit) {
      await this.local.query(
        `INSERT OR IGNORE INTO observed_contests
        (result_id, red_commit, red_host)
        SELECT result_id, ?, ? FROM proofs WHERE project = ? AND task = ? AND key = ?`,
        red.red_commit,
        red.red_host,
        project,
        task,
        key,
      );
    }
  }

  private async lookup(project: string, task: string, key: string, query: Query, local: boolean) {
    const [proof] = await query<Proof>(
      `
      SELECT p.result_id, r."commit", r.host, r.finished_at,
        ${local ? 'COALESCE(red."commit", o.red_commit)' : 'red."commit"'} AS red_commit,
        ${local ? 'COALESCE(red.host, o.red_host)' : 'red.host'} AS red_host
      FROM proofs p JOIN results r
      ON r.id = p.result_id AND r.project = p.project AND r.task = p.task AND r.key = p.key
      LEFT JOIN contradictions c ON c.project = p.project AND c.task = p.task AND c.key = p.key
        AND c.green_result = p.result_id AND c.deleted_proof = 0
      LEFT JOIN results red ON red.id = c.red_result
      ${local ? 'LEFT JOIN observed_contests o ON o.result_id = p.result_id' : ''}
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
    envHashes: [string, string][],
  ): Promise<Sharing> {
    const finishedAt = new Date().toISOString();
    const write = async (backend: Backend) =>
      backend.transaction(JSON.stringify([project, task, key]), async (query) => {
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
          finishedAt,
        );
        if (!result) throw new Error('store did not return the inserted result');
        if (outcome === 'green' && !dirty)
          await query(
            `
          INSERT INTO proofs (project, task, key, result_id, env_hashes) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (project, task, key) DO UPDATE SET
            result_id = excluded.result_id, env_hashes = excluded.env_hashes
        `,
            project,
            task,
            key,
            result.id,
            JSON.stringify(envHashes),
          );
        if (outcome === 'red' && !dirtyInputs) {
          const proof = await this.lookup(project, task, key, query, !backend.remote);
          if (proof) {
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
              finishedAt,
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
        }
        if (!backend.remote) {
          if (outcome === 'red' && !dirtyInputs)
            await query(
              `INSERT INTO unshared_reds (project, task, key, result_id) VALUES (?, ?, ?, ?)
              ON CONFLICT (project, task, key) DO UPDATE SET result_id = excluded.result_id`,
              project,
              task,
              key,
              result.id,
            );
          if (outcome === 'green' && !dirty)
            await query(
              'DELETE FROM unshared_reds WHERE project = ? AND task = ? AND key = ?',
              project,
              task,
              key,
            );
        }
        if (backend.remote) {
          const proof = await this.lookup(project, task, key, query, false);
          await this.observe(project, task, key, query, proof);
        }
        return result.id;
      });
    const localId = await write(this.local);
    if (!this.remote) return 'local';
    if (this.offline) return 'not shared';
    try {
      await write(this.remote);
      await this.local.query('DELETE FROM unshared_reds WHERE result_id = ?', localId);
      return 'shared';
    } catch (error) {
      this.fallback(error);
      return 'sharing uncertain';
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled([this.local.close(), this.remote?.close()]);
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      if (index === 1 && this.offline && result.reason instanceof UnreachableStore) continue;
      throw result.reason;
    }
  }
}
