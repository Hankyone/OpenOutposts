# OpenOutposts

OpenOutposts is open-source infrastructure for running coding agents against machines you control.

It separates the system into three parts:

- The **control plane** manages accounts, sessions, routing, and execution leases.
- A **homestead** runs the agent.
- An **outpost** executes bounded file and shell operations inside a leased workspace.

Outposts connect outward to the control plane and require no inbound ports. The agent has no direct
access to the homestead filesystem or shell.

## Run locally

Requirements: Node.js 22 or newer, npm, and Go 1.24 or newer.

```sh
npm install
npm run build:foundation
npm run test:foundation
```

Follow the [local quickstart](docs/OUTPOSTS_QUICKSTART.md) to run the complete
control-plane/homestead/outpost loop.

## More

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT license](LICENSE)
