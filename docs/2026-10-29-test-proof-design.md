# Test proof: one model for "run only what the change can affect"

Design document, 2026-10-29. Read-only study of app-a at `2e5477472` (develop), app-b,
xp-plugin 1.2.1 and the public docs of seven task-cache tools. No gate was run; every number
below comes from `git`, the timing ledger `$(git rev-parse --git-common-dir)/land-timing.jsonl`
(26,349 rows, 2026-09-24 to 2026-10-29, this M3 Max), the receipt directories, or a cited doc.

## Summary (one page)

**The requirement.** Paul, repeatedly since August: *after a change, run only what that change can
affect, nothing extra*, in a way anyone on any clone or machine can predict, and reusable in
app-b.

**Where we are.** Five mechanisms (exact-tree receipts, declared-input gate receipts, ancestor
rows plus a diff selector, journey evidence, release closure) in 5,954 lines of selection and
receipt code, 136 commits since August, built by ten locally correct cards. Measured on this Mac:
300.8 hours of fresh gate execution in 35 days; 6.4% of ledger rows are reuses; 2,571 executions
were exact repeats of an identical (step, argv, tree) triple already run (29.3 hours); the
2026-10-29 push of a diff touching one gate script and CHANGELOG.md ran 83 gates for 41.7 gate
minutes; the next push reused nothing and ran 72.7 gate minutes. Every story-gate run re-executes
the five host checks (fast tests, typecheck, lint, drift, Python types): 74 of the 300 hours.

**Why ten correct cards failed.** Technically: three different keys answer one question (whole
index tree; declared blob set for 6 gates; commit ancestry re-selected through a path diff), the
diff selector diffs against the merge-base with develop rather than the last proven tree
(`scripts/static-gates.sh:2`), proof is stored per git-dir, per clone and per Mac in four places
with different row shapes, the identity folds in every ref in the repo, and a single unstaged file
turns every leg to "full". Process-wise: each card's Acceptance proved its own mechanism, nothing
ever asserted the requirement, and no card was ever asked what it deletes (xp-plugin issue #200).

**Recommendation.** Build one small open-source package, working name **`proof`**, TypeScript on
Bun (both repos run Bun; Bun ships SQLite, Postgres, glob, SHA-256 and YAML with no dependencies),
and delete the five mechanisms as it lands. Not Turborepo, Nx, Moon, mise, Pants, Bazel or Buck2:
none caches an arbitrary shell gate against a shared Docker stack *and* keeps metadata history
*and* enforces declarations; the ones that trust declarations (Turborepo, Nx, Moon, mise) store
blobs behind a wire spec you would implement yourself anyway, and the ones that enforce (Bazel,
Pants) do it with sandboxes that make a stack or simulator test uncacheable by definition.

- **Two homes.** `proof.yaml` in the repo declares every task's inputs (repo-wide globs, named sets,
  JSON projections like `package.json#dependencies`, declared env names, computed inputs such as an
  import closure) and its environment class. A Postgres database on a Mac, reached over Tailscale,
  holds proofs keyed by `(task, sha256(declaration + input blobs + env values + env class))`.
- **One lookup.** `proof plan --set land` prints RUN / PROVEN / UNDECIDABLE per task with the reason;
  there is no diff base, so the merge-base trap disappears and a new clone or new Mac sees the
  same answer. Unreachable store = everything runs, printed loudly.
- **Enforced where it can be.** Private, static and unit tasks run from a copy holding only declared
  inputs (as the 6 declared gates do today). Shared-stack gates get the honest substitute: their
  script side is sandboxed, the stack side is one coarse named set, and the super test (fresh, four
  times a week) deletes any green it contradicts and records the contradiction against the task.
- **Flakes** follow Paul's rule: an ordinary red against a stored green does not delete the green
  (the green is the rerun); it is recorded as a contradiction; `proof flakes` ranks tasks by it.
- **History** lives in the same store: seconds per run, contradictions, release freshness
  (`proof status --set release --ref v0.150.0` computes keys at the tag from tracked blobs).

**Migration** in eight releasable steps (section 6), the first being the requirement suite itself:
real commit pairs with the exact task set each must run, red today, green step by step. The
suite is the definition of done for every card that follows. Deleted by the end: check-receipts.py,
ancestor-receipts.py, receipt-inputs.py, gate-inputs.py and .json, journey-receipts.py,
journey-inputs.py, journey-release-evidence.py, verify-release-journeys.py, leg-selection.py,
select-leg-gates.py, select-acceptance-legs.py, backmerge-selection.py, test-inputs.py,
acceptance-segments.py, acceptance-selection.sh, native-journey-selection.sh, the three receipt
directories, land-timing.jsonl, the super rows.jsonl, tier-path-index.md, tier-execution-evidence.md
and green-check-receipts.md.

**Open questions for Paul** are in section 7: store host and engine (Postgres on the M3 now, the
mini later), whether CPU architecture belongs in every environment class, keep-or-delete on an
ordinary red against a green, how coarse the shared-stack set may be, and the package name.

---

## 1. The requirement, restated as an executable check

### 1.1 The claim

For a change from tree A to tree B, with every task proven at A, `proof plan` at B must list exactly
the tasks whose declared inputs differ between A and B. Nothing extra; nothing missing that a
declaration names. A task whose state cannot be decided runs (constraint 8: no silent skip).

### 1.2 The suite

`scripts/proof-cases.yaml` holds real commit pairs from develop. `bash scripts/verify-proof-selection.sh`
computes the plan for each pair assuming A fully proven and compares it with `expect`. It is pure
computation over tracked blobs: seconds, no stack, no device. Until `proof` exists the script asks
today's selectors (`select-leg-gates.py --base A --head B`, `select-acceptance-legs.py --base A
--head B --json`, `run-fast-tests.py --all` is unconditional) and prints the union; that run is red
today.

Task names below are the ones section 4 declares. Journeys include `$stack` (requirements R4, Paul
2026-10-30), so cases 4, 7 and 10 select them. Expectations are the design's claim; the card
that lands the suite confirms each against the declarations and Paul reviews the list.

| # | Pair (A → B) | Diff | Expected RUN set | Today |
|---|---|---|---|---|
| 1 | `0f10aba84` → `9a798c96a` | `CHANGELOG.md` only | none | this was the 83-gate push (tree `3a2098b524`, 41.7 gate-min) |
| 2 | `0f10aba84^` → `0f10aba84` | `scripts/verify-metrics-role.sh`, `scripts/test-ratchet.json` | `verify-metrics-role` (ratchet.json is a pre-commit input, not a cached task) | measured: 61 shared-stack, 19 static, 7 private, 13 test-all rows (branch diff vs merge-base) |
| 3 | `3db086374^` → `3db086374` | `CHANGELOG.md`, root `package.json` version only | none (`package.json#version` is excluded by projection) | none for Docker (`effective_paths` exemption), but story-gate and push-quality rerun everything |
| 4 | `9a7923f42^` → `9a7923f42` | `apps/worker/src/config.py` (a docstring) | `pytest:worker-unit`, `pytest:worker-acceptance`, every shared-stack gate and every journey (the `stack` set contains `apps/worker/**`), `image:worker` | same plus static, private, journeys at land |
| 5 | `2d345da46^` → `2d345da46` | `apps/mobile/src/features/items/item-period.tsx` | `bun:mobile` (unit), native and web journeys whose import closure reaches the file (items journeys), `web-audit` cells for those routes; no Docker gate, no Python | native: smoke only (runner-literal selection); web: nothing (spec-only); Docker: everything if the push is a free branch |
| 6 | `ee9e5ec3c^` → `ee9e5ec3c` | `.maestro/flow-switcher-completions.yml` | native journeys whose `runFlow` closure includes the flow; nothing else | smoke + runners naming the flow (close); plus Docker at a free push |
| 7 | `a0d02fc69^` → `a0d02fc69` | `packages/db/src/queries/record-entity.ts` + CHANGELOG + version | `bun:db` (DB unit), `typecheck`, every shared-stack gate and every journey (`$stack`), `pytest:worker-acceptance` (it reads the schema), `image:api`, `image:worker` | plus static, private, journeys |
| 8 | `26eec6bb0^` → `26eec6bb0` | `docs/research/*.md` | none | story-gate full; push-quality full |
| 9 | `8a035f6dd^` → `8a035f6dd` | `lefthook.yml` comment | none | `test-all:worker-acceptance` (9.5 min: `python-leg-inputs.json` lists `lefthook.yml`) |
| 10 | `44a631988^` → `44a631988` | base-image digests in `apps/{worker,generator}/Dockerfile` | `image:worker`, `image:generator`, every shared-stack gate and every journey, `pytest:worker-acceptance` (testcontainers build the image) | same at a sprint; everything at a free push |
| 11 | `e246a47b7^` → `e246a47b7` | `scripts/tiers.md` | none | story-gate full |
| 12 | `416847519^` → `416847519` | `apps/mobile/scripts/lib/e2e-post-provision.sh` | every native journey (a shared harness include) and `native:smoke`; no web, no Docker | native leg on, smoke + runners that source it |
| 13 | any A → A with one untracked file in `docs/` | dirty tree, undeclared path | none | every leg "full" (`leg-selection.py:213`) |
| 14 | any A → A after `git fetch` adds a tag | refs moved, tree unchanged | none | every exact receipt in the checkout invalid (`current_refs`) |

