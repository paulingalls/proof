# Commands

```
proof plan [--set <name>] [--json]  what must run, and why
proof why <task>            current key parts and changes since the newest proof
proof status --ref <ref> [--set <name>] [--json]  proof state at a committed ref
proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]  run tasks and record each result
proof record <task> --outcome green|red|incomplete [--seconds N]
proof invalidate --task <t> [--key k | --all]  delete proofs with a manual audit
proof flakes [--since Nd]    tasks ranked by ordinary contradictions
proof lint                   check declarations against the staged tree
proof check <cases.yaml>     run a requirement suite
proof doctor                 store health and all declared dimension values
proof stats [--set <name>] [--since Nd]  timings, current RUN estimate and time saved
```

`run` exits 0 when every task is proven or green, 1 when a task is red/incomplete or a provider fails, 130/143 when interrupted;
any command exits 2 on a usage, declaration, store or log error. Interrupt exits take precedence
over log errors, and log errors take precedence over task failures without changing recorded outcomes.

`proof run --jobs 2` runs up to two tasks concurrently. `--jobs` accepts a positive safe
integer and belongs after `--fresh` or `--staged`, before the selector. It defaults to 1,
which streams each task's combined stdout and stderr live to proof's stdout in declared
execution order. Task stdout and stderr see no TTY. Above 1, each task's stdout and stderr
appear together on stdout when it finishes, under `--- <task>`; summaries stay in declared
order. Both streams write to one capture file to preserve their write order.

Red and incomplete tasks keep that file; their summary prints its absolute path under
`<state directory>/logs/<project>/tasks/<task>/<UTC timestamp>-<capture UUID>-<first 8 of key>-<outcome>.log`.
Keyless tasks and provider starts use `no-key`. Project and task names are encoded as single
path segments (including `/`, `:`, `%`, `.` and `..`). Each task keeps its newest ten logs;
a green deletes its capture and leaves earlier logs alone. The state directory is the same
one as the local replica, outside checkouts by default. A `PROOF_STATE_DIR` override inside
a checkout also puts logs there, so removing that checkout removes those logs. Logs stay
local and never enter either store: they may contain private data.

Providers without `lane` start once; laned providers start once per used slot. Dependents
await their instance’s readiness, and teardown waits for all running and pending users. Starts use the same capture and display rules, with `--- provider-<name>`
blocks above one job. A failed start's summary names its retained log under
`logs/<project>/providers/<name>/`, with its own ten-log budget. Laned instances use
`stack[0]`, `stack[1]`, etc. in diagnostics, headers and encoded log paths;
a ready start deletes its capture. Background processes left by provider starts no longer
send output to the terminal after startup finishes. Provider stops keep their inherited streams.

### Provider environment

A provider's `start` receives `PROOF_PROVIDER_ENV`, an absolute path to a precreated mode-600
file in a private mode-700 directory under the state directory. To hand an address to its tasks:

```sh
printf 'URL=%s\n' "$ADDRESS" > "$PROOF_PROVIDER_ENV"
```

Proof reads the file after a successful, unsignalled start and validates it before accepting
readiness. The file and private directory are removed before dependents execute, including
on invalid content, failed startup or interruption. Do not delete the file: a missing or unreadable
file fails startup. Writing nothing leaves the environment unchanged. `stop` keeps the caller's
environment with its own `PROOF_LANE_SLOT` when laned; it receives neither the channel path
nor an implicit merge of exports. Unlaned starts and stops receive no inherited lane slot.

Each LF-separated line is `NAME=value`, split at the first `=`. Names match
`[A-Za-z_][A-Za-z0-9_]*`. Values are literal: spaces, extra `=`, quotes, dollar signs and carriage
returns stay unchanged; empty values are allowed. A final newline is optional. There is no shell
evaluation, interpolation, quote removal or comment syntax. Blank lines, malformed names,
duplicate names and NUL bytes fail startup. `PATH`, `HOME`, `TMPDIR`, `PROOF_PROVIDER_ENV` and
`PROOF_LANE_SLOT` are reserved. An export also fails if its name is in any dependent's declared `env`, including an
unselected dependent, or another provider started in this run exports that name and any declared task needs both.
Equal values still conflict; disjoint providers may export the same name. Different slots of
the same provider may export the same name, and each task receives only its instance’s values. Validation uses the
declarations read after that start returns, including startup edits.

