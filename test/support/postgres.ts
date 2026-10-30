import { SQL } from 'bun';

const image =
  'postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b';

function docker(args: string[], timeout = 30_000) {
  const result = Bun.spawnSync(['docker', ...args], { timeout });
  if (result.exitCode !== 0) throw new Error(`docker ${args[0]}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export class Postgres {
  private readonly owner = crypto.randomUUID();
  private id = '';
  private clients: SQL[] = [];
  url = '';
  private static readonly active = new Set<Postgres>();
  private static readonly onInt = () => Postgres.interrupt(130);
  private static readonly onTerm = () => Postgres.interrupt(143);

  private static interrupt(code: number) {
    for (const owned of Postgres.active) {
      try {
        owned.remove();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        code = 2;
      }
    }
    process.exit(code);
  }

  async start() {
    docker(['pull', image], 120_000);
    this.id = docker([
      'create',
      '--name',
      `proof-test-${this.owner}`,
      '--label',
      `proof.test=${this.owner}`,
      '--rm',
      '-e',
      'POSTGRES_PASSWORD=proof-test',
      '-p',
      '127.0.0.1::5432',
      '--entrypoint',
      'timeout',
      image,
      '900',
      'docker-entrypoint.sh',
      'postgres',
    ]);
    if (!Postgres.active.size) {
      process.on('SIGINT', Postgres.onInt);
      process.on('SIGTERM', Postgres.onTerm);
    }
    Postgres.active.add(this);
    try {
      this.verify();
      docker(['start', this.id]);
      const info = this.inspect();
      const port = info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
      this.url = `postgres://postgres:proof-test@127.0.0.1:${port}/postgres`;
      const deadline = Date.now() + 30_000;
      while (true) {
        const sql = new SQL(this.url, { max: 1, connectionTimeout: 1 });
        try {
          await sql`SELECT 1`;
          await sql.close();
          break;
        } catch (error) {
          await sql.close();
          if (Date.now() >= deadline) throw error;
          await Bun.sleep(100);
        }
      }
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private inspect() {
    const result = Bun.spawnSync(['docker', 'inspect', this.id], { timeout: 10_000 });
    if (result.exitCode !== 0) {
      if (result.stderr.toString().toLowerCase().includes('no such object')) return undefined;
      throw new Error(`docker inspect: ${result.stderr.toString()}`);
    }
    return JSON.parse(result.stdout.toString())[0];
  }

  private verify() {
    const info = this.inspect();
    if (
      info &&
      (info.Config.Labels?.['proof.test'] !== this.owner ||
        info.Config.Labels?.['com.docker.compose.project'] !== undefined)
    )
      throw new Error(`refusing to touch unowned or Compose container ${this.id}`);
    return info;
  }

  private remove() {
    if (!this.id) return;
    if (this.verify()) {
      const result = Bun.spawnSync(['docker', 'rm', '-f', '-v', this.id], { timeout: 10_000 });
      if (result.exitCode !== 0 && this.inspect())
        throw new Error(`docker rm: ${result.stderr.toString()}`);
    }
    this.assertAbsent();
  }

  assertAbsent() {
    if (this.inspect()) throw new Error(`container remains: ${this.id}`);
  }

  async database() {
    const admin = this.connect(this.url);
    const name = `proof_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(this.url);
    url.pathname = `/${name}`;
    return { PROOF_STORE: url.href, sql: this.connect(url.href) };
  }

  connect(url: string) {
    const sql = new SQL(url, { max: 1, connectionTimeout: 2 });
    this.clients.push(sql);
    return sql;
  }

  async close() {
    try {
      for (const sql of this.clients.splice(0)) await sql.close();
    } finally {
      try {
        this.remove();
      } finally {
        Postgres.active.delete(this);
        if (!Postgres.active.size) {
          process.off('SIGINT', Postgres.onInt);
          process.off('SIGTERM', Postgres.onTerm);
        }
      }
    }
  }
}

export async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for blocked database operation');
    await Bun.sleep(10);
  }
}

export function output(child: ReturnType<typeof Bun.spawn>) {
  return Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
  ]).then(([code, out, err]) => ({ code, out, err }));
}
