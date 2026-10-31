import type { Backend } from './store';

export async function initialize(backend: Backend) {
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
    await query(`CREATE TABLE IF NOT EXISTS skips (
      project TEXT NOT NULL, task TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (project, task, day)
    )`);
    if (!row) await query('INSERT INTO schema_version (singleton, version) VALUES (1, 2)');
    else if (row.version === 1) await query('UPDATE schema_version SET version = 2');
    return 2;
  });
}
