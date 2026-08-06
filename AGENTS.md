# AGENTS.md

OpenOutposts is a monorepo for a centrally hosted coding-agent control plane and thin remote
execution workers. It is derived from Open-Inspect, whose UI and Cloudflare control plane remain
operational. Open-Inspect's execution model — an agent running inside a provisioned cloud sandbox —
has been deleted, not migrated.

## Vocabulary

Three nouns cover the whole system. The machine and the software it runs share a name.

1. The **control plane** runs on Cloudflare: accounts, routing, leases, machine directory, audit.
2. A **homestead** is where the agent lives: an always-on machine running the Homestead software,
   which hosts Pi and drives outposts through leased tool calls. The wire speaks `homestead.*`.
3. An **outpost** is where work happens: a user machine running the **outpost worker** (the Go
   binary), executing the seven bounded operations inside a leased workspace. Outposts may sleep.

"Runner" is retired; it was the homestead software's pre-vocabulary name. Do not reintroduce it, and
do not invent a fourth noun for any of these three roles.

## Architecture invariants

Keep these objects distinct:

1. A **product session** belongs to the control plane and user-facing event stream.
2. A **harness session** belongs to one central agent runtime such as Pi or Claude Code.
3. An **execution lease** temporarily binds a product session to an outpost.

The agent brain runs centrally. Outpost workers make outbound connections and expose bounded tool
operations; they do not host the agent runtime, model credentials, or product state.

Pi is the only harness. It is embedded in the homestead process through its SDK — no per-session
server, no port, no generated tool files — and the seven bounded operations are handed to it as
closures that call this homestead's lease client. New harnesses must implement the homestead
boundary rather than leaking provider-specific fields into the outpost protocol.

**The model must have no reachable local filesystem or local shell.** Containment is enforced by
Pi's explicit `tools` allowlist and only by the allowlist: a suppression flag such as
`noTools: "builtin"` still leaves extension-registered tools model-visible, which is exactly how an
earlier harness let a model edit the homestead's own disk while reporting success. Any harness
change must keep `packages/homestead/src/pi/containment.test.ts` passing, negative controls
included.

**The agent lives on the homestead machine, so its conversation does too.** Each harness session
persists as a Pi JSONL transcript under the homestead's state directory (`pi-sessions/`, directory
0700, file 0600), at the same path every time that session starts, and a restart or a wake resumes
it; an unreadable file is set aside and the session starts fresh. No model credential is ever
written — the session's key stays in its in-memory credential store, and `SettingsManager` stays
in-memory. Persistence changes only where Pi keeps its transcript, and containment is unchanged:
containment.test.ts exercises the persisted shape too and remains the gate.

**The product transcript in the SessionDO is a bounded record, not an archive.** One oversized event
is shortened before storage and carries a visible marker; the oldest events are pruned once the
transcript passes a generous budget. Live broadcast is never shortened — only the stored copy is
bounded. Deleting a session erases that storage rather than hiding it, which is why the router's
session-ownership gate is load-bearing on `DELETE /sessions/:id`.

The lease-scoped execution path is implemented end to end: the control plane grants leases and
routes tool calls through the outpost Durable Object, the Go worker executes the seven bounded
operations inside the leased workspace, and the homestead's Pi harness drives them from a centrally
running session. `outpost` is the only execution backend — `SANDBOX_PROVIDER` accepts nothing else
and fails loudly on anything else. Sessions are handed to a registered central homestead service
(`openoutposts-homestead`), which serves the session's sandbox WebSocket contract; the web UI is
unchanged. `docs/OUTPOSTS_QUICKSTART.md` runs the whole loop locally.

**The cloud providers create fleet members; they do not host agents.** Modal, E2B, Daytona, Vercel
and OpenComputer survive only as REST clients under `packages/control-plane/src/sandbox/`, each
marked in its header. They speak instance lifecycle and nothing constructs them today. The
fleet-member creator that will use them — with the _user's own_ provider API key, to stand up a
machine running the same worker — does not exist yet. See `docs/ARCHITECTURE.md`.

## Deployment identity safety

This repository owns only OpenOutposts deployments. It does not own, migrate, import, rename, or
destroy any Open-Inspect deployment, even when both products use the same provider account or
resource types. A pre-existing Open-Inspect stack is never an upgrade target for this repository.

- Every hosted resource managed here uses the `openoutposts` name prefix.
- OpenOutposts production state starts from an OpenOutposts-specific backend; never attach this
  repository to an existing state file or cached backend from another project.
- If a plan contains resources without the OpenOutposts identity, stop before applying it.

## Package map

| Package            | Responsibility                                                    |
| ------------------ | ----------------------------------------------------------------- |
| `landing`          | The independently deployable openoutposts.com Cloudflare Worker   |
| `outpost-protocol` | Versioned, transport-neutral homestead/worker messages            |
| `homestead`        | Central harness lifecycle and adapter registry                    |
| `outpost-worker`   | Thin Go worker and local execution backends                       |
| `control-plane`    | Product sessions, Durable Objects, auth, routing, and persistence |
| `web`              | Product UI                                                        |
| `shared`           | Shared product types and the sig1 service-auth contract           |
| `slack-bot`        | Inherited Slack integration Worker                                |
| `github-bot`       | Inherited GitHub integration Worker                               |
| `linear-bot`       | Inherited Linear integration Worker                               |

The three bot packages are inherited and still deployed. `sandbox-runtime`, `modal-infra`,
`e2b-infra`, `daytona-infra` and `opencomputer-infra` are gone: every one of them existed to host or
package the in-sandbox agent.

## Commands

```sh
npm install
npm run build:foundation
npm run test:foundation
npm run build
npm run typecheck
npm test
```

Run Go commands from `packages/outpost-worker` when working on the worker directly.

Build `@open-inspect/shared` before inherited packages that import it. The internal package scope
will be migrated separately after the runtime boundary is stable.

## Conventions

- TypeScript durations use milliseconds and carry an `Ms` suffix.
- Go durations use `time.Duration`.
- Every protocol message carries an explicit protocol version.
- The worker initiates connections; do not require inbound ports on customer machines.
- Never place provider credentials in worker messages or worker state.
- Use conventional commit subjects under 72 characters.
- Preserve the existing single-tenant security assumptions until a separate multi-tenant design is
  implemented and reviewed.
