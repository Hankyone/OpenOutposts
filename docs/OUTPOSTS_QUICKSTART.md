# Outposts quickstart

This walkthrough runs the core OpenOutposts loop on one machine: the control plane locally, a worker
registered against it, and an agent whose brain runs centrally while every file and shell operation
executes on the worker.

## Prerequisites

- Node.js 22+, Go 1.24+
- `npm install && npm run build:foundation` from the repository root
- `jq` on your PATH (the migration script parses wrangler's JSON output with it)
- A local web login configured from `packages/web/.env.example`. GitHub or Google OAuth is needed
  because machine ownership comes from the signed-in user; anonymous enrollment is deliberately
  unavailable.
- For the full agent mode: an API key for one model provider [Pi](https://pi.dev) supports. Nothing
  needs installing — Pi is embedded in the homestead as a library — but a session reads credentials
  only from its own scratch agent directory and never from your personal Pi configuration, so the
  key has to reach it one of the two ways described in steps 5 and 6.

## 1. Migrate the local database

The control plane reads its state from D1. `wrangler dev --local` creates the local database file
but never creates any tables in it, so a fresh checkout starts with an empty schema and the first
thing you do in the UI — signing in, which writes `api_tokens` — fails with a missing-table error.
Run the migrations first:

```sh
npm run db:migrate:local
```

That is `scripts/d1-migrate.sh --local openoutposts-test`, run from the repository root. It targets
the D1 binding declared in `packages/control-plane/wrangler.jsonc`, and it applies
`terraform/d1/migrations/*.sql` in numeric order using the same `_schema_migrations` ledger the
production script uses — the local and remote paths differ in nothing but which database wrangler
talks to. Re-running it is a no-op: every already-recorded version is skipped.

If your local database predates the ledger — the tables are already there but `_schema_migrations`
is empty, so a plain run would try to re-create objects that exist — record the history instead of
replaying it:

```sh
npm run db:migrate:local -- --adopt                 # schema is already at head
npm run db:migrate:local -- --adopt-through 0043    # head is 0043; apply 0044+ normally
```

`--adopt` writes ledger rows without executing the SQL, so only use it when you know the schema
really is at that point. The honest alternative on a scratch database is to delete
`packages/control-plane/.wrangler/state/v3/d1` and migrate from empty. Against the production
database the same flags exist but prompt for confirmation first, and `--yes` skips the prompt.

## 2. Start the control plane and web app

```sh
cd packages/control-plane
cat > .dev.vars <<EOF
INTERNAL_CALLBACK_SECRET=dev-internal-secret
SERVICE_AUTH_SECRET_WEB=dev-web-service-secret
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF
npx wrangler dev --local --port 8788
```

In another terminal, finish the local web setup in `packages/web/README.md`. Point it at this
control plane and use the same web service secret:

```text
CONTROL_PLANE_URL=http://127.0.0.1:8788
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8788
SERVICE_AUTH_SECRET=dev-web-service-secret
```

Then start the app:

```sh
npm run dev -w @open-inspect/web
```

Open `http://localhost:3000`, sign in, and open **Machines**.

## 3. Enroll and connect an outpost worker

Build the local worker once and put it on this terminal's PATH:

```sh
cd packages/outpost-worker
go build -o /tmp/openoutpost ./cmd/openoutpost
export PATH="/tmp:$PATH"
mkdir -p /tmp/outpost-workspace
cd /tmp/outpost-workspace
```

On the Machines page, enter a name, choose this machine's operating system, and select **Generate
command**. Copy the command into the worker terminal. It contains a single-use token and uses the
current directory as this machine's allowed workspace root.

The worker creates its machine key, consumes the token, and prints a six-digit code. Enter that code
on the Machines page. Confirmation binds the generated machine ID and public key to your user. The
command then starts the worker, which makes its signed outbound WebSocket connection and begins
heartbeating. Copy the generated machine ID from its card for the next step.

## 4. Run the scripted round trip (no model needed)

```sh
cd packages/homestead
OUTPOST_MACHINE_ID=outpost-replace-with-your-id
OPENOUTPOSTS_CONTROL_PLANE_URL=http://127.0.0.1:8788 \
OPENOUTPOSTS_INTERNAL_SECRET=dev-internal-secret \
node dist/demo.js --outpost "$OUTPOST_MACHINE_ID" --workspace /tmp/outpost-workspace --script
```

This takes a lease and drives `ls`, `write`, `read`, and `bash` through the control plane to the
worker, printing each result. It proves the whole transport chain without spending model tokens.

## 5. Run a real agent session

```sh
export ANTHROPIC_API_KEY=sk-ant-...
OUTPOST_MACHINE_ID=outpost-replace-with-your-id
OPENOUTPOSTS_CONTROL_PLANE_URL=http://127.0.0.1:8788 \
OPENOUTPOSTS_INTERNAL_SECRET=dev-internal-secret \
OPENOUTPOSTS_DEV_PI_KEY_COMMAND='printenv ANTHROPIC_API_KEY' \
node dist/demo.js --outpost "$OUTPOST_MACHINE_ID" --workspace /tmp/outpost-workspace \
  --model anthropic/claude-sonnet-4-5 \
  "Look around the workspace and create a file hello.md that greets the outpost."
```

Pi is embedded in this process as the central brain, in a scratch directory with an empty working
directory and no local tools at all. The model is offered exactly seven tools — `outpost_bash`,
`outpost_read`, `outpost_write`, `outpost_edit`, `outpost_grep`, `outpost_find`, `outpost_ls` — each
of which travels through the control plane's lease to the worker, with results streaming back.

`--model` is required and takes a `provider/model-id` spec, and its first path segment is the
provider the key belongs to.

`OPENOUTPOSTS_DEV_PI_KEY_COMMAND` is run through a shell and its stdout becomes the provider's API
key, so the key never has to be written to disk; `printenv` is the simplest form of it, but a
keychain or secret-manager lookup works the same way. **This is a development mechanism and only the
demo has it.** There is no product session behind this CLI — it drives a lease by hand with the
deployment's internal secret — so there is no session-scoped credential to fetch and no user whose
stored key to fetch it from. The product path is step 6.

Set `OPENOUTPOSTS_DEMO_VERBOSE=1` to see the harness's own logs, including the tool list the session
actually offers the model.

## 6. Run the full product on outposts

The demo CLI above drives the loop directly. The product itself can run on it: sessions created in
the web UI (or via the sessions API) execute through a central homestead instead of a cloud sandbox,
with no UI changes — the homestead speaks the same session protocol a sandbox would.

Configure the control plane (add to `.dev.vars`, restart `wrangler dev`):

```sh
SANDBOX_PROVIDER=outpost
OUTPOST_TARGET_ID=outpost-replace-with-your-id
OUTPOST_TARGET_WORKSPACE_ROOT=/tmp/outpost-workspace/sessions
WORKER_URL=http://127.0.0.1:8788
```

Point the worker's workspace roots at the same directory, then start the central homestead service:

```sh
cd packages/homestead
OPENOUTPOSTS_CONTROL_PLANE_URL=http://127.0.0.1:8788 \
OPENOUTPOSTS_INTERNAL_SECRET=dev-internal-secret \
node dist/homestead-main.js
```

No provider key is configured here, and that is the point. Each session asks the control plane for
its own credential — at start-up and again at the start of every turn — over an endpoint that
accepts only that session's own token, and the control plane answers from the stored credential
belonging to the user who owns the session. The homestead never holds a key of its own and cannot
substitute one; nothing about the credential lands in the session's scratch agent directory at all,
because the key and the token that fetches it are held in memory for the life of the session.

Every session the product creates now flows: session → homestead assignment → workspace directory
created on the outpost → a central Pi session boots → the homestead connects back as the session's
execution side → prompts and streamed events move through the product exactly as before, while every
file and shell operation happens on the outpost.

### Giving a session a key

In production the session's owner stores their provider key once, encrypted, against their own
account; every session they create resolves it. The web settings surface for that is not built yet,
so on a local checkout the practical options are:

- Store it against your user directly through the control plane's credential routes
  (`PUT /provider-credentials/anthropic` with `{"apiKey":"sk-ant-..."}`, authenticated as the
  signed-in user). This is the real path and the one the product uses.
- Or, for a quick loop with no account at all, set the development override on the homestead:

  ```sh
  OPENOUTPOSTS_DEV_PI_KEY_COMMAND='printenv ANTHROPIC_API_KEY' node dist/homestead-main.js
  ```

  **This is a local-development setting only.** It makes every session on that homestead use one
  operator-supplied key regardless of who owns the session — the single-tenant assumption per-user
  credentials exist to remove. The homestead warns about it at start-up and again on every session
  it starts. Never set it on a deployment serving anyone but you.

Either way, a session whose credential cannot be resolved says so in the homestead's log at session
start (`this session has no usable provider credential and every turn will refuse`), naming the
control plane's own reason. The session still starts — its history is worth more than a clean
refusal — and each turn then refuses with that same reason as its `turn.failed` message, so the
cause reaches the user rather than only the log.

Notes:

- The model a session runs on is the one chosen in the product. The homestead does not substitute
  it: a model the homestead cannot reach fails loudly rather than quietly running something else.
- At registration the homestead reports the provider and model catalog Pi actually supports, so the
  product can offer only models a session could run. The report rides on the registration message
  and carries its own version, and a homestead that cannot read a catalog still registers.
- A session's issued credential carries an expiry and the homestead honours it. The credential is
  re-issued at the start of every turn, and again in place if it reaches its expiry inside a long
  turn, so revoking or rotating a vault entry stops or changes a session that is already running. A
  turn that cannot be given a credential does not start; it fails naming the provider and the
  control plane's own reason rather than running on anything else. This costs one control-plane call
  per turn. (Pi's own `!command` auth mechanism caches a command's stdout for the life of the
  process with no invalidation, so it could not carry any of this; the homestead supplies Pi a
  credential store instead, which Pi consults on every model request.)
- Sessions with a repository are cloned into their workspace before the agent starts. By default the
  machine's own git credentials do the clone (only the URL travels — SSH keys and credential helpers
  keep working, any git host works via `OUTPOST_CLONE_URL_TEMPLATE`). Fleet machines with no ambient
  git access can set `OPENOUTPOSTS_CLONE_AUTH=brokered` on the homestead to fetch short-lived
  repo-scoped tokens from the control plane's credential broker instead. Multi-repo sessions and
  diff/PR capture on outposts are still pending.
- In production the same switch is `sandbox_provider = "outpost"` in Terraform, plus the two
  `outpost_target_*` variables and a running `openoutposts-homestead`.

## 7. Keep the homestead and the worker supervised

Both processes are built to outlive a control-plane restart: the worker retries forever with backoff
to a 30-second ceiling, and the homestead reschedules every reconnection attempt, holds an explicit
keepalive handle so its event loop cannot drain mid-outage, and exits non-zero on any unrecoverable
failure. Neither can survive a crash, a kill, a closed terminal, or a reboot without something
restarting it, so anything long-lived runs under a service manager.

Ready-to-edit units ship with each package:

| Platform | Homestead                                                    | Worker                                                         |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| systemd  | `packages/homestead/deploy/openoutposts-homestead.service`   | `packages/outpost-worker/deploy/openoutpost-worker.service`    |
| launchd  | `packages/homestead/deploy/com.openoutposts.homestead.plist` | `packages/outpost-worker/deploy/com.openoutposts.worker.plist` |

Each systemd unit reads its settings from an environment file; copy the matching
`deploy/*.env.example` to `/etc/openoutposts/` and fill it in with mode 0600. The launchd plists
carry the same settings inline, which is why they are developer-machine tools rather than a place to
keep production credentials. Installation commands are in the header comment of each file.

Both are configured to restart on every exit rather than only on a failing one. An exit the operator
did not ask for is a failure whatever code it carried — that is the exact bug this supervision
exists to survive — and `systemctl stop` / `launchctl bootout` still stop the service for good.

## 8. Self-update smoke test

An enrolled worker keeps itself current: it verifies a signed release manifest, applies a binary
patch against the build it is running, replaces its own binary, and re-executes. This runs that
whole loop locally, with a release you sign yourself, so nothing depends on a published channel.

Build two versions of the worker and the release tool:

```sh
cd packages/outpost-worker
mkdir -p /tmp/release/{v1,v2}
go build -o /tmp/release/openoutpost-release ./cmd/openoutpost-release
```

Mint a release key. The seed goes to stdout, and the line to paste into `internal/update/keys.go`
goes to stderr:

```sh
/tmp/release/openoutpost-release keygen > /tmp/release/seed.txt
```

Paste the printed public key into `releasePublicKeysBase64` in
`packages/outpost-worker/internal/update/keys.go`. **A build with an empty key list never updates**
— that is the intended fail-closed default, and it is why this step comes before the builds. Revert
the file when you are done experimenting.

Now build the two versions with the key compiled in:

```sh
go build -trimpath -ldflags "-s -w -X main.version=v0.0.1" \
  -o /tmp/release/v1/openoutpost-$(go env GOOS)-$(go env GOARCH) ./cmd/openoutpost
go build -trimpath -ldflags "-s -w -X main.version=v0.0.2" \
  -o /tmp/release/v2/openoutpost-$(go env GOOS)-$(go env GOARCH) ./cmd/openoutpost
```

Generate both releases and sign the second one:

```sh
cd /tmp/release
./openoutpost-release generate --version v0.0.1 --new-dir ./v1 --out-dir ./out1
./openoutpost-release generate --version v0.0.2 --new-dir ./v2 \
  --previous-manifest ./out1/outpost-worker/stable/manifest.json \
  --previous-blob-dir ./out1 --out-dir ./out2
OPENOUTPOSTS_RELEASE_SIGNING_KEY=$(cat seed.txt) \
  ./openoutpost-release sign --manifest ./out2/outpost-worker/stable/manifest.json
cat ./out2/outpost-worker/stable/manifest.json
```

Look at `patchSize` in the manifest. Two builds that differ only in their version string produce a
patch of a few hundred bytes against a binary of several megabytes — that is what a fleet downloads
for a normal release.

Serve the release directory over loopback and install the older build:

```sh
(cd out2 && python3 -m http.server 8899 --bind 127.0.0.1 &)
mkdir -p install state
cp ./v1/openoutpost-$(go env GOOS)-$(go env GOARCH) ./install/openoutpost
```

Ask the installed worker what it sees, then let it update itself:

```sh
export OPENOUTPOSTS_STATE_DIR=/tmp/release/state
export OPENOUTPOSTS_UPDATE_BASE_URL=http://127.0.0.1:8899
./install/openoutpost update --check     # prints v0.0.1 / v0.0.2, exits 1
./install/openoutpost update             # applies the patch and swaps the binary
./install/openoutpost --version          # v0.0.2
ls install/                              # openoutpost and openoutpost.old
```

`OPENOUTPOSTS_UPDATE_BASE_URL` is the local-testing override. A real outpost worker composes the
same URL from its own control plane (`{control plane}/releases/`), which serves these exact objects
out of the release R2 bucket.

To watch the daemon path instead of the CLI, run `./install/openoutpost` normally with the same two
environment variables set and an enrolled identity. It waits two minutes, then updates only once the
machine is idle, re-executes itself, and the machine's card in the UI shows the new `workerVersion`
after it re-registers. Confirming that registration is what deletes `openoutpost.old`; a build that
fails to register three times in a row is rolled back to it.

Tear down: stop the static server, delete `/tmp/release`, and revert `keys.go`.

## What just happened

1. The homestead asked the control plane for an execution lease binding a product session to the
   outpost and workspace. The worker accepted it over its WebSocket.
2. Pi ran centrally in a scratch directory with an explicit seven-tool allowlist — the workspace
   files never existed where the model runs, and the model had no local shell or file tool to reach
   for.
3. Every tool call was validated against the protocol schema, forwarded over the worker's
   connection, executed inside the leased workspace (absolute paths and traversal outside it are
   rejected), and returned with the request's correlation ID.
4. Releasing the lease ended the worker's authority to act for that session.

## Session longevity

Sessions are built to live indefinitely — days, months, years — through dormancy, not immortal
processes. An idle session goes to sleep: the product stops it after its inactivity window, the
homestead releases the machine (no process, no lease, no authority), and the workspace directory on
the outpost remains as the session's durable state. Any prompt wakes it: the product re-assigns the
session with fresh credentials, the homestead detects the existing workspace (no re-clone), and work
continues with the full product-side history.

The agent's own conversation survives too. Each harness session keeps a Pi transcript on the
homestead's disk, at the same path every time that session starts, so a homestead restart or a wake
months later carries on the conversation rather than meeting the user as a stranger. A transcript
that cannot be read is renamed aside and the session starts fresh — an agent that refuses to start
because of its own history is worse than one that begins again.

The state directory (`OPENOUTPOSTS_STATE_DIR`, default `~/.openoutposts/homestead-sessions`) holds
both halves, and both are owner-only:

```
homestead-sessions/
  <product-session-id>.json              recovery metadata, no credentials
  pi-sessions/
    <product-session-id>.jsonl           the agent's conversation
```

Dormant records expire after ninety days, and a pruned record takes its conversation with it. A
homestead with no state directory configured — the demo — keeps both in memory and leaves nothing
behind.

The product-side transcript is bounded rather than unlimited: one oversized event is shortened
before storage and says so where it is shown, and a very long session's oldest events are pruned
once it passes its budget. Three optional control-plane variables move the budgets, each falling
back to its default when absent or malformed:

| Variable                          | Default    | What it bounds                   |
| --------------------------------- | ---------- | -------------------------------- |
| `SESSION_EVENT_PAYLOAD_MAX_BYTES` | `65536`    | one stored event's payload       |
| `SESSION_EVENTS_MAX_COUNT`        | `20000`    | events kept per session          |
| `SESSION_EVENTS_MAX_BYTES`        | `52428800` | stored payload bytes per session |

Deleting a session is the end of it. The control plane erases the session's Durable Object storage
and its stored media as well as its index row, so nothing survives the delete.

## Security notes (single-tenant MVP)

- An enrollment token belongs to the signed-in user, expires after ten minutes, is stored only as a
  hash, and can be consumed once. It cannot connect a worker by itself; the machine must print a
  code that its owner confirms in the UI.
- Each confirmed machine signs fresh, nonce-bound connection proofs with its own Ed25519 key. The
  control plane stores only the public key. Removing the machine revokes the identity and a later
  reconnect is refused.
- The worker stores its private identity in an owner-only file on the machine. This protects it from
  other operating-system users, not from commands running as that same account. Use a dedicated
  account when the agent should not reach the account's other files.
- The internal secret mints service tokens that authorize lease and tool calls. It belongs to
  trusted homestead infrastructure only.
- Model credentials are the one thing the internal secret does **not** reach: the issuing endpoint
  accepts only a session's own token, so holding the deployment secret does not let a caller pull
  another session's provider key. A session's scratch agent directory holds the fetch request —
  control-plane URL, session id, provider, and that session's token, owner-readable only — and is
  deleted when the session closes. The provider key itself is never written there.
- Workspace roots are mandatory on the worker: leases are only accepted under the directories you
  list, compared after symlink resolution. Shell commands are unrestricted _within your account_ by
  design — enroll machines and choose operating-system accounts accordingly — and non-loopback
  connections must use TLS.

## Migrating a shared-token deployment

New deployments reject the old fleet-wide bearer. `OUTPOST_ALLOW_LEGACY_SHARED_TOKEN` defaults to
false, and production Terraform does not bind `OUTPOST_ENROLLMENT_TOKEN` unless that switch is
explicitly enabled.

For an existing single-user deployment:

1. Apply the D1 migrations and deploy the new control plane.
2. Temporarily set `OUTPOST_ALLOW_LEGACY_SHARED_TOKEN=true` and preserve the old
   `OUTPOST_ENROLLMENT_TOKEN`. The control plane writes a warning whenever it accepts that fallback.
3. Sign in as the deployment's only user. In that browser's console, claim each old machine:

   ```js
   await fetch("/api/outposts/OLD_MACHINE_ID/claim", { method: "POST" }).then((response) =>
     response.json()
   );
   ```

   The claim refuses deployments with zero or more than one user and refuses machines that already
   have an owner.

4. Upgrade the worker, create a new enrollment on the Machines page, and confirm its code. This
   creates a new machine-specific identity. Move sessions to the new machine entry and remove the
   claimed legacy entry.
5. Set `OUTPOST_ALLOW_LEGACY_SHARED_TOKEN=false`, clear `OUTPOST_ENROLLMENT_TOKEN`, and redeploy.

There is no automatic substitution. A legacy worker fails to reconnect when compatibility is off,
and a revoked machine stays revoked.
