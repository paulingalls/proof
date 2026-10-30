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
  task, key, outcome, host, timings and contradictions, never logs. Each machine
  keeps a local SQLite copy of its own results.
- **Declarations are enforced, not trusted.** Tasks run in a sandbox holding only
  their inputs, so a missing input fails loudly. An undecidable task always runs.
- **Flakes are contested, not hidden.** A red against a stored green contests the
  proof; a second red deletes it, and the task runs until it is green again.

## Install

`proof` needs [Bun](https://bun.sh) 1.4.4 or later and git. It isn't published to npm; depend on a
tagged release from GitHub:

```sh
bun add -d "git+https://github.com/paulingalls/proof.git#v0.5.0"
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
- **`run`** executes in a sandbox holding only the task's inputs, with the environment cleared to
  `PATH`, `HOME`, `TMPDIR` and the declared `env`. A missing input fails the task instead of
  passing by luck.
- **`coverage` and `exempt`**: `proof lint` reports every covered file that no task selects and
  no exemption names.

## Commands

```
proof plan [--json]          what must run, and why
proof run [--tasks <id>...]  run what must run, and record the results
proof record <task> --outcome green|red|incomplete [--seconds N]
proof lint                   check declarations against the staged tree
proof check <cases.yaml>     run a requirement suite
proof doctor                 which store is in use, and whether it's reachable
```

`run` exits 0 when every task is proven or green, 1 when one is red, 130/143 when interrupted;
any command exits 2 on a usage, declaration or store error. Planned: `why`, `status --ref`, `invalidate`, `flakes`, `stats`.

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
meanwhile aren't uploaded later. The store holds metadata only (task, key, outcome, host, timings),
never logs or output. It's a cache: losing it costs re-runs, never correctness.

## Status

Pre-alpha. TypeScript on Bun, zero runtime dependencies, MIT. The `proof` bin starts with
`env -S`, which BusyBox (Alpine) lacks.

## Docs

- [Requirements](docs/2026-10-30-proof-requirements.md): the owner's decisions. Where the other docs conflict with these, these win.
- [Design](docs/2026-10-29-test-proof-design.md): inventory, measurements, model, CLI, and build-vs-adopt.
- [Adversarial review](docs/2026-10-29-test-proof-design-answers.md): answers to the design's open questions.
