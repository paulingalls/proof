import { fileURLToPath } from 'node:url';
import { flakesUsage } from './flakes';
import { invalidateUsage } from './invalidate';
import { recordUsage } from './record';
import { runUsage } from './run';
import { statsUsage } from './stats';
import { whyUsage } from './why';

export const checkUsage = 'usage: proof check <cases.yaml>';
export const planUsage = 'usage: proof plan [--set <name>] [--json]';
export const statusUsage = 'usage: proof status --ref <ref> [--set <name>] [--json]';
export const lintUsage = 'usage: proof lint';
export const doctorUsage = 'usage: proof doctor';

export const helpUsage = 'usage: proof help [<command>]';

const commands: Record<string, [string, string]> = {
  check: [checkUsage, 'Check exact task selection against a requirement suite.'],
  plan: [planUsage, 'Show which tests and gates must run and why.'],
  status: [statusUsage, 'Show proof state at a committed ref.'],
  lint: [lintUsage, 'Check declarations and coverage against the staged tree.'],
  doctor: [doctorUsage, 'Check store health and declared dimension values.'],
  run: [runUsage, 'Run selected tasks and record their results.'],
  record: [recordUsage, 'Record an externally obtained task result.'],
  invalidate: [invalidateUsage, 'Delete proofs with a manual audit record.'],
  flakes: [flakesUsage, 'Report tasks ranked by contradictions.'],
  stats: [statsUsage, 'Report timings, the current RUN estimate and time saved.'],
  why: [whyUsage, 'Explain current key parts and changes since the newest proof.'],
  help: [helpUsage, 'Show general help or help for one command.'],
};

export function commandHelp(name: string) {
  const entry = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!entry) throw new Error(`help unavailable for command '${name}'`);
  return entry.join('\n');
}

export function generalHelp() {
  return `proof selects necessary tests and gates, and reuses/shares proof across clones and machines.

Commands:
${Object.entries(commands)
  .map(([name, [, description]]) => `  ${name.padEnd(12)} ${description}`)
  .join('\n')}
  help [<command>]   Show general help or one command's usage.
  --version          Print the installed version.

proof.yaml root fields:
  version: 1 (required); project: nonempty project name (required).
  inputs: map of named input lists; tasks: map of task declarations.
  include: glob of declaration files (inputs, tasks, unkeyed only).
  coverage: list of globs requiring ownership; exempt: map of exact paths to reasons.
  providers: map of provider declarations; lanes: map of names to positive limits.
  dimensions: map of names to commands whose output enters keys.
  unkeyed: ordered file patterns excluding shared files from nonrepresentative keys.

Task fields:
  run: command (required); inputs: nonempty input list (required).
  env: list of keyed environment names; links: list of trusted checkout paths.
  needs: list of provider names; sets: list of task selection groups.
  lane: declared lane name, or reserved solo (no root declaration needed).
  dimensions: list of root dimension names; keyed: file patterns restoring key contribution.

Provider fields:
  start: command (required); stop: teardown command (optional).
  lane: declared lane name (optional); one instance per used slot when laned.

Input forms:
  Strings/globs, ordered quoted '!' negation, and $name references to named inputs.
  {path, json: [members]}, {path, dotenv-keys: true}, {dotenv, exclude?: [names]},
  {imports-of: entry}, {maestro: flow}.

Configuration environment:
  PROOF_STORE: Postgres URL; overrides the store configuration file.
  XDG_CONFIG_HOME: config base, otherwise HOME/.config; file: proof/store.
    First line is the URL; optional remaining project names restrict sharing.
    Without a URL, proof uses the local SQLite store only.
  PROOF_STATE_DIR: state directory; otherwise XDG_STATE_HOME/proof,
    otherwise HOME/.local/state/proof. Contains proof.db and retained logs.
  HOME: fallback base for configuration and state paths.
  PROOF_LANES=name=N,...: override declared lane limits for a run.

Supplied environment (not configuration switches):
  PROOF_LANE_SLOT: zero-based slot for laned tasks and provider start/stop.
  PROOF_PROVIDER_ENV: start-only path to the provider environment export file.

Exit codes:
  0: successful operation/help; plan may report RUN and still exit 0.
  1: run red/incomplete/provider failure, status with RUN, failed check/lint/doctor.
  2: usage/configuration/declaration/store/log error.
  130: SIGINT during run; 143: SIGTERM during run.

Installed references:
  README: ${fileURLToPath(new URL('../README.md', import.meta.url))}
  Commands: ${fileURLToPath(new URL('../docs/commands.md', import.meta.url))}`;
}
