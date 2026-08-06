/**
 * The encryption contexts every stored ciphertext in the control plane is
 * bound to, written down once.
 *
 * These are constructors rather than inline object literals at the call sites
 * so that the write and the read of one column cannot drift apart — a context
 * that differs by one character between the two makes the value unreadable,
 * and the failure would appear as a decrypt error far from the edit that
 * caused it.
 *
 * The shape of each entry is the answer to "what would relocating this
 * ciphertext buy an attacker": the scope is whoever must not be crossed, and
 * the key name is whichever sibling column must not be swapped.
 */

import type { EncryptionContext } from "./crypto";

/**
 * A user's SCM OAuth tokens.
 *
 * Bound to the SCM identity rather than to a physical row, because this
 * ciphertext is copied by design: it is written in D1's `user_scm_tokens`,
 * handed to a session's Durable Object at creation, and copied again into a
 * child session's participant row — all as the same person's credential. The
 * binding that matters is therefore the person: relocating one user's token
 * onto another user's participant row fails, while the product's own copies
 * keep working.
 */
export function scmOAuthContext(
  providerUserId: string,
  part: "access_token" | "refresh_token"
): EncryptionContext {
  return {
    table: "scm_oauth",
    scopeKind: "scm_user",
    scopeId: providerUserId,
    keyName: part,
  };
}

/** A user's provider (model) credential in the vault. One per owner per provider. */
export function providerCredentialContext(
  userId: string,
  provider: string,
  part: "secret" | "refresh_secret" = "secret"
): EncryptionContext {
  return {
    table: "user_provider_credentials",
    scopeKind: "user",
    scopeId: userId,
    keyName: `${provider}:${part}`,
  };
}

/**
 * Which of the three scoped secret stores, and which scope within it. The
 * secret key is supplied per value, so one scope descriptor covers a whole
 * read or write batch.
 */
export interface SecretScope {
  table: "global_secrets" | "repo_secrets" | "environment_secrets";
  scopeKind: "global" | "repo" | "environment";
  scopeId: string;
}

/** Deployment-wide secrets. A single scope, named rather than left empty. */
export function globalSecretScope(): SecretScope {
  return { table: "global_secrets", scopeKind: "global", scopeId: "deployment" };
}

export function repoSecretScope(repoId: number): SecretScope {
  return { table: "repo_secrets", scopeKind: "repo", scopeId: String(repoId) };
}

export function environmentSecretScope(environmentId: string): SecretScope {
  return { table: "environment_secrets", scopeKind: "environment", scopeId: environmentId };
}

/** A single value in a scoped secret store, bound to its scope and its key. */
export function scopedSecretContext(scope: SecretScope, key: string): EncryptionContext {
  return {
    table: scope.table,
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
    keyName: key,
  };
}

/** The deployment's commit-signing private key. A singleton row. */
export function commitSigningContext(): EncryptionContext {
  return {
    table: "commit_signing_configuration",
    scopeKind: "deployment",
    scopeId: "singleton",
    keyName: "private_key",
  };
}

/** One MCP server's environment dictionary. */
export function mcpServerEnvContext(serverId: string): EncryptionContext {
  return {
    table: "mcp_servers",
    scopeKind: "mcp_server",
    scopeId: serverId,
    keyName: "env",
  };
}

/** An automation's Sentry client secret, used to verify that automation's webhook. */
export function automationSentrySecretContext(automationId: string): EncryptionContext {
  return {
    table: "automations",
    scopeKind: "automation",
    scopeId: automationId,
    keyName: "sentry_client_secret",
  };
}

/**
 * A session sandbox's exposure credentials, stored in that session's own
 * Durable Object SQLite.
 */
export function sandboxSecretContext(
  sessionId: string,
  keyName: "code_server_password" | "ttyd_token"
): EncryptionContext {
  return {
    table: "sandbox",
    scopeKind: "session",
    scopeId: sessionId,
    keyName,
  };
}
