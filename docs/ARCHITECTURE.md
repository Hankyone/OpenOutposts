# OpenOutposts architecture foundation

## Product boundary

OpenOutposts separates reasoning from execution. A centrally running coding-agent harness decides
which tools to call. A thin worker executes those calls on a machine the user owns.

The separation is not a hypothesis any more and there is no compatibility path beside it. The
in-sandbox execution surface — the Python supervisor that ran the agent inside a provisioned
sandbox, the prebuilt-image subsystem, the sandbox environment injection, and the
snapshot/restore/resume axis — has been deleted. There is one execution backend: `outpost`.

## Runtime objects

### Product session

Owned by the control plane. It contains the user-visible conversation, repositories, participants,
policy, and durable event stream.

The event stream is a bounded record, not an archive. One oversized event is shortened before
storage and carries a marker saying so, and once the transcript passes a generous budget the oldest
events are pruned. What is broadcast to connected clients is never shortened; only the stored copy
is bounded. `SESSION_EVENT_PAYLOAD_MAX_BYTES`, `SESSION_EVENTS_MAX_COUNT` and
`SESSION_EVENTS_MAX_BYTES` move the budgets, and each falls back to its default rather than failing.

### Harness session

Owned by the central homestead. It contains harness-specific state such as the Pi session
identifier. The product session points to it through a harness-neutral reference.

The agent lives on the homestead machine, so the harness session lives there too: one Pi JSONL
transcript per product session under the homestead's state directory, owner-only, reopened when the
homestead restarts or the session wakes. A file that cannot be read is set aside and the session
starts fresh. Nothing secret is written — the session's provider key is held in memory by its
credential store — and the harness transcript is a different object from the product one, which
still belongs to the control plane.

Pi is the only adapter. It is embedded in the homestead process through its SDK, and the seven
bounded operations are the only tools its sessions are given — the model is offered no local shell
or file tool, enforced by Pi's explicit tool allowlist. Persisting the conversation changes only
where Pi keeps its transcript; the guarded session shape is otherwise untouched. Claude Code would
be a separate adapter behind the same boundary, not a provider mode hidden inside Pi.

### Execution lease

An expiring assignment connecting one product session to one outpost workspace. The lease controls
which operations are accepted and prevents a stale homestead from continuing to operate after a
session moves or ends.

A machine may serve many sessions over time. A session may move between machines. Neither side is
permanently bound to the other.

## Connection flow

1. The outpost worker starts on a machine and opens an authenticated outbound connection.
2. The control plane registers its capabilities and presence.
3. A product session requests an execution target.
4. The control plane grants an execution lease.
5. The central harness emits tool calls through the homestead.
6. The homestead sends lease-scoped requests to the worker and returns results to the harness.
7. The lease is released when the session completes, moves, or expires.

For the MVP, each outpost has its own Durable Object. Enrollment begins with an owner-scoped,
single-use token and ends only after the owner confirms the code printed by the machine. The Worker
then verifies a signed, nonce-bound proof from that machine's Ed25519 identity before forwarding the
WebSocket. The Durable Object persists registration, connection identity, and heartbeat timestamps.
It refuses a second live connection for the same machine and replaces only a stale connection.

## Cloud providers create fleet members; they do not host agents

Modal, E2B, Daytona, Vercel and OpenComputer are not execution backends. `SANDBOX_PROVIDER` accepts
only `outpost`, and naming a cloud provider fails loudly at startup rather than quietly running
somewhere else.

What survives of them is the provisioning capability: the REST clients under
`packages/control-plane/src/sandbox/` (`client.ts` for Modal, `e2b-rest-client.ts`,
`daytona-rest-client.ts`, `opencomputer-rest-client.ts`, `providers/vercel/client.ts`). Each is
marked in its header. They speak instance lifecycle — create, describe, stop, destroy — and nothing
in the control plane constructs them today. The intended future is that a fleet-member creator uses
them with the _user's own_ provider API key to stand up a machine that runs the same outpost worker
and speaks the same protocol. That creator does not exist yet.

The provider image builders that baked the Python supervisor, OpenCode, code-server and ttyd into a
sandbox image are gone with the supervisor. Provider base images have to be rebuilt around the
worker binary; that is a prerequisite of the fleet-member creator, not a leftover of this one.

## Protocol rules

- Messages are versioned and validated on both sides.
- Tool requests are identified so retries cannot silently duplicate mutations.
- Provider and model credentials remain in the central homestead.
- Workers expose capabilities; they do not choose a model or harness.
- The initial operation set is `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`.
- Transport details are kept outside the message schemas so WebSockets can be replaced without
  rewriting harness adapters or worker backends.

## Migration path

1. ✅ Preserve the existing Open-Inspect UI and control plane.
2. ✅ Run the harness centrally with outpost-backed operations as its only tools.
3. ✅ Route one end-to-end session through the new protocol and worker (see
   [OUTPOSTS_QUICKSTART.md](OUTPOSTS_QUICKSTART.md)).
4. ✅ Connect the product's session flow to the homestead path. The `outpost` sandbox backend hands
   sessions to a registered central homestead, which serves the session's WebSocket contract in
   place of a provisioned sandbox; the UI is unchanged. Deployment-wide for now — per-session
   outpost selection, and repository cloning onto outposts, are the next increments.
5. ✅ Make Pi the harness. It replaced the OpenCode adapter outright rather than sitting beside it,
   because a harness that can reach a local filesystem is a defect, not an option.
6. ✅ Retire the inherited in-sandbox agent supervisor, the prebuilt-image subsystem, the sandbox
   environment injection, and the snapshot/restore/resume surface.
7. Add a Claude Code/Agent SDK adapter for subscription-backed Claude usage.
8. Build the fleet-member creator on the retained provider REST clients, and rebuild provider base
   images around the worker binary.

### What this deletion did not re-home

Named here because they were live product behaviour delivered by the in-sandbox runtime, and are now
absent rather than replaced:

- **User environment variables** (global / repo / environment secrets). They reached a session only
  through the deleted `sandbox-env.ts`. The stores, routes and settings UI still exist and still
  save; nothing delivers them. A per-lease injection mechanism has to be designed against the
  worker's deliberate environment sanitization.
- **MCP servers**, the **agent-initiated Slack notification**, and **agent-spawned child sessions**.
  All three were tools installed into the sandbox agent. Pi's tool surface is a hard allowlist of
  the seven outpost operations, so re-adding any of them is a deliberate widening with its own test.
- **Commit signing** and the **git credential helper / `gh` wrapper**. These lived in the supervisor
  and have no home on an outpost yet.
- **code-server, the web terminal, tunnel and service ports.** Exposing a port on a machine the user
  owns is a different feature from tunnelling out of a disposable sandbox and needs its own security
  decision at enrollment.
