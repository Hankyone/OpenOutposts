/**
 * The outpost backend provisions nothing: "creating a sandbox" is handing the
 * session to a connected homestead. The assignment body is therefore the
 * only delivery mechanism for the session's credentials, which is what these
 * tests are about.
 */

import { describe, it, expect, vi } from "vitest";
import { OUTPOST_PROTOCOL_VERSION, sessionAssignSchema } from "@openoutposts/outpost-protocol";
import { OutpostSandboxProvider } from "./outpost-provider";
import type { CreateSandboxConfig } from "../provider";

function createProvider(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const stub = { fetch: vi.fn(fetchImpl) };
  const homesteadNamespace = {
    idFromName: vi.fn(() => "homestead-id"),
    get: vi.fn(() => stub),
  } as unknown as DurableObjectNamespace;

  return {
    stub,
    provider: new OutpostSandboxProvider({
      homesteadNamespace,
      outpostId: "workstation-01",
      workspaceRoot: "/workspace/sessions",
    }),
  };
}

const baseConfig: CreateSandboxConfig = {
  sessionId: "session-01",
  sandboxId: "sandbox-01",
  repoOwner: null,
  repoName: null,
  controlPlaneUrl: "https://control.example",
  sandboxAuthToken: "bridge-token",
  credentialFetchToken: "fetch-token",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("OutpostSandboxProvider", () => {
  it("delivers the credential-fetch token alongside the bridge token", async () => {
    let body: unknown;
    const { provider } = createProvider(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return Response.json({ assigned: true });
    });

    await provider.createSandbox(baseConfig);

    const assignment = body as Record<string, unknown>;
    expect(assignment.sandboxAuthToken).toBe("bridge-token");
    expect(assignment.credentialFetchToken).toBe("fetch-token");
    // Two secrets, not one value under two names: the whole point is that the
    // harness process holds only the narrow one.
    expect(assignment.credentialFetchToken).not.toBe(assignment.sandboxAuthToken);
  });

  it("sends a body the protocol's assignment schema accepts", async () => {
    let body: Record<string, unknown> = {};
    const { provider } = createProvider(async (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ assigned: true });
    });

    await provider.createSandbox(baseConfig);

    // The homestead DO stamps type, protocolVersion and assignmentId on before it
    // sends; everything else must already validate here, so a missing field is
    // caught at the source rather than as a homestead-side parse failure.
    const parsed = sessionAssignSchema.safeParse({
      type: "session.assign",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      assignmentId: "assignment-01",
      ...body,
    });
    expect(parsed.success).toBe(true);
  });
});
