import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("homestead readiness API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 without a signed-in user", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("forwards the owner-safe readiness response", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ connected: true }));

    const response = await GET();

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/homesteads/readiness");
    await expect(response.json()).resolves.toEqual({ connected: true });
  });

  it("returns 500 when the control plane cannot be reached", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("offline"));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to read homestead readiness",
    });
  });
});
