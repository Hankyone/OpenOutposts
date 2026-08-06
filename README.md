# OpenOutposts

OpenOutposts is an open-source control plane for running coding agents centrally while their tools
operate on machines you own.

The project is derived from Open-Inspect's web and Cloudflare control plane. Its execution model is
different: the agent runs on a central homestead, while thin outpost workers perform bounded
operations inside leased workspaces.

## Foundation

The product has three distinct runtime responsibilities:

1. The control plane owns product sessions, authentication, routing, and the event stream.
2. The homestead owns harness sessions. Pi is the harness, embedded in the homestead process through
   its SDK; Claude Code is a planned adapter behind the same boundary.
3. An outpost worker makes an outbound connection, accepts a time-bounded execution lease, and
   performs filesystem and command operations. It does not run the agent brain.

The core loop works end to end today: a worker registers over an outbound WebSocket, the control
plane grants an execution lease, and a centrally running Pi session performs every file and shell
operation on the leased workspace through validated, lease-scoped tool calls — it is offered no
local shell or file tool at all. The product itself runs on it too — with the `outpost` execution
backend selected, sessions created in the existing web UI are served by a central homestead service
instead of a cloud sandbox, streaming into the same session UI unchanged. Run both with
[docs/OUTPOSTS_QUICKSTART.md](docs/OUTPOSTS_QUICKSTART.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the boundaries and migration rules.

## Packages

| Package                     | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `packages/outpost-protocol` | Versioned messages shared by homesteads and outpost workers  |
| `packages/homestead`        | Central harness lifecycle and Pi integration                 |
| `packages/outpost-worker`   | Thin Go worker for owned execution targets                   |
| `packages/control-plane`    | Product sessions, authentication, routing, leases, and audit |
| `packages/web`              | Next.js product interface                                    |
| `packages/shared`           | Shared product types and service-auth contracts              |
| `packages/github-bot`       | GitHub integration Worker                                    |
| `packages/linear-bot`       | Linear integration Worker                                    |
| `packages/slack-bot`        | Slack integration Worker                                     |

Some inherited npm packages retain their `@open-inspect` internal scope. The scope is packaging
history, not a runtime dependency on an Open-Inspect deployment.

## Development

Requirements: Node.js 22 or newer, npm, and Go 1.24 or newer.

```sh
npm install
npm run build:foundation
npm run test:foundation
```

The complete suite is available through the root `build`, `typecheck`, and `test` scripts. See
[CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change and [SECURITY.md](SECURITY.md) for
private vulnerability reporting.

## License

MIT. Existing copyright notices are retained where required.
