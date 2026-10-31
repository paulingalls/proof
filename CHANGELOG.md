# Changelog

## Unreleased

- `import(...)` and `require(...)` text in strings, templates and comments no longer reads as
  an import; 0.11.1 fixed only statements. A computed call inside a template's `${}` now goes unseen.

## 0.11.1

- `plan --json` and `status --json` rows carry each decidable task's `key`, so a repo can prove a
  change left its keys alone even with no proofs stored. Undecidable rows have no key.
- Text inside strings and templates no longer reads as an import, which made tasks falsely
  undecidable. Type-only imports stay keyed.

## 0.11.0

- `proof run --jobs N` runs tasks concurrently. `lanes:` and a task's `lane:` cap a resource within a
  run, and `lane: solo` runs a task alone. Neither enters a key.
- A red or incomplete task keeps its log under the state directory, outside every worktree, and the
  summary prints the path. Logs stay on the machine. `run` output now reaches stdout from that one
  file: task stderr appears on stdout, and tasks see no terminal.
- `proof stats` reports median seconds, the current plan's estimate and time saved. `run` records
  each skip, in a table a 0.10.0 client ignores.
- `proof flakes` ranks tasks by contradictions. `proof invalidate` deletes proofs and audits it.
- `{path, dotenv-keys: true}` keys a tracked file's names. `{dotenv, exclude}` keys values from a
  checkout file, without ever storing them. A `:` in an `env` name now exits 2.
- `dimensions:` lets a repo key a task on a command's output, such as `xcodebuild -version`.
- The command reference moved to `docs/commands.md`. R15's ledger import, R18's repo adapters and
  R4's provider-key class are dropped from the requirements.

## 0.10.0

- Sets: a task's `sets:` and `--set <name>` for `plan`, `run` and `status`. Names are each repo's own.
- `proof run --staged` runs a commit hook on the exact staged bytes and may publish, so the push finds
  those tasks proven. A task with `needs` publishes nothing if an input differs from the snapshot.
- This repo uses proof for its own commit and push hooks; the README shows how.

## 0.9.0

- A `package.json` `version` value never enters a key, however the file is reached, so version bumps
  re-run nothing. A task that depends on it opts in with `{path: package.json, json: [version]}`.
  Keys change (scheme 4), so existing proofs re-prove once.
- `plan` and `run` are far faster on dirty trees with many closures: 29 s to 0.45 s on a 250-task fixture.
- `proof run --fresh` is the backstop: it runs every task regardless of proofs, one red never stops
  the rest, and a fresh red deletes that green everywhere at once. A task whose sandbox can't be
  built records `incomplete` and the rest continue. Scheduling it is the repo's job.

## 0.8.1

- A `package.json` reached only as resolver metadata keys just the members resolution reads, so a
  version bump no longer re-runs every `imports-of` task. One a source file imports, or a task
  selects by path or glob, still keys whole. Keys change (scheme 3), so existing proofs re-prove once.
- A comment such as `import (x)` no longer counts as a computed import.

## 0.8.0

- `proof status --ref <ref> [--json]`: proof state at any commit or tag, from its committed files
  and your declared env, with no checkout. Exits 0 when every task is proven, 1 otherwise.
- `proof why <task>`: the task's key parts, and exactly what changed since its newest proof, against
  the working tree as it is on disk.
- New proofs store one hash per declared env name, never a value, so `why` can name the variable
  that changed. Stores migrate on first use; older proofs say `env comparison unavailable`.

## 0.7.0

- Providers: `providers: {<name>: {start, stop?}}` and a task's `needs:`. `proof run` starts each
  provider once, only if a task that must run needs it, and runs `stop` once after the last
  dependent, also on failure and interruption. `plan` names the providers a run would start.
  Providers run in the checkout with the caller's environment; dependents keep their sandbox.
  Neither `providers` nor `needs` enters a key (R4). A failed start records its dependents
  `incomplete`, which contests no proof, and `run` exits 1 naming the provider.

## 0.6.0

- `{maestro: <flow.yaml>}` inputs: a journey keys its flow and every file reached through `runFlow`,
  `runScript` and `addMedia`, recursively, from git blobs at any ref. A variable path, a missing
  include, a repeated key or an unparseable flow makes the task undecidable, so it runs and says why.
  `proof lint` resolves Maestro entries and counts their closures as owned.
