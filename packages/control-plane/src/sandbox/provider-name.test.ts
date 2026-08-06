import { describe, it, expect } from "vitest";
import { resolveSandboxBackendName } from "./provider-name";

describe("resolveSandboxBackendName", () => {
  it("defaults to outpost when undefined", () => {
    expect(resolveSandboxBackendName(undefined)).toBe("outpost");
  });

  it("defaults to outpost when empty string", () => {
    expect(resolveSandboxBackendName("")).toBe("outpost");
  });

  it("defaults to outpost when whitespace-only", () => {
    expect(resolveSandboxBackendName("   ")).toBe("outpost");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveSandboxBackendName("OUTPOST")).toBe("outpost");
    expect(resolveSandboxBackendName("  Outpost  ")).toBe("outpost");
  });

  it("refuses a cloud sandbox backend instead of silently substituting", () => {
    for (const name of ["modal", "e2b", "daytona", "vercel", "opencomputer"]) {
      expect(() => resolveSandboxBackendName(name)).toThrow(
        `Unsupported SANDBOX_PROVIDER: ${name}`
      );
    }
  });

  it("throws for an unknown provider", () => {
    expect(() => resolveSandboxBackendName("k8s")).toThrow("Unsupported SANDBOX_PROVIDER: k8s");
  });
});
