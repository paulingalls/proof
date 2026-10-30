import { SQL } from 'bun';
import { redacted } from './config';
import type { Backend, Query } from './store';

export function postgres(url: string): Backend {
  const sql = new SQL(url, { max: 1, connectionTimeout: 5 });
  const queryFor =
    (connection: Pick<SQL, 'unsafe'>): Query =>
    async <T>(statement: string, ...values: (string | number | null)[]) => {
      let index = 0;
      const text = statement.replaceAll('?', () => `$${++index}`);
      return (await connection.unsafe(text, values)) as T[];
    };
  async function named<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      throw new Error(
        `Postgres store ${redacted(url)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    remote: true,
    query: (statement, ...values) => named(() => queryFor(sql)(statement, ...values)),
    async transaction(lock, work) {
      return await named(() =>
        sql.begin('isolation level read committed', async (connection) => {
          await connection`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
          return await work(queryFor(connection));
        }),
      );
    },
    async close() {
      await sql.close();
    },
  };
}
