#!/usr/bin/env bun
import pkg from '../package.json';
import { check } from './check';
import { lint } from './lint';
import { plan } from './plan';
import { record } from './record';
import { run } from './run';

const [command, ...args] = Bun.argv.slice(2);

if (command === '--version') {
  console.log(pkg.version);
} else if (['check', 'plan', 'record', 'lint', 'run'].includes(command ?? '')) {
  try {
    if (command === 'run') {
      process.exitCode = await run(args);
    } else if (command === 'lint') {
      if (args.length) throw new Error('usage: proof lint');
      const findings = lint();
      for (const finding of findings) console.log(finding);
      process.exitCode = findings.length ? 1 : 0;
    } else if (command === 'record') {
      console.log(record(args));
    } else if (command === 'plan') {
      if (args.length && (args.length !== 1 || args[0] !== '--json'))
        throw new Error('usage: proof plan [--json]');
      const rows = plan();
      if (args[0] === '--json') console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(`${row.state} ${row.task}: ${row.reason}`);
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
