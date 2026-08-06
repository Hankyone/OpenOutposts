# OpenOutposts

Under active development.

OpenOutposts is open-source infrastructure for running coding agents against machines you control.
The control plane and UI are derived from
[Open-Inspect](https://github.com/ColeMurray/open-inspect). The remote-execution shape is inspired
by [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview): the agent runs centrally; leased
work runs on your machines. Not affiliated with Cognition or Devin.

## Homestead

A **homestead** is where the agent lives. Today that means [Pi](https://pi.dev) embedded in the
homestead process: model credentials stay there, the conversation persists there, and the model has
no reachable local filesystem or local shell.

A homestead machine can also be enrolled as an outpost. Even then, the agent does not get
homestead-local tools; work still goes through an outpost lease.

## Outpost

An **outpost** is where work happens. A Go worker makes an outbound connection to the control plane,
claims a lease, and runs bounded file and shell operations inside the leased workspace. It does not
host the agent runtime or model credentials. Outposts may sleep.

## Control plane

The control plane runs on Cloudflare Workers and Durable Objects. It owns accounts, product
sessions, routing, machine directory, and execution leases. The product UI is a Next.js app.

## Run locally

Requirements: Node.js 22 or newer, npm, and Go 1.24 or newer.

```sh
npm install
npm run build:foundation
npm run test:foundation
```

Follow the [local quickstart](docs/OUTPOSTS_QUICKSTART.md) to run the complete
control-plane/homestead/outpost loop.

## License

[MIT](LICENSE)
