/**
 * Unit tests for SandboxLifecycleManager.
 *
 * Uses mocked dependencies to test lifecycle orchestration logic.
 */

import { describe, it, expect, vi } from "vitest";
import { hashToken } from "../../auth/crypto";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
  type SandboxLifecycleConfig,
} from "./manager";
import {
  SandboxProviderError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SessionRepositoryInfo,
} from "../provider";
import type { SandboxRow, SessionRow } from "../../session/types";
import type { SandboxStatus } from "../../types";

// ==================== Mock Factories ====================

function createMockSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-123",
    session_name: "test-session",
    title: "Test Session",
    repo_owner: "testowner",
    repo_name: "testrepo",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    outpost_id: null,
    created_at: Date.now() - 60000,
    updated_at: Date.now(),
    ...overrides,
  };
}

function createMockSandbox(
  overrides: Partial<SandboxRow & { spawn_failure_count: number; last_spawn_failure: number }> = {}
): SandboxRow & { spawn_failure_count: number; last_spawn_failure: number } {
  return {
    id: "sandbox-123",
    modal_sandbox_id: "sandbox-testowner-testrepo-123",
    modal_object_id: "modal-obj-123",
    snapshot_id: null,
    snapshot_image_id: null,
    auth_token: "auth-token-123",
    auth_token_hash: "auth-token-hash-123",
    credential_fetch_token_hash: null,
    status: "ready",
    git_sync_status: "completed",
    last_heartbeat: Date.now() - 10000,
    last_activity: Date.now() - 30000,
    last_spawn_error: null,
    last_spawn_error_at: null,
    code_server_url: null,
    code_server_password: null,
    tunnel_urls: null,
    ttyd_url: null,
    ttyd_token: null,
    created_at: Date.now() - 60000,
    spawn_failure_count: 0,
    last_spawn_failure: 0,
    ...overrides,
  };
}

function createMockStorage(
  session: SessionRow | null = createMockSession(),
  sandbox:
    | (SandboxRow & { spawn_failure_count: number; last_spawn_failure: number })
    | null = createMockSandbox(),
  sessionRepositories: SessionRepositoryInfo[] = []
): SandboxStorage & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    getSandbox: vi.fn(() => {
      calls.push("getSandbox");
      return sandbox;
    }),
    getSandboxWithCircuitBreaker: vi.fn(() => {
      calls.push("getSandboxWithCircuitBreaker");
      return sandbox;
    }),
    getSession: vi.fn(() => {
      calls.push("getSession");
      return session;
    }),
    getSessionRepositories: vi.fn(() => {
      calls.push("getSessionRepositories");
      return sessionRepositories;
    }),
    updateSandboxStatus: vi.fn((status: SandboxStatus) => {
      calls.push(`updateSandboxStatus:${status}`);
      if (sandbox) sandbox.status = status;
    }),
    updateSandboxForSpawn: vi.fn((data) => {
      calls.push("updateSandboxForSpawn");
      if (sandbox) {
        sandbox.status = data.status;
        sandbox.created_at = data.createdAt;
        sandbox.auth_token_hash = data.authTokenHash;
        sandbox.credential_fetch_token_hash = data.credentialFetchTokenHash;
        sandbox.auth_token = null;
        sandbox.modal_sandbox_id = data.modalSandboxId;
        sandbox.modal_object_id = null;
      }
    }),
    updateSandboxLastActivity: vi.fn((timestamp: number) => {
      calls.push("updateSandboxLastActivity");
      if (sandbox) sandbox.last_activity = timestamp;
    }),
    incrementCircuitBreakerFailure: vi.fn((timestamp: number) => {
      calls.push("incrementCircuitBreakerFailure");
      if (sandbox) {
        sandbox.spawn_failure_count++;
        sandbox.last_spawn_failure = timestamp;
      }
    }),
    resetCircuitBreaker: vi.fn(() => {
      calls.push("resetCircuitBreaker");
      if (sandbox) {
        sandbox.spawn_failure_count = 0;
        sandbox.last_spawn_failure = 0;
      }
    }),
    setLastSpawnError: vi.fn((error: string | null, timestamp: number | null) => {
      calls.push(`setLastSpawnError:${error ?? "null"}`);
      if (sandbox) {
        sandbox.last_spawn_error = error;
        sandbox.last_spawn_error_at = timestamp;
      }
    }),
    clearLegacySandboxAccessState: vi.fn(() => {
      calls.push("clearLegacySandboxAccessState");
      if (sandbox) {
        sandbox.code_server_url = null;
        sandbox.code_server_password = null;
        sandbox.tunnel_urls = null;
        sandbox.ttyd_url = null;
        sandbox.ttyd_token = null;
      }
    }),
  };
}

