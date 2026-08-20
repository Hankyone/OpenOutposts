import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { proxyProviderCredentialRequest } from "../../../proxy-provider-credential";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  return proxyProviderCredentialRequest(
    `/provider-credentials/${encodeURIComponent(provider)}/oauth/complete`,
    { method: "POST", body: JSON.stringify(body) },
    "Failed to complete subscription sign-in"
  );
}
