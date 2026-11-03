# Changelog

## Unreleased

- `run` accepts mode, jobs, set and strict-inputs flags in any order; `--tasks` still
  consumes the remaining IDs, with `--strict-inputs` accepted anywhere.
- Lint explains that a task selecting an exempt path already owns it and asks to drop
  the redundant exemption.

## 0.32.0

- `run` defaults to machine parallelism; `--jobs N` still overrides it and `--jobs 1`
  streams live. Resource lane limits continue to apply.
- Runs print `run: <n> tasks, jobs <j>` before the plan and execution, counting every
  selected task, including proven and unreached tasks.

## 0.31.0

- Red summaries name omitted tracked files in Bun's `Module not found` messages and
  unmatched test filters with an explicit sandbox cwd, including strict declaration gaps.

## 0.30.0

- `check` counts tasks undecidable at either ref in the exact RUN set and prints their
  reason, preferring the destination reason when both refs are undecidable.
- Included and generated declarations accept `exempt` entries alongside the root’s.
  Duplicate exempt paths fail naming both declarations, even when reasons match.

## 0.29.0

- Every strict red with effective root delivery retries once before recording, even
  without a recognized missing-path diagnostic. Only the retry outcome and time count;
  a green retry without a named path reports an unidentified declaration gap.
- Red summaries recognize Bun's importer-relative `Could not resolve` blocks and
  explain `not a git repository` failures in sandboxes.
- Python `imports-of` follows literal calls through any `.import_module` receiver;
  computed arguments make the task undecidable.

## 0.28.0

- `imports-of` now follows Python imports, including package initializers, relative
  imports, namespace packages and literal dynamic imports. Optional `python-path`
  declares ordered search roots; the default is the entry directory. Missing local
  roots, unresolved relative imports and computed dynamic calls make tasks undecidable.
  Existing TypeScript keys are unchanged.

## 0.27.0

- `run --strict-inputs` audits selection-only task sandboxes. A red naming an omitted
  delivered path retries once with normal delivery; only the final outcome is recorded
  and counted. Declaration gaps print after the summary without changing the exit code.
  Use `--fresh --strict-inputs` to audit already proven tasks.

## 0.26.0

- Root `delivered: [globs]` adds tracked snapshot files to every task sandbox beyond
  input negations, without changing keys. Includes and generators can add patterns.
  Delivered-only working dirt does not block publication; selected files retain their
  byte and key rules, and task links take precedence. `why` summarizes pattern counts.

## 0.25.0

- `lint` now exits 1 when a negation leaves a traced input out, naming the task, path,
  negation and trace entry. Previously passing declarations may need to restore that path.
  Selection and keys are unchanged.
- Red summaries name tracked, omitted workspace export targets for `Cannot find module`
  and `Cannot find package` errors, including subpaths such as `@fixture/db/testing/fixture`.

## 0.24.1

- Negated inputs reuse matching tree paths across tasks instead of matching selected tree
  paths again. Dirty and untracked paths remain subject to exclusions.

## 0.24.0

- Plain `plan` ends with RUN, PROVEN and UNREACHED totals, estimated RUN minutes and
  the number of tasks without timing. Plan JSON is unchanged.
- `stats --never-green` lists selected tasks with no all-time green result, with optional
  `--set` and `--json` output. Existing timing and savings figures are unchanged.

## 0.23.1

- Plans inspect each distinct link set once, reusing the result across tasks. Execution
  still checks links again after tasks run to prevent publishing proof through an escape.

## 0.23.0

- Provider start and stop receive `PROOF_RUN_PID`, the proof process's pid, alive throughout
  provider use. Tasks cannot declare it and providers cannot export it.
- Unknown-field errors include the running proof version and suggest checking it against
  the dependency pin and running `bun install` if they differ.

## 0.22.0

- Optional task `timeout` budgets kill the entire process group and report a red budget
  failure. Interrupts retain incomplete semantics; timeout metadata does not enter keys.

## 0.21.2

- `run` reports cumulative progress after each task and ends its summary with outcome totals,
  including keyless `not recorded` outcomes. Incomplete tasks do not advance the done count.
- Task and provider log paths print as pasteable shell arguments, quoting metacharacters.

## 0.21.1

- Red task summaries name up to three tracked paths explicitly reported missing outside the
  sandbox selection, with a count of the rest. Unreadable logs leave reds unchanged.
- `why` labels current sandbox inputs as delivered and distinguishes keyed contributions
  from unkeyed and super-only exclusions.

## 0.21.0

- Root and included/generated `super-only` patterns exclude files from all task keys without
  representatives. Sandboxes retain exact bytes; fresh runs execute edits, dirty received inputs
  block publication, and `why` names the exclusions and policy transitions. `keyed` overrides,
  overlap with `unkeyed`, negations and unmatched entries are declaration errors.
- Existing unchanged-byte `carry: true` migration can adopt the policy with `rekey --apply`.
  Key scheme 4 and keys without the new declaration remain unchanged.

## 0.20.0

- `run --since <ref>` and `plan --since <ref>` leave unchanged unproven tasks UNREACHED.
  Reached tasks run; current proofs, contested keys and dirty/undecidable inputs keep their
  decisions. Unreached work starts no provider, records no result and earns no skip savings;
  it waits for the fresh super run.

