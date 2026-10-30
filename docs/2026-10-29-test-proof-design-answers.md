# Test proof design: answers to the eleven open questions, and what the design misses

Written 2026-10-29 against the design document of the same date, app-a at `2e5477472`,
app-b at `c2b8aec2`, xp-plugin 1.2.1. Read-only. Every number was re-derived from the ledger
(`.git/land-timing.jsonl`, now 26,436 rows), the code, or the tailnet; where mine differs from the
document's I say so.

## Verification notes that bear on the answers

- The ledger nests wrapper rows (`lanes` 823 s, `docker` 1,027 s, `acceptance`, `test-all:*`,
  `static-gates`) above their children, so hours are not additive. The document's 300.8 fresh hours
  and 29.3 repeat hours include double counting; so does my 347 h recount. Leaf-only, the
  2026-10-29 "CHANGELOG + one script" push ran 88 leaf gates (62 shared-stack, 19 static, 7 private)
  for 50.4 gate-minutes; PR #1514's push ran 93 leaf gates for 47.0 gate-minutes plus
  `worker-acceptance` 912 s. The direction of every conclusion in the document holds; the savings
  figures should be re-cut leaf-only before anyone quotes them.
- The ledger has no `host` field. Every row is this M3. Nothing in it measures the Intel Mac; the
  only Intel number is `tiers.md:64` (story gate 10.8 min on a 4-core MacBookPro15,2 against 3.85).
- The tailnet today: this laptop (`m3-laptop`), an iPhone, and three Linux droplets
  (`svc1-prod`, `svc2-ops`, `svc3-prod`). No Mac mini, no Intel Mac. Both Macs are
  laptops. Homebrew `postgresql@17` is installed here and not running. `pmset` says sleep is off.
- The super test is launchd on Mon/Wed/Fri/Sun 02:00 (`super-test.sh:44`) from the **`app-a-main`**
  clone's checkout, with `CHECK_RECEIPTS_BYPASS=1`. It never runs a branch.
