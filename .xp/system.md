# System

**Product**: `proof` tells anyone working on a repository exactly which tests and
gates must run after a change and which are already proven, and shares that proof
across clones and machines through one Postgres store. Day-one consumers are
app-a (a Bun and Python monorepo, about 230 tasks) and app-b (a smaller Bun
monorepo). Requirements: `docs/2026-10-30-proof-requirements.md`; design and
review alongside it in `docs/`.

**Stack**: TypeScript on Bun (>= 1.4.4), zero runtime dependencies. `bun test`,
`tsc --noEmit`, Biome for lint and format. Store: Postgres in a pinned Docker
image (`Bun.sql`), with a local `bun:sqlite` replica.

**Surfaces & acceptance**: CLI only (`proof plan|run|why|status|record|invalidate|
flakes|stats|check|lint|doctor`, `plan --json`). Acceptance spawns the CLI as a
subprocess against a synthetic git repo built in a temp directory and asserts on
exit code, stdout and stderr. Store-backed acceptance needs a Postgres harness:
not built yet, the first debt worth filing.

**Distribution**: consumers depend on
`git+https://github.com/paulingalls/proof.git#vX.Y.Z` and call the `proof` bin
(`src/cli.ts`, run directly by Bun, no build). Each sprint release is a tag.

**Layout**:
- `src/cli.ts`: the bin entry
- `src/`: core (parser, hashing, key, store, planner, executor, sandboxes)
- `src/adapters/`: shipped adapters (`imports-of`, `maestro`, `dotenv-keys`, `json`)
- `test/`: behavior tests driving the CLI
- `docs/`: requirements, design, adversarial review

**Worktree setup**: `bun install`

**Conventions**: Single quotes, semicolons, 2-space indent, 100 columns (Biome
enforces). Every task the planner decides to skip has a printable reason; every
task it runs has one too.
