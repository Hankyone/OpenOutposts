import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * Add or replace, and remove, one provider credential for the signed-in user.
 *
 * The request body carries the key on its way in and is never logged, never
 * echoed back, and never read again: the control plane's response is metadata
 * only. Validation (slug shape, key length) belongs to the control plane, so
 * the body is forwarded verbatim and its errors are surfaced unchanged.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const response = await controlPlaneUserFetch(
      `/provider-credentials/${encodeURIComponent(provider)}`,
      { method: "PUT", body: JSON.stringify(body) }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    // The error, not the request: a thrown transport error must not carry the
    // body into a log line.
    console.error("Failed to save provider credential:", error);
    return NextResponse.json({ error: "Failed to save provider credential" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/provider-credentials/${encodeURIComponent(provider)}`,
      { method: "DELETE" }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to remove provider credential:", error);
    return NextResponse.json({ error: "Failed to remove provider credential" }, { status: 500 });
  }
}