A rejected export fails that provider's start and blocks its dependents with `incomplete`.
Diagnostics name the provider, line and valid name, never the value; a malformed name or a line
without `=` reports only the line number. Independent tasks still run, and teardown still happens.

Only tasks naming the provider in `needs` receive its exports. Keep those names outside task
`env`: export values remain in memory, never in keys, store records, proof-authored output or
logs. Different clones can use different addresses and reuse the same proof. Output deliberately
printed by a provider or task follows the usual display and capture rules; proof does not scrub it.

Resource lanes add a limit within `--jobs`. For example, after creating an `input` file:

```yaml
version: 1
project: lane-example
lanes: {ios: 2}
providers:
  stack:
    lane: ios
    start: printf "ADDRESS=instance-%s\n" "$PROOF_LANE_SLOT" > "$PROOF_PROVIDER_ENV"
    stop: echo stopped-$PROOF_LANE_SLOT
tasks:
  simulator-a: {run: echo "$PROOF_LANE_SLOT $ADDRESS", inputs: [input], lane: ios, needs: [stack]}
  simulator-b: {run: echo "$PROOF_LANE_SLOT $ADDRESS", inputs: [input], lane: ios, needs: [stack]}
  exclusive: {run: echo exclusive, inputs: [input], lane: solo}
```

Commit the declaration and input, then run `proof run --jobs 3`. At most two `ios` tasks
can occupy the run at once; a task without `lane` is bound only by `--jobs`. Tasks are
admitted in declared order, skipping lanes at capacity. A waiting `solo` stops admission
of later tasks until earlier tasks drain, then occupies the run alone. `solo` is reserved
and needs no declaration. Declaring it in root `lanes`, naming an undeclared lane, or
using a limit other than a positive safe integer is a declaration error (exit 2).

Only RUN tasks take slots: each receives the lowest free nonretired index, starting at 0,
in `PROOF_LANE_SLOT`, even without a provider. The slot is released when the task ends.
PROVEN tasks take none. Unlaned and `solo` tasks receive no slot, even if the caller set it.
A laned provider starts at most once per slot used; sequential tasks reuse its instance.
Every instance stops together when no unfinished task needs the provider. A dependent must
use its provider's declared lane; a provider on an unknown lane or `solo` is invalid.
Task `env` cannot declare `PROOF_LANE_SLOT`.

A failed laned start (including rejected exports) retires its slot and records that task
incomplete. Later RUN tasks use healthy slots; admission capacity drops by one per retired
slot, never below 1. If every slot fails, remaining RUN tasks in that lane record incomplete
with an exhausted-lane reason, including tasks without providers. Existing active tasks finish.
An ordinary red task releases its slot without retiring it.

Override limits up or down for one run:

```sh
PROOF_LANES=ios=1 proof run --fresh --jobs 3
PROOF_LANES=ios=3 proof run --fresh --jobs 3
```

The first example reuses one instance; the second permits up to three slots (this example
has two simulator tasks). Unspecified lanes retain their declared limits. `PROOF_LANES`
accepts comma-separated `name=N` entries with positive safe decimal integers. Empty values,
whitespace, leading zeros, duplicate or unknown names (including `solo`), fractions and extra
`=` signs exit 2 before any task or provider starts, even in an all-PROVEN or empty run.

Task lanes, provider lanes and effective limits are read once when the run starts. Like task sets, they do not enter
proof identity: slots, provider instances and limits do not change keys; changing them preserves proofs, except for a task selecting `proof.yaml`,
whose bytes enter its key. Limits apply per `proof run`; separate invocations do not share
capacity. Per-host locking across clones (design §4.11) remains a milestone Candidate.