Cases 13 and 14 are not commit pairs; the runner stages them in a scratch worktree.

### 1.3 Definition of done

A card that touches selection or proof names the cases it turns green and may not turn any green
case red. The suite runs in the story gate (it is seconds) and in `verify-acceptance.sh`. When all
fourteen are green and the five mechanisms are deleted, the goal in issue #200 closes.

---

## 2. Inventory

Counts from `git ls-files | xargs wc -l` at `2e5477472`.

### 2.1 Stores (where proof lands today)

| Store | Path | Key | Rows / files now | Survives a new worktree? clone? Mac? |
|---|---|---|---|---|
| Exact-tree receipts | `<git-dir>/check-receipts/<key>.json` | sha256{version, step, argv, cwd, **whole index tree**, evidence identity} (`check-receipts.py:101-113`) | 15,643 in the develop checkout; 191 in the live worktree | no / no / no |
| Declared-gate receipts | `~/.xp/receipts/<key>.json` | sha256{gate-inputs identity (blobs, env value hashes, image digests, venv module bytes, xp-plugin version), step, argv} (`gate-inputs.py:255-279`) | 372 files, 14 MB | yes / yes / no |
| Timing and evidence ledger | `<git-common-dir>/land-timing.jsonl` | row: step, argv, tree, scope, outcome, seconds (+ commit, ancestor{leg,name}, evidence identities, platform, targets, release schema…); 12 distinct row shapes | 26,349 rows, 21 MB, read linearly on every lookup (`ancestor-receipts.py:57`) | yes / no / no |
| Super rows | `~/.xp/super-test/logs/<run>/rows.jsonl` | same rows | 4,932 rows in 29 runs | yes / yes / no |
| Whole-acceptance receipt | `~/.xp/data/<id>/acceptance-receipts/<sha>.json` | HEAD sha, only for a full 4-leg clean run | one reader (`m2b-capstone.py`) | — |
| Reference preflight | `<git-common-dir>/reference-preflight-receipts/` | its own blob/lock/image key (`preflight-receipt.ts`, 141 lines) | — | yes / no / no |
| Sprint land record | `~/.xp/data/<id>/sprints/<id>/land.json` | tested tree, `tested_by` free text | — | — |

### 2.2 Mechanisms

| Mechanism | Files (lines) | Keys on | Used by | Over-runs because | Under-runs because |
|---|---|---|---|---|---|
| Exact-tree receipts | `scripts/lib/check-receipts.py` (444), `receipt-inputs.py` (285) | whole index tree + evidence identity (37 env names, provider-key classes, `.env.docker` values minus 27 routing names, compose file hashes, **all refs** when `CHECK_RECEIPTS_REFS`) | story-gate, test-all, static gates, all-tier-legs, docker-tier, acceptance legs, acceptance segments, pre-meta | any commit anywhere kills every receipt; `git fetch` kills them (`current_refs`); every worktree starts cold; caller `--env` lists are parsed then ignored (`receipt-inputs.py:182-186`) | undeclared env (`POSTGRES_URL`, `STORAGE_*`) never enters the key |
| Declared-gate receipts | `gate-inputs.py` (371), `gate-inputs.json` (162), `gate-sandbox.sh` (5) | blobs of declared paths, env value hashes, pulled image digests (pulls at key time), venv module bytes, xp-plugin version | 6 declared of 18 listed private gates; `acceptance-segments` for `bash scripts/verify-X.sh` | 12 of 18 are `undeclared` and fall back to the whole tree; xp-plugin bump reruns all 6 | sandbox does not bar HOME, absolute paths, daemon state, network |
| Ancestor rows + diff selector | `ancestor-receipts.py` (179), `select-leg-gates.py` (339), `leg-selection.py` (254), `test-inputs.py` (431), `python-leg-inputs.json` (120) | newest ledger row per (leg, name) with matching identity, commit an ancestor of HEAD, then `select-leg-gates --base <commit>` must *defer* the gate | sprint and free-push Docker/Python legs (`SPRINT_MODE=1` only), native filter | diff base is `merge-base HEAD origin/develop` (`static-gates.sh:2`): every later push on a branch re-pays the branch's earliest backend change; one unstaged file = full; `RUNTIME_PROJECTS` makes nearly every shared gate read `apps/api`, `apps/worker`, `packages/`, `docker/`; a newer red for an unrelated reason vetoes a valid green; population parsed by regex five ways | `lefthook.yml` and `docs/milestones/*.md` are listed as worker-acceptance inputs; one unresolved import marks a whole test tree uncertain |
| Journey evidence | `journey-receipts.py` (288), `journey-inputs.py` (211), `native-journey-selection.sh` (61), `acceptance-selection.sh` (71) | native: `native:<runner>` row, platform, identity, commit ancestry, selector deferral, SMOKE_INPUTS veto; web: runner+spec+whole backend unchanged | native and web legs, dispatch `--journeys` | web reuse vetoed by any backend or `scripts/` commit while web *selection* is spec-only (asymmetric); smoke forced on any `packages/` change | native journey owns no `apps/mobile/src/**` unless the runner names it |
| Release closure | `journey-release-evidence.py` (187), `verify-release-journeys.py` (203), `release-roster.sh` (71) | 20 shared roots incl. `scripts/` and `apps/mobile/` + owned inputs + flow closure | release-beta (advisory), release-roster | almost every tag is "unproven" because `scripts/` is in the closure; remedy costs hours | — |
| Acceptance segments | `acceptance-segments.py` (220), `acceptance.sh` | three literal shapes keyed on whole tree | card Acceptance via land | any commit on the branch (version bump included) reruns a card's named pytest files; `cd … &&` chains uncached | — |
| Leg selection | `select-acceptance-legs.py` (305), `backmerge-selection.py` (196) | path rules + workspace graph | sprint hook, backmerge, push-scope | `scripts/e2e-*.sh` turns the native leg on even when zero journeys select (build + stack + smoke) | `apps/api/src/**` never adds a journey |
| Hand-maintained index | `tier-path-index.md` (258), `tier-execution-evidence.md` (118), `green-check-receipts.md` (79) | — | no script reads either `.md` index | drift | — |
| Not selection | `lane_run_select.py` (89: picks an EAS run), `test-ratchet.py` (109: test-line floors) | — | — | strike from the list | — |

