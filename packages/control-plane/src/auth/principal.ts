/**
 * The verified identity behind a control-plane request.
 *
 * Every non-public request resolves to exactly one `Principal` before its
 * handler runs. The shapes make illegal states unrepresentable: only service
 * principals can carry asserted actors, and user principals always carry a
 * resolved identity.
 */

import type { ServiceName } from "@open-inspect/shared";

/** Actor namespaces bots may assert (`slack:U123` etc.). */
export const ACTOR_NAMESPACES = ["slack", "github", "linear"] as const;
export type ActorNamespace = (typeof ACTOR_NAMESPACES)[number];

export function isActorNamespace(value: string): value is ActorNamespace {
  return (ACTOR_NAMESPACES as readonly string[]).includes(value);
}

export interface ResolvedIdentity {
  provider: "github" | "google" | "slack" | "linear";
  providerUserId: string;
  /** Canonical D1 `users.id`. Always set for user principals; null for actors the CP has never seen. */
  canonicalUserId: string | null;
  /** DO participant format: bare id for web users, `ns:id` for bot actors. */
  participantUserId: string;
}

/**
 * Which session-scoped credential a sandbox principal presented.
 *
 * `bridge` is the sandbox auth token: the session's whole callback surface.
 * `credential_fetch` is the narrower token minted for the model-credential
 * broker alone. They are separate secrets with separate stored hashes, so the
 * scope here is a verified fact about which one was checked, not a hint — and
 * a handler that requires one must say so rather than accepting either.
 */
export type SandboxTokenScope = "bridge" | "credential_fetch";

export type Principal =
  | { kind: "user"; user: ResolvedIdentity; tokenId: string }
  | { kind: "service"; service: ServiceName; actor: ResolvedIdentity | null }
  | { kind: "sandbox"; sessionId: string; scope: SandboxTokenScope };

/**
 * The actor namespace each service may assert. Web and Modal assert none —
 * web identity arrives by token exchange, never assertion, and the Modal
 * scheduler acts for no one.
 */
export const ASSERTION_RIGHTS: Record<ServiceName, ActorNamespace | null> = {
  web: null,
  "slack-bot": "slack",
  "github-bot": "github",
  "linear-bot": "linear",
  // The homestead acts for whoever owns the session it was handed, and the
  // control plane resolves that owner itself from the session row. A homestead
  // asserting a person would be asserting something it was told.
  homestead: null,
  modal: null,
};
