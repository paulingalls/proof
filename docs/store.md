# Store operations

With a Postgres store configured, every result this machine records is committed
first to its local SQLite file, `proof.db` in its state directory, then to
Postgres. Both records carry the same metadata and timestamp, with independent
result IDs. SQLite stores only this machine's own results; reading a shared proof
does not import another machine's results. Online planning uses the shared answer,
even when an unshared green exists locally. An eligible local red whose share is
absent or uncertain vetoes a shared green after reconnect. This per-key veto
survives local proof deletion; incomplete results and dirty greens cannot clear
it. A clean local green clears it, as does confirmation that the red was shared.
Reconnection alone does not.

For `plan`, `run`, `record`, `status` and `why`, a connection attempt has a two-second timeout. If
the store is unreachable at startup, during a read, or while publishing, the
command switches to the local replica and prints one line to stderr:

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
`proof run --fresh` is R10's backstop: it executes every selected task regardless of proofs.
An eligible fresh red deletes the proof immediately and writes a `super` contradiction in the
same transaction. A fresh green uses the normal clean-green publication path. Incomplete
results and reds over dirty selected inputs delete nothing. Ordinary reds retain R9's
contest-then-delete rule. Contradiction kind is unconstrained text; `super` needs no schema bump.

Deletion summaries name the task and key separately for local and shared commits. The store
returns confirmed deletion decisions after commit; a pre-run lookup cannot establish that a
proof was deleted. If a remote commit is lost, the summary reports `sharing uncertain` and
any confirmed local deletion, without claiming shared deletion. An offline fresh red's local
veto survives deletion and blocks a still-green remote after reconnect until a clean local
green or confirmed red share clears it.

Nothing is queued, replayed, or uploaded on reconnect. Local proofs are never
copied to Postgres retroactively. A missed share costs another run. Without a
Postgres configuration, `plan`, `run` and `record` print no replica or sharing diagnostics.

Proof metadata includes one identity per declared env name: `absent` or SHA-256 of its value.
No env value is stored. These identities are captured with the key by both `record` and `run`;
`why` uses them to explain env changes. Schema 2 adds nullable `proofs.env_hashes`, encoded as
JSON name/identity pairs. NULL denotes a legacy proof whose env comparison is unavailable;
`[]` denotes a new proof with no declared env. Migration preserves existing results and proofs
without backfilling env data.

The first client at this version migrates a fresh, unversioned or schema-1 store to schema 2
under the schema transaction/lock. Any command opening the store can migrate it, including
`doctor`. An older pinned client then exits 2 naming the stored and supported versions until it
upgrades. Upgrade clients sharing a store together. Newer unsupported schemas are rejected
without changing history.

`why` reads the newest surviving proof across keys from the shared store when reachable,
ordered by finish time and result id. Contested proofs remain comparison baselines. Shared reads
do not import remote history into SQLite; offline explanations use only this machine's proofs.

## Start the host

Use Docker Desktop on the host Mac. Keep the first laptop on power and awake;
the later Mac mini must stay awake too. Arrange for Docker Desktop and Tailscale
to start after login before relying on this cache. A stopped or sleeping host
makes clients use their local proofs.

Set these shell variables first. Choose a fresh container and volume name and a
unique ownership label; keep the password outside the repository and shell history
(for example, `read -r -s POSTGRES_PASSWORD` in zsh). Export the variables.

```sh
export PROOF_CONTAINER=proof-store PROOF_VOLUME=proof-store-data
export PROOF_LABEL=proof.store=operator-owned PROOF_PORT=5432
export POSTGRES_USER=proof POSTGRES_DB=proof
# Set and export POSTGRES_PASSWORD privately before proceeding.
```

The following block is also executed by acceptance with scratch values. It uses
a single database owner: initialization needs CREATE TABLE privileges. The named
volume survives container replacement. The digest pins Postgres 17 Alpine.

<!-- proof-start -->
```sh
set -eu
: "${PROOF_CONTAINER:?}" "${PROOF_VOLUME:?}" "${PROOF_LABEL:?}" "${PROOF_PORT:?}"
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${POSTGRES_PASSWORD:?}"
owned_docker() {
  actual=$(docker inspect --format '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}} {{end}}' "$PROOF_CONTAINER")
  case " $actual " in *" $PROOF_LABEL "*) ;; *) return 1 ;; esac
  case "$actual" in *com.docker.compose.project=*) return 1 ;; esac
  docker "$@"
}
docker volume create --label "$PROOF_LABEL" "$PROOF_VOLUME"
docker run -d --name "$PROOF_CONTAINER" --label "$PROOF_LABEL" \
  --restart unless-stopped -p "127.0.0.1:${PROOF_PORT}:5432" \
  -e POSTGRES_USER -e POSTGRES_DB -e POSTGRES_PASSWORD \
  -v "$PROOF_VOLUME:/var/lib/postgresql/data" \
  postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
attempt=0
until owned_docker exec "$PROOF_CONTAINER" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || exit 1
  sleep 1
done
owned_docker exec -u postgres "$PROOF_CONTAINER" sh -eu -c '
  printf "%s\n" "local all all trust" "host all all samenet scram-sha-256" > "$PGDATA/pg_hba.conf"
  pg_ctl reload
'
```
<!-- proof-end -->

