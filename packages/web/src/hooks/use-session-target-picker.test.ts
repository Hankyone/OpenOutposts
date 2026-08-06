import { describe, expect, it } from "vitest";
import type { Environment } from "@open-inspect/shared";
import type { Repo } from "@/hooks/use-repos";
import { describeEnvironment, describeRepository } from "./use-session-target-picker";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    name: "Stack",
    description: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    repositories: [
      { repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
    ],
    ...overrides,
  };
}

describe("describeEnvironment", () => {
  it("shows the repository count", () => {
    expect(describeEnvironment(environment())).toBe("2 repositories");
  });

  it("singularizes a one-repository environment", () => {
    expect(
      describeEnvironment(
        environment({
          repositories: [{ repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" }],
        })
      )
    ).toBe("1 repository");
  });
});

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    fullName: "acme/web",
    owner: "acme",
    name: "web",
    description: null,
    private: false,
    defaultBranch: "main",
    ...overrides,
  };
}

describe("describeRepository", () => {
  it("shows the owner", () => {
    expect(describeRepository(repo())).toBe("acme");
  });

  it("marks private repositories", () => {
    expect(describeRepository(repo({ private: true }))).toBe("acme • private");
  });
});