The first interrupt signals every active task and provider-start process group; a second
kills every active group, including teardown. Interrupted tasks record incomplete. A sandbox
failure cancels and drains siblings before returning the error; `--fresh` instead records
that task incomplete and finishes the remaining tasks.

`proof run --staged` captures the index once. Declarations, includes, task selection, keys,
workspace resolution and sandbox inputs all use that snapshot. Unstaged and untracked files
neither enter the sandbox nor block publication, with one exception: a provider runs in the
checkout and can see unstaged bytes, so a task with `needs` publishes nothing when a selected
input differs from the snapshot (including untracked, unignored glob matches), and its red
contests no proof. This comparison runs before provider startup for every selected dependent,
including later tasks sharing that provider, and again after execution. A startup mismatch still
blocks publication and contests after the checkout is restored. Provider edits, including
changes to the index, cannot replace the captured task view. Existing link
escape checks still apply. Proofs keep the parent commit with a ` (staged)` marker.

For the quickstart's `text` task, stage the desired edit before running the hook:

```sh
git add src/text.ts
# Further edits to src/text.ts can remain unstaged.
bunx proof run --staged
# With sets: [commit] declared on the task:
bunx proof run --staged --set commit
git commit -m "Proven staged change"
bunx proof plan
bunx proof run
bunx proof why text
```

After commit, `plan` and `run` report PROVEN for the committed inputs without executing again.
If an unstaged input edit remains, plain `plan` reports `dirty input`; restore or commit it
before expecting PROVEN. A different committed input gets its own key.

A missing indexed input stays absent even if a file exists on disk. For example, with
`{path: absent.json, json: [value]}` declared but absent from the index, `proof run --staged`
reports the missing input and `not recorded`; a task reading it fails. An unmerged index exits 2
and names the unmerged paths. Stage the resolution to run before completing the merge commit.
`proof run --staged --fresh` and `proof run --fresh --staged` both exit 2 with usage.
`why` prints current parts and staged provenance, then
`historical comparison unavailable: staged proof`: the parent is not the proven tree.

`proof run --fresh` executes every task even when its key is already proven, in the same
sandboxes and with the same providers as an ordinary run. Select a subset with
`proof run --fresh --tasks first second` or `proof run --fresh --set commit`.
Only selected tasks execute, even when other sets have proofs. Providers start once for selected dependents,
including proven ones. A red does not stop later tasks; each result is recorded independently.

Task `sets` are arbitrary names owned by the repository, separate from the named `$input` sets.
A task can belong to several sets; a selected run considers it once. A task with missing or
empty `sets` belongs to no set. Plain `plan` and `run` include every task, including unassigned tasks.
`plan` and `run` select membership from the current working declarations; `status` selects it
from the requested ref. For the declaration above:

```sh
bunx proof plan --set push --json
bunx proof run --set commit
bunx proof run --fresh --set commit
bunx proof status --set push --ref HEAD --json
```

An ordinary selected run skips PROVEN tasks. An unknown set exits 2 and names the known sets
(or `none`). Combining `--set` and `--tasks` also exits 2 before executing anything.
Membership itself does not enter proof identity: moving a task between sets preserves its proof.
If a declaration file is explicitly selected as a task input, its bytes still enter that task's key.

A fresh red over unchanged selected inputs immediately deletes that key's stored green and
records a `super` contradiction. The summary lists every red and each confirmed deletion as
`deleted proof local <task> <key>` or `deleted proof shared <task> <key>`. Ordinary runs still
contest a green on the first red and delete it on the second. A clean fresh green publishes
proof, including for a contested key. Incomplete results and interrupts delete nothing. A task whose sandbox can't be built records
`incomplete` and the rest still run, so a scheduled run finishes; the run exits 1 and names it.

Ordinary globs consider tracked paths and untracked paths that Git does not ignore. An ignored literal
input is missing: it stays outside the sandbox and prevents recording, with its path reported.
Use `links` for ignored file access and `{dotenv: path}` for dotenv value identities.

