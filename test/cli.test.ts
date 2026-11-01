import { expect, test } from 'bun:test';
import pkg from '../package.json';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

test('--version prints the package version', () => {
  const run = Bun.spawnSync([cli, '--version']);
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString().trim()).toBe(pkg.version);
});
