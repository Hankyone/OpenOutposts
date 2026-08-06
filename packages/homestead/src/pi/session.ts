import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentContextFile } from "@openoutposts/outpost-protocol";

import {
  buildPiResourceLoaderOptions,
  buildPiToolOptions,
  type PiAgentHome,
} from "./agent-home.js";
import { unconfiguredCredentialStore, type PiCredentialStore } from "./credential-store.js";
import { openPersistedSessionManager } from "./session-persistence.js";
import { createOutpostTools, type OutpostToolTransport } from "./tools.js";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OutpostAgentSessionOptions {
  home: PiAgentHome;
  /** Carries the seven bounded operations to the leased outpost. */
  transport: OutpostToolTransport;
  /**
   * Virtual instruction files selected by the homestead and leased outpost.
   * Pi's own filesystem discovery remains disabled.
   */
  contextFiles?: AgentContextFile[];
  /**
   * Where Pi reads the session's provider key, on every model request.
   *
   * Omitting it does not mean "no credential needed"; it means a store that
   * refuses. That is deliberate. Pi's default is a file-backed store, and a
   * store with nothing in it reports nothing stored, which sends pi-ai to the
   * ambient environment — so on a homestead whose operator has a provider key in
   * its environment, a session with no credential would quietly run on the
   * operator's key instead of failing.
   */
  credentials?: PiCredentialStore;
  /** `provider/model-id`, e.g. `anthropic/claude-sonnet-4-5`. */
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  /**
   * Where this session's conversation is kept between homestead restarts.
   *
   * Omitting it keeps the conversation in memory, which is what the demo and
   * the containment tests want: a session with nowhere durable to live should
   * leave nothing behind rather than pick a directory of its own.
   */
  persistence?: { sessionFile: string };
}

export interface OutpostAgentSessionResult {
  session: AgentSession;
  /** A conversation was found on disk and this session continues it. */
  resumed: boolean;
  /** The stored conversation was unreadable, set aside, and started over. */
  recovered: boolean;
  /** Entries read back from disk, zero for an in-memory session. */
  entryCount: number;
  /** Conversation messages restored into the agent's context. */
  messageCount: number;
}

/**
 * Builds the one guarded Pi session shape this product ever creates.
 *
 * The harness and the containment tests both go through here on purpose: the
 * property being tested — that the model has no local filesystem or shell — is
 * a property of this configuration, so the test must exercise the very code
 * the homestead uses rather than a copy of it.
 */
export async function createOutpostAgentSession(
  options: OutpostAgentSessionOptions
): Promise<OutpostAgentSessionResult> {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.home.cwd,
    agentDir: options.home.agentDir,
    settingsManager,
    ...buildPiResourceLoaderOptions(options.contextFiles),
  });
  await resourceLoader.reload();

  const modelRuntime = await ModelRuntime.create({
    credentials:
      options.credentials ??
      unconfiguredCredentialStore("no credential store was supplied to this session"),
    // Never read while `credentials` is supplied, and it always is. Passed so
    // that a change which stopped supplying one would resolve inside this
    // session's own directory instead of the operator's `~/.pi/agent`.
    authPath: options.home.authPath,
    modelsPath: options.home.modelsPath,
  });
  const model = options.model ? resolveModel(modelRuntime, options.model) : undefined;

  // The agent lives on the homestead machine, so its conversation is kept on
  // the homestead's disk under the state directory and resumed after a
  // restart. The product transcript is a different object and still belongs to
  // the control plane; this file is the harness session alone.
  const persisted = options.persistence
    ? await openPersistedSessionManager(options.persistence.sessionFile, options.home.cwd)
    : null;

  const { session } = await createAgentSession({
    cwd: options.home.cwd,
    agentDir: options.home.agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: persisted?.manager ?? SessionManager.inMemory(options.home.cwd),
    ...(model === undefined ? {} : { model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...buildPiToolOptions(createOutpostTools(options.transport)),
  });
  return {
    session,
    resumed: persisted?.resumed ?? false,
    recovered: persisted?.recovered ?? false,
    entryCount: persisted?.entryCount ?? 0,
    messageCount: persisted?.messageCount ?? 0,
  };
}

/**
 * Splits a `provider/model-id` spec on its first slash: model ids of their own
 * often contain slashes (`openrouter/anthropic/claude-haiku-4.5`).
 */
export function splitModelSpec(spec: string): { providerId: string; modelId: string } {
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Model must be given as provider/model-id, got: ${spec}`);
  }
  return { providerId: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

function resolveModel(modelRuntime: ModelRuntime, spec: string) {
  const { providerId, modelId } = splitModelSpec(spec);
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) throw new Error(`Pi does not know the model ${spec}`);
  return model;
}
