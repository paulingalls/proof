# Changelog

## 0.2.0

- `proof check` and `proof plan` at app-a's size: 14 cases in 0.61 s (was 11.5 s) and a plan in
  0.24 s on a 10.8k-file, 230-task repo. Keys are unchanged from 0.1.0.
- JSON projections: `{path, json: [members]}` hashes only the named top-level members, so a
  version-only bump runs nothing.
- `env:` names enter a task's key as value hashes; values are never stored or printed.
- A duplicate key in any declaration or cases file fails loudly, with file, line and key.
- `proof lint` reads the staged index and reports unmatched inputs, unowned paths under the
  repo's `coverage:` globs, and invalid `exempt:` entries.

## 0.1.0

- `proof check <cases.yaml>`: each case's RUN set, computed from two refs' blobs and declarations
  (no checkout, no diff base), against its expectation.
- `proof plan [--json]`: RUN or PROVEN per task at HEAD, with a reason; any dirty input or
  declaration makes a task undecidable.
- `proof record <task> --outcome green|red|incomplete`: results in a local SQLite store outside
  the repo; only a clean tree publishes a proof.
- The contested rule: a red after a green makes the task run once more; a green restores the
  proof, a second red deletes it.
- Submodule pointers are inputs; a `.gitmodules` ignore setting cannot hide one.