Runner surface that embeds the above (2,140 lines): `test-all.sh` 238, `all-tier-legs.sh` 255,
`docker-tier-gates.sh` 80, `static-gates.sh`, `compose-gates-dispatch.sh` 105,
`e2e-native-dispatch.sh` 89, `story-gate.sh` 150, `super-test.sh` 311, `verify-acceptance.sh` 266,
`lib/acceptance-legs.sh` 167, `lefthook.yml` 117. Six environment switches gate lookup and publish
across the process tree: `RECEIPTS_FULL`, `RECEIPTS_REFUSED`, `RECEIPTS_NATIVE_SELECTION`,
`RECEIPTS_WEB_SELECTION`, `CHECK_RECEIPTS_BYPASS`, `SUPER_TEST`.

### 2.3 The test surface the model must cover

| Population | Count | Defined in |
|---|---|---|
| `scripts/verify-*.sh` | 159 | disk |
| …shared-stack roster | 63 (59 fan-out + m1a2 + m1a6 + db + site-deploy) | `all-tier-legs.sh:213,200,206,241`, `test-all.sh:205` |
| …private Docker tier | 21 (18 verify + 3 test) | `docker-tier-gates.sh` |
| …static roster | 38 (27 host, 6 compose-config, 3 container, 2 resource proofs) | `lib/static-gate-roster.sh` |
| …operator/card-only | 26 | `gate-fanout-exemptions.sh` |
| …pre-commit leaves and libraries | 14 | — |
| Gates that build an image | 16 | grep |
| Python stages | 5 | `all-tier-legs.sh` |
| Bun fast shards and DB tests | `run-fast-tests.py --all`, `fast-tests*.toml` | push-quality, story-gate |
| Cucumber features | 38 | CI |
| Native journeys (runners) | 70 iOS; Android via exceptions file | `scripts/e2e-native-journeys.sh` |
| Maestro flows (recursive includes) | 227 | `.maestro/` |
| Web journeys | 11 runners, 12 specs | `scripts/e2e-web-all.sh` |
| Web route audit | cells by route | `verify-web-routes.sh` |
| Super test | everything, 4×/week, bypass | `super-test.sh` |

Tracked files: 10,712. Tool versions on this Mac: Bun 1.4.4, uv 0.13.5, Python 3.15.2, arm64.

### 2.4 Measured cost (ledger, 2026-09-24 to 2026-10-29)

- Fresh execution: **300.8 hours** across 462 distinct steps; 23,472 green, 875 red, 313 incomplete,
  1,689 reused (6.4%). Reuses are concentrated in story-gate host checks (lint 92, drift 92,
  python-typecheck 91, db-check 91, typecheck 89, fast-tests 78) and one declared gate
  (data-restore 34).
- Top fresh consumers: `acceptance` 55.3 h (513 runs, 388 s), `fast-tests` 42.8 h (861 runs, 179 s),
  `docker` 36.9 h (117 runs, 1,137 s), `typecheck` 11.5 h (854 runs), `remainder` 9.3 h,
  `gate-drift` 7.4 h, `lint` 7.2 h, `shared-stack:m2c-pipeline` 6.2 h (492 s each),
  `python-typecheck` 4.9 h, `shared-stack:m2c-media` 4.1 h, `m2c-pipeline-sections` 3.7 h
  (222 s), `docker-tier:verify-data-restore-local.sh` 3.4 h, `worker-acceptance` 3.0 h (843 s),
  `web-audit` 2.8 h (1,431 s).
- **Exact repeats**: 2,571 fresh executions of a (step, argv, tree) triple already executed fresh,
  29.3 hours. By step: acceptance 5.0 h, docker 4.4 h, fast-tests 3.1 h, gate-drift 1.1 h. A
  content-keyed store eliminates this class outright; it is a floor on the waste, since it excludes
  reruns forced by unrelated commits.
- Per day: 8–19 h of fresh gate time on days with lands (2026-10-26: 19.3 h; 10-28: 16.7 h;
  10-29: 11.1 h in 1,604 rows).
- The 2026-10-29 push on `free-erasure-move-privacy-lock-deadlock` (tree `3a2098b524`, 08:52–09:07):
  102 rows, all green, 41.7 gate-minutes: 61 shared-stack, 19 static, 13 test-all, 7 private
  Docker; largest `m2c-pipeline-sections` 370 s, `m2c-media` 297 s, `m2c-pipeline-linking`
  251 s, `m2c-pipeline-summary` 187 s, `m2b7-sections` 145 s. The diff from the previous
  green commit on that branch: `scripts/verify-metrics-role.sh` and `CHANGELOG.md`. 76 of the rows
  carry `ancestor` fields, so the proof existed; the selector diffed against the merge-base with
  develop, where the branch had changed `packages/db`.
- PR #1514's push (tree `2652501d3f`, 11:13–15:37): 113 rows, 0 reused, 72.7 gate-minutes
  (worker-acceptance 913 s, docker 1,027 s).
- Story gate: ~42 rows and 7.5–10 min per run; 10 runs on 2026-10-29 (2.75 h of story-scope fresh
  time that day). Every story worktree starts with an empty `check-receipts/`.
- Same (step, tree) both red and green: 161 pairs (acceptance 35, fast-tests 27). These are flakes
  or fixes landed without a tree change; the ledger cannot tell which.

---

## 3. Root-cause analysis

### 3.1 Technical

1. **Three keys for one question.** "Has this task been proven for these inputs?" is answered by
   the whole index tree (exact receipts), by a declared blob set (6 gates), and by commit ancestry
   plus a re-run of the path selector (ancestor rows). The first is invalidated by any commit; the
   third costs a `select-leg-gates.py --base <commit>` subprocess per candidate commit at lookup
   time and depends on the selector's ownership map being right in both directions. Only the second
   is the right shape, and it covers 6 of ~400 tasks.
2. **Selection needs a base; the base is wrong.** A diff selector must pick what to diff against.
   `static-gates.sh:2` picks the merge-base with `origin/develop`. A branch's second push re-pays
   everything its first push proved. The ancestor mechanism was added to fix exactly this and is
   gated to `SPRINT_MODE=1`, needs the newest row per key to be green, and needs the selector to
   *defer* the gate from that commit. A content key has no base: compare the key, not the history.
3. **Storage is local three ways.** Per git-dir (every story worktree cold), per clone (the ledger
   is in the common dir of one clone), per Mac (`~/.xp`). A new Mac re-proves everything. The
   Intel Mac and the M3 never share.
4. **Identity is global and over-broad.** `receipt-inputs.py` ignores every caller's `--env` list
   and instead hashes 37 fixed names, every `.env.docker` value, every compose file, and (when
   `CHECK_RECEIPTS_REFS` is set, which test-all and verify-acceptance always set) `git show-ref
   --head`: every branch and tag in the repo. A fetch invalidates every exact receipt.
5. **Ownership disagrees with itself.** Web selection is spec-only while web reuse is vetoed by any
   backend commit; native selection is runner-literal while the release closure names
   `apps/mobile/` and `scripts/`; `python-leg-inputs.json` lists `lefthook.yml` and milestone docs
   as worker-acceptance inputs. The population of gates is parsed by regex in five places.
6. **Dirty tree = full.** One unstaged or untracked file makes every leg "full" and forbids all
   publication (`leg-selection.py:213`). Content hashing of the working copy makes a dirty tree an
   ordinary input state.
7. **Fail-safe was implemented as "run everything" at every uncertainty**, and uncertainty was
   common (unresolved imports, refs moved, a newer red for another reason, narrowed runs, six env
   switches). Each is individually right under constraint 8; together they make reuse rare.

### 3.2 Process

