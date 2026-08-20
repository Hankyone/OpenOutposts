import { proxyProviderCredentialRequest } from "../../proxy-provider-credential";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return proxyProviderCredentialRequest(
    `/provider-credentials/${encodeURIComponent(provider)}/oauth`,
    { method: "DELETE" },
    "Failed to cancel subscription sign-in"
  );
}
