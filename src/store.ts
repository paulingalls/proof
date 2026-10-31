import { redacted, storeUrl } from './config';
import { postgres, UnreachableStore } from './postgres';
import { sqlite, sqlitePath } from './sqlite';
import { initialize } from './store-schema';

export type Sharing = 'local' | 'shared' | 'not shared' | 'sharing uncertain';
export type Outcome = 'green' | 'red' | 'incomplete';
export type Value = string | number | null;
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

export function localDay(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

type HistoryResult = {
  task: string;
  outcome: Outcome;
  seconds: number | null;
  finished_at: string;
};
type Skip = { task: string; day: string; count: number };

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
    mode: 'ordinary' | 'super' = 'ordinary',
  ): Promise<{ sharing: Sharing; deletedLocal: boolean; deletedShared: boolean }> {
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
        let deleted = false;
        if (outcome === 'red' && !dirtyInputs) {
          const proof = await this.lookup(project, task, key, query, !backend.remote);
          if (proof) {
            deleted = mode === 'super' || proof.red_commit !== null;
            await query(
              `
          INSERT INTO contradictions
            (project, task, key, green_result, red_result, kind, deleted_proof, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
              project,
              task,
              key,
              proof.result_id,
              result.id,
              mode,
              Number(deleted),
              finishedAt,
            );
            if (deleted)
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
        return { id: result.id, deleted };
      });
    const local = await write(this.local);
    const result = { deletedLocal: local.deleted, deletedShared: false };
    if (!this.remote) return { ...result, sharing: 'local' };
    if (this.offline) return { ...result, sharing: 'not shared' };
    try {
      const remote = await write(this.remote);
      await this.local.query('DELETE FROM unshared_reds WHERE result_id = ?', local.id);
      return { ...result, deletedShared: remote.deleted, sharing: 'shared' };
    } catch (error) {
      this.fallback(error);
      return { ...result, sharing: 'sharing uncertain' };
    }
  }

  async skip(project: string, tasks: string[]) {
    if (!tasks.length) return;
    const day = localDay();
    const statement = `INSERT INTO skips (project, task, day, count) VALUES
      ${tasks.map(() => '(?, ?, ?, 1)').join(', ')}
      ON CONFLICT (project, task, day) DO UPDATE SET count = skips.count + excluded.count`;
    const values = tasks.flatMap((task) => [project, task, day]);
    await this.local.query(statement, ...values);
    if (this.remote && !this.offline) {
      try {
        await this.remote.query(statement, ...values);
      } catch (error) {
        this.fallback(error);
      }
    }
  }

  async history(project: string, start: string, end: string) {
    const read = async (query: Query) => ({
      results: await query<HistoryResult>(
        'SELECT task, outcome, seconds, finished_at FROM results WHERE project = ?',
        project,
      ),
      skips: await query<Skip>(
        'SELECT task, day, count FROM skips WHERE project = ? AND day >= ? AND day < ?',
        project,
        start,
        end,
      ),
    });
    if (this.remote && !this.offline) {
      try {
        return await read(this.remote.query);
      } catch (error) {
        this.fallback(error);
      }
    }
    return read(this.local.query);
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
