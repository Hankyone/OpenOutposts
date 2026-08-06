import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { createSandboxProviderFromEnv } from "./provider-factory";

function createEnv(overrides: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    MEDIA_BUCKET: {} as R2Bucket,
    TOKEN_ENCRYPTION_KEY: "test-token-key",
    DEPLOYMENT_NAME: "test",
    ...overrides,
  } as Env;
}

describe("createSandboxProviderFromEnv", () => {
  it("builds the outpost backend", () => {
    const env = createEnv({
      HOMESTEAD: {} as DurableObjectNamespace,
      OUTPOST_TARGET_ID: "outpost-1",
      OUTPOST_TARGET_WORKSPACE_ROOT: "/srv/workspaces",
    });

    expect(createSandboxProviderFromEnv(env).name).toBe("outpost");
  });

  it("refuses to run without the homestead binding", () => {
    const env = createEnv({
      OUTPOST_TARGET_ID: "outpost-1",
      OUTPOST_TARGET_WORKSPACE_ROOT: "/srv/workspaces",
    });

    expect(() => createSandboxProviderFromEnv(env)).toThrow(
      "The HOMESTEAD Durable Object binding is required"
    );
  });

  it("refuses to run without an execution target", () => {
    const env = createEnv({ HOMESTEAD: {} as DurableObjectNamespace });

    expect(() => createSandboxProviderFromEnv(env)).toThrow(
      "OUTPOST_TARGET_ID and OUTPOST_TARGET_WORKSPACE_ROOT are required"
    );
  });

  it("refuses a cloud sandbox backend rather than substituting one", () => {
    const env = createEnv({ SANDBOX_PROVIDER: "modal" });

    expect(() => createSandboxProviderFromEnv(env)).toThrow("Unsupported SANDBOX_PROVIDER: modal");
  });
});
