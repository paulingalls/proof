import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { output, Postgres } from './support/postgres';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-store-list-'));
  paths.push(path);
  return path;
}
function fixture(project: string) {
  const repo = Repo.from(`store-list:${project}`, (template) =>
    template.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project,
        tasks: { lint: { run: 'echo store-list-marker', inputs: ['src/**'] } },
      }),
      'src/a.ts': 'a',
    }),
  );
  repos.push(repo);
  return repo;
}
function config(home = false) {
  const base = directory();
  const file = join(base, home ? '.config/proof/store' : 'proof/store');
  mkdirSync(join(file, '..'), { recursive: true });
  return { file, env: home ? { HOME: base } : { XDG_CONFIG_HOME: base } };
}
const excluded = (file: string, project: string) =>
  `store not used: project '${project}' is not listed in ${file}`;

test('unlisted commands and doctor use SQLite without contacting the file endpoint', async () => {
  let connections = 0;
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        connections++;
        socket.end();
      },
      data() {},
    },
  });
  try {
    for (const home of [false, true]) {
      const repo = fixture('b');
      const { file, env: location } = config(home);
      writeFileSync(file, `postgres://localhost:${listener.port}/proof\na\n b\n`);
      const env = { ...location, PROOF_STATE_DIR: directory() };
      for (const [args, expected] of [
        [['plan'], 'RUN lint'],
        [['record', 'lint', '--outcome', 'green'], 'recorded green lint; proof published'],
        [['plan'], 'PROVEN lint'],
        [['run'], 'PROVEN lint'],
        [['run', '--fresh'], 'store-list-marker'],
        [['status', '--ref', 'HEAD'], 'PROVEN lint'],
        [['why', 'lint'], 'PROVEN lint'],
        [['flakes'], 'no contradictions'],
        [['stats'], 'lint: median'],
        [['invalidate', '--task', 'lint'], 'deleted 1 proof(s)'],
        [['plan'], 'RUN lint'],
      ] as [string[], string][]) {
        const result = await output(repo.spawnCli(args, env));
        expect(result.code).toBe(0);
        expect(result.out).toContain(expected);
        expect(result.err).toBe(`${excluded(file, 'b')}\n`);
        expect(connections).toBe(0);
      }
      const doctor = await output(repo.spawnCli(['doctor'], env));
      expect(doctor.code).toBe(0);
      expect(doctor.err).toBe('');
      expect(doctor.out).toContain(`Store: ${excluded(file, 'b')}\n`);
      expect(doctor.out).toContain('Reachability: reachable\nSchema version: 2\n');
      expect(doctor.out).toContain(`Replica: ${join(env.PROOF_STATE_DIR, 'proof.db')}`);
      expect(connections).toBe(0);
    }
  } finally {
    listener.stop(true);
  }
}, 30_000);

let postgres: Postgres;
beforeAll(async () => {
  postgres = await new Postgres().start();
}, 180_000);
afterAll(async () => {
  await postgres?.close();
}, 30_000);

for (const mode of ['listed', 'url-only', 'override']) {
  test(`${mode} selection shares proof across fresh-state clones`, async () => {
    const repo = fixture('a');
    const { file, env: location } = config();
    const { PROOF_STORE, sql } = await postgres.database();
    let connections = 0;
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(socket) {
          connections++;
          socket.end();
        },
        data() {},
      },
    });
    try {
      const url = mode === 'override' ? `postgres://localhost:${listener.port}/proof` : PROOF_STORE;
      writeFileSync(file, `${url}\nb\n`);
      const env = { ...location, PROOF_STATE_DIR: directory() };
      const local = await output(repo.spawnCli(['record', 'lint', '--outcome', 'green'], env));
      expect(local.code).toBe(0);
      expect(local.err).toBe(`${excluded(file, 'a')}\n`);
      if (mode !== 'override')
        expect(await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).toEqual([]);
      if (mode === 'listed') writeFileSync(file, `${url}\r\nb\r\n\r\na\r\n`);
      if (mode === 'url-only') writeFileSync(file, `${url}\n\n`);
      const selected = { ...env, ...(mode === 'override' ? { PROOF_STORE } : {}) };
      const shared = await output(repo.spawnCli(['run', '--fresh'], selected));
      expect(shared.code).toBe(0);
      expect(shared.err).toBe('');
      expect(shared.out).toContain('store-list-marker');
      expect(await sql`SELECT project, outcome FROM results`).toEqual([
        { project: 'a', outcome: 'green' },
      ]);
      const clone = new Repo(repo);
      repos.push(clone);
      const plan = clone.cli(['plan'], { ...selected, PROOF_STATE_DIR: directory() });
      expect(plan.code).toBe(0);
      expect(plan.err).toBe('');
      expect(plan.out).toContain('PROVEN lint');
      expect(connections).toBe(0);
    } finally {
      listener.stop(true);
    }
  }, 30_000);
}
