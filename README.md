# proof

`proof` tells anyone working on a repository exactly which tests and gates must
run after a change, and which are already proven. It shares that proof across
clones and machines, so a green result earned on one machine is reused by every
other machine with the same tree and environment.

The goal: run only what a change can actually affect, and nothing extra.

## How it works

- **Declarations live in the repo.** `proof.yaml` (plus optional `proof.d/*.yaml`)
  says what each task depends on. TypeScript inputs come from the import closure
  (a Python import graph is planned). You declare only what imports cannot see,
  such as fixtures, SQL, spawned scripts and env names.
- **A key is computed from the tree, never from a diff.** A task's key hashes its id,
  the meaning of its declaration, the content of its inputs, and a small environment
  class. The same tree and environment give the same answer on any clone or
  machine (OS, CPU and Bun version are deliberately not in the key), and a key can
  be computed for any ref without a checkout.
- **Proofs live in one shared store.** Postgres (optional) stores metadata only:
  task, key, outcome, host, timings, per-name env hashes and contradictions, never logs. Each machine
  keeps a local SQLite copy of its own results.
- **Declarations are enforced, not trusted.** Tasks run in a sandbox holding only
  their inputs, so a missing input fails loudly. An undecidable task always runs.
- **Flakes are contested, not hidden.** A red against a stored green contests the
  proof; a second red deletes it, and the task runs until it is green again.

## Install

