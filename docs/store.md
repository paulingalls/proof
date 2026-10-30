# Store fallback and consistency

With a Postgres store configured, every result this machine records is committed
first to its local SQLite file, `proof.db` in its state directory, then to
Postgres. Both records carry the same metadata and timestamp, with independent
result IDs. SQLite stores only this machine's own results; reading a shared proof
does not import another machine's results. Online planning uses the shared answer,
even when an unshared green exists locally.

A connection attempt has a two-second timeout. If the store is unreachable at
startup, during a read, or while publishing, the command switches to the local
replica and prints one line to stderr:

```text
store unreachable (<reason>); using this machine's own proofs
```

A result written after that switch says `not shared`. A result whose shared write
was attempted before connection loss says `sharing uncertain`: the shared
transaction may have committed. The command makes no further remote operations
or application retries. Fallback preserves task exit codes. Authentication,
schema-version and query errors remain errors (exit 2), even with usable local
proofs. The connection timeout does not bound a query on an established session
that silently stops responding.

The replica also remembers shared contests and confirmed proof deletions this
machine has observed through `plan` or `record` (including results published by
`run`). Observations attach to the local proof's result ID and retain the red's
commit and host, without importing its result. A remembered contest survives
reopening, offline use, and removal of the remote configuration. Incomplete
results and dirty greens leave it contested; the next eligible red deletes the
proof, and an eligible local green creates a fresh proof. Reading another
machine's later green does not clear the local marker. Shared absence alone is
not evidence of deletion: an unshared local green survives it. A confirmed
deletion is remembered by key regardless of timestamps across machines, so it
can require one extra run of a newer local green.

A red this machine never saw before going offline cannot be known locally. An
offline proof therefore cannot guarantee that the shared store has no newer red.
R10's super run, which runs every task fresh, is the specified backstop; this
section does not imply that command is already implemented.

Nothing is queued, replayed, or uploaded on reconnect. Local proofs are never
copied to Postgres retroactively. A missed share costs another run. Without a
Postgres configuration, the existing SQLite-only lifecycle prints no replica or
sharing diagnostics.
