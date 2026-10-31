# Commands

```
proof plan [--set <name>] [--json]  what must run, and why
proof why <task>            current key parts and changes since the newest proof
proof status --ref <ref> [--set <name>] [--json]  proof state at a committed ref
proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]  run tasks and record each result
proof record <task> --outcome green|red|incomplete [--seconds N]
proof lint                   check declarations against the staged tree
proof check <cases.yaml>     run a requirement suite
proof doctor                 which store is in use, and whether it's reachable
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
`<state directory>/logs/<project>/<task>/<UTC timestamp>-<first 8 of key>-<outcome>.log`.
Keyless tasks and provider starts use `no-key`. Project and task names are encoded as single
path segments (including `/`, `:`, `%`, `.` and `..`). Each task keeps its newest ten logs;
a green deletes its capture and leaves earlier logs alone. The state directory is the same
one as the local replica, outside checkouts by default. A `PROOF_STATE_DIR` override inside
a checkout also puts logs there, so removing that checkout removes those logs. Logs stay
local and never enter either store: they may contain private data.

Providers start once, all dependents await readiness, and teardown waits for their running
and pending users. Starts use the same capture and display rules, with `--- provider-<name>`
blocks above one job. A failed start's summary names its retained log under `provider-<name>`;
a ready start deletes its capture. Background processes left by provider starts no longer
send output to the terminal after startup finishes. Provider stops keep their inherited streams.

Resource lanes add a limit within `--jobs`. For example, after creating an `input` file:

```yaml
version: 1
project: lane-example
lanes: {ios: 2}
tasks:
  simulator: {run: echo simulator, inputs: [input], lane: ios}
  exclusive: {run: echo exclusive, inputs: [input], lane: solo}
```

Commit the declaration and input, then run `proof run --jobs 3`. At most two `ios` tasks
can occupy the run at once; a task without `lane` is bound only by `--jobs`. Tasks are
admitted in declared order, skipping lanes at capacity. A waiting `solo` stops admission
of later tasks until earlier tasks drain, then occupies the run alone. `solo` is reserved
and needs no declaration. Declaring it in root `lanes`, naming an undeclared lane, or
using a limit other than a positive safe integer is a declaration error (exit 2).

Lanes and limits are read once when the run starts. Like task sets, they do not enter
proof identity: changing them preserves proofs, except for a task selecting `proof.yaml`,
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
input differs from the snapshot (including untracked or ignored glob matches), and its red
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

`proof status --ref <ref> [--set <name>] [--json]` judges selected tasks using that ref's committed
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
`plan --json`. Status exits 0 when every selected task is PROVEN (including a ref with no tasks), 1 when
any selected task is RUN, and 2 for an unknown ref, invalid declarations, usage or store error. An
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

Planned, specified in [R16](2026-10-30-proof-requirements.md) and design §4.6:

```
proof invalidate --task <t> [--key k|--all] delete proofs (recorded as a manual contradiction)
proof flakes [--since 30d]                tasks ranked by contradictions
proof stats [--set land]                  median seconds per task; estimated minutes for a plan
```
