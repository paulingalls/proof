#!/usr/bin/env -S bun --no-env-file
import { resolve } from 'node:path';
import pkg from '../package.json';
import { check } from './check';
import { doctor } from './doctor';
import { lint } from './lint';
import { plan, renderDecision } from './plan';
import { record } from './record';
import { run } from './run';
import { status } from './status';

const [command, ...args] = Bun.argv.slice(2);

if (command === '--version') {
  console.log(pkg.version);
} else if (['check', 'plan', 'record', 'lint', 'run', 'doctor', 'status'].includes(command ?? '')) {
  try {
    // git reports root-relative paths, and the working-tree reads resolve against cwd.
    if (command === 'check' && args[0]) args[0] = resolve(args[0]);
    const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel']);
    if (top.exitCode !== 0) throw new Error(top.stderr.toString().trim());
    process.chdir(top.stdout.toString().trim());
    if (command === 'doctor') {
      if (args.length) throw new Error('usage: proof doctor');
      process.exitCode = await doctor();
    } else if (command === 'run') {
      process.exitCode = await run(args);
    } else if (command === 'lint') {
      if (args.length) throw new Error('usage: proof lint');
      const findings = lint();
      for (const finding of findings) console.log(finding);
      process.exitCode = findings.length ? 1 : 0;
    } else if (command === 'record') {
      console.log(await record(args));
    } else if (command === 'status') {
      let ref: string | undefined;
      let json = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--json' && !json) json = true;
        else if (
          arg === '--ref' &&
          ref === undefined &&
          args[i + 1] &&
          !args[i + 1]?.startsWith('-')
        )
          ref = args[++i];
        else throw new Error('usage: proof status --ref <ref> [--json]');
      }
      if (!ref) throw new Error('usage: proof status --ref <ref> [--json]');
      const rows = await status(ref);
      if (json) console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(renderDecision(row));
      process.exitCode = rows.every((row) => row.state === 'PROVEN') ? 0 : 1;
    } else if (command === 'plan') {
      if (args.length && (args.length !== 1 || args[0] !== '--json'))
        throw new Error('usage: proof plan [--json]');
      const rows = await plan();
      if (args[0] === '--json') console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(renderDecision(row));
    } else {
      if (args.length !== 1 || !args[0]) throw new Error('usage: proof check <cases.yaml>');
      process.exitCode = await check(args[0]);
    }
  } catch (error) {
    console.error(`proof: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
} else {
  console.error(`proof: unknown command '${command ?? ''}'`);
  process.exit(2);
}
