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
bun add -d "git+https://github.com/paulingalls/proof.git#v0.8.1"
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

Proofs are published only from a clean tree. With uncommitted changes to a task's inputs, that task
runs every time and publishes nothing, so a commit hook is safe. `pre-push` or CI, where the tree
is clean, is where proofs get earned.

## Declaring tasks

```yaml
version: 1
project: my-app                # scopes proofs in a shared store
include: proof.d/*.yaml        # optional: more files with `inputs` and `tasks`
inputs:                        # named sets, referenced as $name
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
  the task undecidable, so it always runs and says why.
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
  `undecidable: dirty input '<path>'` and publishes no proof.
  Closures no longer key `dependencies`, `devDependencies`, `scripts`, `patchedDependencies`
  or `packageManager` implicitly. Declare the members your command needs, for example
  `{path: package.json, json: [dependencies, devDependencies, patchedDependencies, packageManager, scripts]}`
  alongside its closure input. Key scheme 4 requires fresh proof for all tasks, including
  tasks without closures. Accepted risk: a test hard-coding a version can retain proof after a
  committed version bump; the super run that executes every task fresh catches it.
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
    start: echo stack-ready
    stop: echo stack-stopped
tasks:
  gate:
    run: cat input
    inputs: [input]
    needs: [stack]
```

With a committed `input` file, `proof plan` prints
`RUN gate: no proof for key; providers: stack`. `proof run` prints the complete selected plan,
then `stack-ready`, the input contents, and `stack-stopped`. A second run reuses the proof and
starts nothing. `proof run --tasks gate` considers only that task and its providers.

`start` must return when the resource is ready; a long-lived resource detaches itself.
Each needed provider starts at most once, only for a task currently RUN. Optional `stop` runs
once after the last selected dependent, including on task failure, startup failure or interruption.
Providers execute through `sh -c` in the checkout with the caller's environment. Dependent tasks
keep their sandbox and declared environment. Included tasks use the root provider names;
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
execution and prevent publishing proof for the pre-start view.

`proof plan --json` remains an array of task decisions. RUN rows with needs also have
`"providers":["stack"]`; their distinct union is the set a run would start. PROVEN rows and
provider-free tasks have no `providers` field. Neither plan form starts resources.

## Commands

```
proof plan [--json]          what must run, and why
proof why <task>            current key parts and changes since the newest proof
proof status --ref <ref> [--json]  proof state of every task at a committed ref
proof run [--fresh] [--tasks <id>...]  run tasks and record each result
proof record <task> --outcome green|red|incomplete [--seconds N]
proof lint                   check declarations against the staged tree
proof check <cases.yaml>     run a requirement suite
proof doctor                 which store is in use, and whether it's reachable
```

`run` exits 0 when every task is proven or green, 1 when a task is red/incomplete or a provider fails, 130/143 when interrupted;
any command exits 2 on a usage, declaration or store error.

`proof run --fresh` executes every task even when its key is already proven, in the same
sandboxes and with the same providers as an ordinary run. Select a subset with
`proof run --fresh --tasks first second`. Providers start once for selected dependents,
including proven ones. A red does not stop later tasks; each result is recorded independently.

A fresh red over unchanged selected inputs immediately deletes that key's stored green and
records a `super` contradiction. The summary lists every red and each confirmed deletion as
`deleted proof local <task> <key>` or `deleted proof shared <task> <key>`. Ordinary runs still
contest a green on the first red and delete it on the second. A clean fresh green publishes
proof, including for a contested key. Incomplete results and interrupts delete nothing.

A dirty tree still executes (a dirty declaration runs without recording) and records results, but says `no proof published` with a reason.
A red over dirty selected inputs cannot delete proof of the committed bytes; unrelated dirt
does not prevent deletion. Offline deletions apply locally and say `not shared`; an attempted
share whose commit is uncertain says `sharing uncertain` and claims no shared deletion.
Reconnection does not replay results. Schedule fresh runs in the repository using cron or
launchd; proof provides no scheduler.

`proof why <task>` starts with the task's `plan` decision, then prints its current key
parts: selected paths with file identities and modes, JSON member identities, declared env names
(without values), and the declaration hash. These parts use the files on disk, including staged
and unstaged edits, additions, deletions and selected ignored files. Git decides whether a
tracked path is clean, so a line-ending or LFS filter never reads as a change; blob ids of
dirty paths hash their raw bytes. Whole-selected object manifests instead print a SHA-256 identity
of their bytes with the version value blanked, rather than a Git blob id.
Plan's dirty-input eligibility stays the same. Resolver-only manifests print
`member package.json <member> <mode> <hash>` lines instead of a `file package.json` line.
A version-only edit reports `no inputs changed` in the comparison even when the dirty rule
requires RUN; a resolution-member edit reports, for example, `changed member package.json name`.

