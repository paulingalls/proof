#!/usr/bin/env bun
import pkg from '../package.json';

const [command] = Bun.argv.slice(2);

if (command === '--version') {
  console.log(pkg.version);
} else {
  console.error(`proof: unknown command '${command ?? ''}'`);
  process.exit(2);
}