- `proof check` fails a case when a task is undecidable at its `from` ref, instead of counting the
  task as selected; such a case could pass without testing selection.
- The design's 14 selection cases all have green synthetic analogues. Journeys declare `$stack`, so a
  backend change re-runs them (requirements R4).
- The import, workspace and Maestro resolver tables run at push; the commit hook keeps the CLI suite.

## 0.5.0

- A shared Postgres store: set `PROOF_STORE` (or `~/.config/proof/store`) to a `postgres://` URL and
  every clone and machine sees the same proofs. The publication and contested rules are unchanged and
  run in one transaction per record; concurrent writers keep every result. A malformed store setting
  exits 2. The password never prints.
- A local replica: each machine keeps its own results in its SQLite file. When the store is
  unreachable, `plan` and `run` use them and say so; a contest seen online keeps a key unproven
  offline. Results recorded offline are not uploaded later.
- `proof doctor` reports the store, its reachability and schema version, and the replica path.
  `docs/store.md` is the operator guide: Postgres in Docker on loopback, exposed with
  `tailscale serve`, guarded by the Tailscale ACL and a password.
- The `proof` bin uses `env -S` so Bun never loads a repo's `.env`; BusyBox `env` (Alpine) lacks `-S`.

## 0.4.0

- `{imports-of: <entry>}` inputs: a TypeScript import closure computed from git blobs at any ref,
  following relative imports, workspace packages (`exports` resolved as Bun does), tsconfig `paths`,
  `baseUrl` and `extends`. Every `package.json` and `tsconfig.json` consulted is keyed. Anything it
  cannot follow (a computed import, an unresolved specifier) makes the task undecidable, so it runs.
- A linked `node_modules` (root or per-package) reaches workspace packages inside the sandbox, through
  the task's own keyed files, so tasks importing workspace packages can publish. An installed package
  that declares a workspace dependency still blocks publication.
- The commit hook runs the fast tests; `*.slow.test.ts` run at push and in the release suite.

## 0.3.0

- `proof run [--tasks ...]`: executes each RUN task in a sandbox holding only its selected inputs
  (exact bytes and modes), with the environment cleared to `PATH`, `HOME`, `TMPDIR` and its `env:`
  names, and records the result against the key captured before it ran. A proof is published only
  when the tree was clean and is unchanged after. It exits 1 on any red; an undecidable task alone
  does not fail the run.
- Interrupting `proof run` records the task `incomplete`, starts nothing more, and exits 130/143; a
  second interrupt kills the task's process group.
- `links:` symlinks untracked dependencies (`node_modules`, `.venv`) into the sandbox. A link that
  reaches tracked files, directly or through workspace symlinks or `.pth` entries, never publishes.
- A file's git mode is part of its key (scheme 2): every existing proof re-proves once.
- With a dirty `proof.yaml`, `plan` and `run` use the working-tree declarations and record nothing.
- proof works from any subdirectory of the repo.

## 0.2.0

- `proof check` and `proof plan` at app-a's size: 14 cases in 0.61 s (was 11.5 s) and a plan in
  0.24 s on a 10.8k-file, 230-task repo. Keys are unchanged from 0.1.0.
- JSON projections: `{path, json: [members]}` hashes only the named top-level members, so a
  version-only bump runs nothing.
- `env:` names enter a task's key as value hashes; values are never stored or printed.
- A duplicate key in any declaration or cases file fails loudly, with file, line and key.
- `proof lint` reads the staged index and reports unmatched inputs, unowned paths under the
  repo's `coverage:` globs, and invalid `exempt:` entries.

## 0.1.0

- `proof check <cases.yaml>`: each case's RUN set, computed from two refs' blobs and declarations
  (no checkout, no diff base), against its expectation.
- `proof plan [--json]`: RUN or PROVEN per task at HEAD, with a reason; any dirty input or
  declaration makes a task undecidable.
- `proof record <task> --outcome green|red|incomplete`: results in a local SQLite store outside
  the repo; only a clean tree publishes a proof.
- The contested rule: a red after a green makes the task run once more; a green restores the
  proof, a second red deletes it.
- Submodule pointers are inputs; a `.gitmodules` ignore setting cannot hide one.