For example, after proving `text`, edit its input and explain it:

```sh
bunx proof record text --outcome green
# Edit src/text.ts.
bunx proof why text
```

The decision says `RUN text: undecidable: dirty input 'src/text.ts'`, and the comparison
includes `changed file src/text.ts`. Explanation never executes tasks or starts providers.

The baseline is the newest surviving proof for this project and task across all keys, including
contested proofs. Newest means greatest finish time, then result id; the comparison names its
commit, host and time. Historical inputs and declarations come from that commit's Git blobs.
Changes list added, removed and changed paths or JSON members, changed env names, and
`declaration changed` when the command or links changed. Env comparisons use stored hashes,
never today's env as a substitute for historical values. Mode changes count too.

With no differences it says `no inputs changed`, or `no comparable inputs changed` when something
couldn't be compared; unresolved inputs print their reasons and available parts. Older proofs say
`env comparison unavailable` while files still compare. A pruned proof commit says
`proof commit unavailable: <commit>` and leaves the current parts visible. A task never proven
says `no proof for this task`. Why exits 0 for these explanations and 2 for an unknown task,
invalid arguments, declarations or store errors. An available proof commit whose declarations
cannot be reconstructed also fails with exit 2, after printing current parts. The shared store
is authoritative while online; an unreachable store announces fallback once and uses only this
machine's own proofs.

`proof status --ref <ref> [--json]` judges every task using that ref's committed
`proof.yaml`, included declarations and input bytes, plus the caller's declared env values.
It resolves branches, commit ids, lightweight tags and annotated tags without checking out the
ref, running tasks or starting providers. Uncommitted edits and installed dependencies do not
change its answer. For example:

```sh
bunx proof status --ref HEAD --json
bunx proof status --ref release --json
```

Rows use the same format as `plan`: PROVEN names the proof's commit, host and time; RUN explains
`no proof for key`, a contested proof or an undecidable key. JSON has the same row shape as
`plan --json`. Status exits 0 when every task is PROVEN (including a ref with no tasks), 1 when
any task is RUN, and 2 for an unknown ref, invalid declarations, usage or store error. An
unreachable store uses the local replica and reports the fallback on stderr, keeping JSON
stdout parseable.

Status reads only the ref's committed files and your declared env, so a ref gets the same answer
on every checkout. `plan` also looks at this checkout, so `status --ref HEAD` can say PROVEN where
`plan` says RUN when the checkout has something the commit doesn't: an uncommitted or ignored file
a task selects (even when `git status` is empty), a file hidden by `assume-unchanged` or
`skip-worktree`, or a linked `node_modules` escaping into tracked files. Status's `trusted links`
suffix restates the declaration rather than reporting an inspection.

`proof check` compares the exact RUN set between committed refs without executing the declared
commands. After the Quickstart's `src/text.ts` edit and commit, save this as `cases.yaml`:

```yaml
- name: text source edit
  from: HEAD~1
  to: HEAD
  expect: [text]
```

Run `bunx proof check cases.yaml`. It prints `PASS text source edit` and exits 0. A mismatched set prints `FAIL` with `missing:` and `extra:` task ids and exits 1.
A case assumes every task is proven at `from`, so a task proof can't decide there fails the case
(`from <ref>: <task> undecidable: <reason>`). One undecidable at `to` must run: it prints a `RUN`
diagnostic and counts as selected.

Planned, specified in [R16](docs/2026-10-30-proof-requirements.md) and design §4.6:

```
proof invalidate --task <t> [--key k|--all] delete proofs (recorded as a manual contradiction)
proof flakes [--since 30d]                tasks ranked by contradictions
proof stats [--set land]                  median seconds per task; estimated minutes for a plan
```

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
   Then run `bunx proof doctor` on each machine.

If the store is unreachable, `proof` says so and uses that machine's own proofs; results recorded
meanwhile aren't uploaded later. The store holds metadata only (task, key, outcome, host, timings, per-name env hashes),
never logs or output. It's a cache: losing it costs re-runs, never correctness.

## Status

Pre-alpha. TypeScript on Bun, zero runtime dependencies, MIT. The `proof` bin starts with
`env -S`, which BusyBox (Alpine) lacks.

## Docs

- [Requirements](docs/2026-10-30-proof-requirements.md): the owner's decisions. Where the other docs conflict with these, these win.
- [Design](docs/2026-10-29-test-proof-design.md): inventory, measurements, model, CLI, and build-vs-adopt.
- [Adversarial review](docs/2026-10-29-test-proof-design-answers.md): answers to the design's open questions.