A dirty tree still executes (a dirty declaration runs without recording) and records results, but says `no proof published` with a reason.
A red over dirty selected inputs cannot delete proof of the committed bytes; unrelated dirt
does not prevent deletion. Offline deletions apply locally and say `not shared`; an attempted
share whose commit is uncertain says `sharing uncertain` and claims no shared deletion.
Reconnection does not replay results. Schedule fresh runs in the repository using cron or
launchd; proof provides no scheduler.

`plan --json` and `status --ref <ref> --json` return arrays of task decisions.
Each row has `task`, `state` and `reason`. A decidable row also has `key`, the
64-character lowercase hexadecimal key that `run` records, even when no proof exists.
An undecidable row omits `key` and explains the cause in `reason`.
RUN rows with `needs` also include `providers`, the names a run would start;
PROVEN rows and tasks without needs omit `providers`.

For a committed `text` task selecting `src/text.ts`, using a fresh store with no proofs:

```sh
bunx proof plan --json
bunx proof status --ref HEAD --json
printf 'unrelated\n' > notes.txt
bunx proof plan --json
git tag release
bunx proof plan --json
printf 'export const text = 2;\n' > src/text.ts
bunx proof plan --json
bunx proof status --ref HEAD --json
```

The first two commands print identical RUN rows with `reason: "no proof for key"`
and the same `key`. The untracked note and tag leave the plan row unchanged.
The input edit makes plan omit `key` and report
`undecidable: dirty input 'src/text.ts'`; status still prints the original committed row.
Committing the input edit gives plan a different key. Plan exits 0 throughout;
status exits 1 here because the task has no proof.

`proof why <task>` starts with the task's `plan` decision, then prints its current key
parts: selected paths with file identities and modes, JSON member identities, declared env and dimension names
(without values), and the declaration hash. These parts use the files on disk, including staged
and unstaged edits, deletions and untracked additions that Git does not ignore. Git decides whether a
tracked path is clean, so a line-ending or LFS filter never reads as a change; blob ids of
dirty paths hash their raw bytes. Whole-selected object manifests instead print a SHA-256 identity
of their bytes with the version value blanked, rather than a Git blob id.
Plan's dirty-input eligibility stays the same. Resolver-only manifests print
`member package.json <member> <mode> <hash>` lines instead of a `file package.json` line.
A version-only edit reports `no inputs changed` in the comparison even when the dirty rule
requires RUN; a resolution-member edit reports, for example, `changed member package.json name`.

For the README's shared-file example, `proof why reader` includes these lines after a
committed edit to `shared.txt`:

```text
unkeyed shared.txt
no inputs changed
```

Each received unkeyed file appears once, sorted, instead of its file or member identity.
The representative still prints `file shared.txt <mode> <hash>`. A policy change lists
`now unkeyed shared.txt` when adopting the exclusion, or `now keyed shared.txt` when restoring
its contribution, rather than claiming no inputs changed. These lines compare against the
newest surviving proof, just like other differences.

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

`proof status --ref <ref> [--set <name>] [--json]` judges selected tasks using that ref's committed
`proof.yaml`, included declarations and input bytes, plus the caller's declared env and
dimension values.
It resolves branches, commit ids, lightweight tags and annotated tags without checking out the
ref, running tasks or starting providers. Input bytes come from the ref; env, dotenv and dimension
values come from this invocation. For example:

```sh
bunx proof status --ref HEAD --json
bunx proof status --ref release --json
```

Rows use the same format as `plan`: PROVEN names the proof's commit, host and time; RUN explains
`no proof for key`, a contested proof or an undecidable key. JSON has the same row shape as
`plan --json`. Status exits 0 when every selected task is PROVEN (including a ref with no tasks), 1 when
any selected task is RUN, and 2 for an unknown ref, invalid declarations, usage or store error. An
unreachable store uses the local replica and reports the fallback on stderr, keeping JSON
stdout parseable.

Status reads the ref's committed files and declarations, declared env, checkout dotenv values,
and dimension commands evaluated on the current machine. `plan` also looks at this checkout,
so `status --ref HEAD` can say PROVEN where
`plan` says RUN when the checkout has something the commit doesn't: an uncommitted, unignored file
a task selects, a file hidden by `assume-unchanged` or
`skip-worktree`, or a linked `node_modules` escaping into tracked files. Status's `trusted links`
suffix restates the declaration rather than reporting an inspection.

