// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionTargetPicker } from "./use-session-target-picker";

const mocks = vi.hoisted(() => ({
  outposts: [] as Array<{
    id: string;
    name: string;
    platform: string;
    architecture: string;
    connected: boolean;
    lastSeenAt: string;
  }>,
  loadingOutposts: false,
  outpostsUnavailable: false,
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [
      {
        id: 1,
        fullName: "acme/web",
        owner: "acme",
        name: "web",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ],
    loading: false,
  }),
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [], loading: false }),
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: () => ({ branches: [{ name: "main" }], loading: false }),
}));

vi.mock("@/hooks/use-outposts", () => ({
  useOutposts: () => ({
    outposts: mocks.outposts,
    loading: mocks.loadingOutposts,
    unavailable: mocks.outpostsUnavailable,
    refresh: vi.fn(),
  }),
}));

function machine(id: string, connected = true) {
  return {
    id,
    name: id === "workshop" ? "Workshop" : "Laptop",
    platform: "darwin",
    architecture: "arm64",
    connected,
    lastSeenAt: "2026-08-18T12:00:00.000Z",
  };
}

beforeEach(() => {
  mocks.outposts = [];
  mocks.loadingOutposts = false;
  mocks.outpostsUnavailable = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useSessionTargetPicker machine placement", () => {
  it("defaults to a connected machine and builds a combined request", async () => {
    mocks.outposts = [machine("workshop")];
    const { result } = renderHook(() => useSessionTargetPicker());

    await waitFor(() => expect(result.current.selectedOutpost?.id).toBe("workshop"));

    expect(result.current.sessionTarget).toEqual({
      kind: "repo",
      repoFullName: "acme/web",
      outpostId: "workshop",
    });
    expect(result.current.buildRequestFields()).toEqual({
      repoOwner: "acme",
      repoName: "web",
      branch: "main",
      outpostId: "workshop",
    });
    expect(result.current.configKey).toContain("outpost:workshop");
  });

  it("restores a still-listed stored machine before another connected machine", async () => {
    localStorage.setItem("openoutposts-last-selected-outpost", "laptop");
    mocks.outposts = [machine("workshop"), machine("laptop", false)];
    const { result } = renderHook(() => useSessionTargetPicker());

    await waitFor(() => expect(result.current.selectedOutpost?.id).toBe("laptop"));

    expect(result.current.sessionTarget?.outpostId).toBe("laptop");
  });

  it("changes machine identity without changing the repository target", async () => {
    mocks.outposts = [machine("workshop"), machine("laptop")];
    const { result } = renderHook(() => useSessionTargetPicker());

    await waitFor(() => expect(result.current.selectedOutpost?.id).toBe("workshop"));
    const previousTarget = result.current.sessionTarget;
    const previousConfigKey = result.current.configKey;

    act(() => result.current.pickerProps.onOutpostSelectValueChange("laptop"));

    expect(result.current.sessionTarget).not.toBe(previousTarget);
    expect(result.current.sessionTarget).toEqual({
      kind: "repo",
      repoFullName: "acme/web",
      outpostId: "laptop",
    });
    expect(result.current.configKey).not.toBe(previousConfigKey);
    expect(result.current.buildRequestFields()).toMatchObject({
      repoOwner: "acme",
      repoName: "web",
      outpostId: "laptop",
    });
  });

  it("keeps a no-outpost deployment launchable and reports an unavailable fleet honestly", async () => {
    mocks.outpostsUnavailable = true;
    const { result } = renderHook(() => useSessionTargetPicker());

    await waitFor(() => expect(result.current.sessionTarget?.kind).toBe("repo"));

    expect(result.current.selectedOutpost).toBeUndefined();
    expect(result.current.outpostsUnavailable).toBe(true);
    expect(result.current.loadingOutposts).toBe(false);
    expect(result.current.isLaunchable).toBe(true);
    expect(result.current.buildRequestFields()).toEqual({
      repoOwner: "acme",
      repoName: "web",
      branch: "main",
    });
  });
});
