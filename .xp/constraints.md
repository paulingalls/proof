# Constraints

Reversing one of these makes it a different project. Cap the entire UTF-8 file at
4,500 bytes to fit Codex's 10,000-byte SessionStart hook limit. Reviewers enforce
these and cite the item. A rule a hook or the plugin already enforces is a second
copy: delete it.

1. **One mechanism per job.** Before adding a mechanism, name the existing one it
   replaces or extends. app-a grew five overlapping reuse mechanisms from locally
   correct cards and none met the goal; "done" is a requirement-suite case going
   green, never "the mechanism exists". A card names the cases it turns green and
   turns no green case red.
2. **Zero runtime dependencies.** Bun and its built-ins (`Bun.sql`, `bun:sqlite`,
   `Bun.spawn`) only. Dev dependencies are fine.
3. **Nothing from a consumer leaks into the core.** No app-a, app-b or
   xp-plugin vocabulary in the schema, task kinds, CLI or messages. Run-set names
   belong to each repo's `proof.yaml`.
4. **Fail loud; never skip silently.** Raise instead of returning null or empty. An
   undecidable task runs and says why. A missing input fails. No fallback that
   masks a defect; the store fallback (R14) announces itself.
5. **Test behavior at the outermost boundary that reaches it, once.** Drive the
   CLI against synthetic repos built in temp directories. When an integration or
   acceptance test covers a behavior, delete the unit tests that duplicate it.
6. **No tests of tests.** A guard is fault-injected once, when added, only if its
   failure would be silent or corrupting. No meta-tests of gates.
7. **Tests cost what code costs.** Test lines stay at or below twice the lines
   they test. The commit hook finishes in under a minute.
8. **Small files: target 300 lines, hard cap 500, tests included.** Extract,
   do not scroll.
9. **Comments carry only what a test or a name cannot**: the why, an external
   constraint, a rejected design.
10. **Run it before you write it down.** A plan, card, review or decision that
    claims what code does has read or executed that code first.
11. **The requirements win.** `docs/2026-10-30-proof-requirements.md` holds Paul's
    decisions. A change to one, or a premise found false, goes to Paul.
12. **This Mac is shared.** Never edit, commit or push in any repository but this
    one. Never read `.env*` files. No load or stress runs without asking. Check
    Docker compose project labels before touching any container.
