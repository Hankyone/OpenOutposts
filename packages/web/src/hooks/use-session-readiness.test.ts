// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTargetSelection } from "./use-session-target-picker";
import { useSessionReadiness } from "./use-session-readiness";

const mocks = vi.hoisted(() => ({
  homestead: { connected: true as boolean | null, loading: false, unavailable: false },
  outpost: {
    sessions: [],
    connected: true as boolean | null,
    lastHeartbeatAt: "2026-08-18T12:00:00.000Z" as string | null,
    loading: false,
    unavailable: false,
  },
  credentials: {
    credentials: [
      {
        id: "credential-1",
        provider: "anthropic",
        label: null,
        kind: "api_key" as const,
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
    ],
    loading: false,
    unavailable: false,
    mutate: vi.fn(),
  },
  catalog: {
    catalog: null,
    view: {
      source: "homestead" as "homestead" | "stale" | "unavailable",
      reportedAt: "2026-08-18T12:00:00.000Z",
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: [
            {
              id: "anthropic/claude-sonnet",
              providerId: "anthropic",
              modelId: "claude-sonnet",
              name: "Claude Sonnet",
              description: null,
              reasoning: null,
              contextWindow: null,
              maxTokens: null,
              inProductCatalog: true,
            },
          ],
        },
      ],
      unconnectedProviders: [],
    },
    source: "homestead" as "homestead" | "stale" | "unavailable" | "error" | null,
    loading: false,
    unavailable: false,
  },
}));

vi.mock("@/hooks/use-homestead-readiness", () => ({
  useHomesteadReadiness: () => mocks.homestead,
}));
vi.mock("@/hooks/use-outposts", () => ({
  useOutpostBoundSessions: () => mocks.outpost,
}));
vi.mock("@/hooks/use-provider-credentials", () => ({
  useProviderCredentials: () => mocks.credentials,
}));
vi.mock("@/hooks/use-model-catalog", () => ({
  useModelCatalog: () => mocks.catalog,
}));

function picker(overrides: Partial<SessionTargetSelection> = {}): SessionTargetSelection {
  return {
    sessionTarget: {
      kind: "repo",
      repoFullName: "acme/web",
      outpostId: "workstation-1",
    },
    selectedBranch: "main",
    repos: [],
    loadingRepos: false,
    selectedRepo: {
      id: 1,
      fullName: "acme/web",
      owner: "acme",
      name: "web",
      description: null,
      private: true,
      defaultBranch: "main",
    },
    selectedOutpost: {
      id: "workstation-1",
      name: "Workstation",
      platform: "darwin",
      architecture: "arm64",
      connected: true,
      lastSeenAt: "2026-08-18T12:00:00.000Z",
    },
    loadingOutposts: false,
    outpostsUnavailable: false,
    isLaunchable: true,
    configKey: "acme/web|outpost:workstation-1",
    buildRequestFields: () => null,
    pickerProps: { displayTargetName: "web" } as SessionTargetSelection["pickerProps"],
    ...overrides,
  };
}

describe("useSessionReadiness", () => {
  beforeEach(() => {
    mocks.homestead.connected = true;
    mocks.homestead.loading = false;
    mocks.homestead.unavailable = false;
    mocks.outpost.connected = true;
    mocks.outpost.loading = false;
    mocks.outpost.unavailable = false;
    mocks.credentials.credentials = [
      {
        id: "credential-1",
        provider: "anthropic",
        label: null,
        kind: "api_key",
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
    ];
    mocks.credentials.loading = false;
    mocks.credentials.unavailable = false;
    mocks.catalog.source = "homestead";
    mocks.catalog.loading = false;
    mocks.catalog.unavailable = false;
    mocks.catalog.view.source = "homestead";
  });

  it("reports the five live facts for a ready selection", () => {
    const { result } = renderHook(() => useSessionReadiness(picker(), "anthropic/claude-sonnet"));

    expect(result.current).toEqual([
      { label: "Homestead", value: "Connected", tone: "ready" },
      { label: "Machine", value: "Workstation, connected", tone: "ready" },
      { label: "Provider key", value: "Anthropic connected", tone: "ready" },
      { label: "Model", value: "Ready", tone: "ready" },
      { label: "Repository", value: "acme/web", tone: "ready" },
    ]);
  });

  it("points blocked checks to the existing repair screens", () => {
    mocks.homestead.connected = false;
    mocks.outpost.connected = false;
    mocks.credentials.credentials = [];
    mocks.catalog.source = "stale";
    mocks.catalog.view.source = "stale";

    const noRepository = picker({
      sessionTarget: { kind: "none", outpostId: "workstation-1" },
      selectedRepo: undefined,
    });
    const { result } = renderHook(() =>
      useSessionReadiness(noRepository, "anthropic/claude-sonnet")
    );

    expect(result.current).toContainEqual({
      label: "Machine",
      value: "Workstation, offline",
      tone: "blocked",
      href: "/machines",
    });
    expect(result.current).toContainEqual({
      label: "Provider key",
      value: "Connect Anthropic",
      tone: "blocked",
      href: "/settings?tab=providers",
    });
    expect(result.current).toContainEqual({
      label: "Repository",
      value: "No repository",
      tone: "neutral",
    });
  });
});