Issue #200 names it: no role saw the concern's history, each card's Acceptance proved its own
mechanism ("this gate reuses its receipt"), nothing asserted the requirement ("a CHANGELOG-only
commit re-runs nothing"), and no card named what it deleted, so the cheapest local move was always a
new mechanism. Free patches skipped slate review, the only review that looks above a card. The
result is `green-check-receipts.md`: 79 lines that cannot be explained simply because they describe
five systems and their exceptions.

The structural fix is the one this document is for: a requirement suite that is red until the
requirement is met, and a model with one key, one store and one lookup, with deletion written into
every migration step.

---

## 4. The model

### 4.1 Vocabulary

- **Task**: one command whose outcome is green or red, with a stable id (`verify-metrics-role`,
  `native:your-page`, `bun:db`, `pytest:worker-unit`).
- **Input**: something whose change can change the outcome: a tracked file (by blob), a projection
  of a file (`package.json#dependencies`), an environment variable (by value hash), a computed set
  (an import closure), a provider resource identity (the stack's inputs).
- **Environment class**: the facts about the host that the declaration says matter (architecture,
  Xcode, iOS runtime, Playwright browsers, Docker engine…). Coarse by design.
- **Key**: `sha256(task id ‖ declaration hash ‖ inputs hash ‖ environment class hash)`.
- **Proof**: a stored green for a key. **Result**: any stored run (green, red, incomplete) with
  seconds, host, commit, mode.
- **Set**: a named group of tasks a lifecycle boundary runs (`commit`, `push`, `story`, `land`,
  `super`, `release`).
- **Provider**: a resource a task needs that is not itself cached (`stack`, `ios-build`,
  `ios-lane`, `web-export`). A provider is started only if a task that needs it must run.

### 4.2 Declaration format: `proof.yaml`

One file at the repo root; `include:` may pull `proof.d/*.yaml` so apps own their own tasks. YAML
because Bun parses it natively and it reads well in review; JSON is accepted. Example with one of
each kind of task in app-a:

```yaml
version: 1
store: ${PROOF_STORE:-postgres://proof@mini.tailnet.ts.net:5432/proof}
project: app-a

env_classes:            # dimensions, resolved once per invocation by the CLI
  static: []            # pure text checks: identical everywhere
  host:   [arch, bun, python, uv]
  docker: [arch, docker-engine]
  ios:    [arch, xcode, ios-runtime]
  web:    [arch, playwright, chromium, firefox, webkit]

inputs:                 # named sets; a task references them as $name
  harness: [scripts/lib/**, scripts/gate-sentinel.sh, scripts/checkout-id.sh, scripts/verify-common.sh]
  deps:
    - {path: package.json, json: [dependencies, devDependencies, workspaces, patchedDependencies, packageManager]}
    - bun.lock
    - patches/**
    - "apps/*/uv.lock"
    - "apps/*/pyproject.toml"
    - packages/py-common/uv.lock
  stack:                # what the shared compose stack is built from
    - $deps
    - apps/api/**
    - apps/worker/**
    - apps/generator/**
    - packages/**
    - docker/**
    - docker-compose*.yml
    - scripts/docker-compose.test-all.yml
    - {path: .env.docker.example, dotenv-keys: true}     # key names, not values
    - "!**/*.test.ts"
    - "!**/__tests__/**"
    - "!apps/*/tests/**"
    - "!**/*.md"
  mobile-build:
    - $deps
    - apps/mobile/**
    - "!apps/mobile/e2e/**"
    - "!apps/mobile/**/*.test.*"
    - packages/**
    - "!packages/**/*.test.ts"

providers:
  stack:      {start: bash scripts/lib/stack-up.sh,   stop: bash scripts/lib/stack-down.sh, inputs: [$stack], lanes: 6}
  ios-build:  {start: bash apps/mobile/scripts/build-embedded.sh, inputs: [$mobile-build], lanes: 2}
  web-export: {start: bash apps/mobile/scripts/web-export.sh, inputs: [$mobile-build]}

lanes: {host: 6, private-docker: 3, ios: 2, web: 2}

tasks:
  # a private Docker gate: fully sandboxed, like the 6 declared gates today
  verify-metrics-role:
    run: bash scripts/verify-metrics-role.sh
    inputs: [scripts/verify-metrics-role.sh, $harness, docker/postgres/**, packages/db/drizzle/**]
    env: [RESTORE_SKIP_FRESHNESS]
    class: docker
    sandbox: full
    lane: private-docker
    sets: [push, land, super]

  # a shared-stack gate: script side sandboxed, stack side by provider identity
  verify-m2c-media:
    run: bash scripts/verify-m2c-media.sh
    inputs: [scripts/verify-m2c-media.sh, $harness, apps/worker/tests/acceptance/media/**, scripts/fixtures/media/**]
    needs: [stack]
    class: docker
    sandbox: script
    sets: [land, super]

  # a static text gate
  verify-firewall-parity:
    run: bash scripts/verify-firewall-parity.sh
    inputs: [scripts/verify-firewall-parity.sh, $harness, infra/deploy/**/firewall*.tf, infra/deploy/*/docker-compose.yml]
    class: static
    sandbox: full
    sets: [story, land, super]

  # Bun unit tests for one package (DB tests need the test Postgres: a provider)
  bun:db:
    run: bash scripts/run-fast-bun.sh packages/db
    inputs: [packages/db/**, $deps, bunfig.toml, tsconfig.base.json, scripts/run-fast-bun.sh, scripts/fast-tests-db.toml]
    needs: [test-db]
    class: host
    sandbox: full
    links: [node_modules]          # symlinked into the sandbox; identity enters via $deps
    sets: [push, story, land, super]

  # pytest for a Python project
  pytest:worker-unit:
    run: uv run --frozen --directory apps/worker pytest tests -m "not compose_stack and not acceptance" -q
    inputs: [apps/worker/src/**, apps/worker/tests/**, "!apps/worker/tests/acceptance/**", apps/worker/pyproject.toml, apps/worker/uv.lock, packages/py-common/**]
    class: host
    sandbox: full
    links: [apps/worker/.venv, packages/py-common/.venv]
    sets: [push, story, land, super]

  # lint and typecheck: whole-repo tasks keyed on the files they read
  typecheck:
    run: bun run typecheck
    inputs: ["**/*.ts", "**/*.tsx", "**/tsconfig*.json", $deps, "!**/node_modules/**"]
    class: host
    sets: [push, story, land, super]

  # an image build whose digest other tasks could depend on
  image:worker:
    run: docker build -f apps/worker/Dockerfile apps/worker
    inputs: [apps/worker/Dockerfile, apps/worker/**, packages/py-common/**, .dockerignore]
    class: docker
    sets: [land, super]

  # a Maestro journey: flows by recursive include, app by the build set, backend by the stack set
  native:your-page:
    run: bash apps/mobile/scripts/e2e-your-page.sh
    inputs:
      - apps/mobile/scripts/e2e-your-page.sh
      - apps/mobile/scripts/lib/**
      - {maestro: .maestro/your-page.yml}           # runFlow/runScript/addMedia closure
      - {imports-of: apps/mobile/app/(tabs)/your-page.tsx}   # TS import closure (adapter)
      - $stack
      - apps/api/e2e-fixtures/**
    needs: [stack, ios-build]
    class: ios
    lane: ios
    sets: [land, super, release]
    flaky-budget: 1       # informational: proof flakes ranks tasks above budget

  # a Playwright journey
  web:landing:
    run: bash apps/mobile/scripts/e2e-landing-web.sh
    inputs: [apps/mobile/scripts/e2e-landing-web.sh, apps/mobile/e2e/landing.e2e.ts, apps/mobile/e2e/support/**, {imports-of: apps/mobile/app/landing.tsx}, $stack]
    needs: [stack, web-export]
    class: web
    env: [E2E_WEB_PROJECTS]
    sets: [land, super, release]

  # Cucumber
  cucumber:api:
    run: bun run --cwd apps/api cucumber
    inputs: [apps/api/features/**, apps/api/src/**, $deps]
    needs: [test-db]
    class: host
    sets: [land, super]

exempt:                 # scripts that are not tasks, with the reason (proof lint enforces coverage)
  scripts/verify-archival-media-resources.sh: operator-only, 7.9 min, 4 GiB upload
  scripts/verify-common.sh: sourced library
```

Rules the CLI enforces at `proof lint` (runs in pre-commit, milliseconds):

- every `scripts/verify-*.sh`, `scripts/test-*.sh`, `apps/mobile/scripts/e2e-*.sh`, `apps/*/tests`
  directory and workspace package is either a task's `run`/`inputs` or in `exempt:` with a reason
  (replaces `verify-gate-drift.sh`'s ownership census);
- every glob matches at least one tracked file; a `maestro:` or `imports-of:` entry resolves;
- a sandboxed task's `run` script is inside its own inputs; a `needs: [stack]` task includes `$stack`
  (the CLI adds it implicitly, the lint only reports a declaration that excludes it);
- an `env:` name that is never read by the task's script tree is a warning (grep), a read name
  that is not declared is an error for `sandbox: full` tasks (the sandbox clears the environment
  to PATH, HOME, TMPDIR and declared names, so the task would fail anyway).

Input kinds: `glob` (gitignore semantics, `!` negation), `{path, json: [keys]}` (hash of the named
JSON members only: `package.json#version` never enters a key), `{path, dotenv-keys: true}` (sorted
key names), `{maestro: flow}` (recursive `runFlow`, `runScript`, `addMedia` closure), `{imports-of:
entry}` (adapter: TS import closure from an entry through workspace packages, the mechanism
`web-audit-route-selection` already built for the route audit), `$name` (named set), `env` (declared
separately). No command-output inputs: Nx has `runtime: node --version`, and it is the door through
which non-determinism enters a key; tool versions enter only through the environment class.

### 4.3 Environment classes

Resolved once per invocation and printed by `proof doctor`:

| Dimension | Source | Belongs to |
|---|---|---|
| `os`, `arch` | `uname -sm` | host, docker, ios, web |
| `bun` | `bun --version` | host |
| `python`, `uv` | `uv run python --version`, `uv --version` | host |
| `docker-engine` | `docker version --format '{{.Server.Version}}'` | docker |
| `xcode`, `ios-runtime` | `xcodebuild -version`, the runtime the runner selects | ios |
| `playwright`, browsers | `bunx playwright --version`, installed browser versions | web |

The class hash is the sorted dimension values. A task's class is coarse on purpose: a new Mac with
the same Xcode is the same class; an Xcode update re-proves `ios` tasks only. Whether `arch`
belongs in `host` (Bun unit tests on x64 versus arm64) is open question 7.2; the declaration can
drop it per class.

### 4.4 Key scheme

```
decl_hash   = sha256(canonical JSON of the task's declaration, named sets expanded)
inputs_hash = sha256 over sorted lines:
                "<path>\0<blob sha>"            for every tracked file a glob matches (index blob; a
                                                 working-copy edit is re-hashed with git hash-object)
                "<path>\0untracked\0<blob sha>" for an untracked file a glob matches (warned)
                "<path>#<key>\0<sha256 of the member>" for a json projection
                "<path>\0keys\0<sha256 of sorted key names>" for dotenv-keys
                "env\0<NAME>\0<sha256 of value>|absent"   for each declared env name
                "<provider>\0<inputs_hash of the provider>"  for each needs:
class_hash  = sha256(sorted dimension=value)
key         = sha256(task_id ‖ decl_hash ‖ inputs_hash ‖ class_hash)
```

Docker images enter the key through files: every `FROM`, compose `image:` and `pulled_images`
reference in this repo is digest-pinned (`verify-image-digests.sh` keeps it so), so the pinned
reference is content in a declared file. A built image is the hash of its Dockerfile and build
context (declared as a task or provider input). No pull at key time, no daemon inspection: the
current `gate-inputs.py` pulls missing images while computing identity, which is a network call
inside a lookup.

Keys for a *past* commit are computable without a checkout (`git ls-tree -r <ref>` gives blobs),
which is what release freshness uses. Env values are then taken from the current environment, which
is right: the question is "is the tag proven for this environment".

Cost: `git ls-files -s` for 10,712 files plus glob matching is tens of milliseconds in Bun; a
`git status --porcelain` and a few `hash-object` calls for dirty paths; one `SELECT` per task
batched as one round-trip. `proof plan` for 400 tasks should finish in under a second on the
tailnet; the current ancestor lookup reads a 21 MB ledger per candidate.

### 4.5 Store schema (Postgres; SQLite for local-only mode has the same tables)

```sql
create table results (
  id          bigserial primary key,
  project     text not null,            -- 'app-a', 'app-b'
  task        text not null,
  key         char(64) not null,
  outcome     text not null check (outcome in ('green','red','incomplete')),
  mode        text not null check (mode in ('ordinary','alone','super','release')),
  seconds     real not null,
  host        text not null,            -- hostname; no paths
  env_class   jsonb not null,           -- {arch:'arm64', xcode:'26.1', ...}
  commit      char(40),                 -- HEAD at run time, null when detached scratch
  branch      text,
  dirty       boolean not null,
  trigger     text not null,            -- push|story|land|super|release|manual
  run_id      uuid not null,
  started_at  timestamptz not null,
  finished_at timestamptz not null
);
create index on results (project, task, key, finished_at desc);

create table proofs (                   -- the lookup table: one green per key
  project text not null, task text not null, key char(64) not null,
  result_id bigint not null references results(id),
  primary key (project, task, key)
);

create table contradictions (           -- a red where a proof existed, or a super red against a green
  id bigserial primary key,
  project text not null, task text not null, key char(64) not null,
  green_result bigint not null references results(id),
  red_result   bigint not null references results(id),
  kind text not null check (kind in ('ordinary','super')),
  deleted_proof boolean not null,
  recorded_at timestamptz not null default now()
);

create table runs (
  run_id uuid primary key, project text not null, host text not null, trigger text not null,
  set_name text, commit char(40), started_at timestamptz not null, finished_at timestamptz,
  planned int, ran int, proven int, undecidable int
);
```

What is never stored: logs, stdout, argv beyond the declared `run` string (already in the repo),
env values (only hashes), absolute paths, story text. `results.seconds` replaces
`land-timing.jsonl`; `contradictions` replaces super-test contradiction reports; `runs` replaces
the per-run summaries; `proofs` replaces three receipt directories and the ancestor rows.

Write policy: any host on the tailnet with the role may insert; `proofs` is upserted by the
transaction that inserts a green result, so first-writer and last-writer agree (same key, same
meaning). A super-mode red deletes the `proofs` row in the same transaction and records a
`contradictions` row with `deleted_proof = true`. An ordinary red against an existing proof records
`deleted_proof = false` and leaves the proof (section 4.8). Retention: results older than 180 days
are pruned nightly except the one each `proofs` row references.

### 4.6 CLI

```
proof plan   [--set land | --tasks a b c] [--json]     RUN / PROVEN / UNDECIDABLE per task, with why
proof run    [--set land | --tasks …] [--fresh] [--alone] [--jobs N]
                                                     plan, start needed providers, execute RUN tasks
                                                     under lane limits, record every result, print
                                                     the summary; exit nonzero on any red or undecidable
proof why    <task>                                  the key's components and the input lines that
                                                     differ from the newest proof for this task
proof status --set release --ref v0.150.0             keys at the ref's tree; lists unproven tasks
proof record <task> --outcome green --seconds 93 …   for runners that execute outside proof run
proof invalidate --task <t> [--key k | --all]        delete proofs (operator; recorded as contradiction kind 'manual')
proof flakes [--since 30d]                           tasks ranked by ordinary contradictions
proof stats  [--set land]                            median seconds per task; estimated minutes for a plan
proof check  scripts/proof-cases.yaml                the requirement suite
proof lint                                           declaration coverage and validity
proof doctor                                         store reachability, env class, sandbox tools
```

Reasons `proof plan` prints, one per task: `proven at <commit> on <host> <when>`,
`changed: <n> inputs (first: packages/db/src/queries/record-entity.ts)`, `no proof for key`,
`env class differs (xcode 26.0 → 26.1)`, `declaration changed`, `store unreachable: running`,
`undecidable: glob matches no file` (and the run refuses to skip it).

### 4.7 Enforcement

| `sandbox:` | Applies to | What the CLI does | What it cannot catch |
|---|---|---|---|
| `full` | private Docker gates, static gates, unit tests, pytest, image builds | `git checkout-index` of the declared blobs into a gitless temp dir, dirty paths copied from the working tree, `links:` symlinked, environment cleared to PATH/HOME/TMPDIR plus declared names, `cwd` = the temp dir. The same as `gate-sandbox.sh` today, extended from 6 to ~230 tasks. | reads of `$HOME`, absolute paths, the Docker daemon's image cache, network |
| `script` | shared-stack gates | the gate's script side (its own script, `$harness`, fixtures) is checked out into the temp dir; the stack is reached through the provider's ports in the environment. An undeclared helper or fixture read fails with "no such file", which is the honest signal. | what the running stack reads: covered by `$stack` being coarse and by the super backstop |
| `none` | native and web journeys, providers | run in the checkout (Metro, Xcode, Playwright need it) | everything; covered by coarse inputs, `imports-of`, and super |

macOS `sandbox-exec` deny-read profiles were considered and rejected: deprecated, undocumented
profile language, and the Docker CLI and Xcode need broad reads. `fs_usage` needs root. Linux CI
can add an strace audit later (mise does this); it is not on the path.

The super test is the enforcement of last resort and the only enforcement for `none`: it runs every
task with `--fresh` four times a week; a red whose key has a proof deletes it everywhere and records
the contradiction. `proof flakes` and the contradiction table name the tasks whose declarations
need widening. A task with two super contradictions in 30 days is reported by `proof lint` until
its declaration changes.

### 4.8 Flakes

Paul's rule: a flaky test is re-run alone; never serialise a tier; a green at an unaffected
ancestor is already the rerun. In store terms:

- An ordinary red for key K where `proofs(K)` exists: the current run is red (the push or land
  fails), the result is recorded, a `contradictions` row (`kind = ordinary`, `deleted_proof =
  false`) is written, and the proof stays. The next plan says PROVEN: the earlier green is the
  rerun. Nothing retries automatically.
- `proof run --alone <task>`: executes regardless of proof; a green updates `proofs(K)` to the new
  result; a second red is a second contradiction.
- A super red for K deletes `proofs(K)` (rule 3) and the task runs at the next ordinary plan.
- `proof flakes` ranks tasks by ordinary contradictions per run in a window; `flaky-budget` in the
  declaration is a threshold for the lint warning. Replaces the 161 unexplained red/green pairs the
  ledger holds today.

The trade-off is named in open question 7.3: keeping the proof on an ordinary red can mask an
undeclared input until the next super run (at most three days). Deleting it instead costs one
rerun per flake. The default follows Paul's stated rule.

### 4.9 Providers and lanes

A provider is started once per `proof run` if and only if at least one RUN task needs it, after the
plan is printed. This is the single largest structural saving after keys: today the shared stack is
built whenever any shared gate is selected and the native leg provisions a device whenever
`scripts/e2e-*.sh` changes, even when every journey is reused. Lanes bound concurrency per resource
(`stack: 6` matches `XP_GATE_JOBS=6`; `ios: 2` matches `APP_A_E2E_LANES=2`). A provider's own
inputs hash is part of every dependent task's key, so "stack changed" and "gate script changed" are
the same kind of fact.

Serial constraints that exist today (m1a2 and m1a6 alone, the isolated private group) become
`lane: solo` on those tasks.

### 4.10 How each boundary uses it

| Boundary | Today | With proof |
|---|---|---|
| pre-commit | lefthook leaves (seconds) | unchanged, plus `proof lint` |
| push-quality | lint, typecheck, `run-fast-tests.py --all` unconditionally; free branches add `test-all.sh --free-push` | `proof run --set push` (lint, typecheck, Bun shards, pytest units, private and static gates, shared-stack gates). CHANGELOG-only: zero tasks, no stack |
| story-gate | 42 host rows every run, cold per worktree | `proof run --set story`; the first story commit after a backmerge pays once per content, every worktree shares |
| card Acceptance (land.py `sh -c`) | `acceptance.sh` segments, three cached shapes | the Acceptance line is `proof run --tasks "pytest:worker-unit verify-m2c-media native:your-page"`. The plugin is unchanged; `--tested-by` stays |
| sprint land | select legs → verify-acceptance → legs | `proof run --set land` |
| backmerge | backmerge-selection.py | a merge is a tree; `proof run --set land` on it |
| super | bypass, rows.jsonl, classify | `proof run --set super --fresh --mode super`; contradictions in the store |
| release | verify-release-journeys.py, release-roster.sh | `proof status --set release --ref vX.Y.Z` then `proof run --set release --ref vX.Y.Z` in the disposable worktree runs only unproven ones |
| timings | land-timing.jsonl, stage marks | `proof stats`; the plan prints estimated minutes |

### 4.11 Concurrency across clones and hosts

Keys are content-derived, so two clones at the same content share proof without coordination.
Inserts are append-only; `proofs` upsert is idempotent. Two hosts running the same key at once both
run (Paul: no one waits on another clone); the plan prints `running on <host> since <t>` from the
`runs` table as information only. Lane locks stay per host (the simulator and the compose project
names are host resources). A store outage during a run loses that run's rows: fine, it is a cache.

Offline results: `proof run` writes each result to a local spool (`~/.proof/spool.sqlite`) and
flushes it to the store when reachable, so a run done while the mini is off is not lost. The spool
is never read by `plan`.

### 4.12 Security

- The store binds to the Tailscale interface of its host (`listen_addresses = '100.x.y.z'`),
  `pg_hba.conf` allows `100.64.0.0/10` with scram-sha-256, one role `proof` with INSERT/SELECT on
  `results`, `runs`, `contradictions` and INSERT/UPDATE/DELETE on `proofs`. WireGuard carries it;
  TLS is optional.
- Connection string in `~/.config/proof/store` (0600) or `PROOF_STORE`; never in the repo.
- Content: task ids, hashes, outcomes, seconds, hostnames, commit shas, branch names, tool
  versions. No env values, no logs, no paths outside the repo, no story text.
- A compromised tailnet node could insert false greens; the super test's fresh run is the detector,
  and `results.host` names the writer. The threat is accepted for a one-person tailnet; a signing
  key per host (Turborepo's `x-artifact-tag` HMAC) is the upgrade if the store is ever shared wider.
- Backup: nightly `pg_dump` to the host's disk; losing the store costs one super run.

### 4.13 Package boundary

- Package `proof` (TypeScript, Bun; scoped on npm, MIT). Core: declaration parser and lint, glob
  and projection hashing over the git index, environment class resolution, key, store client
  (Postgres via `Bun.sql`, SQLite via `bun:sqlite`), spool, planner, executor with sandboxes, lanes
  and providers, `why`, `status`, `check`, `flakes`, `stats`, `doctor`. Zero runtime dependencies.
- Adapters shipped with the core because both repos need them: `maestro` closure, `imports-of`
  (TS/TSX import walk honouring tsconfig paths and workspace packages), `dotenv-keys`, `json`
  projection. An adapter is a function from a declaration entry to input lines; a repo can add one
  under `proof.d/adapters/*.ts`.
- Stays in app-a: `proof.yaml` and `proof.d/*.yaml`, provider scripts (`stack-up.sh` is today's
  `shared_stack_setup`), the case file, `verify-proof-selection.sh`, lefthook wiring, the
  super-test and release wrappers, the Python-environment class resolver if uv is absent on a
  host.
- app-b: `proof.yaml` with ~12 tasks (five Bun test lanes, pytest unit and acceptance,
  Playwright, Maestro, lint, typecheck) and a `test-db` provider from its compose file; its
  `.githooks/sprint` becomes `proof run --set sprint`.

---

## 5. Build versus adopt

Measured against: R1 an arbitrary shell task against external state (stack, simulator) with no
output files, cached by declared inputs; R2 repo-wide globs, env, image and tool identity as inputs;
R3 Bun and Python without plugins; R4 a free self-hosted store on a Mac over Tailscale that keeps
history; R5 enforced declarations; R6 "why did X run"; R7 migration cost for 159 gates and three
test frameworks; R8 architecture collisions, revoking a wrong green, concurrent clones. Doc dates
are 2025–2026 unless noted.

| | R1 shell vs external state | R2 inputs | R3 Bun+Python | R4 store | R5 enforce | R6 why | R7 migration | R8 |
|---|---|---|---|---|---|---|---|---|
| **Turborepo 2.9** | yes; logs always cached; assumes determinism | `$TURBO_ROOT$` globs, `env`; OS/arch and tool versions only via a key file you write | shim `package.json` per Python dir | 6-endpoint HTTP spec (hash GET/PUT, status, events with HIT/MISS, `x-artifact-duration/-sha/-dirty-hash` headers); ducktors server or DIY; free; blobs plus those headers | trust (+ strict env) | `--dry=json`, `--summarize`, `turbo query affected` | scripts + `turbo.json` + shims + a server | no OS/arch in key; revoke = `--force` or server 404; no flake notion |
| **Nx 24** | yes (`run-commands`) | richest: `{workspaceRoot}` globs, `env`, `runtime: <command>`, `externalDependencies`, named inputs | `project.json`, no plugin | custom runners removed in 21; Nx Cloud (free tier) or `@nx/*-cache` (free, activation key) or a 2-endpoint PUT/GET spec (Nx ≥ 20.8) with 409 on overwrite; blobs only | trust; Ultracache (Cloud, 2026-10-22) observes reads, Cloud-only | `nx affected --explain` (24: task-based) | `project.json` per project, `nx.json` inputs, a server; Nx's graph, daemon and release churn (21→24 in 17 months) | no OS by default; immutable keys; flake retries Cloud-only |
| **Moon 2.6** | yes; outputs optional; hit semantics for output-less tasks undocumented | `/` globs, `$VAR`, `cacheKey`; toolchain versions | yes | Bazel REAPI via bazel-remote; moonbase shut 2025-03; TLS "very unstable"; blobs only | trust | `moon hash` diff, `query affected` | `moon.yml` per project + bazel-remote | OS not documented in hash; `cacheLifetime` |
| **mise 2026.7** | yes; `outputs=[]` caches result+log; experimental | globs, `cache.env`, `command_inputs`, tools, OS+arch | yes | HTTPS v1 to `mbx-cache` (unreleased); **writes only from protected-branch CI runs** | trust; strace audit on Linux only | `--dry-run`, `--task-cache-explain` | `mise.toml` tasks | the write rule blocks a Mac-fed store |
| **Pants 2.33** | in-sandbox only: `test_shell_command` with every file declared; workspace env caches per session | targets anywhere; env in key | Python first-class; JS experimental, no Bun | REAPI; blobs | FS sandbox | `--changed-since`; no cache dry-run | BUILD files everywhere; Bun unsupported | platform in key; `--force` |
| **Bazel 8/9** | `tags=["local","external"]` = never cached, by design | labels; `--action_env` | heavy rules; no Bun rules | REAPI (bazel-remote); history needs BuildBuddy | strongest (`darwin-sandbox`) | `--explain` | rewrite | platform in key; no delete RPC |
| **Buck2** | undocumented; needs an RE server to cache at all | labels | no JS prelude | REAPI required | RE-side | `log what-ran` post hoc | rewrite | — |
| Earthly | ended 2025-04 | | | | | | | |
| Dagger | containers only; no simulators | | | | | | | |
| Taskfile, Gradle, sccache, Lage, Rush, Vitest/Jest/Playwright `--changed`, Nix | local checksums or compiler/package caches; no proof store for external-state tests | | | | | | | |

### 5.1 Reading

- The tools that happily cache arbitrary shell (Turborepo, Nx, Moon, mise) all **trust** the
  declaration, and their wire protocols store blobs with little or no metadata. Turborepo's spec is
  the richest (duration, sha, dirty hash, HIT/MISS events); Nx's is two endpoints. Either way the
  server on the Mac is yours to write, and the history (timings, flakes, contradictions, release
  freshness) is out of band.
- The tools that **enforce** (Bazel, Pants, Nix) do so with sandboxes that make a compose-stack or
  simulator task uncacheable or session-scoped. That is the right call for hermetic builds and the
  wrong one here.
- Nothing has a notion of environment class beyond platform, a contradiction record, a flake
  policy, or "why" that names the changed input across machines.
- mise is the nearest fit (OS+arch, `command_inputs`, `--task-cache-explain`, Postgres metadata in
  its reference server) and is ruled out by one hard-coded line: only protected-branch CI may
  write. It is experimental and could change; worth re-reading in six months.
- Turborepo would fit app-b's shape (Bun workspaces) and could fit app-a with shim packages,
  at the cost of: no environment class without a key file, no enforcement, no contradiction or
  flake history, cache semantics designed for outputs ("hit = restore outputs" means a cached
  `stack-up` would be skipped, so providers cannot be tasks), and a custom server anyway.

### 5.2 Recommendation

Build `proof` (section 4.13). The custom part of any adoption is the store, the key with an
environment class, the lookup with reasons, and the enforcement; the runner on top is ~thin.
Copy Nx's input grammar (`{workspaceRoot}` globs, named inputs) and Turborepo's wire shape if a
HTTP layer is ever wanted in front of Postgres. Size: the core is on the order of 2,500 lines of
TypeScript plus adapters; app-a's `proof.yaml` is on the order of 1,500 lines of declarations
for ~400 tasks, generated once from today's selectors and then reviewed. That replaces 5,954 lines
of selection and receipt code, most of the 2,140-line runner surface, and three stores.

Why TypeScript on Bun and not Python: both repos run Bun (app-a 1.4.4 on this host and in its images; app-b pins `bun@1.4.2`); Bun
ships SQLite, Postgres, glob, SHA-256 and YAML/TOML parsing with no dependencies, so the CLI is one
`bunx proof` from bash, lefthook, Python or the xp-plugin; Python would need `psycopg` and a YAML
parser installed per host, and app-a's existing Python harness only ever shells out. The
`imports-of` adapter is naturally TypeScript.

---

## 6. Migration plan for app-a

Each step is one card or free patch, releasable alone, and names what it deletes. The requirement
suite's case numbers refer to section 1.2.

| Step | Card | Builds | Deletes | Cases green after |
|---|---|---|---|---|
| 1 | `proof-requirement-suite` | `scripts/proof-cases.yaml` (14 cases), `scripts/verify-proof-selection.sh` (asks today's selectors; red), the goal record for issue #200 | `scripts/tier-path-index.md`, `scripts/tier-execution-evidence.md` (no reader), `lane_run_select.py` is renamed out of the selection family | none (suite is red; that is the point) |
| 2 | `proof-core` (in the new repo) + `proof-private-gates` (app-a) | package v0.1: declarations, lint, key, SQLite store, `plan/run/why/check/doctor`, `sandbox: full`; app-a declares the 21 private and 38 static gates and runs them through `proof run` from `docker-tier-gates.sh` and `static-gates.sh` | `gate-inputs.py`, `gate-inputs.json`, `gate-sandbox.sh`, `~/.xp/receipts`, the 12 `undeclared` entries (every private gate is declared or exempt) | 2, 11; 1 and 8 for the static and private populations |
| 3 | `proof-store` | Postgres on the M3 Mac (Homebrew, launchd, Tailscale bind), role, schema, `PROOF_STORE`, spool, `proof doctor`; CLAUDE.md "new Mac" paragraph | `<git-dir>/check-receipts/` (15,643 files here), `CHECK_RECEIPTS_DIR`, `GATE_RECEIPTS_DIR` | 14 (refs no longer in identity) |
| 4 | `proof-host-and-stack` | `$deps`, `$stack`, `$harness`; Bun shards, pytest stages, lint, typecheck, shared-stack gates and the `stack` provider declared; push-quality and story-gate become `proof run --set push/story`; `test-all.sh --free-push` and the sprint Docker leg become `proof run --set land --lane …`; providers start lazily | `check-receipts.py`, `receipt-inputs.py`, `ancestor-receipts.py`, `select-leg-gates.py` (Docker and Python parts), `leg-selection.py`, `test-inputs.py`, `python-leg-inputs.json`, `static-gates.sh` selection, the six `RECEIPTS_*`/`CHECK_RECEIPTS_*` switches, `stage-timing.sh`, `run-fast-tests.py --all`'s unconditional run | 1, 3, 4, 7, 9, 10, 13 |
| 5 | `proof-journeys` | `maestro:` and `imports-of:` adapters; 70 native, 11 web, web-audit cells declared with `ios-build`/`web-export` providers and lanes; `e2e-native-dispatch.sh --journeys` and the web runners call `proof run` | `journey-receipts.py`, `journey-inputs.py`, `native-journey-selection.sh`, `acceptance-selection.sh`, `select-acceptance-legs.py`, `backmerge-selection.py`, `SMOKE_INPUTS`, `NATIVE_RECEIPT_ROWS`/`WEB_RECEIPT_ROWS`, `journey-receipt-locks/` | 5, 6, 12 |
| 6 | `proof-acceptance` | card Acceptance lines are `proof run --tasks …`; `scripts/acceptance.sh` becomes a one-line wrapper; `.xp/system.md` and `scripts/acceptance.md` rewritten to one paragraph | `acceptance-segments.py`, `acceptance-dependencies.py`, the whole-acceptance receipt directory, `m2b-capstone.py`'s receipt read | all remain green; land wall clock measured |
| 7 | `proof-super-and-release` | `super-test.sh` runs `proof run --set super --fresh --mode super`; `release-beta.sh` and `release-roster.sh` use `proof status/run --set release --ref`; `proof stats` replaces the timing ledger in `tiers.md` | `journey-release-evidence.py`, `verify-release-journeys.py`, `super-test-classify.py`'s reuse logic, `land-timing.jsonl`, `~/.xp/super-test/logs/*/rows.jsonl`, `land-timing-ledger.json`, `green-check-receipts.md`, the receipts paragraphs of `tiers.md` and CLAUDE.md | suite stays green; issue #200 goal closes |
| 8 | `proof-app-b` | `proof.yaml` for app-b (12 tasks, `test-db` provider), `.githooks/sprint` → `proof run --set sprint`; package published | nothing in app-a | — |

Order rationale: 2 before 3 so the package is exercised locally with SQLite before the network
store exists; 4 is the largest wall-clock win (host checks and the shared stack are 74 h + most of
the Docker hours) and lands before journeys; 6 waits for 4 and 5 because Acceptance lines name
tasks of both kinds.

### 6.1 The new-Mac story

1. Install Bun, Docker, Xcode; join the tailnet; `git clone`; `bun install`; `uv sync`.
2. Write `~/.config/proof/store`.
3. `proof doctor` prints the environment class and the store round-trip.
4. `proof plan --set land` on develop prints PROVEN for every task whose class matches (host,
   docker, static, web with the same browsers) and RUN for `ios` tasks only if Xcode differs.
   Nothing re-proves by virtue of being a new machine.

Moving the store: `pg_dump` on the M3, `pg_restore` on the mini, change one line in
`~/.config/proof/store` on each Mac. The Intel Mac shares host/static/docker proofs if `arch` is
dropped from those classes (question 7.2); otherwise it builds its own set once.

### 6.2 What the plugin needs

Nothing in step 1–7: land.py runs the Acceptance line with `sh -c` and `--tested-by` is unchanged.
Issue #200's goal record and third-attempt gate are the plugin's own work and are what keeps the
next three months from repeating this one; they are not on the path for `proof`.

---

## 7. Risks and open questions for Paul

| # | Question | Recommendation |
|---|---|---|
| 7.1 | **Store engine and host.** Postgres (Homebrew, launchd) on the M3 now, the mini later? Or SQLite behind a 200-line Bun HTTP service? | Postgres. Both repos already speak it, `Bun.sql` needs no driver, moving is `pg_dump`, and there is no second service to keep alive. The HTTP shape can be added later if a non-tailnet client ever appears. |
| 7.2 | **Is `arch` in every class?** Bun unit tests and static gates pass identically on x64 and arm64; Docker images and simulators do not. | `arch` in `docker`, `ios`, `web`; not in `host` or `static`. Revisit if a host-class contradiction ever names arch. |
| 7.3 | **Ordinary red against a stored green: keep or delete the proof?** Keep follows your rerun rule and masks an undeclared input for at most three days; delete is fail-safe and costs one rerun per flake. | Keep, record the contradiction, and let `proof lint` nag a task with two in 30 days. The super test owns correctness. |
| 7.4 | **How coarse may `$stack` be?** As written it includes `packages/**` and `apps/{api,worker,generator}/**`, so any backend edit reruns all 63 shared gates (12–13 min of stack time at six lanes). Narrowing per gate (which worker tests a gate reads) is a later card using `imports-of` for TS and an AST walk for Python (today's `test-inputs.py` idea, kept as an adapter). | Start coarse; it equals today's worst case and makes every non-backend change free. Narrow after measuring which gates dominate (`m2c-*` resynthesis: 1,100 s of the 2,500). |
| 7.5 | **Declarations are 1,500 lines of YAML.** Generated once from the selectors, then reviewed; `proof lint` keeps coverage. Risk: a lazy `**` declaration that makes a task never reuse. | `proof stats` reports each task's reuse rate; a task under 20% over 30 days is listed for review. |
| 7.6 | **Push-quality runs unit shards unconditionally today by policy** ("Push quality jobs always run without receipt reuse"). The model reuses them by content. | Reuse. A shard proven for identical package content on this Mac an hour ago is the same proof; the policy existed because the old key was wrong, not because the proof was. |
| 7.7 | **Xcode updates re-prove 70 journeys** (50+ min at two lanes) because `xcode` is in the `ios` class. | Accept; it is the honest cost and happens monthly at most. A `--class-override` is deliberately not provided. |
| 7.8 | **Package name and home.** `proof` is short and may collide on npm; alternatives `greens`, `attest`. New public repo under your account; MIT. | `proof`, scoped on npm; CLI `proof`. |
| 7.9 | **Scope creep in step 4.** It replaces `test-all.sh`'s orchestration; the plan prints which runners remain. | Keep `test-all.sh` as a thin wrapper that calls `proof run --set land` for one release so the super test compares the two; then delete. |
| 7.10 | **The super test is the backstop and runs four times a week on one Mac.** If it is red for unrelated reasons, contradictions are not recorded for the tasks after the red. | `--mode super` records every task independently (it already continues past reds under `SUPER_TEST=1`). |
| 7.11 | **Loss of the ledger's history** (26k rows, 35 days). | Import it once into `results` with `trigger='import'` and no `proofs` rows; the timing medians in `tiers.md` keep their provenance. |

---

## Appendix: how the numbers were produced

- Line counts: `git ls-files <paths> | xargs wc -l` at `2e5477472`.
- Ledger: `python3 -I` over `$(git rev-parse --git-common-dir)/land-timing.jsonl`, excluding
  `stage_timing_mark` rows from fresh totals; "exact repeat" = a second fresh row with identical
  `(step, json(argv), tree)`.
- Pushes: rows whose `tree` starts with `3a2098b524` and `2652501d3f`.
- Receipt counts: `ls <git-dir>/check-receipts | wc -l` in the develop checkout and the live
  worktree; `ls ~/.xp/receipts | wc -l`; `cat ~/.xp/super-test/logs/*/rows.jsonl | wc -l`.
- Commit candidates for the suite: `git log origin/develop --no-merges --since=2026-10-15
  --format='%h %s' -- <path>` filtered to ≤3 files.
- Tool survey: vendor docs fetched 2026-10-29; URLs are in the survey transcript and the key ones
  are turborepo.dev/api/remote-cache-spec, nx.dev/docs/reference/inputs and
  21.nx.dev/docs/guides/tasks--caching/self-hosted-caching, moonrepo.dev/docs/guides/remote-cache,
  mise.jdx.dev/tasks/remote-cache.html, pantsbuild.org/stable/reference/targets/test_shell_command,
  bazel.build/reference/be/common-definitions.
