import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModalSandboxDashboardUrl,
  buildModalWorkspaceSlug,
  createModalClient,
} from "./client";

describe("buildModalWorkspaceSlug", () => {
  it("uses the raw workspace when the Modal environment has no web suffix", () => {
    expect(buildModalWorkspaceSlug("acme")).toBe("acme");
    expect(buildModalWorkspaceSlug("acme", "")).toBe("acme");
  });

  it("appends the Modal environment web suffix for endpoint URLs", () => {
    expect(buildModalWorkspaceSlug("acme", "prod-web")).toBe("acme-prod-web");
  });
});

describe("buildModalSandboxDashboardUrl", () => {
  it("builds a Modal dashboard URL for a sandbox object", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/main/deployed/openoutposts?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("supports an explicit Modal environment", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        modalEnvironment: "production",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/production/deployed/openoutposts?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("encodes URL components", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme team",
        modalEnvironment: "prod/main",
        providerObjectId: "sb 123/456?x=1",
      })
    ).toBe(
      "https://modal.com/apps/acme%20team/prod%2Fmain/deployed/openoutposts?activeTab=sandboxes&sandboxId=sb%20123%2F456%3Fx%3D1"
    );
  });

  it("returns null when required inputs are missing", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: undefined,
        providerObjectId: "sb-123",
      })
    ).toBeNull();
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: null,
      })
    ).toBeNull();
  });
});

describe("ModalClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends multi-repo members as flat snake_case create fields", async () => {
    // Modal's create handler builds its SessionConfig from the request by
    // field name, so the wire keys must match SessionConfig exactly.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { sandbox_id: "sb-1", status: "spawning", created_at: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.createSandbox({
      sessionId: "session-123",
      sandboxId: "sandbox-456",
      repoOwner: "testowner",
      repoName: "testrepo",
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "auth-token",
      repositories: [
        { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
        { repoOwner: "testowner", repoName: "backend", baseBranch: "develop" },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.repositories).toEqual([
      { repo_owner: "testowner", repo_name: "testrepo", branch: "main", base_sha: null },
      { repo_owner: "testowner", repo_name: "backend", branch: "develop", base_sha: null },
    ]);
  });

  it("sends a null repositories create field for single-repo sessions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { sandbox_id: "sb-1", status: "spawning", created_at: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.createSandbox({
      sessionId: "session-123",
      repoOwner: "testowner",
      repoName: "testrepo",
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "auth-token",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.repositories).toBeNull();
  });

  it("parses optional create response fields without rejecting valid Modal data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            sandbox_id: "sb-1",
            modal_object_id: "mo-1",
            status: "spawning",
            created_at: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.createSandbox({
        sessionId: "session-123",
        repoOwner: "testowner",
        repoName: "testrepo",
        controlPlaneUrl: "https://control-plane.test",
        sandboxAuthToken: "auth-token",
      })
    ).resolves.toEqual({
      sandboxId: "sb-1",
      modalObjectId: "mo-1",
      status: "spawning",
      createdAt: 1,
    });
  });

  it("parses nullable create response fields from Modal-infra", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            sandbox_id: "sb-1",
            modal_object_id: null,
            status: "spawning",
            created_at: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    const result = await client.createSandbox({
      sessionId: "session-123",
      repoOwner: "testowner",
      repoName: "testrepo",
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "auth-token",
    });

    expect(result).toEqual({
      sandboxId: "sb-1",
      modalObjectId: undefined,
      status: "spawning",
      createdAt: 1,
    });
  });

  it("rejects malformed create responses instead of trusting the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { sandbox_id: "sb-1", status: "spawning", created_at: "1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await expect(
      client.createSandbox({
        sessionId: "session-123",
        repoOwner: "testowner",
        repoName: "testrepo",
        controlPlaneUrl: "https://control-plane.test",
        sandboxAuthToken: "auth-token",
      })
    ).rejects.toThrow("Modal API error: Invalid response");
  });
});
