#!/usr/bin/env node
/**
 * End-to-end demo: an agent brain running centrally while its hands work on
 * an outpost.
 *
 * Requirements: a running control plane, a connected outpost worker, and (for
 * the agent mode) a model spec plus a command that prints its provider key.
 *
 * This is a development tool. It drives a lease by hand with the deployment's
 * internal secret and there is no product session behind it, so there is no
 * session-scoped credential to fetch and no user whose vault to fetch it from
 * — hence the key command below. The product path is the homestead service, where
 * each session's credential comes from its owner's vault; see homestead-main.ts.
 *
 * Environment:
 *   OPENOUTPOSTS_CONTROL_PLANE_URL   control plane base URL
 *   OPENOUTPOSTS_INTERNAL_SECRET     the deployment's internal callback secret
 *   OPENOUTPOSTS_DEV_PI_KEY_COMMAND  shell command printing the provider API key
 *
 * Usage:
 *   demo --outpost <id> --workspace </abs/path> --model provider/model "<prompt>"
 *   demo --outpost <id> --workspace </abs/path> --script
 */
import { randomUUID } from "node:crypto";

import { OutpostClient } from "./outpost-client.js";
import { createSessionCredentialStore, type PiCredential } from "./pi/credential-store.js";
import { PiHarness } from "./pi/harness.js";
import { splitModelSpec } from "./pi/session.js";

interface DemoArgs {
  outpostId: string;
  workspacePath: string;
  model?: string;
  prompt?: string;
  script: boolean;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): DemoArgs {
  let outpostId: string | undefined;
  let workspacePath: string | undefined;
  let model: string | undefined;
  let script = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--outpost") outpostId = argv[++i];
    else if (arg === "--workspace") workspacePath = argv[++i];
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--script") script = true;
    else positional.push(arg);
  }

  if (!outpostId) fail("--outpost <id> is required");
  if (!workspacePath) fail("--workspace </absolute/path> is required");
  if (!script && positional.length === 0) fail("provide a prompt, or use --script");
  const result: DemoArgs = { outpostId, workspacePath, script };
  if (model !== undefined) result.model = model;
  if (positional.length > 0) result.prompt = positional.join(" ");
  return result;
}

async function runScripted(outposts: OutpostClient, args: DemoArgs): Promise<void> {
  const productSessionId = `demo-${randomUUID().slice(0, 8)}`;
  console.log(`Leasing ${args.outpostId} for ${args.workspacePath} ...`);
  const lease = await outposts.createLease({
    outpostId: args.outpostId,
    productSessionId,
    workspacePath: args.workspacePath,
  });
  console.log(`Lease ${lease.leaseId} granted (expires ${lease.expiresAt})`);

  try {
    const steps: Array<{
      operation: "ls" | "write" | "read" | "bash";
      input: Record<string, unknown>;
    }> = [
      { operation: "ls", input: {} },
      {
        operation: "write",
        input: { path: "outpost-demo.txt", content: "written from the control plane\n" },
      },
      { operation: "read", input: { path: "outpost-demo.txt" } },
      { operation: "bash", input: { command: "cat outpost-demo.txt && rm outpost-demo.txt" } },
    ];
    for (const step of steps) {
      console.log(`\n$ ${step.operation} ${JSON.stringify(step.input)}`);
      const result = await outposts.callTool(
        args.outpostId,
        lease.leaseId,
        step.operation,
        step.input
      );
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) fail(`scripted step failed: ${result.error ?? "unknown"}`);
    }
    console.log("\nScripted round trip succeeded: the outpost executed every operation.");
  } finally {
    await outposts.releaseLease(args.outpostId, lease.leaseId, "completed");
    console.log(`Lease ${lease.leaseId} released.`);
  }
}

async function runAgent(outposts: OutpostClient, args: DemoArgs): Promise<void> {
  // Pi reads provider keys only from the store this homestead hands it — there is
  // no ambient CLI login to inherit — so the agent mode needs both a model and
  // a command that prints the key for that model's provider.
  const model = args.model;
  if (!model) fail("--model provider/model-id is required for the agent mode");
  const keyCommand = process.env.OPENOUTPOSTS_DEV_PI_KEY_COMMAND;
  if (!keyCommand) {
    fail(
      "OPENOUTPOSTS_DEV_PI_KEY_COMMAND is not set (e.g. 'printenv ANTHROPIC_API_KEY');\n" +
        "it is run as a shell command and its stdout is used as the provider API key.\n" +
        "This demo has no product session, so it cannot use per-session credentials."
    );
  }
  const credential: PiCredential = {
    kind: "key-command",
    providerId: splitModelSpec(model).providerId,
    keyCommand,
  };

  const harness = new PiHarness({
    outposts,
    outpostId: args.outpostId,
    defaultModel: model,
    credentials: createSessionCredentialStore(credential),
    onLog: (line) => {
      if (process.env.OPENOUTPOSTS_DEMO_VERBOSE) console.error(`[pi] ${line}`);
    },
  });

  console.log(`Starting central Pi session against outpost ${args.outpostId} ...`);
  const session = await harness.createSession({
    productSessionId: `demo-${randomUUID().slice(0, 8)}`,
    workspacePath: args.workspacePath,
    model,
  });
  console.log(`Session ${session.harnessSessionId} ready. Sending prompt.\n`);

  let failed = false;
  try {
    for await (const event of harness.sendPrompt(session, { content: args.prompt ?? "", model })) {
      switch (event.type) {
        case "assistant.delta":
          process.stdout.write(event.text);
          break;
        case "reasoning.delta":
          break;
        case "tool.started":
          console.log(`\n[tool ${event.name}] ${JSON.stringify(event.input)}`);
          break;
        case "tool.completed":
          console.log(`[tool done${event.isError ? " (error)" : ""}]`);
          break;
        case "turn.completed":
          console.log("\n\nTurn completed.");
          break;
        case "turn.failed":
          failed = true;
          console.error(`\n\nTurn failed: ${event.message}`);
          break;
        case "approval.requested":
          break;
      }
    }
  } finally {
    await harness.close(session);
  }
  if (failed) process.exit(1);
}

async function main(): Promise<void> {
  const controlPlaneUrl = process.env.OPENOUTPOSTS_CONTROL_PLANE_URL;
  const internalSecret = process.env.OPENOUTPOSTS_INTERNAL_SECRET;
  if (!controlPlaneUrl) fail("OPENOUTPOSTS_CONTROL_PLANE_URL is not set");
  if (!internalSecret) fail("OPENOUTPOSTS_INTERNAL_SECRET is not set");

  const args = parseArgs(process.argv.slice(2));
  const outposts = new OutpostClient({ controlPlaneUrl, internalSecret });

  const status = await outposts.status(args.outpostId).catch(() => null);
  if (!status || status.connected !== true) {
    fail(
      `outpost ${args.outpostId} is not connected. Enroll it from the Machines page, ` +
        `confirm the code printed by the worker, then start openoutpost.`
    );
  }
  console.log(`Outpost ${args.outpostId} is connected.`);

  if (args.script) {
    await runScripted(outposts, args);
  } else {
    await runAgent(outposts, args);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
