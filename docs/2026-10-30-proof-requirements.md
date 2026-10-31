# `proof`: requirements for the builder

You are building `proof`, a small open-source package. It tells anyone working on a repository exactly
which tests and gates must run after a change and which are already proven, and it shares that proof
across clones and machines. Build it with xp-plugin (slates, cards, reviews, lands) in its own new
repository. This document is your requirements. Its decisions are Paul's (the owner), made on 2026-10-29/30.
Review them once before you plan. If one is wrong, say so and why, and ask Paul; don't silently
deviate. Two longer documents hold the reasoning and detail, and you should read both:

- **Design:** `docs/2026-10-29-test-proof-design.md`
  (inventory, measurements, model, CLI, build-vs-adopt). Where it conflicts with this file, this file wins.
- **Adversarial review:** `docs/2026-10-29-test-proof-design-answers.md`
  (answers to the design's open questions, and what the design gets wrong).
- **Why ten earlier attempts failed:** `gh issue view 200 --repo paulingalls/xp-plugin --comments`.

> **Names are anonymized.** `app-a` is the large private monorepo that motivated `proof`;
> `app-b` is a smaller one. Paths, commits, task ids and measurements are real; product-specific
> names inside them are substituted.

## 1. The goal

In Paul's words: "only running what actually needs to run after a change, nothing extra", and
"anyone working on this project knew what needed to be tested and what didn't."

**Customers on day one:**
- **app-a** (`app-a`): a Bun and Python monorepo with about 230 tasks.
  Those span Bun and pytest units, DB tests, lint and typecheck, about 100 bash `verify-*.sh` gates (many against
  one shared Docker compose stack), Cucumber, Playwright web journeys, Maestro iOS and Android journeys, and a
  super test that runs everything from scratch four times a week. Pushes take 12-17 minutes on an M-series Mac
  and about an hour on an Intel Mac. On 2026-10-29 a push re-ran 83 gates when exactly 1 could be affected.
- **app-b** (`app-b`): a smaller Bun monorepo (Expo mobile, web,
  server, Python), about a dozen tasks.

**The lesson that shapes everything:** app-a has five overlapping reuse and selection mechanisms
(about 5,500 lines). Each was built by a locally correct card, and none met the goal. So:
- one mechanism per job
- every adoption step deletes what it replaces
- "done" is the requirement check below passing, never "the mechanism exists"

## 2. Definition of done: the requirement suite

The suite is a list of real app-a commit pairs with the exact task set each must run. Section 1.2 of the
design lists 14 cases. Examples:
- a `CHANGELOG.md`-only change runs nothing
- one gate script runs that gate
- a `packages/db` query runs the DB tests and the stack gates that declare it
- a mobile component runs its journeys only
- a dirty tree with one untracked doc runs nothing
- a fetched tag runs nothing

It is red today. `proof check <cases.yaml>` runs it in seconds. Expected sets that depend on declarations not
yet written are confirmed with Paul when the declarations land.

**The rule for every card:** it names the suite cases it turns green, and it may turn no green case red.

The package has its own tests for its own behaviour, on synthetic repos it builds in temp directories.

## 3. Requirements

### The model
- **R1. Two homes.**
  - What a task depends on is declared in the repo: `proof.yaml`, plus optional `proof.d/*.yaml`, versioned
    and reviewed.
  - What has been proven lives in one shared store.
  - "What must run" is one deterministic lookup: the same tree and environment give the same answer on any
    clone or machine.
- **R2. No diff base.** A key is computed from the tree itself, never from a diff against a merge-base or
  branch point. This removes app-a's root cause: `scripts/static-gates.sh:2` diffs against
  `git merge-base HEAD origin/develop`, so a branch's first change re-runs on every later push. A key must
  also be computable for any ref without a checkout (`git ls-tree`), for release freshness.
- **R3. A simple key** (Paul: "as simple as possible, so it covers the cases that make sense but not too many,
  or the key becomes useless"). It is a hash of:
  - task id
  - scheme version
  - the declaration's *meaning* (not its YAML text, so cosmetic edits don't re-prove)
  - the content of the task's inputs: blob hashes of derived and declared files, json projections, and value
    hashes of declared env names
  - a small environment class

  Nothing else goes into the key.
  - Paul, 2026-10-30: `package.json#version` is excluded at every depth and through every selection
    route, including direct imports, paths and globs. An explicit `{path: package.json, json: [version]}`
    opts in. For a whole-selected valid JSON object, key exact bytes with only the first
    `"version": <parsed version>` value blanked; retain layout and every other member. Adding or
    removing the member changes those bytes. No depth scanner: an earlier nested version with the
    same value is an accepted rare corner under the 99% rule. Invalid JSON and valid non-object JSON
    keep whole-byte identity only where the file already keys whole; explicit projections and
    resolver metadata retain their current failures. Sandboxes always hold exact original bytes.
    For plain `plan` and `run`, staged or unstaged version edits RUN, while `why` reports no inputs
    changed. Under `run --staged`, a version-only index retains the key its commit will have.
- **R4. Providers govern lifecycle, never keys.** Providers are the shared stack, a test database, the iOS app
  build and the web export. They start only when some RUN task needs them. A task's key holds the task's own
  inputs, never a provider's whole input set. A stack gate's inputs include a coarse named set `$stack` (the
  backend source it exercises) and the stack's real identity: the included env-file values the stack reads.
  - Paul, 2026-10-30: drop the provider-key class (absent, dummy or real). Real keys run only in
    the super run, which ignores proofs, so a dummy green cannot stand in for a real run.
    A class in the key would hide super reds from dummy proofs and prevent reuse of super greens.
    Repos exclude provider keys from dotenv identity.
  - Journeys (native and web) exercise the running backend, so their inputs include `$stack` too: a backend
    change re-runs them. Never a stale PROVEN; a repo narrows `$stack` per journey if that costs too much
    (Paul, 2026-10-30, resolving design §4.2 against §1.2 cases 4, 7 and 10).
- **R5. Derive, then declare.**
  - **Derived:** the import closure, from the language's own tooling rather than hand-written globs:
    Bun/TypeScript via `bun build --metafile` or the TypeScript program (honouring tsconfig paths and workspace
    packages), Python via a static import graph (for example grimp).
  - **Declared on top:** what imports cannot see, such as runtime-read files (fixtures, prompt assets, SQL),
    spawned scripts, env names, Maestro flow includes, and named sets.
  - **Shipped with the core:** the adapters for `imports-of` (TS and Python), `maestro` flow closure,
    `dotenv-keys` and `json` projection.
- **R6. Environment classes are minimal.** No dimension enters a key by default: OS, CPU architecture and
  Bun version do not change these results, and the Intel Mac (on an older macOS) shares every proof with the
  Apple-silicon Macs (Paul, 2026-10-29). A repo declares a dimension only for tasks whose results it changes,
  such as Xcode and the simulator runtime for native journeys; an Xcode update then re-proves those journeys,
  with no override.

### Enforcement and correctness
- **R7. Enforce declarations, never trust them.**
  - **Host, static and private-container tasks** run from a sandbox containing only their derived and declared
    inputs.
  - **Workspace packages must be sound:** a workspace dependency's source enters the closure and the sandbox. It
    is never reached through a `node_modules` symlink back into the real tree. The design's own `bun:db` example
    misses `packages/shared`, which 485 files import.
  - **Shared-stack tasks** get script-side sandboxing plus the coarse `$stack` set.
  - **A missing input fails loudly.**
- **R8. Fail safe, never silent.**
  - An undecidable task runs: a glob that matches nothing, an unknown adapter, a dirty tracked input. `plan`
    prints why for every task.
  - Only clean trees publish proofs, except `run --staged`: Paul, 2026-10-30, an immutable index
    snapshot may publish. Plain `plan` and `run` retain the clean-tree rule.
- **R9. Red against a stored green: contested.**
  - When the newest result for a key is red, that key is never PROVEN.
  - A contested key runs once: green restores the proof, a second red deletes it.
  - An incomplete or killed run contests nothing.
  - `proof flakes` ranks tasks by contradictions.
  - A flake is re-run alone; never serialise a whole tier for one flake.
  - Logs stay on the machine: they may hold private data, so they never reach either store (R13).
- **R10. The super test is the backstop.** It runs every task fresh, and records each task's result
  independently so one red doesn't hide others. A fresh red against a stored green for the same key deletes
  that green everywhere and records a contradiction. Its greens publish proofs like any other clean run.
- **R11. Running-stack reuse is modelled.** A run brings the stack up once for all its stack tasks. A stack
  already running is reused only if its identity matches the current tree's.

### The store
- **R12. Postgres in Docker** (a pinned image, never a Homebrew service).
  - **Where:** on Paul's M3 MacBook first, which stays awake on power; later the Mac mini, never asleep.
  - **Address:** a Tailscale MagicDNS name.
  - **Network:** Postgres listens on all interfaces inside Docker, published only on `127.0.0.1:5432`.
    The host exposes it with `tailscale serve --bg --tcp 5432 tcp://127.0.0.1:5432`; a Tailscale ACL
    limits port 5432 to the user's own devices. `pg_hba.conf` uses
    `host all all samenet scram-sha-256`. Tailscale and the loopback publish enforce tailnet membership
    (Docker Desktop hides client addresses); Postgres always enforces the password.
  - **Connection string:** from the environment or user config, never in the repo.
  - **Moving hosts** is `pg_dump`/restore, or starting empty: it's a cache, so loss costs time, never
    correctness.
- **R13. Metadata only:** task, key, outcome, host, env class, commit, seconds, timestamps,
  per-declared-env-name absent-or-value hashes, contradiction records. Paul, 2026-10-30: store these
  env identities per proof for `why`; never env values. Never logs or output: app-a's logs can contain
  private personal data.
- **R14. A local fallback.** Each machine keeps a local SQLite replica of its own results. When the store is
  unreachable, `plan` falls back to that machine's own proofs, otherwise runs everything, and says so loudly.
- **R15. The store absorbs the history** that app-a scatters today: per-task timings, flake history,
  contradictions, and release freshness ("every journey green at this tag" is a query).
  Ledger import dropped 2026-10-30: no current consumer needs it (the lead's reading; Paul may correct it).

### The interface
- **R16. The CLI** follows design §4.6:
  - `plan`, `run`, `why`, `status --ref`, `record`, `invalidate`, `flakes`, `stats`, `check`, `lint`, `doctor`
  - `plan --json` is for wrappers and hooks
  - `why <task>` shows the key's parts and which inputs changed since the newest proof
  - `run` exits nonzero on red or interruption, not on undecidable alone: it runs in commit hooks, where the
    tree is dirty by default, so an undecidable task that ran green is reported, never failed (Paul, 2026-10-30).
- **R17. Concurrency across clones and hosts:** two runs of the same key may both execute, and the store keeps
  both results. A proof is written atomically, and readers never see a half-written one.

### The package
- **R18. TypeScript on Bun, zero runtime dependencies, MIT,** on npm under a scoped name (plain `proof`,
  `proven` and similar are taken).
  - **Core:** parser and lint, hashing over the git index, env class, key, store client (`Bun.sql`,
    `bun:sqlite`), planner, executor, sandboxes, providers and lanes, CLI.
  - **Shipped adapters:** as in R5.
  - Repo adapters under `proof.d/adapters/` dropped 2026-10-30: no current consumer needs it
    (the lead's reading; Paul may correct it).
- **R19. Nothing from a consumer leaks into the core.** No app-a or xp-plugin vocabulary goes in the schema,
  CHECK constraints, task kinds or CLI. Run sets (`push`, `land`, `story`, `super`, ...) are each repo's own
  names in its `proof.yaml`.
- **R20. app-b adopts with about a dozen declarations and no core change.** Two frictions to handle:
  it uses floating image tags, and it relies on `--env-file`.

## 4. Non-goals

- No remote execution, build graph, or CI caching service.
- Not a Bazel/Nx replacement for builds: it decides and records test proof only.
- No shadow mode. Paul chose to cut over directly, with R9's contested rule and R10's super backstop as the
  safety net.

## 5. Adoption in app-a (that repo's lead runs these as app-a cards)

Cut over caller by caller, each card deleting its old path in the same change, so two identities never live
side by side for long:

1. **The requirement suite first:** `proof-cases.yaml` plus a gate running `proof check`. Red.
2. **app-a's declarations,** generated where possible, and `proof lint` green.
3. **story-gate on `proof run`:** host tasks only, one caller.
4. **push-quality and the push hook.**
5. **land and the sprint Docker leg**, deleting `ancestor-receipts.py`, `select-leg-gates.py`,
   `leg-selection.py` and the exact-tree receipts.
6. **Journeys and release freshness**, deleting `journey-receipts.py`, `journey-release-evidence.py` and the
   super-test rows.
7. **The super test on `proof run --fresh`.**

Each card names the suite cases it turns green, and the order may change if a card proves it.

## 6. How to build it

- **New repository** `paulingalls/proof`. Ask Paul before making it public.
- **Run `xp.py setup` there** (xp-plugin; the banner path is at session start). Seed its
  `.xp/constraints.md` from these rules:
  - small files
  - zero runtime dependencies
  - fail loud and never skip silently
  - behaviour tests at the outermost boundary
  - no tests of tests
  - one mechanism per job
- **Start from the requirement suite.** Your first slate should make `proof check` runnable, and a minimal
  `plan` plus store correct on a synthetic repo, before any adapter breadth.
- **Before the first slate,** re-read section 1 of this file and the issue-200 lesson. Before adding any
  mechanism, name the existing one it replaces or extends.
- **Paid model calls:** none are needed. Never touch beta or any production system. On this Mac, other clones
  run tests: no load tests without asking Paul.
- **Escalate to Paul:** the package name and visibility, any change to a decision here, and any premise you
  find false.
