import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalRequestString,
  buildServiceAuthHeaders,
  canonicalizeQuery,
  sha256Hex,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  ACTOR_HEADER,
} from "./service-signature";

/**
 * The golden vectors that pin the verifier in `@open-inspect/shared`, produced
 * by an independent Python reference. This module is a second implementation of
 * the same grammar, so it has to answer to the same vectors — otherwise the two
 * halves could drift and the failure would be an authentication, not a test.
 */
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../shared/test-fixtures/service-auth-vectors.json", import.meta.url)),
    "utf8"
  )
) as {
  vectors: Array<{
    name: string;
    service: string;
    secret: string;
    timestampMs: number;
    nonce: string;
    method: string;
    url: string;
    body?: string;
    bodyBase64?: string;
    actor?: string;
    expected: {
      pathname: string;
      canonicalQuery: string;
      bodySha256Hex: string;
      canonicalString: string;
      signatureHex: string;
      signatureHeader: string;
    };
  }>;
};

/** A vector's body is either UTF-8 text or base64-encoded bytes, never both. */
function vectorBody(vector: { body?: string; bodyBase64?: string }): Uint8Array | string {
  if (vector.bodyBase64 === undefined) return vector.body ?? "";
  return Uint8Array.from(Buffer.from(vector.bodyBase64, "base64"));
}

describe("sig1 signing agrees with the golden vectors", () => {
  it("has vectors to check against", () => {
    expect(vectors.vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors.vectors.map((v) => [v.name, v] as const))(
    "reproduces %s byte for byte",
    async (_name, vector) => {
      expect(await sha256Hex(vectorBody(vector))).toBe(vector.expected.bodySha256Hex);

      const parsed = new URL(vector.url);
      expect(parsed.pathname).toBe(vector.expected.pathname);
      expect(canonicalizeQuery(parsed.search)).toBe(vector.expected.canonicalQuery);

      const canonical = buildCanonicalRequestString({
        service: vector.service,
        timestampMs: vector.timestampMs,
        nonce: vector.nonce,
        method: vector.method,
        pathname: vector.expected.pathname,
        canonicalQuery: vector.expected.canonicalQuery,
        bodySha256Hex: vector.expected.bodySha256Hex,
        actor: vector.actor ?? "",
      });
      // The canonical string is the contract. Compare it directly rather than
      // only its HMAC, so a layout change is named rather than just "mismatch".
      expect(canonical).toBe(vector.expected.canonicalString);

      const headers = await buildServiceAuthHeaders({
        service: vector.service,
        secret: vector.secret,
        method: vector.method,
        url: vector.url,
        body: vectorBody(vector),
        actor: vector.actor,
        timestampMs: vector.timestampMs,
        nonce: vector.nonce,
      });
      expect(headers[SERVICE_SIGNATURE_HEADER]).toBe(vector.expected.signatureHeader);
      expect(headers[SERVICE_HEADER]).toBe(vector.service);
      if (vector.actor) expect(headers[ACTOR_HEADER]).toBe(vector.actor);
      else expect(headers[ACTOR_HEADER]).toBeUndefined();
    }
  );
});

describe("sig1 signing binds the request", () => {
  const base = {
    service: "homestead",
    secret: "homestead-secret",
    method: "POST",
    url: "https://cp.test/outposts/machine-1/leases",
    body: JSON.stringify({ productSessionId: "s1" }),
  };

  it("produces a different signature for a different path", async () => {
    const a = await buildServiceAuthHeaders({ ...base, timestampMs: 1, nonce: "aa" });
    const b = await buildServiceAuthHeaders({
      ...base,
      url: "https://cp.test/outposts/machine-2/leases",
      timestampMs: 1,
      nonce: "aa",
    });
    expect(a[SERVICE_SIGNATURE_HEADER]).not.toBe(b[SERVICE_SIGNATURE_HEADER]);
  });

  it("produces a different signature for a different method", async () => {
    const a = await buildServiceAuthHeaders({ ...base, timestampMs: 1, nonce: "aa" });
    const b = await buildServiceAuthHeaders({
      ...base,
      method: "DELETE",
      timestampMs: 1,
      nonce: "aa",
    });
    expect(a[SERVICE_SIGNATURE_HEADER]).not.toBe(b[SERVICE_SIGNATURE_HEADER]);
  });

  it("produces a different signature for a different body", async () => {
    const a = await buildServiceAuthHeaders({ ...base, timestampMs: 1, nonce: "aa" });
    const b = await buildServiceAuthHeaders({
      ...base,
      body: JSON.stringify({ productSessionId: "someone-elses" }),
      timestampMs: 1,
      nonce: "aa",
    });
    expect(a[SERVICE_SIGNATURE_HEADER]).not.toBe(b[SERVICE_SIGNATURE_HEADER]);
  });

  it("mints a fresh nonce per call, so no two requests are interchangeable", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const headers = await buildServiceAuthHeaders(base);
      seen.add(headers[SERVICE_SIGNATURE_HEADER].split(".")[2]);
    }
    expect(seen.size).toBe(25);
  });
});
