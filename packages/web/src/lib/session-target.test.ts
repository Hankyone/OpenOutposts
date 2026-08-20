import { describe, expect, it } from "vitest";
import {
  type SessionTarget,
  MULTIPLE_REPOSITORIES_OPTION_VALUE,
  NO_REPOSITORY_OPTION_VALUE,
  buildSessionTargetRequestFields,
  environmentOptionValue,
  getTargetConfigKey,
  getTargetSelectValue,
  isSessionTargetLaunchable,
  parseEnvironmentOptionValue,
  parseTargetSelectValue,
  setSessionTargetOutpost,
} from "./session-target";

describe("parseEnvironmentOptionValue", () => {
  it("round-trips environmentOptionValue and returns null for anything else", () => {
    expect(parseEnvironmentOptionValue(environmentOptionValue("env_a1"))).toBe("env_a1");
    expect(parseEnvironmentOptionValue("acme/web")).toBeNull();
    expect(parseEnvironmentOptionValue(NO_REPOSITORY_OPTION_VALUE)).toBeNull();
  });
});

describe("buildSessionTargetRequestFields", () => {
  it("preserves a nested owner namespace in a repository target", () => {
    expect(
      buildSessionTargetRequestFields({ kind: "repo", repoFullName: "group/subgroup/web" }, "main")
    ).toEqual({ repoOwner: "group/subgroup", repoName: "web", branch: "main" });
  });

  it("emits exactly one target mode per kind (createSessionRequestSchema exclusivity)", () => {
    const branch = "develop";

    const none = buildSessionTargetRequestFields({ kind: "none" }, branch);
    expect(none).toEqual({ repoOwner: null, repoName: null });

    const repo = buildSessionTargetRequestFields(
      { kind: "repo", repoFullName: "acme/backend" },
      branch
    );
    expect(repo).toEqual({ repoOwner: "acme", repoName: "backend", branch: "develop" });
    expect(repo).not.toHaveProperty("environmentId");
    expect(repo).not.toHaveProperty("repositories");

    const environment = buildSessionTargetRequestFields(
      { kind: "environment", environmentId: "env-1" },
      branch
    );
    expect(environment).toEqual({ environmentId: "env-1" });

    const repos = buildSessionTargetRequestFields(
      { kind: "repos", repoFullNames: ["acme/backend", "acme/frontend"] },
      branch
    );
    expect(repos).toEqual({
      repositories: [
        { repoOwner: "acme", repoName: "backend" },
        { repoOwner: "acme", repoName: "frontend" },
      ],
    });
    expect(repos).not.toHaveProperty("branch");
  });

  it("omits branch for a repo target when no branch is selected", () => {
    const fields = buildSessionTargetRequestFields(
      { kind: "repo", repoFullName: "acme/backend" },
      ""
    );
    expect(fields).toEqual({ repoOwner: "acme", repoName: "backend", branch: undefined });
    expect(JSON.parse(JSON.stringify(fields))).not.toHaveProperty("branch");
  });

  it("combines a repository target with independent machine placement", () => {
    const fields = buildSessionTargetRequestFields(
      { kind: "repo", repoFullName: "acme/backend", outpostId: "workshop" },
      "main"
    );

    expect(fields).toEqual({
      repoOwner: "acme",
      repoName: "backend",
      branch: "main",
      outpostId: "workshop",
    });
  });

  it("combines every repository mode with independent machine placement", () => {
    expect(buildSessionTargetRequestFields({ kind: "none", outpostId: "workshop" }, "")).toEqual({
      repoOwner: null,
      repoName: null,
      outpostId: "workshop",
    });
    expect(
      buildSessionTargetRequestFields(
        { kind: "environment", environmentId: "env-1", outpostId: "workshop" },
        ""
      )
    ).toEqual({ environmentId: "env-1", outpostId: "workshop" });
    expect(
      buildSessionTargetRequestFields(
        { kind: "repos", repoFullNames: ["acme/backend"], outpostId: "workshop" },
        ""
      )
    ).toEqual({
      repositories: [{ repoOwner: "acme", repoName: "backend" }],
      outpostId: "workshop",
    });
  });
});

