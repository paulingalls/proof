#!/usr/bin/env -S bun --no-env-file
import { resolve } from 'node:path';
import pkg from '../package.json';
import { check } from './check';
import { doctor } from './doctor';
import { flakes } from './flakes';
import {
  checkUsage,
  commandHelp,
  doctorUsage,
  generalHelp,
  helpUsage,
  lintUsage,
  planUsage,
  statusUsage,
} from './help';
import { invalidate } from './invalidate';
import { lint } from './lint';
import { plan, renderDecision } from './plan';
import { record } from './record';
import { run } from './run';
import { stats } from './stats';
import { status } from './status';
import { why } from './why';

const [command, ...args] = Bun.argv.slice(2);

const commands = [
  'check',
  'plan',
  'record',
  'lint',
  'run',
  'doctor',
  'status',
  'why',
  'stats',
  'flakes',
  'invalidate',
  'help',
];
const helpFlag = (value: string | undefined) => value === '--help' || value === '-h';
const unknown = (name: string) => `unknown command '${name}'\ncommands: ${commands.join(', ')}`;

if (command === '--version') {
  console.log(pkg.version);
} else if (
  command === undefined ||
  (args.length === 0 && (helpFlag(command) || command === 'help'))
) {
  console.log(generalHelp());
} else if (commands.includes(command)) {
  try {
    if (command === 'help' || (args.length === 1 && helpFlag(args[0]))) {
      if (args.length !== 1) throw new Error(helpUsage);
      const name = command === 'help' && !helpFlag(args[0]) ? (args[0] as string) : command;
      if (!commands.includes(name)) throw new Error(unknown(name));
      console.log(commandHelp(name));
      process.exit(0);
    }
    // git reports root-relative paths, and the working-tree reads resolve against cwd.
    if (command === 'check' && args[0]) args[0] = resolve(args[0]);
    const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel']);
    if (top.exitCode !== 0) throw new Error(top.stderr.toString().trim());
    process.chdir(top.stdout.toString().trim());
    if (command === 'invalidate') {
      console.log(await invalidate(args));
    } else if (command === 'flakes') {
      await flakes(args);
    } else if (command === 'stats') {
      await stats(args);
    } else if (command === 'why') {
      await why(args);
    } else if (command === 'doctor') {
      if (args.length) throw new Error(doctorUsage);
      process.exitCode = await doctor();
    } else if (command === 'run') {
      process.exitCode = await run(args);
    } else if (command === 'lint') {
      if (args.length) throw new Error(lintUsage);
      const findings = lint();
      for (const finding of findings) console.log(finding);
      process.exitCode = findings.length ? 1 : 0;
    } else if (command === 'record') {
      console.log(await record(args));
    } else if (command === 'status') {
      let ref: string | undefined;
      let set: string | undefined;
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
        else if (
          arg === '--set' &&
          set === undefined &&
          args[i + 1] &&
          !args[i + 1]?.startsWith('-')
        )
          set = args[++i];
        else throw new Error(statusUsage);
      }
      if (!ref) throw new Error(statusUsage);
      const rows = await status(ref, set);
      if (json) console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(renderDecision(row));
      process.exitCode = rows.every((row) => row.state === 'PROVEN') ? 0 : 1;
    } else if (command === 'plan') {
      let set: string | undefined;
      let json = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--json' && !json) json = true;
        else if (
          arg === '--set' &&
          set === undefined &&
          args[i + 1] &&
          !args[i + 1]?.startsWith('-')
        )
          set = args[++i];
        else throw new Error(planUsage);
      }
      const rows = await plan(set);
      if (json) console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(renderDecision(row));
    } else {
      if (args.length !== 1 || !args[0]) throw new Error(checkUsage);
      process.exitCode = await check(args[0]);
    }
  } catch (error) {
    console.error(`proof: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
} else {
  console.error(`proof: ${unknown(command)}`);
  process.exit(2);
}
