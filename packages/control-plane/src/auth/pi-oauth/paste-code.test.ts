import { describe, expect, it } from "vitest";
import { parsePastedAuthorizationCode } from "./paste-code";

describe("parsePastedAuthorizationCode", () => {
  it("reads the code query parameter from a loopback redirect URL", () => {
    expect(
      parsePastedAuthorizationCode("http://localhost:53692/callback?code=abc.def&state=xyz")
    ).toBe("abc.def");
  });

  it("reads a code from the URL hash", () => {
    expect(parsePastedAuthorizationCode("http://localhost/callback#code=from-hash")).toBe(
      "from-hash"
    );
  });

  it("splits Anthropic's code#state paste format", () => {
    expect(parsePastedAuthorizationCode("AUTHORIZATIONCODE#pkce-verifier")).toBe(
      "AUTHORIZATIONCODE"
    );
  });

  it("accepts a query-shaped paste without a URL", () => {
    expect(parsePastedAuthorizationCode("code=pasted-code&state=x")).toBe("pasted-code");
  });

  it("accepts a bare authorization code", () => {
    expect(parsePastedAuthorizationCode("  sk_oauth_code_value  ")).toBe("sk_oauth_code_value");
  });

  it("rejects empty and non-code text", () => {
    expect(parsePastedAuthorizationCode("")).toBeNull();
    expect(parsePastedAuthorizationCode("not a code")).toBeNull();
    expect(parsePastedAuthorizationCode("short")).toBeNull();
  });
});
