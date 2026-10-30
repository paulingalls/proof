# Changelog

## 0.4.0

- `{imports-of: <entry>}` inputs: a TypeScript import closure computed from git blobs at any ref,
  following relative imports, workspace packages (`exports` resolved as Bun does), tsconfig `paths`,
  `baseUrl` and `extends`. Every `package.json` and `tsconfig.json` consulted is keyed. Anything it
  cannot follow (a computed import, an unresolved specifier) makes the task undecidable, so it runs.
- A linked `node_modules` (root or per-package) reaches workspace packages inside the sandbox, through
  the task's own keyed files, so tasks importing workspace packages can publish. An installed package
  that declares a workspace dependency still blocks publication.
- The commit hook runs the fast tests; `*.slow.test.ts` run at push and in the release suite.

## 0.3.0

- `proof run [--tasks ...]`: executes each RUN task in a sandbox holding only its selected inputs
  (exact bytes and modes), with the environment cleared to `PATH`, `HOME`, `TMPDIR` and its `env:`
  names, and records the result against the key captured before it ran. A proof is published only
  when the tree was clean and is unchanged after. It exits 1 on any red; an undecidable task alone
  does not fail the run.
- Interrupting `proof run` records the task `incomplete`, starts nothing more, and exits 130/143; a
  second interrupt kills the task's process group.
- `links:` symlinks untracked dependencies (`node_modules`, `.venv`) into the sandbox. A link that
  reaches tracked files, directly or through workspace symlinks or `.pth` entries, never publishes.
- A file's git mode is part of its key (scheme 2): every existing proof re-proves once.
- With a dirty `proof.yaml`, `plan` and `run` use the working-tree declarations and record nothing.
- proof works from any subdirectory of the repo.

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
