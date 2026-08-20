import { proxyProviderCredentialRequest } from "../../../proxy-provider-credential";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return proxyProviderCredentialRequest(
    `/provider-credentials/${encodeURIComponent(provider)}/oauth/start`,
    { method: "POST" },
    "Failed to start subscription sign-in"
  );
}
