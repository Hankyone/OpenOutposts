import { describe, expect, it } from "vitest";
import {
  extractSessionIdFromBranch,
  generateBranchName,
  isInspectBranch,
  normalizeBranchName,
} from "./git";

describe("normalizeBranchName", () => {
  it("trims and lowercases branch names", () => {
    expect(normalizeBranchName(" Feature/Test ")).toBe("feature/test");
  });
});

describe("generateBranchName", () => {
  it("generates lowercase openoutposts branches", () => {
    expect(generateBranchName("Session-ABC")).toBe("openoutposts/session-abc");
  });
});

describe("extractSessionIdFromBranch", () => {
  it("extracts lowercase session IDs from session branches", () => {
    expect(extractSessionIdFromBranch(" OpenOutposts/Session-ABC ")).toBe("session-abc");
  });
});

describe("isInspectBranch", () => {
  it("matches session branches case-insensitively", () => {
    expect(isInspectBranch(" OPENOUTPOSTS/Session-ABC ")).toBe(true);
  });
});
