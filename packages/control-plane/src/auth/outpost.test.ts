import { describe, expect, it } from "vitest";

import { verifyOutpostEnrollmentToken } from "./outpost";

describe("verifyOutpostEnrollmentToken", () => {
  it("accepts the configured bearer token", async () => {
    await expect(
      verifyOutpostEnrollmentToken("Bearer outpost-secret", "outpost-secret")
    ).resolves.toBe(true);
  });

  it("fails closed for missing configuration or a wrong token", async () => {
    await expect(verifyOutpostEnrollmentToken("Bearer outpost-secret", undefined)).resolves.toBe(
      false
    );
    await expect(verifyOutpostEnrollmentToken("Bearer wrong", "outpost-secret")).resolves.toBe(
      false
    );
    await expect(verifyOutpostEnrollmentToken(null, "outpost-secret")).resolves.toBe(false);
  });
});
