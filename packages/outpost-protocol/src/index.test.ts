import { describe, expect, it } from "vitest";

import {
  MODEL_CATALOG_VERSION,
  OUTPOST_PROTOCOL_VERSION,
  HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE,
  HOMESTEAD_RECOVERY_VERSION,
  HOMESTEAD_SUPERSEDED_CLOSE_CODE,
  MAX_SESSION_STARTUP_ERROR_LENGTH,
  bridgePromptCommandSchema,
  reasoningEffortSchema,
  thinkingLevelForReasoningEffort,
  controlToHomesteadMessageSchema,
  controlToWorkerMessageSchema,
  homesteadRecoveryRequestSchema,
  homesteadRecoveryResponseSchema,
  sessionStartupFailureRequestSchema,
  homesteadToControlMessageSchema,
  outpostOperationSchema,
  toolInputSchemas,
  toolResultSchemas,
  workerToControlMessageSchema,
} from "./index";

describe("outpost protocol", () => {
  it("accepts a versioned registration", () => {
    const result = workerToControlMessageSchema.parse({
      type: "outpost.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      outpostId: "workstation-01",
      name: "Anouar's workstation",
      workerVersion: "0.1.0",
      capabilities: {
        platform: "darwin",
        architecture: "arm64",
        operations: ["bash", "read", "write", "edit", "grep", "find", "ls"],
        workspaceRoots: ["/workspace"],
      },
    });

    expect(result.type).toBe("outpost.register");
  });

  it("rejects an incompatible protocol version", () => {
    const result = workerToControlMessageSchema.safeParse({
      type: "outpost.heartbeat",
      protocolVersion: OUTPOST_PROTOCOL_VERSION + 1,
      outpostId: "workstation-01",
      sentAt: "2026-07-22T12:00:00Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an outpost ID that cannot be used as a route identity", () => {
    const result = workerToControlMessageSchema.safeParse({
      type: "outpost.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      outpostId: "workstation/01",
      name: "Workstation",
      workerVersion: "0.1.0",
      capabilities: {
        platform: "darwin",
        architecture: "arm64",
        operations: ["bash"],
        workspaceRoots: [],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts registration and heartbeat acknowledgements", () => {
    expect(
      controlToWorkerMessageSchema.parse({
        type: "outpost.registered",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId: "workstation-01",
        connectionId: "connection-01",
        registeredAt: "2026-07-22T12:00:00Z",
        heartbeatIntervalMs: 15_000,
      }).type
    ).toBe("outpost.registered");

    expect(
      controlToWorkerMessageSchema.parse({
        type: "outpost.heartbeat_ack",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId: "workstation-01",
        receivedAt: "2026-07-22T12:00:15Z",
      }).type
    ).toBe("outpost.heartbeat_ack");
  });

  it("accepts lease acceptance and typed tool results", () => {
    expect(
      workerToControlMessageSchema.parse({
        type: "lease.accepted",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        leaseId: "lease-01",
      }).type
    ).toBe("lease.accepted");

    const result = workerToControlMessageSchema.parse({
      type: "tool.result",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      requestId: "request-01",
      leaseId: "lease-01",
      ok: false,
      output: null,
      error: "lease lease-01 is not active on this worker",
      errorCode: "lease_unknown",
    });
    expect(result.type).toBe("tool.result");
  });

  it("validates per-operation tool payloads", () => {
    expect(toolInputSchemas.bash.safeParse({ command: "ls -la", timeoutMs: 30_000 }).success).toBe(
      true
    );
    expect(toolInputSchemas.bash.safeParse({ command: "" }).success).toBe(false);
    expect(toolInputSchemas.edit.safeParse({ path: "a.txt", oldString: "x" }).success).toBe(false);
    expect(
      toolResultSchemas.bash.safeParse({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        durationMs: 12,
        truncated: false,
      }).success
    ).toBe(true);
  });

  it("accepts homestead registration and session assignment", () => {
    expect(
      homesteadToControlMessageSchema.parse({
        type: "homestead.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        homesteadId: "homestead-01",
        homesteadVersion: "0.1.0",
        harnesses: ["pi"],
      }).type
    ).toBe("homestead.register");

    const assignment = controlToHomesteadMessageSchema.parse({
      type: "session.assign",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      assignmentId: "assignment-01",
      productSessionId: "session-01",
      sandboxId: "sandbox-01",
      sandboxAuthToken: "token-01",
      credentialFetchToken: "fetch-token-01",
      controlPlaneUrl: "https://control.example",
      harness: "pi",
      model: "anthropic/claude-sonnet-4-6",
      outpostId: "workstation-01",
      workspacePath: "/workspace/project",
    });
    expect(assignment.type).toBe("session.assign");

    // The credential-fetch token is required, not optional: a control plane
    // that could omit it would leave the homestead with only the bridge token to
    // fetch a provider key with, which is the reach this field removes.
    expect(
      controlToHomesteadMessageSchema.safeParse({
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-02",
        productSessionId: "session-02",
        sandboxId: "sandbox-02",
        sandboxAuthToken: "token-02",
        controlPlaneUrl: "https://control.example",
        harness: "pi",
        outpostId: "workstation-01",
        workspacePath: "/workspace/project",
      }).success
    ).toBe(false);

    expect(
      homesteadToControlMessageSchema.safeParse({
        type: "session.assign_rejected",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId: "assignment-01",
        reason: "outpost is not connected",
      }).success
    ).toBe(true);
  });

  it("versions homestead restart recovery separately from protocol messages", () => {
    expect(
      homesteadRecoveryRequestSchema.parse({
        recoveryVersion: HOMESTEAD_RECOVERY_VERSION,
        productSessionId: "session-01",
        sandboxId: "sandbox-01",
      })
    ).toEqual({
      recoveryVersion: 1,
      productSessionId: "session-01",
      sandboxId: "sandbox-01",
    });
    expect(
      homesteadRecoveryResponseSchema.safeParse({
        recoveryVersion: 2,
        productSessionId: "session-01",
        sandboxId: "sandbox-01",
        sandboxAuthToken: "bridge-token",
        credentialFetchToken: "fetch-token",
      }).success
    ).toBe(false);
  });

  it("bounds post-accept startup failure reports", () => {
    expect(
      sessionStartupFailureRequestSchema.parse({
        stage: "repository_clone",
        error: "git clone exited 128",
        sandboxId: "sandbox-01",
        timestamp: 1_800_000_000_000,
      })
    ).toEqual({
      stage: "repository_clone",
      error: "git clone exited 128",
      sandboxId: "sandbox-01",
      timestamp: 1_800_000_000_000,
    });
    expect(
      sessionStartupFailureRequestSchema.safeParse({
        stage: "repository_clone",
        error: "x".repeat(MAX_SESSION_STARTUP_ERROR_LENGTH + 1),
        sandboxId: "sandbox-01",
        timestamp: 1_800_000_000_000,
      }).success
    ).toBe(false);
  });

  it("tells a refused homestead identity apart from every other refusal", () => {
    expect(
      controlToHomesteadMessageSchema.safeParse({
        type: "homestead.error",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        code: "duplicate_identity",
        message: "Homestead id homestead-01 is already registered on another live connection",
      }).success
    ).toBe(true);

    // A homestead has to act differently on each: being refused means another
    // process owns this id and retrying at once is a hot loop, while being
    // superseded means this connection was already judged dead.
    expect(HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE).not.toBe(HOMESTEAD_SUPERSEDED_CLOSE_CODE);
  });

  it("accepts a registration that reports a model catalog", () => {
    const result = homesteadToControlMessageSchema.parse({
      type: "homestead.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      homesteadId: "homestead-01",
      homesteadVersion: "0.1.0",
      harnesses: ["pi"],
      catalog: {
        catalogVersion: MODEL_CATALOG_VERSION,
        providers: [{ id: "anthropic", name: "Anthropic" }],
        models: [
          {
            providerId: "anthropic",
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            reasoning: true,
            thinkingLevels: { off: null, max: "max" },
            input: ["text", "image"],
            contextWindow: 1_000_000,
            maxTokens: 128_000,
          },
        ],
      },
    });

    expect(result.type).toBe("homestead.register");
    // A message-level assertion would pass on a stripped catalog, which is
    // exactly the failure this field is prone to.
    expect(result.type === "homestead.register" && result.catalog?.models[0]?.id).toBe(
      "claude-sonnet-5"
    );
  });

  it("rejects a catalog whose payload version is not understood", () => {
    const result = homesteadToControlMessageSchema.safeParse({
      type: "homestead.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      homesteadId: "homestead-01",
      homesteadVersion: "0.1.0",
      harnesses: ["pi"],
      catalog: {
        catalogVersion: MODEL_CATALOG_VERSION + 1,
        providers: [],
        models: [],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts lease-scoped tool requests", () => {
    const result = controlToWorkerMessageSchema.parse({
      type: "tool.request",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      requestId: "request-01",
      leaseId: "lease-01",
      operation: "read",
      input: { path: "/workspace/README.md" },
    });

    expect(result.type).toBe("tool.request");
  });

  it("carries workspace context outside the seven model tool operations", () => {
    expect(
      controlToWorkerMessageSchema.parse({
        type: "context.request",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        requestId: "context-01",
        leaseId: "lease-01",
      }).type
    ).toBe("context.request");

    const result = workerToControlMessageSchema.parse({
      type: "context.result",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      requestId: "context-01",
      leaseId: "lease-01",
      ok: true,
      files: [{ path: "outpost:/AGENTS.md", content: "# Instructions" }],
    });
    expect(result.type === "context.result" && result.files[0]?.path).toBe("outpost:/AGENTS.md");
    expect(outpostOperationSchema.options).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("distinguishes one-request cancellation from lease-wide cancellation", () => {
    expect(
      controlToWorkerMessageSchema.parse({
        type: "tool.cancel",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        leaseId: "lease-01",
        requestId: "request-01",
      })
    ).toMatchObject({ requestId: "request-01" });

    expect(
      controlToWorkerMessageSchema.parse({
        type: "tool.cancel",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        leaseId: "lease-01",
      })
    ).not.toHaveProperty("requestId");

    expect(
      workerToControlMessageSchema.safeParse({
        type: "tool.result",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        requestId: "request-01",
        leaseId: "lease-01",
        ok: false,
        output: null,
        error: "request cancelled",
        errorCode: "cancelled",
      }).success
    ).toBe(true);
  });
});

describe("the turn contract", () => {
  const command = {
    type: "prompt",
    messageId: "msg-1",
    content: "what changed?",
    model: "anthropic/claude-sonnet-4-5",
    reasoningEffort: "high",
    author: {
      userId: "user-1",
      gitIdentity: { mode: "attributed-user", name: "Ada", email: "ada@example.com" },
    },
  };

  it("accepts a prompt exactly as the control plane sends it", () => {
    const result = bridgePromptCommandSchema.parse({
      ...command,
      attachments: [{ attachmentId: "att-1", name: "shot.png", mimeType: "image/png" }],
    });

    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    expect(result.reasoningEffort).toBe("high");
    expect(result.author?.userId).toBe("user-1");
    expect(result.attachments?.[0]?.name).toBe("shot.png");
  });

  it("accepts a prompt that chose neither a model nor an effort", () => {
    const result = bridgePromptCommandSchema.parse({
      type: "prompt",
      messageId: "msg-1",
      content: "hello",
    });

    expect(result.model).toBeUndefined();
  });

  it("accepts an agent-only git identity", () => {
    const result = bridgePromptCommandSchema.parse({
      ...command,
      author: { userId: "user-1", gitIdentity: { mode: "agent-only" } },
    });

    expect(result.author?.gitIdentity.mode).toBe("agent-only");
  });

  /**
   * A field one side sends and the other drops is the defect this schema was
   * added for; it has to be a parse failure and not a silent strip.
   */
  it("rejects a prompt carrying a field this version does not define", () => {
    const result = bridgePromptCommandSchema.safeParse({ ...command, toolPolicy: "unrestricted" });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("toolPolicy");
  });

  it("maps every product reasoning effort onto a harness thinking level", () => {
    for (const effort of reasoningEffortSchema.options) {
      expect(thinkingLevelForReasoningEffort(effort)).not.toBeNull();
    }
    expect(thinkingLevelForReasoningEffort("none")).toBe("off");
    expect(thinkingLevelForReasoningEffort("max")).toBe("max");
  });

  /** Null, not a default: an effort nobody agreed on must stop the turn. */
  it("refuses to guess at an effort it does not know", () => {
    expect(thinkingLevelForReasoningEffort("ludicrous")).toBeNull();
  });
});
