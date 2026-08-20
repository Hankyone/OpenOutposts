import { proxyProviderCredentialRequest } from "../proxy-provider-credential";

export async function GET() {
  return proxyProviderCredentialRequest(
    "/provider-credentials/oauth-methods",
    { method: "GET" },
    "Failed to fetch subscription sign-in methods"
  );
}
