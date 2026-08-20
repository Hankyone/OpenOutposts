import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * Forward a signed-in user's provider-credential request to the control plane.
 *
 * The owner is resolved there from the forwarded session token. This proxy
 * never names a user and never logs a request body.
 */
export async function proxyProviderCredentialRequest(
  path: string,
  init: RequestInit = {},
  failed: string
): Promise<NextResponse> {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneUserFetch(path, init);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error(failed, error);
    return NextResponse.json({ error: failed }, { status: 500 });
  }
}