function createMockBroadcaster(): SandboxBroadcaster & { messages: object[] } {
  const messages: object[] = [];
  return {
    messages,
    broadcast: vi.fn((message: object) => {
      messages.push(message);
    }),
  };
}

function createMockWebSocketManager(
  hasSandboxWs = false,
  clientCount = 0
): WebSocketManager & { sendCalls: object[] } {
  const sendCalls: object[] = [];
  return {
    sendCalls,
    getSandboxWebSocket: vi.fn(() => (hasSandboxWs ? ({} as WebSocket) : null)),
    closeSandboxWebSocket: vi.fn(),
    sendToSandbox: vi.fn((message: object) => {
      sendCalls.push(message);
      return true;
    }),
    getConnectedClientCount: vi.fn(() => clientCount),
  };
}

function createMockAlarmScheduler(): AlarmScheduler & { alarms: number[] } {
  const alarms: number[] = [];
  return {
    alarms,
    scheduleAlarm: vi.fn(async (timestamp: number) => {
      alarms.push(timestamp);
    }),
  };
}

function createMockIdGenerator(): IdGenerator {
  let counter = 0;
  return {
    generateId: vi.fn(() => `generated-id-${++counter}`),
  };
}

function parseStructuredLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map(
    (call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>
  );
}

function createMockProvider(
  overrides: Partial<{
    createSandbox: (config: CreateSandboxConfig) => Promise<CreateSandboxResult>;
  }> = {}
): SandboxProvider {
  return {
    name: "mock",
    createSandbox:
      overrides.createSandbox ||
      vi.fn(async (config: CreateSandboxConfig) => ({
        sandboxId: config.sandboxId,
        status: "connecting",
        createdAt: Date.now(),
      })),
  };
}

function createTestConfig(): SandboxLifecycleConfig {
  return {
    ...DEFAULT_LIFECYCLE_CONFIG,
    controlPlaneUrl: "https://test.workers.dev",
    model: "anthropic/claude-sonnet-4-5",
  };
}

// ==================== Tests ====================

