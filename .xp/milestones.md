# Milestones

A user-facing goal is measured where users are.

Each Measure is one shell line run from the repository root. It prints the
remaining distance in one line: a cheap read over records or files, never a test
run. A dated source prints its own trend. Candidates are optional discoveries
belonging to this goal; start the next slate there.

## Run only what might fail
Goal: Paul: "only running what actually needs to run after a change, nothing extra"; 99% is fine, and wasted test time is a defect (docs/2026-10-30-proof-requirements.md §1).
Measure: bun --no-env-file src/cli.ts stats --since 7d 2>&1 | tail -1
Candidates: `run` on app-a (unmeasured); Python closures (R5), R11 stack reuse and R20 when app-b adopts or `run` is live on app-a; per-host lane locks (design §4.11)

## Overlap without overdraft
Goal: Paul (via legacy-mini, #74): "a usable solution that works for multiple projects and doesn't overdraft CPU"; "careful with lanes that we don't blow CPU". The run overlaps tasks up to what the host can give.
Measure: sqlite3 -readonly ~/.local/state/proof/proof.db "WITH d AS (SELECT max(substr(finished_at,1,10)) day FROM results WHERE project='legacy' AND substr(finished_at,12,5) BETWEEN '10:00' AND '10:10'), r AS (SELECT seconds, finished_at FROM results, d WHERE project='legacy' AND finished_at BETWEEN day||'T10:00' AND day||'T16:00') SELECT 'legacy super '||(SELECT day FROM d)||': '||count(*)||' results, wall '||round((julianday(max(finished_at))-julianday(min(finished_at)))*1440)||' min, mean concurrency '||round(sum(seconds)/86400.0/(julianday(max(finished_at))-julianday(min(finished_at))),2) FROM r"
Candidates: host-CPU admission gate (#74 card c: os.cpus() idle sampling, one admission per sample above C/2); per-task rusage weights only if the gate still lets heavy tasks stack (#74 d)