describe("select-value round trip", () => {
  it("round-trips each target kind through its option value", () => {
    const targets: SessionTarget[] = [
      { kind: "none" },
      { kind: "repo", repoFullName: "acme/backend" },
      { kind: "environment", environmentId: "env_abc123" },
    ];
    for (const target of targets) {
      expect(parseTargetSelectValue(getTargetSelectValue(target), null)).toEqual(target);
    }
  });

  it("maps the sentinels to their option values", () => {
    expect(getTargetSelectValue({ kind: "none" })).toBe(NO_REPOSITORY_OPTION_VALUE);
    expect(getTargetSelectValue({ kind: "repos", repoFullNames: ["a/b"] })).toBe(
      MULTIPLE_REPOSITORIES_OPTION_VALUE
    );
    expect(getTargetSelectValue({ kind: "environment", environmentId: "env-1" })).toBe(
      environmentOptionValue("env-1")
    );
  });

  it("seeds the multi-repository mode from the previously selected repo", () => {
    expect(
      parseTargetSelectValue(MULTIPLE_REPOSITORIES_OPTION_VALUE, {
        kind: "repo",
        repoFullName: "Acme/Backend",
      })
    ).toEqual({ kind: "repos", repoFullNames: ["acme/backend"] });

    expect(parseTargetSelectValue(MULTIPLE_REPOSITORIES_OPTION_VALUE, { kind: "none" })).toEqual({
      kind: "repos",
      repoFullNames: [],
    });

    const existing: SessionTarget = { kind: "repos", repoFullNames: ["a/b", "a/c"] };
    expect(parseTargetSelectValue(MULTIPLE_REPOSITORIES_OPTION_VALUE, existing)).toBe(existing);
  });

  it("keeps machine placement when the repository mode changes", () => {
    const previous: SessionTarget = {
      kind: "repo",
      repoFullName: "acme/backend",
      outpostId: "workshop",
    };

    expect(parseTargetSelectValue(NO_REPOSITORY_OPTION_VALUE, previous)).toEqual({
      kind: "none",
      outpostId: "workshop",
    });
    expect(parseTargetSelectValue(environmentOptionValue("env-1"), previous)).toEqual({
      kind: "environment",
      environmentId: "env-1",
      outpostId: "workshop",
    });
  });
});

describe("getTargetConfigKey", () => {
  it("distinguishes ad-hoc lists so edits invalidate a warmed session", () => {
    const one = getTargetConfigKey({ kind: "repos", repoFullNames: ["a/b"] });
    const two = getTargetConfigKey({ kind: "repos", repoFullNames: ["a/b", "a/c"] });
    expect(one).not.toBe(two);
  });

  it("distinguishes machine placement for the same repository target", () => {
    const first = getTargetConfigKey({
      kind: "repo",
      repoFullName: "acme/backend",
      outpostId: "workshop",
    });
    const second = getTargetConfigKey({
      kind: "repo",
      repoFullName: "acme/backend",
      outpostId: "laptop",
    });
    expect(first).not.toBe(second);
  });
});

describe("setSessionTargetOutpost", () => {
  it("changes and clears machine placement without changing the repository target", () => {
    const target: SessionTarget = { kind: "repo", repoFullName: "acme/backend" };
    const placed = setSessionTargetOutpost(target, "workshop");

    expect(placed).toEqual({
      kind: "repo",
      repoFullName: "acme/backend",
      outpostId: "workshop",
    });
    expect(setSessionTargetOutpost(placed, null)).toEqual(target);
  });
});

describe("isSessionTargetLaunchable", () => {
  it("requires at least one repository in the ad-hoc mode", () => {
    expect(isSessionTargetLaunchable(null)).toBe(false);
    expect(isSessionTargetLaunchable({ kind: "repos", repoFullNames: [] })).toBe(false);
    expect(isSessionTargetLaunchable({ kind: "repos", repoFullNames: ["a/b"] })).toBe(true);
    expect(isSessionTargetLaunchable({ kind: "none" })).toBe(true);
    expect(isSessionTargetLaunchable({ kind: "environment", environmentId: "env-1" })).toBe(true);
  });
});