describe("SandboxLifecycleManager", () => {
  describe("spawnSandbox", () => {
    it("passes the session's pinned outpost to the provider", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(
        createMockSession({ outpost_id: "build-server-01" }),
        sandbox
      );
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ outpostId: "build-server-01" })
      );
    });

    it("spawns when all conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const alarmScheduler = createMockAlarmScheduler();
      const idGenerator = createMockIdGenerator();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxForSpawn");
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ outpostId: null })
      );
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_status")
      ).toBe(true);

      // Two distinct credentials, both hashed before the provider is called.
      const [config] = vi.mocked(provider.createSandbox).mock.calls[0];
      expect(config.credentialFetchToken).toBeTruthy();
      expect(config.credentialFetchToken).not.toBe(config.sandboxAuthToken);
      const [spawnData] = vi.mocked(storage.updateSandboxForSpawn).mock.calls[0];
      expect(spawnData.authTokenHash).toBe(await hashToken(config.sandboxAuthToken));
      expect(spawnData.credentialFetchTokenHash).toBe(await hashToken(config.credentialFetchToken));
    });

    it("logs one terminal sandbox.spawn event for success", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const spawnLogs = parseStructuredLogs(logSpy).filter(
        (entry) => entry.msg === "Sandbox spawn completed" && entry.event === "sandbox.spawn"
      );
      logSpy.mockRestore();

      expect(spawnLogs).toHaveLength(1);
      expect(spawnLogs[0]).toEqual(
        expect.objectContaining({
          outcome: "success",
          sandbox_id: expect.any(String),
          duration_ms: expect.any(Number),
        })
      );
    });

    it("logs one terminal sandbox.spawn event for failure", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new Error("spawn exploded");
        }),
      });
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const errorLogs = parseStructuredLogs(errorSpy);
      errorSpy.mockRestore();

      expect(errorLogs).toContainEqual(
        expect.objectContaining({
          msg: "Sandbox spawn completed",
          event: "sandbox.spawn",
          outcome: "error",
          duration_ms: expect.any(Number),
        })
      );
    });

    it("does not overwrite a stop that lands while spawn failure is pending", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      let rejectSpawn!: (reason?: unknown) => void;
      const provider = createMockProvider({
        createSandbox: vi.fn(
          () =>
            new Promise<CreateSandboxResult>((_resolve, reject) => {
              rejectSpawn = reject;
            })
        ),
      });
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const spawning = manager.spawnSandbox();
      await vi.waitFor(() => expect(provider.createSandbox).toHaveBeenCalledOnce());

      storage.updateSandboxStatus("stopped");
      rejectSpawn(new SandboxProviderError("No homestead is connected", "transient"));
      await spawning;

      expect(sandbox.status).toBe("stopped");
      expect(
        broadcaster.messages.some(
          (message) => (message as { type?: string }).type === "sandbox_error"
        )
      ).toBe(false);
    });

    it("does not overwrite a stop that lands while spawn success is pending", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      let resolveSpawn!: (result: CreateSandboxResult) => void;
      const provider = createMockProvider({
        createSandbox: vi.fn(
          () =>
            new Promise<CreateSandboxResult>((resolve) => {
              resolveSpawn = resolve;
            })
        ),
      });
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const spawning = manager.spawnSandbox();
      await vi.waitFor(() => expect(provider.createSandbox).toHaveBeenCalledOnce());
      const [createConfig] = vi.mocked(provider.createSandbox).mock.calls[0];

      storage.updateSandboxStatus("stopped");
      resolveSpawn({
        sandboxId: createConfig.sandboxId,
        status: "connecting",
        createdAt: Date.now(),
      });
      await spawning;

      expect(sandbox.status).toBe("stopped");
      expect(
        broadcaster.messages.some(
          (message) =>
            (message as { type?: string; status?: string }).type === "sandbox_status" &&
            (message as { status?: string }).status === "connecting"
        )
      ).toBe(false);
    });

    it("logs only an error terminal event when spawn success-side effects fail", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      vi.mocked(storage.resetCircuitBreaker).mockImplementation(() => {
        throw new Error("storage unavailable");
      });
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );
      const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      const terminalLogs = [
        ...parseStructuredLogs(infoSpy),
        ...parseStructuredLogs(errorSpy),
      ].filter((entry) => entry.event === "sandbox.spawn");
      infoSpy.mockRestore();
      errorSpy.mockRestore();

      expect(terminalLogs).toHaveLength(1);
      expect(terminalLogs[0]).toEqual(expect.objectContaining({ outcome: "error" }));
    });

    it("schedules connecting timeout alarm after spawn", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.spawnSandbox();
      const after = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const scheduledTime = alarmScheduler.alarms[0];
      expect(scheduledTime).toBeGreaterThanOrEqual(before + config.connectingTimeout.timeoutMs);
      expect(scheduledTime).toBeLessThanOrEqual(after + config.connectingTimeout.timeoutMs);
    });

    it("respects circuit breaker blocking", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        spawn_failure_count: 3,
        last_spawn_failure: now - 60000, // 1 minute ago, within 5 min window
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_error")
      ).toBe(true);
    });

    it("resets circuit breaker when window passes", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        created_at: now - 60000,
        spawn_failure_count: 3,
        last_spawn_failure: now - 6 * 60 * 1000, // 6 minutes ago, outside 5 min window
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("resetCircuitBreaker");
      expect(provider.createSandbox).toHaveBeenCalled();
    });

    it("updates status correctly through lifecycle", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      // Should go: pending -> spawning -> connecting
      const statusCalls = storage.calls.filter((c) => c.startsWith("updateSandbox"));
      expect(statusCalls).toContain("updateSandboxForSpawn");
      expect(statusCalls).toContain("updateSandboxStatus:connecting");
    });

    it("handles provider errors and increments failure count for permanent errors", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new SandboxProviderError("Auth failed", "permanent");
        }),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("does not increment circuit breaker for transient errors", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new SandboxProviderError("Network timeout", "transient");
        }),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).not.toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("skips spawn when already spawning", async () => {
      const sandbox = createMockSandbox({ status: "spawning" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
  });

  describe("handleAlarm", () => {
    it("detects heartbeat timeout and sets stale", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // 100 seconds ago, past 90s timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:stale");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "stale")).toBe(
        true
      );
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
      expect(wsManager.closeSandboxWebSocket).toHaveBeenCalledWith(1000, "Heartbeat stale");
    });

    it("handles inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000, // Recent heartbeat
        last_activity: now - 11 * 60 * 1000, // 11 minutes ago, past 10 min timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0); // No clients
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:stopped");
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
    });

    it("extends timeout when clients connected", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 11 * 60 * 1000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 2); // 2 clients connected
      const alarmScheduler = createMockAlarmScheduler();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      // Should extend, not timeout
      expect(storage.calls).not.toContain("updateSandboxStatus:stopped");
      expect(alarmScheduler.alarms.length).toBe(1);
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_warning")
      ).toBe(true);
    });

    it("schedules next alarm correctly", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 5 * 60 * 1000, // 5 minutes ago, not yet timed out
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0);
      const alarmScheduler = createMockAlarmScheduler();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:stopped");
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("calls onSandboxTerminating callback on heartbeat stale", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // Past 90s timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledOnce();
    });

    it("calls onSandboxTerminating callback on inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000, // Recent heartbeat
        last_activity: now - 11 * 60 * 1000, // Past 10 min timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false, 0), // No clients
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledOnce();
    });

    it("does not call onSandboxTerminating when no callback provided", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);

      // No callbacks - should not throw
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();
      expect(storage.calls).toContain("updateSandboxStatus:stale");
    });

    it("detects connecting timeout and sets failed", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 130_000, // 130s ago, past 120s timeout
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(storage.calls).toContain("clearLegacySandboxAccessState");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "failed")).toBe(
        true
      );
      expect(
        broadcaster.messages.some((m) => (m as { type?: string }).type === "sandbox_error")
      ).toBe(true);
    });

    it("does not timeout connecting sandbox within timeout window", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 30_000, // 30s ago, well within 120s timeout
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
      // Should schedule a follow-up alarm
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("calls onSandboxTerminating callback on connecting timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 130_000,
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledOnce();
    });
  });

  describe("scheduleDisconnectCheck", () => {
    it("schedules alarm at heartbeat timeout from now", async () => {
      const storage = createMockStorage();
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.scheduleDisconnectCheck();
      const after = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const alarmTime = alarmScheduler.alarms[0];
      // Should be approximately now + heartbeat.timeoutMs (90s)
      expect(alarmTime).toBeGreaterThanOrEqual(before + config.heartbeat.timeoutMs);
      expect(alarmTime).toBeLessThanOrEqual(after + config.heartbeat.timeoutMs);
    });
  });

  describe("warmSandbox", () => {
    it("skips when sandbox already connected", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(true); // Has WebSocket
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("skips when status is spawning", async () => {
      const sandbox = createMockSandbox({ status: "spawning" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("calls spawnSandbox when conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_warming")
      ).toBe(true);
      expect(provider.createSandbox).toHaveBeenCalled();
    });
  });

  describe("updateLastActivity", () => {
    it("updates storage", () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const timestamp = Date.now();
      manager.updateLastActivity(timestamp);

      expect(storage.calls).toContain("updateSandboxLastActivity");
    });
  });

  describe("scheduleInactivityCheck", () => {
    it("schedules alarm at correct time", async () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const beforeTime = Date.now();
      await manager.scheduleInactivityCheck();
      const afterTime = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const scheduledTime = alarmScheduler.alarms[0];
      expect(scheduledTime).toBeGreaterThanOrEqual(beforeTime + config.inactivity.timeoutMs);
      expect(scheduledTime).toBeLessThanOrEqual(afterTime + config.inactivity.timeoutMs);
    });
  });

  describe("multi-repo spawn", () => {
    const MULTI_REPO_MEMBERS: SessionRepositoryInfo[] = [
      { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
      { repoOwner: "testowner", repoName: "backend", baseBranch: "develop" },
    ];

    function createMultiRepoManager(overrides?: {
      provider?: SandboxProvider;
      sandbox?: ReturnType<typeof createMockSandbox>;
      sessionRepositories?: SessionRepositoryInfo[];
    }) {
      const sandbox =
        overrides?.sandbox ??
        createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(
        createMockSession(),
        sandbox,
        overrides?.sessionRepositories ?? MULTI_REPO_MEMBERS
      );
      const provider = overrides?.provider ?? createMockProvider();
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );
      return { manager, provider, storage };
    }

    it("passes the member list on fresh spawns", async () => {
      const { manager, provider } = createMultiRepoManager();

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ repositories: MULTI_REPO_MEMBERS })
      );
    });

    it("omits the member list for single-member sessions", async () => {
      const { manager, provider } = createMultiRepoManager({
        sessionRepositories: [MULTI_REPO_MEMBERS[0]],
      });

      await manager.spawnSandbox();

      const config = vi.mocked(provider.createSandbox).mock.calls[0][0];
      expect(config.repositories).toBeUndefined();
    });

    it("omits the member list for pre-list sessions with no member rows", async () => {
      const { manager, provider } = createMultiRepoManager({ sessionRepositories: [] });

      await manager.spawnSandbox();

      const config = vi.mocked(provider.createSandbox).mock.calls[0][0];
      expect(config.repositories).toBeUndefined();
    });
  });

  describe("sandbox settings", () => {
    it("doSpawn() passes sandboxSettings from session to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("doSpawn() passes empty settings when sandbox_settings is null", async () => {
      const session = createMockSession({ sandbox_settings: null });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });

    it("doSpawn() sanitizes malformed tunnelPorts from stored settings", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":["not-a-number", -1, 99999, 3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("doSpawn() forwards valid cpuCores and memoryMib to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"cpuCores":2,"memoryMib":4096}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { cpuCores: 2, memoryMib: 4096 },
        })
      );
    });

    it("doSpawn() drops non-positive cpuCores and memoryMib from stored settings", async () => {
      const session = createMockSession({
        sandbox_settings: '{"cpuCores":-2,"memoryMib":0}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });
  });
});
