import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * The signed-in user's provider credentials: presence and metadata only.
 *
 * The control plane exposes no read path for a stored secret — the only
 * decryption in the system is session-scoped issuance to a homestead — so nothing
 * that passes through here can contain key material. The owner is resolved at
 * the control plane from the forwarded user token; this proxy never names one.
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneUserFetch("/provider-credentials");
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch provider credentials:", error);
    return NextResponse.json({ error: "Failed to fetch provider credentials" }, { status: 500 });
  }
}
