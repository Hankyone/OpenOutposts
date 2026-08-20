import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";

import {
  collectMessages,
  connectConfirmedOutpost,
  createSignedInUser,
  homesteadFetch,
  homesteadHeaders,
  openClientWs,
  openSandboxWs,
  queryDO,
  seedConfirmedOutpost,
} from "./helpers";

const CONNECT_HOMESTEAD_URL = "https://test.local/homesteads/connect";
const SOCKET_CLOSE_TIMEOUT_MS = 2_000;

/** Complete the close handshake so Durable Object close hooks finish before teardown. */
async function closeSocket(ws: WebSocket | null, label: string): Promise<void> {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} WebSocket did not finish closing`)),
      SOCKET_CLOSE_TIMEOUT_MS
    );
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close(1000, "test complete");
  });
}

/** Register a real OutpostDO connection and answer the small slice this proof drives. */
async function connectScriptedOutpost(owner: { userId: string; accessToken: string }) {
  const machine = await seedConfirmedOutpost(`product-roundtrip-${Date.now()}`, owner);
  const { response, ws } = await connectConfirmedOutpost(machine);
  expect(response.status).toBe(101);
  if (!ws) throw new Error("Outpost WebSocket upgrade failed");

  const toolRequests: Record<string, unknown>[] = [];
  const releasedLeases: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
      string,
      unknown
    >;
    if (message.type === "lease.offer") {
      ws.send(
        JSON.stringify({
          type: "lease.accepted",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          leaseId: message.leaseId,
        })
      );
      return;
    }
    if (message.type === "tool.request") {
      toolRequests.push(message);
      ws.send(
        JSON.stringify({
          type: "tool.result",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          requestId: message.requestId,
          leaseId: message.leaseId,
          ok: true,
          output: {
            stdout: "hello from the scripted outpost\n",
            stderr: "",
            exitCode: 0,
            durationMs: 3,
            truncated: false,
          },
        })
      );
      return;
    }
    if (message.type === "lease.release") releasedLeases.push(message);
  });

  const registered = collectMessages(ws, {
    until: (message) => message.type === "outpost.registered",
  });
  ws.send(
    JSON.stringify({
      type: "outpost.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      outpostId: machine.outpostId,
      name: "Product round-trip machine",
      workerVersion: "0.1.0-test",
      capabilities: {
        platform: "linux",
        architecture: "amd64",
        operations: ["bash", "read", "write", "edit", "grep", "find", "ls"],
        workspaceRoots: ["/workspace"],
      },
    })
  );
  expect(await registered).toContainEqual(
    expect.objectContaining({ type: "outpost.registered", outpostId: machine.outpostId })
  );

  return { machine, ws, toolRequests, releasedLeases };
}

/** Register a homestead and accept exactly the product-session assignment under test. */
async function connectScriptedHomestead() {
  const response = await SELF.fetch(CONNECT_HOMESTEAD_URL, {
    headers: {
      Upgrade: "websocket",
      ...(await homesteadHeaders("GET", CONNECT_HOMESTEAD_URL)),
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("Homestead WebSocket upgrade failed");
  ws.accept();

  let resolveAssignment: ((assignment: Record<string, unknown>) => void) | undefined;
  const assignment = new Promise<Record<string, unknown>>((resolve) => {
    resolveAssignment = resolve;
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
      string,
      unknown
    >;
    if (message.type !== "session.assign") return;
    resolveAssignment?.(message);
    ws.send(
      JSON.stringify({
        type: "session.assign_accepted",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: message.assignmentId,
      })
    );
  });

  const registered = collectMessages(ws, {
    until: (message) => message.type === "homestead.registered",
  });
  ws.send(
    JSON.stringify({
      type: "homestead.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      homesteadId: `product-roundtrip-${Date.now()}`,
      homesteadVersion: "0.1.0-test",
      harnesses: ["pi"],
    })
  );
  expect(await registered).toContainEqual(
    expect.objectContaining({ type: "homestead.registered" })
  );

  return { ws, assignment };
}

describe("product session on an outpost", () => {
  it("carries one prompt through assignment, lease, tool execution, and transcript", async () => {
    const owner = await createSignedInUser(`product-roundtrip-${Date.now()}`);
    const outpost = await connectScriptedOutpost(owner);
    const homestead = await connectScriptedHomestead();
    let bridge: WebSocket | null = null;
    let client: WebSocket | null = null;

    try {
      const createResponse = await SELF.fetch("https://test.local/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Automated product round trip",
          outpostId: outpost.machine.outpostId,
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json<{ sessionId: string }>();
      const assigned = await homestead.assignment;
      expect(assigned).toMatchObject({
        type: "session.assign",
        productSessionId: created.sessionId,
        harness: "pi",
        outpostId: outpost.machine.outpostId,
      });

      const leaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpost.machine.outpostId}/leases`,
        {
          method: "POST",
          body: JSON.stringify({
            productSessionId: created.sessionId,
            workspacePath: assigned.workspacePath,
          }),
        }
      );
      expect(leaseResponse.status).toBe(201);
      const lease = await leaseResponse.json<{ leaseId: string }>();

      const bridgeConnection = await openSandboxWs(created.sessionId, {
        authToken: String(assigned.sandboxAuthToken),
        sandboxId: String(assigned.sandboxId),
      });
      expect(bridgeConnection.response.status).toBe(101);
      if (!bridgeConnection.ws) throw new Error("Session bridge WebSocket upgrade failed");
      bridge = bridgeConnection.ws;
      bridge.accept();

      const clientConnection = await openClientWs(created.sessionId, {
        subscribe: true,
        userId: owner.userId,
      });
      client = clientConnection.ws;

      const promptCommands = collectMessages(bridge, {
        until: (message) => message.type === "prompt",
      });
      const promptResponse = await SELF.fetch(
        `https://test.local/sessions/${created.sessionId}/prompt`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${owner.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Run the deterministic outpost check" }),
        }
      );
      expect(promptResponse.status).toBe(200);
      const prompt = (await promptCommands).find((message) => message.type === "prompt");
      expect(prompt).toMatchObject({ content: "Run the deterministic outpost check" });
      const messageId = String(prompt?.messageId);

      const toolResponse = await homesteadFetch(
        `https://test.local/outposts/${outpost.machine.outpostId}/tool`,
        {
          method: "POST",
          body: JSON.stringify({
            leaseId: lease.leaseId,
            operation: "bash",
            input: { command: "printf 'hello from the scripted outpost\\n'" },
          }),
        }
      );
      expect(toolResponse.status).toBe(200);
      const toolResult = await toolResponse.json<{
        ok: boolean;
        output: { stdout: string };
      }>();
      expect(toolResult).toMatchObject({
        ok: true,
        output: { stdout: "hello from the scripted outpost\n" },
      });

      const completed = collectMessages(client, {
        until: (message) =>
          message.type === "sandbox_event" &&
          (message.event as Record<string, unknown> | undefined)?.type === "execution_complete",
      });
      const now = Date.now() / 1000;
      const event = (value: Record<string, unknown>) =>
        JSON.stringify({
          ...value,
          messageId,
          sandboxId: assigned.sandboxId,
          timestamp: now,
        });
      bridge.send(event({ type: "step_start" }));
      bridge.send(
        event({
          type: "tool_call",
          tool: "outpost_bash",
          args: { command: "printf 'hello from the scripted outpost\\n'" },
          callId: "tool-product-roundtrip",
          status: "completed",
          output: toolResult.output.stdout,
        })
      );
      bridge.send(event({ type: "token", content: "The outpost round trip completed." }));
      bridge.send(event({ type: "step_finish" }));
      bridge.send(
        event({
          type: "execution_complete",
          success: true,
          ackId: `execution_complete:${messageId}`,
        })
      );

      const liveMessages = await completed;
      const liveEvents = liveMessages
        .filter((message) => message.type === "sandbox_event")
        .map((message) => message.event as Record<string, unknown>);
      expect(liveEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool_call", callId: "tool-product-roundtrip" }),
          expect.objectContaining({
            type: "token",
            content: "The outpost round trip completed.",
          }),
          expect.objectContaining({ type: "execution_complete", success: true }),
        ])
      );
      expect(outpost.toolRequests).toHaveLength(1);
      expect(outpost.toolRequests[0]).toMatchObject({
        operation: "bash",
        leaseId: lease.leaseId,
      });

      const session = env.SESSION.get(env.SESSION.idFromName(created.sessionId));
      const storedEvents = await queryDO<{ type: string; message_id: string }>(
        session,
        "SELECT type, message_id FROM events WHERE message_id = ? ORDER BY created_at",
        messageId
      );
      expect(storedEvents.map((stored) => stored.type)).toEqual(
        expect.arrayContaining(["user_message", "tool_call", "token", "execution_complete"])
      );

      const releaseResponse = await homesteadFetch(
        `https://test.local/outposts/${outpost.machine.outpostId}/leases/${lease.leaseId}`,
        { method: "DELETE", body: JSON.stringify({ reason: "completed" }) }
      );
      expect(releaseResponse.status).toBe(200);
      expect(outpost.releasedLeases).toContainEqual(
        expect.objectContaining({ type: "lease.release", leaseId: lease.leaseId })
      );
    } finally {
      await Promise.all([
        closeSocket(bridge, "bridge"),
        closeSocket(client, "client"),
        closeSocket(homestead.ws, "homestead"),
        closeSocket(outpost.ws, "outpost"),
      ]);
    }
  });
});
