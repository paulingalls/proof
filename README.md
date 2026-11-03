# proof

`proof` tells anyone working on a repository exactly which tests and gates must
run after a change, and which are already proven. It shares that proof across
clones and machines, so a green result earned on one machine is reused by every
other machine with the same tree and declared dimensions.

The goal: run only what a change can actually affect, and nothing extra.
Use `proof run --since <ref>` to bound unproven work to tasks whose keys changed since
that commit. Unchanged unproven tasks read `UNREACHED` and wait for the fresh super run;
`proof plan --since <ref>` previews the same selection. Existing proofs still read `PROVEN`.
The super uses `--fresh` and never `--since`. See [command details](docs/commands.md).

## How it works

- **Declarations live in the repo.** `proof.yaml` (plus optional included or generated declarations)
  says what each task depends on. TypeScript and Python inputs come from their import closures. You declare only what imports cannot see,
  such as fixtures, SQL, spawned scripts and runtime files.
- **A key is computed from the tree, never from a diff.** A task's key hashes its id,
  the meaning of its declaration, the content of its tree-derived inputs, and declared dimensions. The same tree and declared dimensions give the same answer on any clone or
  machine (OS, CPU and Bun version are deliberately not in the key), and a key can
  be computed for any ref without a checkout.
- **Proofs live in one shared store.** Postgres (optional) stores metadata only:
  task, key, outcome, host, timings, dimension hashes, declared dimension values and
  contradictions, never logs. Each machine
  keeps a local SQLite copy of its own results.
- **Declarations are enforced, not trusted.** Tasks run in a sandbox holding
  their selected inputs and root `delivered` files. Missing selected inputs fail loudly.
  An undecidable task always runs.
- **Flakes are contested, not hidden.** A red against a stored green contests the
  proof; a second red deletes it, and the task runs until it is green again.

## Install

