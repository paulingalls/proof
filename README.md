# proof

`proof` tells anyone working on a repository exactly which tests and gates must
run after a change, and which are already proven. It shares that proof across
clones and machines, so a green result earned on one machine is reused by every
other machine with the same tree and environment.

The goal: run only what a change can actually affect, and nothing extra.

## How it works

- **Declarations live in the repo.** `proof.yaml` (plus optional `proof.d/*.yaml`)
  says what each task depends on. Most inputs are derived from the language's own
  tooling: the TypeScript/Bun import closure and a Python import graph. You declare
  only what imports cannot see, such as fixtures, SQL, spawned scripts, env names
  and Maestro flow includes.
- **A key is computed from the tree, never from a diff.** A task's key hashes its id,
  the meaning of its declaration, the content of its inputs, and a small environment
  class. The same tree and environment give the same answer on any clone or
  machine, and a key can be computed for any ref without a checkout.
- **Proofs live in one shared store.** Postgres stores metadata only: task, key,
  outcome, host, timings and contradictions, never logs. Each machine keeps a
  local SQLite fallback.
- **Declarations are enforced, not trusted.** Tasks run in a sandbox holding only
  their inputs, so a missing input fails loudly. An undecidable task always runs.
- **Flakes are contested, not hidden.** A red against a stored green re-runs once.
  A fresh-from-scratch super run is the backstop.

## CLI

```
proof plan [--json]     what must run, and why
proof run               run what must run, and record the results
proof why <task>        the key's parts, and the inputs that changed since the last proof
proof status --ref <r>  proof state at any ref
proof check <cases>     run the requirement suite
proof record | invalidate | flakes | stats | lint | doctor
```

## Status

Pre-alpha. The package is TypeScript on Bun, has zero runtime dependencies, and
is MIT-licensed. Its npm scope is still to be decided.

## Docs

- [Requirements](docs/2026-10-30-proof-requirements.md): the owner's decisions. Where the other docs conflict with these, these win.
- [Design](docs/2026-10-29-test-proof-design.md): inventory, measurements, model, CLI, and build-vs-adopt.
- [Adversarial review](docs/2026-10-29-test-proof-design-answers.md): answers to the design's open questions.
