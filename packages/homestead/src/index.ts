import type { ModelThinkingLevel, PromptAuthor } from "@openoutposts/outpost-protocol";

export {
  OutpostClient,
  OutpostClientError,
  type CreateLeaseInput,
  type Lease,
  type OutpostClientOptions,
  type ToolCallResult,
} from "./outpost-client.js";
export { PiHarness, type PiHarnessOptions } from "./pi/harness.js";
export { PiHarnessFactory, type PiHarnessFactoryOptions } from "./pi/factory.js";
export {
  createOutpostAgentSession,
  splitModelSpec,
  type OutpostAgentSessionOptions,
  type OutpostAgentSessionResult,
  type PiThinkingLevel,
} from "./pi/session.js";
export { openPersistedSessionManager, type PersistedPiSession } from "./pi/session-persistence.js";
export { PiEventTranslator } from "./pi/events.js";
export { streamTurn, type PromptableSession, type StreamTurnOptions } from "./pi/turn.js";
export {
  applyTurnModel,
  applyTurnThinkingLevel,
  currentModelSpec,
  TurnSettingError,
  type ConfigurableSession,
} from "./pi/turn-settings.js";
export {
  buildPiResourceLoaderOptions,
  buildPiToolOptions,
  createPiAgentHome,
  outpostSystemPromptAppendix,
  type PiAgentHome,
} from "./pi/agent-home.js";
export {
  createSessionCredentialStore,
  IssuedCredentialStore,
  ModelCredentialUnavailableError,
  unconfiguredCredentialStore,
  CREDENTIAL_REFRESH_SKEW_MS,
  type CreateSessionCredentialStoreOptions,
  type IssuedCredentialStoreOptions,
  type PiCredential,
  type PiCredentialStore,
  type ResolvedModelCredential,
  type SessionCredentialStore,
} from "./pi/credential-store.js";
export {
  fetchModelCredential,
  fetchModelCredentialWithRetry,
  ModelCredentialError,
  CREDENTIAL_FETCH_BUDGET_MS,
  type IssuedModelCredential,
  type ModelCredentialRequest,
} from "./pi/model-credential.js";
export { buildModelCatalog, collectPiModelCatalog, type PiModelRegistry } from "./pi/catalog.js";
export {
  createOutpostTools,
  OutpostToolError,
  OUTPOST_TOOL_NAMES,
  PI_LOCAL_TOOL_NAMES,
  type OutpostToolTransport,
} from "./pi/tools.js";
export { HomesteadDaemon, type HomesteadDaemonOptions } from "./service/homestead-daemon.js";
export {
  indexSessionHarnessFactories,
  type CreateSessionHarnessInput,
  type SessionHarnessFactory,
} from "./service/harness-factory.js";
export { BridgeSession, readTurnRequest, type TurnReadResult } from "./service/bridge-session.js";
export { BridgeTurnTranslator, type BridgeEvent } from "./service/bridge-events.js";

export type HarnessKind = "pi" | "claude-code";

export interface HarnessSessionReference {
  productSessionId: string;
  harnessSessionId: string;
  harness: HarnessKind;
}

/**
 * What one turn consumed, summed over every model round trip it took.
 *
 * Pi reports token counts on each assistant message and prices them itself
 * from its bundled model table. A model Pi has no price for yields a zero
 * total, which is not the same as a turn that cost nothing, so `cost` is left
 * absent in that case rather than reported as zero spend.
 */
export interface HarnessTurnUsage {
  /** Provider spend for the turn, in USD, when the harness can price it. */
  cost?: number;
  input: number;
  output: number;
  /** Reasoning tokens, when the provider breaks them out. A subset of output. */
  reasoning?: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type HarnessEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.started"; toolCallId: string; name: string; input: unknown }
  | { type: "tool.completed"; toolCallId: string; output: unknown; isError: boolean }
  | { type: "approval.requested"; approvalId: string; description: string }
  | { type: "turn.completed"; usage?: HarnessTurnUsage }
  | { type: "turn.failed"; message: string; usage?: HarnessTurnUsage };

export interface CreateHarnessSessionInput {
  productSessionId: string;
  workspacePath: string;
  model?: string;
}

/**
 * One user turn, as the harness is asked to run it.
 *
 * Everything the product decided about this turn travels here. A harness that
 * cannot honour a field must fail the turn saying so — none of these may be
 * dropped, because each one is displayed to the user as though it took effect.
 */
export interface TurnRequest {
  content: string;
  /** `provider/model-id` for this turn, which may differ from the last one. */
  model?: string;
  /** The harness thinking level the product's reasoning effort maps onto. */
  thinkingLevel?: ModelThinkingLevel;
  /** Whose message this turn answers. */
  author?: PromptAuthor;
}

export interface AgentHarness {
  readonly kind: HarnessKind;
  createSession(input: CreateHarnessSessionInput): Promise<HarnessSessionReference>;
  sendPrompt(session: HarnessSessionReference, turn: TurnRequest): AsyncIterable<HarnessEvent>;
  interrupt(session: HarnessSessionReference): Promise<void>;
  close(session: HarnessSessionReference): Promise<void>;
}