`proof` needs [Bun](https://bun.sh) 1.4.4 or later and git. It isn't published to npm; depend on a
the latest tagged release from GitHub:

```sh
bun add -d "git+https://github.com/paulingalls/proof.git#v0.27.0"
bunx proof --version
```

## Quickstart

Declare tasks in `proof.yaml` at the repository root:

```yaml
version: 1
project: my-app
tasks:
  math:
    run: bun test test/math.test.ts
    inputs:
      - imports-of: test/math.test.ts
  text:
    run: bun test test/text.test.ts
    inputs:
      - imports-of: test/text.test.ts
```

Commit it, then:

```sh
bunx proof plan    # RUN math: no proof for key ...
bunx proof run     # runs both, records them: "green math; proof published"
bunx proof plan    # PROVEN math ... / PROVEN text ...
```

Edit `src/text.ts` (imported by `test/text.test.ts`) and commit: `plan` now says `RUN text` and
keeps `math` PROVEN, and `run` runs only `text`.

Plain `run` publishes when a task's selected inputs are clean, even with unrelated dirt.
Uncommitted changes to selected inputs, including `unkeyed` and `super-only` files, make that
task run every time and publish nothing. A dirty declaration prevents every task from publishing. A commit hook can
use `proof run --staged` to prove the index instead: its green is reusable after committing those staged bytes, including
at push or in CI.

## Adopting proof in an existing repo

- **Deliver the whole tree.** Put `delivered: ['**']` at the root on day one. Tests read files
  imports can't see; without it those reads are false reds. Delivered files don't enter keys, so
  an edit to an undeclared read waits for the super; `--strict-inputs` lists those reads.
- **One task per test target**, keyed by `imports-of:` its entry plus globs for fixtures, SQL and
  spawned scripts. Start with fast unit packages, then services, then acceptance and e2e.
- **Link ignored files.** `links: [node_modules, apps/web/node_modules, .env]` for each
  `node_modules` and ignored config a task reads. List the variable names a command needs in `env:`;
  the sandbox environment otherwise holds only `PATH`, `HOME` and `TMPDIR`. Bun loads `.env`
  from its working directory even without `--env-file`.
- **The sandbox is not a git checkout.** It holds files, not a repository, so a test that runs
  `git ls-files` or `git rev-parse` exits 128 there. Check file presence directly instead.
- **Don't link a Python venv.** `uv run` syncs the venv it finds, so a linked `.venv` is
  rewritten by concurrent tasks. Run `uv run --frozen --directory <project> pytest ...` and let
  uv build a sandbox venv from its cache under `HOME`.
- **Key what a shared stack serves.** Providers and `needs` never enter keys, so declare the
  migrations, seeds and provider scripts on every dependent task (a named `$stack` set), or an
  edit to them leaves those tasks PROVEN.
- **Keep paid and live tests out of ordinary runs.** Put the other tasks in sets (`sets: [commit]`)
  and have hooks run `proof run --set commit`; paid tasks stay out of every set, so only plain
  `run` and the fresh super execute them. Their keys reach the command only through `env:`.
- **Check the setup**: `proof plan`, `proof why <task>`, `proof lint` (uncovered files, traced
  paths a negation drops), `proof check` (state what an edit should run; compare with proof's
  selection), and `proof run --fresh --strict-inputs` (reads the declarations miss).

## Declaring tasks

```yaml
version: 1
project: my-app                # scopes proofs in a shared store
include: proof.d/*.yaml        # optional: more files with `inputs` and `tasks`
inputs:                        # named input sets, referenced as $name
  config:
    - tsconfig.json
    - {path: package.json, json: [dependencies, devDependencies]}
tasks:
  math:
    run: bun test test/math.test.ts
    inputs:
      - $config
      - {imports-of: test/math.test.ts}
      - 'fixtures/**'
    sets: [commit, push]       # repository-owned task boundaries
    env: [CI]                  # caller env names passed into the sandbox
    links: [node_modules]      # untracked paths the sandbox links in
coverage: ['src/**', 'scripts/**']
exempt:
  scripts/deploy.sh: run by hand at release
```

- **Inputs** are git paths or globs (`'!pattern'` excludes, quoted), a JSON projection
  (`{path, json: [members]}`: only those members are keyed, so editing `scripts` in
  `package.json` above changes nothing), or `{imports-of: entry}`: the TypeScript import
  closure from that entry, following workspace packages and tsconfig `paths`, `baseUrl` and
  `extends` the way Bun does. An import proof can't follow, such as a computed `import()`, makes
  the task undecidable, so it always runs and says why. Text in strings, templates and comments
  is not an import. A computed call inside a template's `${}` is not seen and leaves the task
  decidable; literal imports there are still followed.

  Ordinary globs consider tracked paths and untracked paths that Git does not ignore. An ignored literal
  input is missing: it stays outside the sandbox and prevents recording, with its path reported.
  Use `links` for ignored file access. Remove deprecated `{dotenv: path}` inputs; they are ignored.
- **Python closures** use `{imports-of: entry.py, python-path: [src, tests]}`.
  Roots are searched in order; omitting `python-path` uses the entry's directory.
  Only tracked `.py` modules and package initializers are followed. Regular packages
  win over same-named modules and earlier namespace portions; namespace packages can
  span roots. Relative imports resolve from the importing file's directory.
  Unresolved absolute imports are treated as installed packages or stdlib, unless their
  top-level name exists elsewhere in the tracked tree; then the task is undecidable and
  names the tracked path so you can correct `python-path`. Unresolved relative imports and
  computed `import_module`, `<expr>.import_module` or `__import__` calls are undecidable;
  literal absolute calls are followed, including arbitrary attribute receivers such as
  `factory().import_module('m')`. Strings, docstrings and comments add no imports.
  `python-path` is a nonempty list of repo-relative directories (`.` means repository root)
  and is valid only for `.py` entries. Declare fixtures, configuration, `conftest.py` and
  plugins separately when they are not imported:

  ```yaml
  tasks:
    test-widget:
      run: uv run pytest tests/test_widget.py
      inputs:
        - {imports-of: tests/test_widget.py, python-path: [src, tests]}
        - tests/conftest.py
        - tests/fixtures/**
        - pyproject.toml
        - uv.lock
  ```

- **Closure manifests**: a `package.json` reached only as import resolver metadata keys
  `name`, `main`, `module`, `type`, `exports`, `imports`, `workspaces`, `extends` and
  `compilerOptions`. A committed `version` bump or changelog edit therefore preserves the closure
  proof. `exports` retains
  JSON object order because the resolver takes the first matching condition; other projected
  members use canonical object order. A manifest imported directly by source, or selected by
  a path or glob, keys its exact bytes with the first `"version": <parsed version>` value
  blanked. This applies to every `package.json` at any depth; layout and other members stay keyed.
  Adding or removing the member still changes those bytes. A nested version with the same value
  earlier in the file is an accepted rare corner of this simple replacement.
  Opt in when the task needs the version: `{path: package.json, json: [version]}`.
  Invalid JSON and valid non-object JSON keep their whole-byte identity where the file keys whole;
  projections and resolver metadata retain their failures. Sandboxes always hold exact file bytes,
  including version. A dirty consulted manifest still runs with
  `undecidable: dirty input '<path>'` and publishes no proof in plain `run`.
  `run --staged` consults indexed bytes, so a version-only staged edit can retain PROVEN.
  Closures no longer key `dependencies`, `devDependencies`, `scripts`, `patchedDependencies`
  or `packageManager` implicitly. Declare the members your command needs, for example
  `{path: package.json, json: [dependencies, devDependencies, patchedDependencies, packageManager, scripts]}`
  alongside its closure input. Key scheme 4 requires fresh proof for all tasks, including
  tasks without closures. Accepted risk: a test hard-coding a version can retain proof after a
  committed version bump; the super run that executes every task fresh catches it.
- **Generated declarations stay out of git.** Root `generate: {run, inputs, links?}` runs a
  generator in a sandbox containing its selected inputs from the judged tree. It writes included
  declarations (`inputs`, `tasks`, `unkeyed`, `super-only`, `delivered`, `exempt`) to the empty `$PROOF_DECLARATIONS`
  directory. Committed `include` files can coexist; duplicate tasks and input sets fail. `plan` and other declaration
  readers therefore execute repository code on a cache miss. For example, commit `source.txt`,
  this root declaration, and `scripts/generate-proof.sh`:

  ```yaml
  version: 1
  project: example
  generate:
    run: sh scripts/generate-proof.sh
    inputs: [scripts/generate-proof.sh]
  ```

  ```sh
  cat > "$PROOF_DECLARATIONS/tasks.yaml" <<'YAML'
  tasks:
    smoke:
      run: cat source.txt
      inputs: [source.txt]
  YAML
  ```

  `proof plan --json` lists `smoke`. Output may contain nested `*.yaml` files and must contain at
  least one; write `tasks: {}` for an intentionally empty declaration. Symlinks are refused.
  To migrate committed generated files, change the generator to write to `$PROOF_DECLARATIONS`,
  add `generate`, remove their `include` glob, untrack the old files and ignore that output directory.
  proof never reads ignored output. [Generation details](docs/commands.md#generated-declarations)
  cover caching, failures, dirty inputs, index and ref behavior. Run `proof check` whenever the
  generator changes: proof cannot detect a generator bug that omits an input. Shell and Dockerfile
  tracing remain the generator's responsibility.

- **Files every task needs.** Root `delivered` supplies matching tracked snapshot files to
  every task sandbox, independently of inputs and their negations:

  ```yaml
  version: 1
  project: delivery-example
  delivered: [assets/**]
  tasks:
    read:
      run: cat assets/a assets/b
      inputs: [source]
  ```

  With committed `source`, `assets/a` containing `a`, and `assets/b` containing `b`,
  `bunx proof run --tasks read` reads `ab` and reports `green read; proof published`.
  Editing and committing an asset keeps the key and PROVEN decision unchanged;
  `bunx proof run --fresh --tasks read` executes the new bytes. An undeclared read can
  retain a green until the fresh super; delivery trades that detection for fewer false reds.
  To audit already proven tasks, run `bunx proof run --fresh --strict-inputs`.
  Each task first receives selection only (plus declared links). Every red retries once
  in a fresh sandbox when root delivery supplies paths outside selection and links.
  Only the retry outcome and time are recorded and counted; the strict attempt cannot
  contest a green. After the summary, `declaration gap read: assets/a, assets/b` lists
  detected paths, or `declaration gap read: unidentified` reports a green retry without
  a named path. Named gaps also print after a red retry; gaps do not change the exit code.
  With no effective delivery, a strict red records normally. Cancellation prevents retry
  and records incomplete. Red summaries also explain missing git checkout metadata and
  recognize Bun's importer-relative `Could not resolve` blocks; see [commands](docs/commands.md).
  This does not detect every undeclared read.
  Dirty or checkout-deleted delivered-only paths still supply snapshot bytes; untracked
  matches are absent and unrelated dirt does not block publication. Under `--staged`,
  delivery uses the captured index. A file also selected follows selection's bytes,
  dirty checks and key policy, including explicit `unkeyed`/`super-only` exclusions.
  Paths equal to or below a task link are skipped; link trust rules stay in force.
  Included and generated declarations add patterns to the root list. Each pattern must
  match tracked files in the judged tree; negations and malformed lists fail every reader
  before task filtering. `why` prints one `delivered pattern assets/**: 2 files` line per
  distinct pattern, counting all tracked matches before selection and link exclusions.
  Generators receive only their selected inputs; provider mismatch checks still compare
  selection only, and providers run in the checkout. Delivery does not establish coverage
  ownership: `lint` still reports covered files with no selecting task. Gitlinks and directory
  symlinks retain the sandbox's existing refusals. Repos without `delivered` keep their
  sandboxes and keys. Unlike `unkeyed` and `super-only`, delivery adds files without
  changing any key contribution.
- **Shared files and representatives.** Root `unkeyed` removes matching files from every
  task's key; task `keyed` opts representatives back in. For example, create `shared.txt`
  containing `ready`, then use:

  ```yaml
  version: 1
  project: shared-example
  unkeyed: [shared.txt]
  tasks:
    reader:
      run: cat shared.txt
      inputs: [shared.txt]
    smoke:
      run: grep -q ready shared.txt
      inputs: [shared.txt]
      keyed: [shared.txt]
  ```

  Run `bunx proof run`, commit an edit to `shared.txt` that keeps `ready`, then run
  `bunx proof plan`: `reader` stays PROVEN and `smoke` runs. A fresh
  `bunx proof run --fresh --tasks reader` prints the new bytes. Choose representatives
  that exercise the shared file's behavior; the super run executes every task fresh as the backstop.

  Both fields are lists of nonempty paths or globs; empty lists are allowed, negation (`!`)
  is refused, and every entry must match a file. Every matched `unkeyed` file needs at least
  one task whose `keyed` matches it **and whose inputs actually receive it**. Every `keyed`
  match must be inside `unkeyed`. Uncovered files, including new files under a broad glob
  or files a representative stops importing, are declaration errors on every command.
  `keyed` does not add inputs. Included tasks can be representatives, and an included file can
  carry `unkeyed`, which adds to the root list, so a generated list can live in `proof.d`.

  This applies to direct inputs, JSON and dotenv-name projections, resolver manifest members,
  and files reached through `imports-of` or `maestro`. Traversal continues through an unkeyed
  file, so its imports still key. Sandboxes keep exact bytes, and dirty inputs still RUN.
  Environment values and deprecated `{dotenv: path}` inputs do not enter keys. The commit first adopting `unkeyed` moves affected keys once;
  subsequent committed file edits retain proof for nonrepresentatives. `why` lists each
  received unkeyed path as `delivered not keyed unkeyed <path>`.
- **Test edits that wait for the super.** Root `super-only` excludes paths or globs from
  every task's key without requiring a representative. For example, create `source.txt`
  containing `ready` and `test.sh` containing `cat source.txt`, then use:

  ```yaml
  version: 1
  project: test-example
  super-only: [test.sh]
  tasks:
    test:
      run: sh test.sh
      inputs: [test.sh, source.txt]
  ```

  Commit these files and run `bunx proof run`. Add `printf "checked\n"` to `test.sh`
  and commit it: `bunx proof plan` still says PROVEN. `bunx proof why test` lists
  `delivered not keyed super-only test.sh` and `no inputs changed`. `bunx proof run --fresh --tasks test`
  runs the new script and prints `ready` and `checked`. Source changes still change the key.

  Files retain exact sandbox bytes and dependency traversal. Dirty received paths block
  publication. Entries must match files, cannot be negations, cannot overlap `unkeyed`,
  and cannot be restored by task `keyed`; every declaration reader enforces these rules.
  Included and generated declarations add `super-only` entries to the root list.
  Repos without `super-only` retain their existing keys, including existing unkeyed policy.
  Adoption changes affected keys once. With `carry: true`, `proof rekey --apply` can
  migrate an existing green if the inputs are unchanged at its commit; an edited input
  refuses with `input changed`. Without carry, adoption reruns once. A new task always
  needs its own proof. With `--since`, an unproven task whose complete key is unchanged
  is UNREACHED; an existing valid proof stays PROVEN. The fresh super run is the backstop.
- **Maestro inputs**, such as `{maestro: flows/journey.yaml}`, select the flow and its
  recursive `runFlow` and `runScript` references (strings or `{file: path}`), plus
  `addMedia` paths (a list or `{files: [...]}`). References resolve relative to the including
  flow. Proof walks `repeat`, `retry` (including `file`), inline and conditional `runFlow`
  commands, and configuration `onFlowStart` / `onFlowComplete` commands without evaluating
  conditions. Only flows are parsed as YAML; scripts and media are blob leaves. Cycles terminate.
  Missing, variable (`${...}`), unsafe or non-regular references and malformed flows make the
  task undecidable, naming the flow and reference. Declare other runtime reads, such as
  `assertScreenshot` reference images, with globs. For a declared task `a`, use
  `proof plan --json`, `proof run --tasks a`, and `proof lint` to inspect, execute and check ownership.
- **Dotenv names** are tree-derived inputs:
  ```yaml
  inputs:
    - {path: example.conf, dotenv-keys: true}
  ```
  `dotenv-keys` projects sorted unique names from a tracked file at the requested ref.
  Committed value-only changes preserve proof; dirty tracked edits run undecidable.
  Blank lines, comments, optional `export`, empty values and single-line quotes are accepted.
  Missing, unreadable or malformed tracked files run undecidable without printing source.

  `{dotenv: path, exclude: [names]}` is deprecated and ignored, even if the file is missing
  or malformed. Remove it and use `links: [stack.conf]` when a task needs an ignored file.
  `env` is only a pass-through allowlist; caller values, including absence, never enter keys.
  To read and key a tracked file's bytes, list its ordinary path as an input. Links cannot
  reach tracked files. Nonignored untracked files prevent publication only for tasks selecting them.
  An untracked dirty path at or below a task's declared link is not an input of that task.
- **Dimensions** declare machine values only for tasks that depend on them:
  ```yaml
  dimensions: {tool: 'printf demo'}
  tasks:
    native:
      run: 'true'
      inputs: [input]
      dimensions: [tool]
  ```
  Add these fields to a version-1 declaration with a project name and a tracked `input` file.
  `proof run --tasks native`, `proof plan`, `proof why native` and `proof doctor` inspect this
  example. Nothing enters a key by default. Commands run from the repository root in the normal
  environment, only for dimensions used by selected tasks, at most once per command text per
  invocation. Trimmed stdout contributes its SHA-256 under `dimension:<name>` in the existing
  env identity. Changing command text alone preserves proof when the value stays the same.
  Repeated or reordered task dimensions also preserve proof. Definitions belong at the root;
  undeclared names fail declaration validation, even in unselected tasks.

  Nonzero exits or empty trimmed output make the task undecidable, naming the dimension;
  it runs and publishes nothing. Successful trimmed dimension values are stored per result
  by `record` and `run`, for `stats --by tool`. A dimension declares a non-secret fact:
  it must not print a secret, even when its command reads ambient env. Task env and dotenv
  values remain excluded from the store. General command output stays out of diagnostics
  and the store.
  `why` compares stored hashes and reports `changed env dimension:tool`; it never executes the
  historical command. `status --ref` uses that ref's commands on the current machine.
  Dimension names cannot contain `:`, and `dotenv` cannot name a file exactly `dimension`,
  keeping tuple names distinct from ordinary env and dotenv names. `doctor` is the diagnostic
  exception: it evaluates every declared dimension and prints raw values, continuing through
  failures and exiting 1 if any fail.
- **`run`** executes in a sandbox holding the task's inputs and root `delivered` files, with the environment cleared to
  `PATH`, `HOME`, `TMPDIR` and the declared `env`. A missing input fails the task instead of
  passing by luck.
- **`coverage` and `exempt`**: `proof lint` reports every covered file that no task selects and
  no exemption names. An exemption means no task selects the file, not just that no task
  executes it: a file any task reads as an input is owned by that task, and exempting it too is a
  lint error. Included and generated declarations add exemptions to the root’s. A path
  exempted in two files fails naming both files, even when the reasons match.
  If a task selects an exempt path, lint asks you to drop the redundant exemption;
  the task already owns that path.

## Providers

Declare shared resources at the root and name them in each dependent task:

```yaml
version: 1
project: provider-demo
providers:
  stack:
    start: |
      printf 'URL=%s\n' "$ADDRESS" > "$PROOF_PROVIDER_ENV"
      echo stack-ready
    stop: echo stack-stopped
tasks:
  gate:
    run: test "$URL" = http://127.0.0.1:5432 && cat input
    inputs: [input]
    needs: [stack]
```

With a committed `input` file, `proof plan` prints
`RUN gate: no proof for key; providers: stack`. Run it with:

```sh
ADDRESS=http://127.0.0.1:5432 proof run
```

This prints the selected task count and effective job limit, then the complete selected plan,
then `stack-ready`, the input contents, and `stack-stopped`. A second run reuses the proof and
starts nothing. `proof run --tasks gate` considers only that task and its providers.

`start` must return when the resource is ready; a long-lived resource detaches itself.
A needed provider without `lane` starts at most once, only for a task currently RUN.
A provider declaring `lane: ios` starts once per used slot of the declared `ios` lane;
every dependent must declare that same lane. Tasks and their provider instance receive
`PROOF_LANE_SLOT` (0 through limit minus one). PROVEN tasks take no slot and start nothing.
Optional `stop` runs for every attempted instance after the last selected dependent,
including on task failure, startup failure or interruption.
Providers execute through `sh -c` in the checkout with the caller's environment.
Start and stop receive `PROOF_RUN_PID`, the invoking proof process's pid, overriding any inherited
value; that process stays alive during provider use. Tasks do not receive it. Dependent tasks
keep their sandbox and declared environment, plus exports from their needed providers.
`start` receives `PROOF_PROVIDER_ENV`, the path of a private mode-600 file in the state directory.
It may write literal `NAME=value` lines there; proof reads and removes it after startup.
`URL` above must stay outside task `env` to avoid a duplicate export name. Exports never enter
keys or store records, so
clones with different resource addresses can share proofs. Tasks without `needs: [stack]` receive
none of its exports. Empty files preserve the existing lifecycle. See [the export rules](docs/commands.md#provider-environment)
for names, conflicts and privacy. Included tasks use the root provider names;
unknown names are declaration errors. `PROOF_LANE_SLOT` and `PROOF_RUN_PID` are reserved in task `env` and provider
exports. `PROOF_LANES=ios=1 proof run --jobs 3` replaces the declared limit for that invocation;
see [lane scheduling and failures](docs/commands.md#provider-environment) for details.

A failed start prevents its dependents from executing and records `incomplete`; existing proofs
and contests stay intact. Selected dirty inputs use the existing committed-key recording path
with the dirty flag; unrelated dirt leaves that flag clear, including for provider dependents.
A dirty declaration or uncomputable committed input instead prints `not recorded` with a reason. Independent tasks still run. A failed start or stop names the provider and makes
`run` exit 1; other stops still run and recorded task results are retained.

SIGINT/SIGTERM reaches the running task or start process group. No further tasks or providers
start; pending RUN dependents of attempted providers record incomplete, and cleanup finishes
before exit 130/143. The first signal during `stop` lets teardown finish; a second signal kills
its running group.

Tasks may declare `timeout: 900` to limit the command to 900 seconds. The optional field
accepts whole seconds from 1 to 2147483; without it there is no budget. Timing starts when
the task command spawns, after provider startup and sandbox construction. At expiry, proof
immediately kills the whole process group with SIGKILL and records red, with
`killed at budget after 900 seconds` in the summary. Other tasks continue. An interrupt
already in progress takes precedence and records incomplete. Like `lane` and `carry`,
`timeout` does not enter keys; editing a selected file such as `proof.yaml` still changes
its key by its bytes. See [run output](docs/commands.md) for progress and exit status.

Provider declarations and `needs` do not enter task keys. A selected file such as `proof.yaml`
or a provider script still enters the key by its bytes. Declare the resource's relevant inputs
on each task (a named `$stack` set can share them). Startup edits are re-evaluated before task
execution and prevent publishing proof for the pre-start view (under `--staged`, see below).

`proof plan --json` remains an array of task decisions. RUN rows with needs also have
`"providers":["stack"]`; their distinct union is the set a run would start. PROVEN rows and
provider-free tasks have no `providers` field. Neither plan form starts resources.

## Commands

Run `proof` (or `proof --help`, `proof -h`, `proof help`) to list commands,
`proof.yaml` fields, environment variables, exit codes and absolute paths to the installed
README and command reference. Help exits 0 and works outside a git repo without `proof.yaml`.

```sh
proof run --help
proof help run
```

Both print the same usage and description; `proof run -h` also works. Every command supports
these help forms.

`plan`, `run`, `why`, `status`, `record`, `invalidate`, `flakes`, `stats`, `check`, `lint`,
`doctor`, `rekey` and `help`. Every flag, output line and exit code is in [docs/commands.md](docs/commands.md).

`proof run` defaults to the machine’s `os.availableParallelism()` concurrent tasks.
Use `proof run --jobs 2` to set a positive safe integer limit, or `proof run --jobs 1`
for live combined stdout/stderr. Above one job, output appears in completed task blocks;
resource lanes still cap admission within the job limit. Before the plan and execution,
`run: <n> tasks, jobs <j>` prints the selected count (including PROVEN and UNREACHED)
and effective limit, even for empty selections or limits above the task count.

Run mode (`--fresh`, `--staged` or `--since <ref>`), `--strict-inputs`, `--jobs N`
and `--set <name>` may appear in any order, for example
`proof run --fresh --set commit --jobs 1` with a declared `commit` set.
`--tasks <id> ...` consumes the remaining IDs and must come last, though `--strict-inputs`
also works after it. Repeated or conflicting flags, missing values and unknown arguments
exit 2 with usage.

`proof rekey [--apply]` carries valid older proofs to today's keys without running tasks.
The env-move route works for every task. Add `carry: true` to a task to also carry across
input declaration changes when today's inputs already existed unchanged at the green commit.
Opt in only when files absent from the old sandbox could not change what ran (for example,
a test runner discovering tests by glob). `carry` accepts only booleans and does not enter keys.
On a clean HEAD, run `proof rekey` to preview each task, source commit and added input file,
then `proof rekey --apply` to publish ordinary proofs. See
[rekey details](docs/commands.md#rekey) for refusals and backend behavior.

## Sharing proofs across machines

With no configuration, proofs live in a local SQLite file
(`${XDG_STATE_HOME:-~/.local/state}/proof/proof.db`) and are shared by every clone on that machine.

To share them across machines, run Postgres on one always-on machine and point every machine at
it. [docs/store.md](docs/store.md) is the full guide, and its setup block is executed by the test
suite. The shape, using Docker and [Tailscale](https://tailscale.com):

1. **Start Postgres on the host** with the guide's commands: a digest-pinned image, a named volume,
   a password, published only on `127.0.0.1:5432` so the LAN can't reach it.
2. **Expose it on your tailnet** through the host's own Tailscale. The container doesn't join the
   tailnet and isn't a new device:
   ```sh
   tailscale serve --bg --tcp 5432 tcp://127.0.0.1:5432
   ```
   Use `serve`, never `funnel` (which would publish it to the internet).
3. **Limit port 5432** to your own devices in the tailnet policy, if your tailnet holds anything
   else. Every connection still needs the password.
4. **Point each machine at it** in `~/.config/proof/store` (directory mode 700, file mode 600), or
   `PROOF_STORE` in the environment:
   ```
   postgres://proof:<password>@<host-magicdns-name>:5432/proof
   ```
   Optionally add allowed project names, one per subsequent nonempty line. Names match
   `proof.yaml` exactly; unlisted projects use SQLite only. A URL alone allows every project,
   and `PROOF_STORE` ignores the list. See [project selection](docs/store.md#configure-clients-and-diagnose),
   including older-client and worktree behavior. Then run `bunx proof doctor` on each machine.

If the store is unreachable, `proof` says so and uses that machine's own proofs; results recorded
meanwhile aren't uploaded later. `invalidate` deletes locally but exits 2 if shared deletion cannot
be confirmed, warning that the shared proof may survive. The store holds metadata only (task, key, outcome, host, timings, dimension hashes, declared
dimension values), never logs or general command output. It's a cache: losing it costs re-runs, never correctness.

## How this repo uses proof

This repository declares four real tasks. `lint`, `typecheck` and `test-fast` belong to
both `commit` and `push`; `test-slow` belongs to `push`. Each sandbox holds only the
files its command reads. Coverage makes `proof lint` reject unowned source, script
and test files.

See [proof.yaml](proof.yaml) for the declarations.

The ordered pre-commit hook scans secrets, then runs:

```sh
bun --no-env-file src/cli.ts lint
bun --no-env-file src/cli.ts run --staged --set commit
```

The pre-push hook scans outgoing commits for secrets with Git's ref-update stdin,
then runs:

```sh
bun --no-env-file src/cli.ts run --jobs 2 --set push
```

A cold commit executes lint, typecheck and fast tests. Push reuses those staged
proofs after commit and executes only slow tests; the next push reuses all four.
With proofs seeded, a README-only commit runs no task. Editing `docs/store.md`
selects slow tests because they execute its setup example. Test edits rerun lint
and typecheck; fast and slow test inventories select their respective test task.
The sprint gate retains `bun install --frozen-lockfile`.

Measured once per workload and job count on this arm64 Mac with Bun 1.4.4 on
October 30, 2026 (PDT), at tree/index `6a1e482`. Each cold workload used an empty
isolated SQLite store and configuration; push after commit reused that job count's
staged commit proofs. These CLI workload times exclude hook secret scanning and the
pre-commit declaration lint. Suite parallelism stayed unchanged: 71 fast and 225 slow tests.

Commands measured with `N=1` and `N=2`:

```sh
bun --no-env-file src/cli.ts run --staged --jobs N --set commit
bun --no-env-file src/cli.ts run --jobs N --set push
```

| Workload | Jobs 1 seconds | Jobs 2 seconds | Starting load, 1 / 2 | RUN tasks |
| --- | ---: | ---: | ---: | --- |
| Cold commit | 29.57 | 32.58 | 179.08 / 29.42 | lint, typecheck, test-fast |
| Cold push | 77.19 | 54.16 | 68.55 / 22.04 | lint, typecheck, test-fast, test-slow |
| Push after staged commit proofs | 47.45 | 55.37 | 123.25 / 22.83 | test-slow |

All six historical runs exited green with the listed result rows. Commit now uses machine
parallelism by default; its hook command is unchanged. Push retains its explicit two jobs.
After staged proofs, only one RUN task remained and the two-job measurement was slower.
The changing shared-host load prevents a controlled speedup claim. These observations are
not timing guarantees.

## Status

Pre-alpha. TypeScript on Bun, zero runtime dependencies, MIT. The `proof` bin starts with
`env -S`, which BusyBox (Alpine) lacks.

## Docs

- [Requirements](docs/2026-10-30-proof-requirements.md): the owner's decisions. Where the other docs conflict with these, these win.
- [Design](docs/2026-10-29-test-proof-design.md): inventory, measurements, model, CLI, and build-vs-adopt.
- [Adversarial review](docs/2026-10-29-test-proof-design-answers.md): answers to the design's open questions.
