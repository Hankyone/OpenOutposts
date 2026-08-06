import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "@open-inspect/shared";
import {
  BOUND_CIPHERTEXT_PREFIX,
  encryptToken,
  encryptTokenPair,
  decryptToken,
  generateEncryptionKey,
  generateId,
  hashToken,
  isBoundCiphertext,
} from "./crypto";

describe("crypto", () => {
  describe("generateEncryptionKey", () => {
    it("generates a base64-encoded 32-byte key", () => {
      const key = generateEncryptionKey();

      // Decode and verify length
      const decoded = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(32);
    });

    it("generates unique keys each time", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();

      expect(key1).not.toBe(key2);
    });
  });

  describe("generateId", () => {
    it("generates a hex string of default length (16 bytes = 32 chars)", () => {
      const id = generateId();

      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it("generates a hex string of specified length", () => {
      const id8 = generateId(8);
      const id32 = generateId(32);

      expect(id8).toMatch(/^[0-9a-f]{16}$/);
      expect(id32).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique IDs each time", () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).not.toBe(id2);
    });
  });

  const rowA = {
    table: "user_provider_credentials",
    scopeKind: "user",
    scopeId: "user-a",
    keyName: "anthropic:secret",
  } as const;
  const rowB = {
    table: "user_provider_credentials",
    scopeKind: "user",
    scopeId: "user-b",
    keyName: "anthropic:secret",
  } as const;

  describe("encryptToken / decryptToken", () => {
    it("encrypts and decrypts a token successfully", async () => {
      const key = generateEncryptionKey();
      const originalToken = "gho_abc123xyz";

      const encrypted = await encryptToken(originalToken, key, rowA);
      const decrypted = await decryptToken(encrypted, key, rowA);

      expect(decrypted).toBe(originalToken);
    });

    it("produces different ciphertext each time (random IV)", async () => {
      const key = generateEncryptionKey();
      const token = "gho_abc123xyz";

      const encrypted1 = await encryptToken(token, key, rowA);
      const encrypted2 = await encryptToken(token, key, rowA);

      // Same plaintext should produce different ciphertext due to random IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same value
      expect(await decryptToken(encrypted1, key, rowA)).toBe(token);
      expect(await decryptToken(encrypted2, key, rowA)).toBe(token);
    });

    it("handles empty string", async () => {
      const key = generateEncryptionKey();

      const encrypted = await encryptToken("", key, rowA);
      const decrypted = await decryptToken(encrypted, key, rowA);

      expect(decrypted).toBe("");
    });

    it("handles long tokens", async () => {
      const key = generateEncryptionKey();
      const longToken = "a".repeat(10000);

      const encrypted = await encryptToken(longToken, key, rowA);
      const decrypted = await decryptToken(encrypted, key, rowA);

      expect(decrypted).toBe(longToken);
    });

    it("handles special characters and unicode", async () => {
      const key = generateEncryptionKey();
      const specialToken = "token_with_special_chars!@#$%^&*()_+-=[]{}|;':\",./<>?`~";
      const unicodeToken = "token_with_unicode_\u{1F510}\u{1F511}";

      const encryptedSpecial = await encryptToken(specialToken, key, rowA);
      const encryptedUnicode = await encryptToken(unicodeToken, key, rowA);

      expect(await decryptToken(encryptedSpecial, key, rowA)).toBe(specialToken);
      expect(await decryptToken(encryptedUnicode, key, rowA)).toBe(unicodeToken);
    });

    it("fails to decrypt with wrong key", async () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      const token = "gho_abc123xyz";

      const encrypted = await encryptToken(token, key1, rowA);

      // Decryption with wrong key should throw
      await expect(decryptToken(encrypted, key2, rowA)).rejects.toThrow();
    });

    it("fails to decrypt corrupted ciphertext", async () => {
      const key = generateEncryptionKey();
      const token = "gho_abc123xyz";

      const encrypted = await encryptToken(token, key, rowA);

      // Corrupt the ciphertext by changing a character
      const corrupted = encrypted.slice(0, -5) + "XXXXX";

      await expect(decryptToken(corrupted, key, rowA)).rejects.toThrow();
    });
  });

  describe("row binding", () => {
    it("marks what it writes with the binding prefix", async () => {
      const key = generateEncryptionKey();
      const encrypted = await encryptToken("sk-live", key, rowA);

      expect(encrypted.startsWith(BOUND_CIPHERTEXT_PREFIX)).toBe(true);
      expect(isBoundCiphertext(encrypted)).toBe(true);
    });

    it("refuses a ciphertext moved to another user's row", async () => {
      const key = generateEncryptionKey();
      const stolen = await encryptToken("sk-user-a-live-key", key, rowA);

      // The exact relocation the binding exists to stop: same key, same table,
      // same column — only the owner differs.
      await expect(decryptToken(stolen, key, rowB)).rejects.toThrow();
    });

    it("refuses a ciphertext moved to another column of the same row", async () => {
      const key = generateEncryptionKey();
      const access = await encryptToken("access-token", key, {
        table: "scm_oauth",
        scopeKind: "scm_user",
        scopeId: "12345",
        keyName: "access_token",
      });

      await expect(
        decryptToken(access, key, {
          table: "scm_oauth",
          scopeKind: "scm_user",
          scopeId: "12345",
          keyName: "refresh_token",
        })
      ).rejects.toThrow();
    });

    it("refuses a ciphertext moved to another store", async () => {
      const key = generateEncryptionKey();
      const repoSecret = await encryptToken("value", key, {
        table: "repo_secrets",
        scopeKind: "repo",
        scopeId: "42",
        keyName: "API_KEY",
      });

      await expect(
        decryptToken(repoSecret, key, {
          table: "environment_secrets",
          scopeKind: "environment",
          scopeId: "42",
          keyName: "API_KEY",
        })
      ).rejects.toThrow();
    });

    it("cannot be defeated by shifting characters across a field boundary", async () => {
      const key = generateEncryptionKey();
      const encrypted = await encryptToken("value", key, {
        table: "repo_secrets",
        scopeKind: "repo",
        scopeId: "12",
        keyName: "3:KEY",
      });

      await expect(
        decryptToken(encrypted, key, {
          table: "repo_secrets",
          scopeKind: "repo",
          scopeId: "123",
          keyName: ":KEY",
        })
      ).rejects.toThrow();
    });

    it("refuses a context field carrying a newline", async () => {
      const key = generateEncryptionKey();

      await expect(
        encryptToken("value", key, { ...rowA, scopeId: "user-a\nuser-b" })
      ).rejects.toThrow(/newline/);
    });

    it("refuses an empty context field", async () => {
      const key = generateEncryptionKey();

      await expect(encryptToken("value", key, { ...rowA, scopeId: "" })).rejects.toThrow(
        /non-empty/
      );
    });

    it("reads a legacy unbound value written before the scheme, under any context", async () => {
      // Exactly what the old encryptToken produced: bare base64(IV||ciphertext),
      // no prefix, no additional authenticated data.
      const key = generateEncryptionKey();
      const keyData = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        new TextEncoder().encode("legacy-secret")
      );
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      const legacy = btoa(String.fromCharCode(...combined));

      expect(isBoundCiphertext(legacy)).toBe(false);
      expect(await decryptToken(legacy, key, rowA)).toBe("legacy-secret");
      // A legacy value is unbound by definition — it is readable from any row,
      // which is the weakness being retired. Stated here so the dual-read is a
      // recorded property rather than an accident.
      expect(await decryptToken(legacy, key, rowB)).toBe("legacy-secret");
    });
  });

  describe("hashToken", () => {
    it("produces a 64-character hex string (SHA-256)", async () => {
      const hash = await hashToken("test_token");

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic (same input = same output)", async () => {
      const hash1 = await hashToken("test_token");
      const hash2 = await hashToken("test_token");

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different inputs", async () => {
      const hash1 = await hashToken("token1");
      const hash2 = await hashToken("token2");

      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", async () => {
      const hash = await hashToken("");

      // SHA-256 of empty string is a known value
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });

  describe("encryptTokenPair", () => {
    const pairContexts = {
      access: {
        table: "scm_oauth",
        scopeKind: "scm_user",
        scopeId: "12345",
        keyName: "access_token",
      },
      refresh: {
        table: "scm_oauth",
        scopeKind: "scm_user",
        scopeId: "12345",
        keyName: "refresh_token",
      },
    } as const;

    it("returns null for both tokens when both are undefined", async () => {
      const key = generateEncryptionKey();
      const result = await encryptTokenPair(undefined, undefined, key, pairContexts);
      expect(result.accessTokenEncrypted).toBeNull();
      expect(result.refreshTokenEncrypted).toBeNull();
    });

    it("encrypts provided access token and returns null for undefined refresh token", async () => {
      const key = generateEncryptionKey();
      const result = await encryptTokenPair("access-token-123", undefined, key, pairContexts);
      expect(result.accessTokenEncrypted).not.toBeNull();
      expect(result.refreshTokenEncrypted).toBeNull();

      const decrypted = await decryptToken(result.accessTokenEncrypted!, key, pairContexts.access);
      expect(decrypted).toBe("access-token-123");
    });

    it("encrypts provided refresh token and returns null for undefined access token", async () => {
      const key = generateEncryptionKey();
      const result = await encryptTokenPair(undefined, "refresh-token-456", key, pairContexts);
      expect(result.accessTokenEncrypted).toBeNull();
      expect(result.refreshTokenEncrypted).not.toBeNull();

      const decrypted = await decryptToken(
        result.refreshTokenEncrypted!,
        key,
        pairContexts.refresh
      );
      expect(decrypted).toBe("refresh-token-456");
    });

    it("encrypts both tokens when both are provided", async () => {
      const key = generateEncryptionKey();
      const result = await encryptTokenPair("access-token", "refresh-token", key, pairContexts);
      expect(result.accessTokenEncrypted).not.toBeNull();
      expect(result.refreshTokenEncrypted).not.toBeNull();

      const decryptedAccess = await decryptToken(
        result.accessTokenEncrypted!,
        key,
        pairContexts.access
      );
      const decryptedRefresh = await decryptToken(
        result.refreshTokenEncrypted!,
        key,
        pairContexts.refresh
      );
      expect(decryptedAccess).toBe("access-token");
      expect(decryptedRefresh).toBe("refresh-token");
    });

    it("throws when encryption fails (invalid key)", async () => {
      await expect(
        encryptTokenPair("access-token", "refresh-token", "not-a-valid-base64-key!!!", pairContexts)
      ).rejects.toThrow();
    });
  });

  describe("timingSafeEqual", () => {
    it("returns true for equal strings", () => {
      expect(timingSafeEqual("abc", "abc")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(timingSafeEqual("abc", "abd")).toBe(false);
    });

    it("returns false for different lengths", () => {
      expect(timingSafeEqual("abc", "abcd")).toBe(false);
    });

    it("works with fixed-length token hashes", async () => {
      const token = "sandbox-token";
      const sameHashA = await hashToken(token);
      const sameHashB = await hashToken(token);
      const differentHash = await hashToken("other-token");

      expect(timingSafeEqual(sameHashA, sameHashB)).toBe(true);
      expect(timingSafeEqual(sameHashA, differentHash)).toBe(false);
    });
  });
});