- `gate-inputs.json` is at `scripts/`, not `scripts/lib/`: 18 gates, 6 declared, 12 `undeclared`,
  and `verify-metrics-role.sh` is one of the undeclared (the document's example declares it).
- `static-gates.sh:2` merge-base, `leg-selection.py` "worktree differs from index",
  `receipt-inputs.py` ignoring the caller's `extra` and hashing `git show-ref --head`,
  `python-leg-inputs.json` listing `lefthook.yml` five times and a milestone doc twice,
  `RUNTIME_PROJECTS`: all as described.
- Today's identity also carries three things the design drops: `CONTRACT = 4` (a scheme version),
  `provider_class` (absent / `dummy-` / real for each provider key), and `stack_config()` (the
  values of every `.env.docker` key in the template minus 27 routing names). See the last section.
- `web-audit-selection.ts` (62 lines) and `route-census.ts` (165 lines) are a route census; neither
  walks TypeScript imports. The `imports-of` adapter is new work, not "already built".
- `packages/db/src` imports `@app-a/shared` from 33 files and `@app-a/framing` from 12. The
  design's `bun:db` example declares neither. `node_modules/@app-a/shared` is a symlink to
  `../../packages/shared`; `apps/worker/.venv`'s `.pth` is the absolute path of this checkout's
  `packages/py-common/src`.
- `verify-no-history-ids.sh` reads `CHANGELOG.md`; six static gates read `package.json`;
  `verify-fleet-dashboard.sh` and `verify-m1g3-entity-resolve.sh` glob every `scripts/verify-*.sh`.
  Cases 1, 2 and 3 of the suite will not come out "none" or "one gate"; they come out "the text
  gates that declare those files", which run in seconds. Fine, but the table should say so.
- `apps/worker/tests/conftest.py:138` runs `docker build` of `docker/postgres`, not of the worker
  image; case 10's reason is wrong even if its expectation survives.
- Flake orderings per identical `(step, argv, tree)`: 151 keys mixed red and green. 120 are
  red-then-green only (a flake that was re-run). 31 had a green **before** a later red; 15 of those
  31 ended red and were never re-greened. By step: fast-tests 12, lint 5, python-typecheck 4,
  shared-stack 4.
- npm: `proof`, `proven`, `greens`, `attest`, `provable`, `testproof` are all taken.
- app-b: no reuse mechanism at all; `.githooks` not lefthook; pre-commit runs staged-file
  eslint/prettier/ruff and per-workspace `tsc`; pre-merge-commit runs `test:all` (Bun lanes +
  python non-acceptance, 88 s); the sprint hook runs pytest acceptance (657 s, testcontainers) and
  Playwright (160 s, three projects, `e2e/specs/*.e2e.ts`) concurrently; `e2e/` is a separate Bun
  project with its own lockfile; eight Maestro flows run through `scripts/maestro-acceptance.ts`
  outside the sprint hook; `docker-compose.yml` images are tag-floating (`postgres:16-alpine`,
  `valkey/valkey:8-alpine`); 11 scripts depend on `--env-file=.env` values.

---

## 7.1 Store engine and host

**Answer.** Postgres, yes. Not on a laptop. Put it on an always-on Linux node of the tailnet (a
dedicated small droplet running Postgres in Docker with a volume and a nightly `pg_dump` to Spaces,
declared in Terraform like every other resource), and move it to the mini if one ever arrives. In
addition, make the local SQLite spool a read-through replica of this host's own results, so `plan`
degrades to "what this machine has proven" when the store is unreachable instead of "run everything".

**Agree?** Agree on the engine, differ on the host.

The engine argument is right: `Bun.sql` needs no driver, both repos already run Postgres, history
needs real queries (`flakes`, `stats`, `status --ref`), and an HTTP service in front of SQLite is a
second process with its own auth to keep alive and would still sit on the same host.

The host argument is wrong on the facts: there is no mini, and "the M3" is `m3-laptop`.
The requirement is "anyone on any clone or machine sees the same answer". The design's fallback for
an unreachable store is "everything runs, printed loudly", and with a laptop host that is the
Intel Mac's normal state whenever the lid is closed, the laptop is elsewhere, or macOS is at the
login window (the GUI Tailscale client runs in the user session, so the store is unreachable after
a reboot until someone logs in). That is the one-hour Intel push the whole exercise exists to end.
A droplet costs about $6 a month and removes the question.

**Strongest argument against.** Today the ledger shows one consumer: this laptop. The Intel Mac is
not even on the tailnet. A local Postgres is free, has no Terraform footprint, no secret to rotate,
and `plan` on this laptop never degrades. A droplet adds a resource to prod infra and the release
drift check, and the store will hold commit shas and branch names off-machine.

Why I still choose it: the sensitivity of the content is low (task ids, hashes, shas, seconds), the
drift check is one declaration, and the local-replica fallback is needed either way. Hosting on the
laptop means building the cross-machine feature and then operating it in the one topology where it
fails most.

**What would change my mind.** After 30 days with the store on the droplet: if fewer than 5% of
`runs` rows come from a host other than the M3, or the Intel Mac has not joined the tailnet, move
the store to the M3 and keep the replica. Conversely, if hosted on the M3 first: count
`store unreachable` plan outcomes from the Intel Mac per week; more than two is the signal to move.

**Missed.** (a) Bind order: Postgres bound to the Tailscale address at boot fails to start if the
interface is not up yet; listen on all interfaces and restrict in `pg_hba.conf` (and a Tailscale
ACL on 5432, see security below). (b) Homebrew `brew upgrade` will one day move `postgresql@17`
to a major that needs `pg_upgrade`; Docker with a pinned image avoids it. (c) The design puts a
default connection string in `proof.yaml` (`store: ${PROOF_STORE:-postgres://proof@mini...}`) and
says in 4.12 the connection string is never in the repo; pick the second.

## 7.2 Is `arch` in every class?

**Answer.** `arch` in `docker`, `ios`, `web`; `os` in all four; `arch` out of `host` and `static`,
with a per-task override (`class: host+arch`) for the few host tasks that load native wheels or
assert on platform bytes.

**Agree?** Agree, with the override named now rather than "revisit".

**Strongest argument against.** Native code is where arm64 and x64 differ, and the Python side
has it: NER models, embeddings, anything numpy. A green from the M3 served to the Intel Mac for
`pytest:worker-unit` could be a false green on a wheel that behaves differently, and the
memory file already records one platform-dependent byte assertion (`gzip bytes differ by platform`,
macOS vs Linux). Keeping `arch` everywhere is the safe default and costs only the Intel Mac's first
full proof.

Why I still choose it: the gain is concentrated exactly where the Intel Mac is slowest. Story-gate
host checks are 75 hours of the ledger on the M3; the same checks take 2.8x longer on the Intel
(`tiers.md:64`). Sharing them is most of what the Intel Mac gets from the store. The native-wheel
risk is small, nameable per task, and caught by the super test if the Intel Mac ever runs one.

**What would change my mind.** The Intel Mac's first `proof run --set story --fresh` on a tree the
M3 has fully proven. Any red there whose key is PROVEN on the M3 is an arch contradiction; the task
gets `+arch`. More than three such tasks means put `arch` back in `host`.

**Missed.** The dimension that matters more than `arch` for `host` is the toolchain the task runs
with: Bun's version is in `host` (good), but Bun's version is also pinned per repo
(`packageManager: bun@1.4.2` in app-b) and tool versions are already in `$deps` where pinned.
Double counting is harmless; the real omission is `node_modules` content. `$deps` hashes the
lockfile, not what is installed; a stale `bun install` (memory: "back-merge leaves a stale bun
store") gives a red that no key explains. `proof doctor` should compare the lockfile hash to the
install's recorded hash and refuse to record results from a mismatched install.

## 7.3 Ordinary red against a stored green: keep or delete?

**Answer.** Neither. Mark the proof *contested*: `plan` treats a contested key as RUN once; a green
restores it (and updates `proofs` to the new result); a second red deletes it. Never serve PROVEN
for a key whose most recent same-key result is red.

**Agree?** Differ.

The document reads Paul's rule as "a green at an ancestor is already the rerun". That rule is about
a green whose inputs have not changed since, which is proof reuse, not flake policy. When the newest
observation for exactly these inputs is red, the earlier green is not the rerun; it is the first
run and the red is the second. "Keep" means: a push fails on the red, the developer pushes again
with nothing changed, `plan` says PROVEN, nothing executes, the push passes. That is a retry
implemented as a skip, and it never produces the "alone" rerun Paul's rule requires.

The ledger does not support "keep". Of the 31 keys where a green preceded a red on identical
content, 15 were never greened again. Under "keep", every one of those 15 would have been served as
proven after the red. Some are flakes nobody bothered to re-run because the branch moved on; the
ledger cannot tell, which is the point: the store should not guess green.

**Strongest argument against.** Contested costs one rerun per flake, and fast-tests alone account for
12 of the 31 green-then-red keys; on the Intel Mac that rerun is six minutes. The super test will
catch an undeclared input within three days anyway, so "keep" only risks a branch-local window.

Why I still choose it: the super test runs on the `app-a-main` clone's develop, not on branches, so the
window is "until it lands plus up to three days", and the land is the thing being gated. One
rerun per flake is the price Paul's own rule already pays; the design's "alone" command is the
same rerun. And a contested-then-red key is the fastest possible detector of an undeclared input,
which `flakes` can then rank; "keep" throws that signal away.

**What would change my mind.** After 30 days of contested: if every contested rerun came back green
(zero second reds) and the reruns cost more than, say, 20 minutes a week on the slowest host, the
masking risk is empirically nil and "keep" is cheaper. The store has the data to say.

**Missed.** A red in `--mode super` on a *different* env class (the `app-a-main` clone on the M3) does
not touch a proof written by the Intel Mac; keys differ by class. Fine, but say it. And a red
`incomplete` (killed run) must not contest anything.

## 7.4 How coarse may `$stack` be?

**Answer.** Start coarse, as recommended, but fix the key scheme first so that narrowing later is
possible at all: a task's key must contain only the inputs the *task* declares; a provider's input
hash enters a task's key only when the task names `$stack` (or a narrower set) itself. Provider
inputs decide whether the provider starts or rebuilds, not what the dependent task's key is.

**Agree?** Agree on "start coarse"; differ on the model as written, because the model contradicts
the recommendation.

Section 4.4 puts `"<provider>\0<inputs_hash of the provider>"` into every dependent task's
`inputs_hash`, and 4.9 repeats it. With that rule the narrowing in 7.4 can never happen: a gate
whose own declaration is narrowed still carries the whole `$stack` through `needs: [stack]`. The
same rule breaks suite case 5: `native:your-page` needs `ios-build`, whose inputs are
`$mobile-build = apps/mobile/** + packages/**`, so a one-line edit to `item-period.tsx` re-keys
all 70 native journeys (50+ minutes at two lanes), and the `imports-of` entry is decoration. The
design has not decided the mobile-side granularity; it has written two incompatible answers.

The fix is small: providers carry inputs for their own lifecycle (start, rebuild, `lane`), and a
task that wants the coarse set says `$stack` or `$mobile-build` explicitly (lint can warn when a
`needs: [stack]` task declares nothing from the stack at all). Then `native:smoke` declares the
whole build set and runs on any mobile change, which is today's rule, and `native:your-page`
declares its route's import closure plus the app shell.

**Strongest argument against.** A journey is a test of the whole binary. A crash at module load in
an unrelated screen, a changed global provider, a theme token: the import closure of one route
misses them, and 4.4's rule is the honest statement that the binary changed. Coarse is correct;
narrow is a bet.

Why I still choose it: the bet is the entire wall-clock win on the mobile side, it is the rule the
repo already lives with (smoke plus named journeys), and the super test re-proves the whole roster
four times a week. What must not happen is the design silently choosing "coarse" through the key
scheme while the suite expects "narrow".

**What would change my mind.** Super contradictions on `native:*` tasks whose key was PROVEN under
narrow declarations. One a month is a declaration to widen; one a week is the model being wrong,
and `$mobile-build` goes back into every journey.

**Missed.** Three things about the stack that are not files. (a) `.env.docker` values: today
`stack_config()` hashes every template key's value minus routing names; the design hashes only key
names. A flag flipped in an untracked `.env.docker` changes the stack and no key. (b) Provider-key
class: today `provider_class()` distinguishes absent / `dummy-` / real and it is in the identity;
the design drops it. Five gates self-skip their paid part under `dummy-` keys, so a green from a
keyless worktree would be served as PROVEN to the lead's real-key run. Both belong in the `stack`
provider's declaration (`{dotenv: .env.docker, exclude: [routing names]}` and a `provider-keys`
dimension). (c) Running-stack reuse: `REUSE_STACK` appears 56 times and `OWN_STACK` 50 times in the
scripts; a stack left running from another branch is not "the provider at this inputs hash". The
provider must label the compose project with its inputs hash and recreate on mismatch, or the
key describes a stack that was not the one tested.

## 7.5 Declarations are 1,500 lines of YAML

**Answer.** Generate once, review, and add two things: a `proof narrow <task>` loop that starts a
`sandbox: full` task from the minimal declaration (its script plus `$harness`) and widens on each
"no such file" until green, so declarations are derived from failures rather than guessed; and a
lint that refuses `**`, `scripts/**` and `proof.yaml` itself as inputs. Reuse-rate reporting as
recommended.

**Agree?** Agree, with the derivation tool added, because a reviewed guess is still a guess and 1,500
lines will be reviewed once and never again.

**Strongest argument against.** The narrowing loop only works for `sandbox: full`; the
shared-stack, journey and provider declarations (the expensive ones) stay hand-written. And a
declaration derived from one run captures that run's path, not every path.

Why I still choose it: 59 of the 63 shared-stack gates share the same script-side shape (script,
harness, fixtures), so the loop covers their script side; the stack side is coarse by 7.4. The
expensive declarations are few enough to read.

**What would change my mind.** If after step 4 `proof stats` shows the reuse rate of generated
declarations within 10 points of hand-written ones, the tool was not worth its lines.

**Missed.** `decl_hash` should not include glob text. The resolved input lines already describe
what the globs matched; hashing the YAML too means every cosmetic edit, set rename, or `sets:`
change re-proves 400 tasks. Key only what changes the run: `run`, declared env names, `sandbox`,
`links`, `class` dimensions, `needs`. Migration will churn the YAML daily for weeks; this is the
difference between tuning declarations and re-paying the roster each time.

## 7.6 Push-quality runs unit shards unconditionally today

**Answer.** Reuse by content.

**Agree?** Agree.

**Strongest argument against.** Push quality is the last gate before code leaves the machine; a
stale `node_modules` or a poisoned Bun preload (memory: "DB tests hard-fail on could not start on
host port") can make a green that was never true. Unconditional execution is the cheap insurance.

Why I still choose it: those failures were red, not green, and a red is recorded as a red. The
policy exists because the old key was the whole index tree, which no push ever matched. With a
content key, "proven an hour ago for identical package content, lockfile and Bun" is the same proof.
Fast-tests are 42.8 ledger hours; this is the second-largest single saving.

**What would change my mind.** Any contradiction on a `bun:*` or `pytest:*` key whose newest green
came from a different checkout than the red (same host, same class). That is a sandbox leak, and
until it is found, push quality goes back to `--fresh` for that task.

**Missed.** The shards are four timing-balanced DB shards over private database pairs cloned from
migration-fingerprinted templates. The task granularity should be the package, not the shard:
a shard's membership moves when timings rebalance, and a per-shard key would re-prove on a
rebalance. The `test-db` provider's inputs are `packages/db/drizzle/**` plus the template script.

## 7.7 Xcode updates re-prove 70 journeys

**Answer.** Accept. Keep the full Xcode version and the iOS runtime version as separate dimensions.
No override flag.

**Agree?** Agree.

**Strongest argument against.** Fifty-plus minutes for a point release that touched nothing a
journey exercises, on a machine other people use.

Why I still choose it: the super test re-proves the roster fresh within three days of any update
anyway, so the cost is the same roster run moved earlier; an override is exactly the kind of knob
the memory file warns against ("harness weight is a cost"). Time the update before a super slot
and the extra cost is zero.

**What would change my mind.** Nothing measurable; this is a policy, and a cheap one.

**Missed.** The `ios/` prebuild directory is gitignored and regenerated from Expo's fingerprint by
`ensure-ios-prebuild.sh`. A stale prebuild changes the binary with no tracked-file change. The
`ios-build` provider's start must run that script (it already does on every native build), and
the design should say so, since nothing in the key sees `ios/`.

## 7.8 Package name and home

**Answer.** Scoped: `@paulingalls/proof` (or whatever scope the new repo's owner uses), CLI binary
`proof`. Public repo, MIT.

**Agree?** Agree on scoped; the document's "may collide" is now "does collide": `proof` on npm is a
2022 test framework, and `proven`, `greens`, `attest`, `provable` and `testproof` are taken too.

**Strongest argument against.** A scoped name reads as personal, not as a project, and the bare
binary name `proof` will someday collide with someone else's tool on PATH.

Why I still choose it: a scoped name is the only free option without inventing a word, and a word
invented today will be reconsidered when the repo has a second contributor. The binary name is
local and renameable.

**What would change my mind.** A second project outside Paul's account adopting it; then move to an
org scope.

**Missed.** Nothing material.

## 7.9 Scope creep in step 4

**Answer.** Keep `test-all.sh` as a thin wrapper, but the comparison that justifies deleting it is
not "one release against the super test". Add a shadow mode first: during steps 2 to 4, every old
runner also calls `proof plan` and records, per task, what proof would have said; a task the old
runner executed and found red while proof said PROVEN is logged as a shadow contradiction. Delete
the wrapper when a week of shadow rows (four super runs, every land) shows zero.

**Agree?** Agree on the wrapper; differ on the evidence that retires it.

**Strongest argument against.** Shadow mode is more code during the one phase where the goal is to
delete code, and it runs two selectors for weeks, the exact condition issue #200 describes.

Why I still choose it: the shadow is read-only (it never changes what runs), it is the only way to
learn the false-green rate of the declarations before trusting them, and it has a fixed end
condition. The alternative is to cut over on faith and learn the rate from the super test after the
fact, on landed code.

**What would change my mind.** If step 2's private and static gates (59 tasks, fully sandboxed)
show zero shadow contradictions in two weeks, shadow can be skipped for the rest of the sandboxed
population and kept only for `script` and `none` tasks.

**Missed.** Step 4 is where the Intel Mac's hour and the M3's twelve minutes actually move; it is
also one card replacing push-quality, story-gate, `test-all.sh --free-push`, the sprint Docker leg
and six environment switches at once. If it is split, there will be a release where story-gate uses
proof and land does not, and two identities exist again. Order the split by boundary, not by
mechanism: story-gate first (one caller, host tasks only), push-quality second, land last, each
deleting its own old path in the same card.

## 7.10 The super test is the backstop

**Answer.** `--mode super` records every task independently, as recommended, and two more things:
super runs from the `app-a-main` clone, so that checkout needs the store config and the same package
version; and the super run itself must write a `runs` row with `planned = ran` so a super that was
cut short (laptop asleep at 02:00, memory: "background shells reaped on memory pressure") cannot
be mistaken for a clean roster.

**Agree?** Agree.

**Strongest argument against.** Making every task independent in super hides the ordering
dependencies the shared stack actually has (one gate's DB state feeding the next); a super that
continues past a red may report contradictions that are consequences, not causes.

Why I still choose it: the consequences are also contradictions, and they are the evidence that
the stack-state coupling exists. `flakes` will cluster them; `lane: solo` is the tool for the ones
that matter.

**What would change my mind.** If super contradictions on shared-stack tasks come mostly in runs
of consecutive gates after one red, the "independent" claim is false and super should restart the
stack after a red before continuing.

**Missed.** The super test is the only enforcement for `sandbox: none` tasks and it never runs a
branch. A journey proof produced on a branch with an undeclared input is consumed by that branch's
land before super ever sees the content. Say this plainly in the document: branch-local false
greens on journeys are detected after landing, within three days, not before.

## 7.11 Loss of the ledger's history

**Answer.** Import once with `trigger = 'import'`, no `proofs` rows, and tag nested wrapper rows so
`stats` excludes them from medians. `host` is `m3-laptop` for every row (the ledger has
no host field and was written by this machine).

**Agree?** Agree.

**Strongest argument against.** The import carries 12 row shapes into a clean schema for the sake
of 35 days of medians that `tiers.md` already records.

Why I still choose it: it is one script, and the step-level medians are the only baseline for
"did proof make this faster" at step 7.

**What would change my mind.** Nothing; it is cheap.

**Missed.** The super rows (`~/.xp/super-test/logs/*/rows.jsonl`, 4,932 rows) are the only record
of super reds and belong in the same import with `mode = 'super'`.

---

## What the design gets wrong or leaves out

Ranked by severity. The first four can each produce a false green in the model as written.

### 1. Provider inputs are folded into every dependent key, which contradicts the suite, 7.4 and the mobile-side plan

Section 4.4 and 4.9 put each `needs:` provider's input hash into the task key. With `ios-build`
declaring `apps/mobile/** + packages/**`, suite case 5 (one mobile file, "items journeys only")
cannot pass: all 70 native journeys, 11 web journeys and the audit re-key on any mobile edit. With
`stack` declaring `apps/{api,worker,generator}/** + packages/**`, 7.4's "narrow later with
`imports-of`" can never narrow anything. The model has to choose, and the choice has to be the one
the suite expects: tasks declare their own inputs; providers govern their own lifecycle. Then the
design should also say what the mobile-side rule is (smoke carries the whole build set; a journey
carries its route closure plus the app shell), because it is the largest remaining wall-clock
question and the document currently answers it both ways.

### 2. Three identity components that exist today are dropped

- `.env.docker` values. Today's `stack_config()` hashes every template key's value minus 27
  routing names; the design hashes key names only. An untracked flag change alters every
  shared-stack outcome and no key.
- Provider-key class (absent / `dummy-` / real). Five gates self-skip paid parts under dummy keys. A
  keyless worktree's green becomes PROVEN for the lead's paid run.
- A scheme version (`CONTRACT = 4` today; `gate-inputs.py` also keys on the xp-plugin version and
  its own helper files). The design's key has none, so a change to the sandbox, the glob semantics
  or the hash lines silently keeps old proofs valid. Add `proof`'s key-schema version to the key.

### 3. The `full` sandbox is not sound across workspace boundaries, and the design's own example shows it

`links: [node_modules]` symlinks the real checkout's `node_modules`, whose `@app-a/shared` points
at `../../packages/shared`, i.e. the real checkout, not the sandbox copy. `apps/worker/.venv`'s
`.pth` is the absolute path of the checkout's `packages/py-common/src`. So a `bun:db` or
`pytest:worker-unit` task can read any workspace package without declaring it and the sandbox
cannot tell. The `bun:db` example declares `packages/db/**` and `$deps` while 33 files in
`packages/db/src` import `@app-a/shared` and 12 import `@app-a/framing`: an edit to `shared`
leaves `bun:db` PROVEN. Fix: lint derives workspace dependencies from each `package.json`
(`workspace:*`) and `[tool.uv.sources]` and adds them to the task's inputs; the sandbox rewrites
workspace symlinks to its own copies.

### 4. Running-stack reuse is not in the model

`REUSE_STACK` (56 occurrences) and `OWN_STACK` (50) mean a gate often runs against a stack built
from some earlier tree. A proof keyed on `$stack` at tree B that ran against a stack built at tree A
is a false green when A and B differ in the stack set. The provider must label the compose project
with its inputs hash and recreate on mismatch; `proof run` must refuse to record a shared-stack
result against an unlabelled stack. Related: DB state carried between gates within one stack makes
a gate's outcome depend on which gates ran before it, which no key sees; `lane: solo` covers two
gates and not the general case. The super test will surface the rest as contradictions.

### 5. "Keep the proof on an ordinary red" is a retry implemented as a skip

See 7.3. Fifteen of 31 green-then-red keys in the ledger ended red. Contested state costs one rerun
and matches Paul's "re-run alone" rule literally.

### 6. The `imports-of` adapter is new, hard, and load-bearing

The document says the route audit already built it; it did not (`web-audit-selection.ts` is a
route census). The adapter must handle Expo Router's file-based routes (a sibling route file nobody
imports changes navigation), Metro platform extensions (`.ios.tsx`, `.native.tsx`, `.web.tsx`),
`require()` of assets, `tsconfig` paths, workspace packages, and dynamic imports. Each miss is a
false green on a journey. Budget it as its own card with its own cases, and start journeys on the
coarse set until it has cases.

### 7. Store on a laptop, Tailscale in the user session

See 7.1. Also: every tailnet node, including three production droplets and an iPhone, can reach
port 5432 under the design's `pg_hba` rule; a Tailscale ACL limiting 5432 to Paul's user devices is
one line and removes the "compromised node inserts greens" threat the document accepts. Postgres
bound to a `100.x` address at boot can fail before the interface exists. The local spool should be
a read-through replica of own results, not write-only.

### 8. The suite's expectations are not yet true, and the suite cannot see the store

Cases 1, 2, 3 ignore text gates that legitimately read `CHANGELOG.md`, `package.json` and every
`scripts/verify-*.sh`; case 10's reason is wrong (`conftest.py` builds `docker/postgres`); case 5
contradicts the key scheme (item 1). The document says the landing card confirms each; it should
also say the suite is a planner check only. It needs three store cases it lacks: a proof written by
host X in class C is PROVEN for host Y in class C and RUN in class C'; a super red deletes; a
contested key runs once. And one more pair: a commit that only changes `proof.yaml` cosmetically
(a set rename) must run nothing (item "decl_hash", 7.5).

### 9. app-b adoption friction

- Floating image tags (`postgres:16-alpine`, `valkey/valkey:8-alpine`). The design keys images
  through pinned digests in files and forbids daemon inspection; app-b has neither pins nor
  Renovate's digest pinning. A `postgres:16-alpine` that moves under a proof is a false green.
  Precondition: pin, as app-a does. Say this in the adoption guide.
- `bun --env-file=.env` in 11 scripts: outcomes depend on untracked values; the `env:` list per
  task must be derived from what those scripts read, and the lint's "undeclared read name" check
  must see through `--env-file`.
- `e2e/` is a separate Bun project with its own lockfile outside the workspaces; `$deps` for
  Playwright tasks is `e2e/bun.lock`, not the root one.
- Maestro runs outside the sprint hook via `scripts/maestro-acceptance.ts`; the design counts
  "Maestro" among the 12 tasks but nothing in app-b's hooks runs it, so there is no set to
  attach it to yet.
- The sprint hook runs acceptance and Playwright concurrently on per-run ports from
  `worktree-common.sh`; the `test-env` provider has to reproduce that port allocation or the two
  tasks fight. The hook also starts testcontainers per pytest run; those are inside the task, fine.
- There is no reuse mechanism to delete, so the win is only the 657 s acceptance and 160 s
  Playwright skipped when `apps/agent` or the web/server side is untouched. Worth it, but modest;
  do not promise app-b the app-a numbers.

### 10. Package boundary leaks

The schema's CHECK constraints bake in `mode in ('ordinary','alone','super','release')` and
`trigger in ('push','story','land','super','release','manual')`: xp-plugin vocabulary. app-b
has `pre-merge-commit` and `sprint`. Make both free text (or project-declared enums in
`proof.yaml`). `$harness`, `lane: solo`, `flaky-budget` and the `release` set are fine as repo
declarations. The `maestro` adapter is legitimately shared. The `web-audit` cell shape (cells by
route) is app-a-only and should live under `proof.d/adapters/`, not in the core.

### 11. Migration steps that leave app-a worse off mid-way

- Steps 2 and 3 declare 59 private and static gates under proof while the shared stack, host checks
  and journeys stay on the five old mechanisms: for at least two releases there are six
  mechanisms. Each step must delete its old path in the same card (the document says so; the
  cards must be reviewed for it).
- Nothing changes the Intel Mac's hour until step 4; the exact-tree receipts keep dying on every
  fetch until `check-receipts.py` is gone. If the Intel Mac matters, step 3 (the store) should land
  before step 2's wider gate population, not after.
- Step 7 deletes `land-timing.jsonl` and `rows.jsonl`; without the step-11 import landing in the
  same card, `tiers.md` loses its provenance.
- Card Acceptance lines become `proof run --tasks …`; `land.py` runs the line unchanged and
  `--tested-by` still skips it with a warning, so the plugin is untouched, as claimed. But the plan
  reviewer's `sh -n -c` check now passes any task name; `proof lint` must also validate every
  task named in open cards, or a renamed task silently makes an Acceptance line a no-op (constraint
  8 territory).
- No shadow phase (7.9): the design cuts over and learns the declaration error rate from the super
  test afterwards, on landed code.

### 12. Smaller omissions

- The two macs run several clones each (`app-a-main`, `app-a2`, `app-a`); lane limits are
  per-process in the design and per-host in reality. A host-level lock in `~/.proof` is needed or
  two clones exceed `stack: 6` and `ios: 2` together.
- `hostname` on macOS changes with the network; use the Tailscale node name or a stable id in
  `~/.config/proof`.
- `results` retention prunes at 180 days except the proof's result; contradictions reference both
  results and will dangle unless they are exempt too.
- `typecheck` keyed on `**/*.ts` re-runs on any TypeScript edit (954 runs, 12.5 h). Correct, but a
  per-package `tsc -b` split is the next-largest host saving after fast-tests and is not mentioned.
- The hours in section 2.4 double count wrappers; re-cut them leaf-only before they are used to
  justify anything to anyone.
