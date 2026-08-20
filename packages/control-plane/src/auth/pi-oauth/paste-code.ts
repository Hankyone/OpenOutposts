/**
 * Turn a paste from the user into an authorization code.
 *
 * Pi's CLI races a localhost callback against a "paste the code / redirect
 * URL" prompt. Hosted sign-in has only the paste: the provider still redirects
 * to the registered loopback URI, the browser shows a failed connection, and
 * the user copies the address bar. A raw code is accepted too.
 */

export function parsePastedAuthorizationCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get("code");
    if (fromQuery) return fromQuery;
    if (url.hash) {
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
      const fromHash = hashParams.get("code");
      if (fromHash) return fromHash;
    }
  } catch {
    // Not a URL.
  }

  if (value.includes("#")) {
    const [code] = value.split("#", 2);
    if (code.trim()) return code.trim();
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(
      value.includes("?") ? value.slice(value.indexOf("?") + 1) : value
    );
    const code = params.get("code");
    if (code) return code;
  }

  // A bare code has no whitespace or quotes; anything else is a failed paste.
  if (/^[A-Za-z0-9._~+/-]+=*$/.test(value) && value.length >= 8) return value;
  return null;
}
