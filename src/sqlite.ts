import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from './config';
import type { Backend, Query, Value } from './store';

export function sqlitePath() {
  return join(statePath(), 'proof.db');
}

export function sqlite(): Backend {
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
  let transactions = Promise.resolve();
  return {
    query,
    remote: false,
    async transaction(_lock, work) {
      const previous = transactions;
      let release = () => {};
      transactions = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await work(query);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } finally {
        release();
      }
    },
    async close() {
      db.close();
    },
  };
}