## 0.19.3

- Dirty paths block publication only for tasks selecting them, including selected `unkeyed` files.
  Unrelated dirt permits proofs from `run`, fresh runs and `record`, including provider dependents.
  Runs warn before execution when initial dirt blocks requested tasks.

## 0.19.2

- A sandbox that cannot be removed no longer aborts the run: it warns with the task and path left
  behind, preserves task outcomes and lets remaining tasks finish.

## 0.19.1

- A failed provider start now ends the run summary, after every task line, with its exit code or
  problem, the number of tasks it blocked, its log path and the tail of that log. Each blocked task's
  `incomplete` line names the provider.

## 0.19.0

- A task can declare `carry: true`. `proof rekey` then carries its green to a changed key when `run`,
  `links` and dimensions match, every current input is byte-identical at the green's commit, no input
  was deleted and nothing contests it. It prints each carry and every added file, and nothing changes
  at plan time. `rekey` is now a permanent command.

## 0.18.0

- A task's key is now its tree-derived inputs plus declared dimensions. `env` only passes values into
  the sandbox, and `{dotenv}` inputs are accepted but ignored; use `links` for ignored files. Make a
  value a dimension if it changes what a task proves.
- Tasks with env or dotenv inputs re-key once. `proof rekey [--apply]` carries proofs that are still
  valid for this tree to their new keys, without running anything.

## 0.17.2

- `proof why` compares with the newest proof holding this machine's dimension values, and says so when
  none does, so one platform's record no longer hides another's cause.

## 0.17.1

- A declared link may be a symlink: an untracked path at or below a task's or generator's `links` is
  no longer an input, which failed generated declarations and left tasks undecidable.
- A `node_modules` shared with another checkout resolves workspace packages to this tree, not that
  checkout's source.

## 0.17.0

- `proof stats` and `--json` report this machine's generator cache hits, runs and median seconds when
  a project declares `generate`. Events stay local in the state directory.

## 0.16.1

- `proof lint` computes each task's selection once rather than per path: a synthetic 439-task repo
  went from 1.5 s to 0.3 s. Findings are unchanged.

## 0.16.0

- Root `generate: {run, inputs, links?}` keeps generated declarations out of git. proof runs the
  generator in a sandbox built from the tree it judges, including a ref or the index, and reads the
  files it writes to `$PROOF_DECLARATIONS` as included declarations. Output is cached by the
  generator's inputs. Failures are fatal, and declarations a dirty tree changes publish no proof.
- A repo should run `proof check` when its generator changes: a bug that drops an input is otherwise
  invisible until the super run.

## 0.15.0

- `proof stats --by <dimension>` splits each task's median and run count by dimension value. Results
  from before this release count under a no-value row. `proof stats --json` prints the report as one
  JSON document.
- Each result now stores its resolved dimension values, so a dimension must never print a secret.
  Task env values are still never stored. Schema stays 2, and older clients keep working.

## 0.14.1

- `proof`, `--help`, `-h` and `help` print the commands, `proof.yaml` fields, environment, exit codes
  and installed docs paths, with no git repo needed. `proof <command> --help` and `proof help <command>`
  describe one command. An unknown command lists the valid ones.

## 0.14.0

- A provider can declare `lane: <name>`. proof starts one instance per lane slot in use, only for
  RUN tasks, so tasks that would wipe each other's stack can run in parallel. Tasks needing it must
  declare that lane. A failed start retires its slot.
- Every RUN task in a declared lane, and a laned provider's `start` and `stop`, receive
  `PROOF_LANE_SLOT`. The name is reserved.
- `PROOF_LANES=name=N,...` replaces declared lane limits for a run. Slots and limits stay out of keys.

## 0.13.3

- Git-ignored files no longer count: globs see what git sees, and proof no longer lists them. An
  ignored literal input is a missing input; use `links` or `{dotenv}` for ignored files a task needs.

## 0.13.2

- `run` scans ignored files once rather than around every task, and builds sandboxes in one git
  batch: on a 414-task repo with 156,000 ignored files, about 50 s per task became under 4 s.

## 0.13.1

- A link from one declared root into another is no longer an escape, which rejected bun workspace
  links. A committed symlink whose relative target is in the same selection now reaches the sandbox.

## 0.13.0

- A provider `start` can write `NAME=value` lines to `$PROOF_PROVIDER_ENV`. Tasks needing that
  provider receive them, unkeyed, so clones with different addresses share proofs.

## 0.12.2

- Lines after the URL in the store file name the projects allowed to use it. Any other project
  stays on SQLite and says so once. A file with only a URL behaves as before.

## 0.12.1

- `plan` and `lint` cost about a third at 413 tasks: glob matches, selectors, resolved imports and
  Maestro flow reads are shared within one process. No key, decision or reason changes.

## 0.12.0

- Root `unkeyed` excludes shared files from task keys while preserving exact sandbox bytes;
  task `keyed` selects representatives. Declarations require a receiving representative for
  every excluded file. Closure traversal and dirty-input rules stay unchanged. `why` lists
  excluded files and explains policy changes. Existing keys stay unchanged without the policy.

## 0.11.2

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
