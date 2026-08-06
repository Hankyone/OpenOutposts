# Outpost worker

The outpost worker is the thin execution endpoint installed on an owned machine or provisioned in a
managed sandbox. It makes an authenticated outbound connection, accepts execution leases, and
performs the bounded operations defined by `@openoutposts/outpost-protocol` — bash, read, write,
edit, grep, find, and ls — inside the leased workspace.

The worker never stores model credentials and never runs an agent harness.

## Configuration

Create a one-time command on the Machines page, then run it from the directory the worker may
expose:

```sh
openoutpost enroll \
  --control-plane https://control-plane.example.com \
  --token oo_enroll_REDACTED \
  --workspace-root "$PWD"
```

The command creates a machine-specific Ed25519 identity, prints the six-digit code that must be
confirmed in the UI, and waits for confirmation. It stores the control-plane URL, machine ID,
display name, workspace roots, and private key in an owner-only identity file. A normal
`openoutpost` start loads that file; it does not need an enrollment token.

The default identity directory is:

- macOS: `~/Library/Application Support/OpenOutposts`
- Linux as root: `/var/lib/openoutposts`
- Linux as a user: `$XDG_STATE_HOME/openoutposts` or `~/.local/state/openoutposts`
- Windows: `%ProgramData%\OpenOutposts`

`OPENOUTPOSTS_STATE_DIR` overrides that location. `OPENOUTPOSTS_CONTROL_PLANE_URL` may override the
stored URL. `OPENOUTPOSTS_TOKEN`, `OPENOUTPOSTS_ID`, `OPENOUTPOSTS_NAME`, and
`OPENOUTPOSTS_WORKSPACE_ROOTS` exist only for the explicit, default-off legacy migration described
in the quickstart.

## Confinement model

- A lease binds one workspace directory under a configured root; leases are validated against
  symlink-resolved paths, and file operations reject absolute paths, traversal, and symlink escapes
  (including writes through dangling symlink leaves).
- `bash` runs unrestricted shell commands **within your account** — that is the product. The
  boundary you control is the operating-system account and machine you enroll. Workspace roots
  constrain leases and the bounded file tools, but they are not an operating-system sandbox for
  shell commands. The worker strips `OPENOUTPOSTS_*` from child environments; use a dedicated
  account if agent commands must not read the account's other files.
- Concurrency is capped, outputs are bounded, commands are killed by process group on timeout, and
  releasing or expiring a lease cancels any operation still running under it.

## Self-update

An enrolled worker keeps itself current. It checks the release channel about every six hours
(jittered, first check two minutes after start-up), and installs what it finds without anyone
logging into the machine.

What it will and will not install:

- The release manifest is signed with an offline Ed25519 key, and the worker verifies that signature
  against a public key compiled into the binary before it parses a single field. There is no
  unsigned path: a build with no embedded key logs
  `self-update disabled: no release public key embedded` and never updates. A manifest older than
  one already accepted is refused, so serving stale objects cannot walk a machine backwards onto a
  build whose bugs are known.
- Updates normally arrive as a binary patch against the running build — usually a few hundred bytes
  rather than tens of megabytes. Patching is only a transport saving: every hop verifies the patch
  and its result against digests the signed manifest names, and any mismatch falls back to the full
  download rather than installing something unverified.
- Development builds (`version` still `dev`) never update; no manifest describes them.

When it installs:

- Only when the worker is idle — no lease held and no tool call running — and has been for a minute.
  A busy machine defers to the next check rather than interrupting a session.
- The binary is replaced in place and the process re-executes itself, keeping its process ID. A
  service manager sees no exit at all. Where re-exec is unavailable the worker exits with code 3,
  which every supplied unit treats as "start me again".
- The binary it replaced is kept beside it as `openoutpost.old` until the new one has registered
  with the control plane. A new binary that fails to register three times in a row is rolled back to
  that copy automatically.

Requirements and controls:

- **The directory holding the binary must be writable by the account the worker runs as.** This is
  the one thing an installation has to get right; `/usr/local/bin` owned by root with the worker
  running as a service user will not work. The supplied units install to a service-user-owned
  directory for exactly this reason.
- `openoutpost update --check` reports the installed and available versions and exits non-zero when
  an update is available. `openoutpost update` installs one immediately, skipping the idle wait; a
  running worker picks the new binary up when it next restarts.
- `--no-self-update` on the daemon, or `OPENOUTPOSTS_SELF_UPDATE=off`, turns the background updater
  off entirely.
- `OPENOUTPOSTS_UPDATE_BASE_URL` overrides where releases are fetched from. It exists for the local
  smoke test in the quickstart; normally releases come from the machine's own control plane.

Nothing about self-update can stop the worker doing its job: every failure is a log line, and the
updater never exits 2, which the systemd unit reserves for configuration errors that must not be
retried.

## Supervision

The worker reconnects to a missing control plane on its own, with jittered backoff to a 30-second
ceiling that resets after any connection that stayed up for a minute. It tears its own connection
down when the control plane stops acknowledging heartbeats, so a half-open path becomes a reconnect
rather than silent invisibility. Nothing restarts the worker after a crash, a kill, or a reboot.
`deploy/` holds a systemd unit and a launchd plist with restart semantics and an example environment
file; installation commands are in each file's header comment.
