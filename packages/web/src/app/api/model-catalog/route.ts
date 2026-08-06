import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * The models this user can actually reach: what the homestead's harness
 * reports, intersected with the providers the user has connected.
 *
 * A `source` of "unavailable" means no homestead has ever reported a catalog to
 * the deployment — on the managed-sandbox path that is the normal state, and a
 * caller should keep using the bundled model list rather than show an empty
 * picker.
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneUserFetch("/model-catalog");
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch model catalog:", error);
    return NextResponse.json({ error: "Failed to fetch model catalog" }, { status: 500 });
  }
}
