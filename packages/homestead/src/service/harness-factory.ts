import type { AgentHarness, HarnessKind } from "../index.js";

/**
 * The narrow assignment data an adapter needs before its session is created.
 *
 * The bridge credential is deliberately absent. A harness may fetch the
 * session's model credential, but it must never receive the bearer that can
 * connect to product state or perform product-side actions.
 */
export interface CreateSessionHarnessInput {
  productSessionId: string;
  outpostId: string;
  credentialFetchToken: string;
  model?: string;
}

/**
 * Builds one fresh harness adapter for one product session.
 *
 * Factories, rather than harness instances, are shared by the daemon. A
 * harness carries assignment-specific outpost, credential, and transcript
 * state, so reusing one from a singleton registry would cross session
 * boundaries.
 */
export interface SessionHarnessFactory {
  readonly kind: HarnessKind;
  create(input: CreateSessionHarnessInput): AgentHarness;
  /** Removes adapter-owned durable state after the product session expires. */
  removePersistedSessions?(productSessionIds: readonly string[]): Promise<void>;
}

/**
 * Validates the daemon's small, fixed set of factories once at construction.
 */
export function indexSessionHarnessFactories(
  factories: readonly SessionHarnessFactory[]
): ReadonlyMap<HarnessKind, SessionHarnessFactory> {
  if (factories.length === 0) {
    throw new Error("at least one session harness factory is required");
  }

  const indexed = new Map<HarnessKind, SessionHarnessFactory>();
  for (const factory of factories) {
    if (indexed.has(factory.kind)) {
      throw new Error(`duplicate session harness factory: ${factory.kind}`);
    }
    indexed.set(factory.kind, factory);
  }
  return indexed;
}
