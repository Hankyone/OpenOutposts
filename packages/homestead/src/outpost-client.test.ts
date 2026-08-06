import { describe, expect, it, vi } from "vitest";

import { OutpostClient, OutpostClientError } from "./outpost-client.js";

function clientWith(...responses: Response[]) {
  let call = 0;
  const fetchImpl = vi.fn(async () => responses[Math.min(call++, responses.length - 1)]);
  const client = new OutpostClient({
    controlPlaneUrl: "https://control.example/",
    internalSecret: "test-secret",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

describe("OutpostClient", () => {
  it("creates leases with a signed credential that binds the request", async () => {
    const { client, fetchImpl } = clientWith(
      Response.json({ leaseId: "lease-01", expiresAt: "2026-07-22T13:00:00Z" }, { status: 201 })
    );

    const lease = await client.createLease({
      outpostId: "workstation-01",
      productSessionId: "session-01",
      workspacePath: "/workspace/project",
    });
    expect(lease.leaseId).toBe("lease-01");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.example/outposts/workstation-01/leases");
    const headers = init.headers as Record<string, string>;
    // A signature, not a standing bearer: it names the homestead and covers
    // this method, path and body, so it authorizes this request and no other.
    expect(headers["X-OpenOutposts-Service"]).toBe("homestead");
    expect(headers["X-OpenOutposts-Service-Signature"]).toMatch(
      /^sig1\.\d+\.[0-9a-f]{1,64}\.[0-9a-f]{64}$/
    );
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      productSessionId: "session-01",
      workspacePath: "/workspace/project",
    });
  });

  it("signs each request differently, so one captured header opens nothing else", async () => {
    const { client, fetchImpl } = clientWith(
      Response.json({ leaseId: "lease-01", expiresAt: "2026-07-22T13:00:00Z" }, { status: 201 }),
      Response.json({ leaseId: "lease-02", expiresAt: "2026-07-22T13:00:00Z" }, { status: 201 })
    );

    await client.createLease({
      outpostId: "workstation-01",
      productSessionId: "session-01",
      workspacePath: "/workspace/project",
    });
    await client.createLease({
      outpostId: "workstation-02",
      productSessionId: "session-01",
      workspacePath: "/workspace/project",
    });

    const signatureOf = (call: number) =>
      (
        (fetchImpl.mock.calls[call] as unknown as [string, RequestInit])[1].headers as Record<
          string,
          string
        >
      )["X-OpenOutposts-Service-Signature"];
    expect(signatureOf(0)).not.toBe(signatureOf(1));
  });

  it("returns tool failures instead of throwing on invalid input", async () => {
    const { client } = clientWith(
      Response.json(
        { ok: false, error: "Invalid edit input", errorCode: "invalid_input" },
        { status: 400 }
      )
    );

    const result = await client.callTool("workstation-01", "lease-01", "edit", { path: "x" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
  });

  it("loads lease-scoped workspace context through a signed internal request", async () => {
    const { client, fetchImpl } = clientWith(
      Response.json({
        ok: true,
        files: [{ path: "outpost:/project/AGENTS.md", content: "# Project rules" }],
      })
    );

    await expect(client.readContext("workstation-01", "lease-01")).resolves.toEqual([
      { path: "outpost:/project/AGENTS.md", content: "# Project rules" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.example/outposts/workstation-01/leases/lease-01/context");
    expect(init.method).toBe("POST");
  });

  it("refuses malformed or failed workspace context snapshots", async () => {
    const malformed = clientWith(Response.json({ ok: true, files: [{ path: "", content: "x" }] }));
    await expect(malformed.client.readContext("workstation-01", "lease-01")).rejects.toThrow(
      "invalid workspace context"
    );

    const failed = clientWith(
      Response.json({ ok: false, files: [], error: "lease expired", errorCode: "lease_expired" })
    );
    await expect(failed.client.readContext("workstation-01", "lease-01")).rejects.toThrow(
      "lease expired"
    );
  });

  it("recovers a session only through a versioned credential rotation", async () => {
    const { client, fetchImpl } = clientWith(
      Response.json({
        recoveryVersion: 1,
        productSessionId: "session-01",
        sandboxId: "sandbox-01",
        sandboxAuthToken: "rotated-bridge",
        credentialFetchToken: "rotated-fetch",
      })
    );

    const recovered = await client.recoverSession("session-01", "sandbox-01");
    expect(recovered.sandboxAuthToken).toBe("rotated-bridge");
    expect(recovered.credentialFetchToken).toBe("rotated-fetch");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.example/outposts/session-recovery");
    expect(JSON.parse(init.body as string)).toEqual({
      recoveryVersion: 1,
      productSessionId: "session-01",
      sandboxId: "sandbox-01",
    });
  });

  it("refuses an incompatible session recovery response", async () => {
    const { client } = clientWith(
      Response.json({
        recoveryVersion: 2,
        productSessionId: "session-01",
        sandboxId: "sandbox-01",
        sandboxAuthToken: "rotated-bridge",
        credentialFetchToken: "rotated-fetch",
      })
    );

    await expect(client.recoverSession("session-01", "sandbox-01")).rejects.toThrow(
      "invalid session recovery response"
    );
  });

  it("throws on transport-level failures", async () => {
    const { client } = clientWith(new Response("Unauthorized", { status: 401 }));
    await expect(
      client.callTool("workstation-01", "lease-01", "bash", { command: "ls" })
    ).rejects.toThrow(OutpostClientError);
  });
});