`proof` needs [Bun](https://bun.sh) 1.4.4 or later and git. It isn't published to npm; depend on a
tagged release from GitHub:

```sh
bun add -d "git+https://github.com/paulingalls/proof.git#v0.13.2"
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

Plain `run` publishes proofs only from a clean tree. With uncommitted changes to a task's inputs,
that task runs every time and publishes nothing. A commit hook can use `proof run --staged`
to prove the index instead: its green is reusable after committing those staged bytes, including
at push or in CI.

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
    env: [CI]                  # env names that reach the task and enter its key
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
  Use `links` for ignored file access and `{dotenv: path}` for dotenv value identities.
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
  `{dotenv: path}` env values stay keyed: those values identify the stack and the sandbox
  does not receive that file. The commit first adopting `unkeyed` moves affected keys once;
  subsequent committed file edits retain proof for nonrepresentatives. Repos without
  `unkeyed` keep their existing keys. `why` lists each received unkeyed path.
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
- **Dotenv identity** has two forms:
  ```yaml
  inputs:
    - {path: .env.example, dotenv-keys: true}
    - {dotenv: .env.docker, exclude: [A, API_KEY]}
  ```
  `dotenv-keys` projects sorted unique names from a tracked file at the requested ref.
  Committed value-only changes preserve proof; dirty tracked edits run undecidable.
  `dotenv` reads the invocation checkout at every ref, including `status --ref`; each included
  name contributes a value hash under `<file>:<NAME>`. Omit `exclude` to include every name;
  when supplied it must be a nonempty list. Reordering or repeating declarations changes nothing.
  Ordinary `env` names cannot contain `:`. Values never enter proof metadata or diagnostics;
  `proof why gate` reports, for example, `changed env .env.docker:FLAG`.

  Both forms accept blank lines, comments, optional `export`, whitespace around `=`, empty
  values and single-line single or double quotes. Unquoted inline comments need whitespace
  before `#`; quoted `#` is literal. After closing quotes, only whitespace or a whitespace-led
  comment is allowed. Escapes protect double quotes but are not decoded; there is no variable
  expansion or command substitution. Repeated assignments use the last value. Unsupported
  syntax makes the task undecidable with a file and line number, without printing source.
  Missing or unreadable files also run undecidable and publish nothing. `proof lint` validates
  checkout paths without requiring dotenv files to exist or be tracked.

  `dotenv` provides identity only: it neither supplies task environment variables nor copies
  the file into the sandbox. A task reading an ignored file adds `links: [.env.docker]`.
  Gitignore local dotenv files: nonignored untracked files prevent publication under the
  clean-tree rule. To read a tracked dotenv file, also list its ordinary path as an input;
  this materializes it and keys its bytes. Links cannot reach tracked files.
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
  it runs and publishes nothing. Command output stays out of diagnostics and the store.
  `why` compares stored hashes and reports `changed env dimension:tool`; it never executes the
  historical command. `status --ref` uses that ref's commands on the current machine.
  Dimension names cannot contain `:`, and `dotenv` cannot name a file exactly `dimension`,
  keeping tuple names distinct from ordinary env and dotenv names. `doctor` is the diagnostic
  exception: it evaluates every declared dimension and prints raw values, continuing through
  failures and exiting 1 if any fail.
- **`run`** executes in a sandbox holding only the task's inputs, with the environment cleared to
  `PATH`, `HOME`, `TMPDIR` and the declared `env`. A missing input fails the task instead of
  passing by luck.
- **`coverage` and `exempt`**: `proof lint` reports every covered file that no task selects and
  no exemption names.

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

This prints the complete selected plan,
then `stack-ready`, the input contents, and `stack-stopped`. A second run reuses the proof and
starts nothing. `proof run --tasks gate` considers only that task and its providers.

`start` must return when the resource is ready; a long-lived resource detaches itself.
Each needed provider starts at most once, only for a task currently RUN. Optional `stop` runs
once after the last selected dependent, including on task failure, startup failure or interruption.
Providers execute through `sh -c` in the checkout with the caller's environment. Dependent tasks
keep their sandbox and declared environment, plus exports from their needed providers.
`start` receives `PROOF_PROVIDER_ENV`, the path of a private mode-600 file in the state directory.
It may write literal `NAME=value` lines there; proof reads and removes it after startup.
`URL` above belongs outside task `env`: provider exports never enter keys or store records, so
clones with different resource addresses can share proofs. Tasks without `needs: [stack]` receive
none of its exports. Empty files preserve the existing lifecycle. See [the export rules](docs/commands.md#provider-environment)
for names, conflicts and privacy. Included tasks use the root provider names;
unknown names are declaration errors.

A failed start prevents its dependents from executing and records `incomplete`; existing proofs
and contests stay intact. Dirty inputs use the existing committed-key recording path with the
dirty flag. A dirty declaration or uncomputable committed input instead prints `not recorded`
with a reason. Independent tasks still run. A failed start or stop names the provider and makes
`run` exit 1; other stops still run and recorded task results are retained.

SIGINT/SIGTERM reaches the running task or start process group. No further tasks or providers
start; pending RUN dependents of attempted providers record incomplete, and cleanup finishes
before exit 130/143. The first signal during `stop` lets teardown finish; a second signal kills
its running group.

Provider declarations and `needs` do not enter task keys. A selected file such as `proof.yaml`
or a provider script still enters the key by its bytes. Declare the resource's relevant inputs
on each task (a named `$stack` set can share them). Startup edits are re-evaluated before task
execution and prevent publishing proof for the pre-start view (under `--staged`, see below).

`proof plan --json` remains an array of task decisions. RUN rows with needs also have
`"providers":["stack"]`; their distinct union is the set a run would start. PROVEN rows and
provider-free tasks have no `providers` field. Neither plan form starts resources.

## Commands

`plan`, `run`, `why`, `status`, `record`, `invalidate`, `flakes`, `stats`, `check`, `lint` and `doctor`. Every flag, output line and exit code is in [docs/commands.md](docs/commands.md).

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
be confirmed, warning that the shared proof may survive. The store holds metadata only (task, key, outcome, host, timings, per-name env hashes),
never logs or output. It's a cache: losing it costs re-runs, never correctness.

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

All six runs exited green with the listed result rows. Commit keeps the default one job
because two did not improve its measurement. Push uses two based on the cold-push reduction.
After staged proofs, only one RUN task remains and the two-job measurement was slower.
Feedback from these runs guides the hook choice; the changing shared-host load prevents a
controlled speedup claim. These observations are not timing guarantees.

## Status

Pre-alpha. TypeScript on Bun, zero runtime dependencies, MIT. The `proof` bin starts with
`env -S`, which BusyBox (Alpine) lacks.

## Docs

- [Requirements](docs/2026-10-30-proof-requirements.md): the owner's decisions. Where the other docs conflict with these, these win.
- [Design](docs/2026-10-29-test-proof-design.md): inventory, measurements, model, CLI, and build-vs-adopt.
- [Adversarial review](docs/2026-10-29-test-proof-design-answers.md): answers to the design's open questions.
