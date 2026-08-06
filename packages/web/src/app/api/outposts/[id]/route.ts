import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * Remove a machine from the fleet.
 *
 * The control plane owns the decision: it releases the machine's leases,
 * disconnects it, and drops its directory row, or refuses when the deployment
 * cannot attribute machines to this user. Its status and body are passed
 * through unchanged so the page can say which of those happened.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(`/outposts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to remove outpost:", error);
    return NextResponse.json({ error: "Failed to remove outpost" }, { status: 500 });
  }
}