`proof stats [--set <name>] [--since Nd]` reports the current declaration roster in
its declared order. `--set` scopes every task, count, estimate and total to that set;
an unknown set exits 2 as in `plan`. Removed or renamed tasks leave all figures.
Each task's median uses every timed green result across keys, hosts and dates,
including dirty results. An even sample averages its middle two values; untimed
and non-green results do not price skips. Run counts include green, red and incomplete results,
timed or untimed, in the current window; manual invalidation records are excluded.

`--since` defaults to `30d` and accepts positive whole days with representable calendar
boundaries. The current window includes today and the preceding N−1 local calendar days;
the previous window is the N days before it. Both use the reading machine's timezone,
with inclusive start and exclusive end midnights. Skips retain the recording machine's
local date. Invalid, missing, repeated or unknown flags exit 2 with usage.

For a committed `text` task in `sets: [push]`, with no earlier history:

```sh
proof record text --outcome green --seconds 20
proof run
proof run
proof run
proof stats
proof stats --set push --since 2d
```

The last command prints:

```text
text: median 20s; 1 runs in 2d
estimated 0m for 0 RUN tasks
saved 1m of 1.33m in 2d (75%); previous 2d: unavailable
```

The estimate sums medians for today's selected RUN tasks, counting and naming tasks
without a timed green as `; unpriced <count>: <tasks>`. It excludes PROVEN tasks.
The last line measures recorded savings: each skip costs the same all-time median in
both windows. Its total adds actual timed result seconds of every outcome. Numbers
round to two decimal places with trailing zeroes stripped; percentages use unrounded
totals. A zero total prints `unavailable`. Unpriced skips append
`; unpriced skips: <count> current, <count> previous`; they never silently cost zero.
A zero-second green is a priced sample.

Only `run` records skips, at its final PROVEN decisions; `plan` and `stats` record none.
Stats reads history from the shared store when online, or this machine's replica with
the usual loud fallback, never adding both backends together. It runs no tasks or providers.

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

`proof flakes [--since Nd]` reports the committed project's contradiction history,
including removed tasks. It prints `ordinary task super` followed by rows ranked by
ordinary count descending, then task name ascending. Super counts are separate;
a super-only task appears with ordinary count 0. Manual deletions never count.
With no rows it prints `no contradictions in 30d` (or the selected window) and exits 0.
The default is `30d`; positive whole days select the last N local calendar days including
today, starting at local midnight, as in `stats`. Missing, repeated, malformed or
unrepresentable windows and unknown flags exit 2 with usage. History comes from one
backend: shared when online, otherwise local with the fallback diagnostic.

```sh
proof flakes
proof flakes --since 7d
```

`proof invalidate --task <t> [--key k | --all]` deletes the task's proof for its key at
committed HEAD by default. Checkout dirt does not change that key. An undeclared task
or undecidable HEAD key exits 2. Explicit `--key` deletes only that key; `--all` enumerates
the task's existing keys independently in each backend. Both explicit forms support
removed tasks and bypass input evaluation, but still require a committed project declaration.
They do not exclude future concurrent proof publications.

```sh
proof invalidate --task b
proof invalidate --task b --key "$key"
proof invalidate --task b --all
```

Here `$key` is the stored proof key to clear. Local-only output is `deleted N proof(s)`;
a configured store reports local and shared counts separately. No proof prints `deleted 0`
and exits 0. A deletion inserts an untimed `manual` result and a `manual` contradiction in
the same per-key transaction. A later clean green restores PROVEN without a contest.
Missing task or values, duplicate or unknown flags, and `--key` with `--all` exit 2.

An unreachable shared store leaves the local deletion committed but exits 2 with
`shared proof may survive`; a green exit confirms both backends completed. There is no
manual veto or replay on reconnect. Another clone learns the deletion when planning online;
a locally retained proof then runs offline with `contested: red at <commit>`, using the
existing contest representation for the manual deletion. See [store operations](store.md).