Paste the block into a dedicated shell and keep that shell for the commands
below, which reuse `owned_docker`. It enables error handling with `set -eu`. If
startup fails, inspect and remove only your labelled resources. Never touch a Compose
container. Before subsequent `docker exec`, stop, restart or removal, inspect
`docker inspect "$PROOF_CONTAINER"` and confirm the ownership label and absence
of `com.docker.compose.project`; `owned_docker` above does that for execs.
Inspect a volume's labels with `docker volume inspect "$PROOF_VOLUME"` before
removing it. `docker rm -v` does not remove a named volume.

TCP readiness avoids the image's temporary socket-only initialization server.
The image defaults to `listen_addresses = '*'`; check the effective setting and
HBA after startup:

```sh
owned_docker exec -u postgres "$PROOF_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SHOW listen_addresses'
owned_docker exec -u postgres "$PROOF_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT type, address, auth_method, error FROM pg_hba_file_rules'
```

The replacement HBA has no broad remote allow rule. Unix-socket administration
inside the container is trusted; TCP always requires a password. `samenet`
admits Docker's directly connected network. Docker Desktop rewrites source
addresses, so Postgres cannot enforce tailnet membership. Publishing only on
127.0.0.1 keeps the port off the LAN. Tailscale and its policy enforce membership.

## Expose only to your devices

Make the `tailscale` CLI available in your PATH (the Mac app also ships it at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`). After reviewing the
tailnet policy, run on the host:

```sh
tailscale serve --bg --tcp 5432 tcp://127.0.0.1:5432
tailscale serve status
```

This changes host configuration and is deliberately excluded from acceptance.
Use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
not Funnel. Restrict TCP 5432 to explicit device sources in the
[tailnet policy](https://tailscale.com/docs/reference/syntax/policy-file).
For example, replace every documentation address below with your devices'
Tailscale addresses (including a representative excluded device):

```json
{
  "hosts": {
    "proof-host": "100.64.0.10",
    "own-laptop": "100.64.0.11",
    "own-desktop": "100.64.0.12",
    "excluded-device": "100.64.0.13"
  },
  "acls": [
    { "action": "accept", "proto": "tcp", "src": ["own-laptop", "own-desktop"], "dst": ["proof-host:5432"] }
  ],
  "tests": [
    { "src": "own-laptop", "accept": ["proof-host:5432"] },
    { "src": "own-desktop", "accept": ["proof-host:5432"] },
    { "src": "excluded-device", "deny": ["proof-host:5432"] }
  ]
}
```

Merge with the existing policy and run its policy tests before saving. Rules are
additive: an existing broad allow (including a grant) must not also admit other
nodes to this port. Verify doctor from an allowed device; verify TCP refusal from
an excluded tailnet node and a LAN-only device. Loopback acceptance proves none
of those network checks. Every TCP client still needs the database password.

## Configure clients and diagnose

The user config is `${XDG_CONFIG_HOME:-$HOME/.config}/proof/store`. Put the URL
alone on its first line, with no YAML and no `PROOF_STORE=` prefix. For example,
using placeholders only:

```text
postgres://proof:PERCENT_ENCODED_PASSWORD@HOST.TAILNET.ts.net:5432/proof
```

Use the host's Tailscale MagicDNS name. Percent-encode reserved characters in
username, password and database name. Create the directory with mode 700 and the
file with mode 600 (`umask 077` before writing it). `PROOF_STORE` in the environment
takes precedence over the file; do not commit either credentials or real names.

Run `proof doctor` inside a repository with `proof.yaml`. It prints labelled
Store, Reachability, Schema version, Replica, Project and Bun lines. The URL is
redacted to protocol and host/port. An empty store initializes through the same
schema lifecycle as plan. Exit 0 means reachable; exit 1 means a configured store
is unreachable, with a reason and schema `unavailable`. Doctor never substitutes
the replica's health for remote health. Authentication, schema and query errors
exit 2. With no remote configured it diagnoses SQLite and exits 0 on success.

The SQLite filename is `proof.db` under `PROOF_STATE_DIR`, otherwise
`$XDG_STATE_HOME/proof`, otherwise `$HOME/.local/state/proof`. Doctor prints that
path even with no remote configured.

## Back up and move hosts

Use the pinned container's tools, with the ownership checks above. Keep backups
outside the container and volume, with user-only permissions:

```sh
umask 077
owned_docker exec -u postgres "$PROOF_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > proof-store.dump
owned_docker exec -u postgres "$PROOF_CONTAINER" createdb -U "$POSTGRES_USER" proof_restore
owned_docker exec -i -u postgres "$PROOF_CONTAINER" pg_restore -U "$POSTGRES_USER" -d proof_restore --exit-on-error < proof-store.dump
```

The last two commands rehearse restoration into a fresh database. Compare result,
proof and contradiction counts with the source and run doctor against that
database. For migration, start the pinned image on the new host with a fresh
named volume, transfer the dump privately, and restore into its empty database
with the same `pg_restore` command (substitute its database name). Configure its
loopback publish, Tailscale Serve and policy, then change the MagicDNS host in
clients' user config and run doctor. Avoid writes during the final dump/cutover
if retaining every shared result matters. Keep the old volume until verified.

Starting empty is also valid: initialize a fresh volume, update clients, and run
doctor. Lost cache history costs reruns, not correctness. Local results are never
uploaded retroactively, including after a host move.
