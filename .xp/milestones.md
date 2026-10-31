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
