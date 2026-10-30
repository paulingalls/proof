#!/usr/bin/env bun
import pkg from '../package.json';
import { check } from './check';
import { plan } from './plan';
import { record } from './record';

const [command, ...args] = Bun.argv.slice(2);

if (command === '--version') {
  console.log(pkg.version);
} else if (command === 'check' || command === 'plan' || command === 'record') {
  try {
    if (command === 'record') {
      console.log(record(args));
    } else if (command === 'plan') {
      if (args.length) throw new Error('usage: proof plan');
      for (const row of plan()) console.log(`${row.state} ${row.task}: ${row.reason}`);
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
