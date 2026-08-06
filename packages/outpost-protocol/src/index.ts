import { z } from "zod";

/**
 * The wire contract's version. Every message carries it, and both sides refuse
 * a version they were not built for rather than guessing at the difference.
 *
 * - **1** — outpost registration, leases, the seven tool operations, and the
 *   homestead boundary up to session assignment.
 * - **2** — the turn contract (`bridgePromptCommandSchema`). Before it, a
 *   session's model, reasoning effort and author were chosen by the product on
 *   every message and read by nobody: the homestead took the model it was assigned
 *   and ran that for the session's whole life. Version 2 makes the turn's own
 *   parameters part of the contract, so a homestead either honours them or refuses
 *   the turn saying why.
 * - **3** — request-scoped tool cancellation and an explicit cancelled result.
 *   A cancel without a request id still stops every queued or running operation
 *   under the lease; a cancel with one stops only that request.
 * - **4** — the runner became the homestead. Message types (`homestead.*`),
 *   identifier fields, and the connect route were renamed with it. No behavior
 *   changed, but a version-3 process and a version-4 process do not share a
 *   vocabulary, so they refuse each other instead of half-understanding.
 * - **5** — a lease can request the outpost workspace's agent context without
 *   exposing context discovery as an eighth model tool. Context files remain
 *   prompt input; every action still goes through the original seven operations.
 */
export const OUTPOST_PROTOCOL_VERSION = 5 as const;

const protocolVersionSchema = z.literal(OUTPOST_PROTOCOL_VERSION);
const identifierSchema = z.string().min(1).max(200);
export const outpostIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const timestampSchema = z.string().datetime({ offset: true });

export const outpostOperationSchema = z.enum([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
]);

export const outpostCapabilitiesSchema = z.object({
  platform: z.string().min(1),
  architecture: z.string().min(1),
  operations: z.array(outpostOperationSchema).min(1),
  workspaceRoots: z.array(z.string().min(1)).default([]),
});

const messageBaseSchema = z.object({
  protocolVersion: protocolVersionSchema,
});

export const outpostRegistrationSchema = messageBaseSchema.extend({
  type: z.literal("outpost.register"),
  outpostId: outpostIdentifierSchema,
  name: z.string().min(1).max(200),
  workerVersion: z.string().min(1),
  capabilities: outpostCapabilitiesSchema,
});

export const outpostHeartbeatSchema = messageBaseSchema.extend({
  type: z.literal("outpost.heartbeat"),
  outpostId: outpostIdentifierSchema,
  sentAt: timestampSchema,
});

export const outpostRegisteredSchema = messageBaseSchema.extend({
  type: z.literal("outpost.registered"),
  outpostId: outpostIdentifierSchema,
  connectionId: identifierSchema,
  registeredAt: timestampSchema,
  heartbeatIntervalMs: z.number().int().positive(),
});

export const outpostHeartbeatAcknowledgedSchema = messageBaseSchema.extend({
  type: z.literal("outpost.heartbeat_ack"),
  outpostId: outpostIdentifierSchema,
  receivedAt: timestampSchema,
});

export const outpostErrorSchema = messageBaseSchema.extend({
  type: z.literal("outpost.error"),
  code: z.enum([
    "invalid_message",
    "registration_required",
    "identity_mismatch",
    "unsupported_message",
  ]),
  message: z.string().min(1),
});

export const leaseOfferSchema = messageBaseSchema.extend({
  type: z.literal("lease.offer"),
  leaseId: identifierSchema,
  productSessionId: identifierSchema,
  workspacePath: z.string().min(1),
  expiresAt: timestampSchema,
});

export const leaseAcceptedSchema = messageBaseSchema.extend({
  type: z.literal("lease.accepted"),
  leaseId: identifierSchema,
});

export const leaseRejectedSchema = messageBaseSchema.extend({
  type: z.literal("lease.rejected"),
  leaseId: identifierSchema,
  reason: z.string().min(1),
});

export const leaseReleaseSchema = messageBaseSchema.extend({
  type: z.literal("lease.release"),
  leaseId: identifierSchema,
  reason: z.enum(["completed", "expired", "moved", "cancelled"]),
});

// With no request id this cancels every queued or running operation under the
// lease. A request id narrows cancellation to one timed-out operation.
export const toolCancelSchema = messageBaseSchema.extend({
  type: z.literal("tool.cancel"),
  leaseId: identifierSchema,
  requestId: identifierSchema.optional(),
});

export const toolRequestSchema = messageBaseSchema.extend({
  type: z.literal("tool.request"),
  requestId: identifierSchema,
  leaseId: identifierSchema,
  operation: outpostOperationSchema,
  input: z.record(z.string(), z.unknown()),
});

export const contextRequestSchema = messageBaseSchema.extend({
  type: z.literal("context.request"),
  requestId: identifierSchema,
  leaseId: identifierSchema,
});

export const toolErrorCodeSchema = z.enum([
  "lease_unknown",
  "lease_expired",
  "operation_unsupported",
  "invalid_input",
  "path_outside_workspace",
  "execution_error",
  "timeout",
  "cancelled",
]);

export const toolResultSchema = messageBaseSchema.extend({
  type: z.literal("tool.result"),
  requestId: identifierSchema,
  leaseId: identifierSchema,
  ok: z.boolean(),
  output: z.unknown(),
  error: z.string().optional(),
  errorCode: toolErrorCodeSchema.optional(),
});

export const AGENT_CONTEXT_MAX_BYTES = 512 * 1024;

export const agentContextFileSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(AGENT_CONTEXT_MAX_BYTES),
});

export const contextResultSchema = messageBaseSchema.extend({
  type: z.literal("context.result"),
  requestId: identifierSchema,
  leaseId: identifierSchema,
  ok: z.boolean(),
  files: z.array(agentContextFileSchema).max(64),
  error: z.string().optional(),
  errorCode: toolErrorCodeSchema.optional(),
});

export const workerToControlMessageSchema = z.discriminatedUnion("type", [
  outpostRegistrationSchema,
  outpostHeartbeatSchema,
  leaseAcceptedSchema,
  leaseRejectedSchema,
  toolResultSchema,
  contextResultSchema,
]);

// Homestead boundary: a central homestead service registers with the control
// plane over an outbound connection and receives product-session assignments.
export const harnessKindSchema = z.enum(["pi", "claude-code"]);

/**
 * The model catalog a homestead reports, so the product can only ever offer a
 * model the harness can actually reach.
 *
 * The harness owns the registry (Pi's `ModelRuntime`), and the harness runs in
 * the homestead — so the control plane learns the catalog from a homestead or not at
 * all. It rides on registration because a catalog does not change within a
 * homestead process's lifetime, which makes a separate request a round trip for
 * data that is already known.
 *
 * The payload carries its own version, independent of the protocol version:
 * the shape of a model record will move (costs, modalities, per-provider
 * metadata) far more often than the wire protocol, and a homestead that reports a
 * catalog version the control plane does not understand must be able to
 * register anyway. For the same reason the field is optional — a homestead with
 * no catalog is still a valid protocol-version-1 homestead, it simply contributes
 * nothing to the product's model list.
 */
export const MODEL_CATALOG_VERSION = 1 as const;

/** Pi's thinking vocabulary. Product reasoning efforts are mapped onto it. */
export const modelThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const catalogProviderSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
});

export const catalogModelSchema = z.object({
  providerId: z.string().min(1).max(200),
  id: z.string().min(1).max(400),
  name: z.string().min(1).max(400),
  /** False means the model has no thinking mode at all. */
  reasoning: z.boolean(),
  /**
   * Per-level support, as the harness reports it: a missing level means
   * "provider default", an explicit null means "unsupported". The two are not
   * the same, which is why the map is passed through rather than flattened
   * into a list of supported levels.
   */
  thinkingLevels: z.partialRecord(modelThinkingLevelSchema, z.string().nullable()).optional(),
  input: z.array(z.enum(["text", "image"])).default([]),
  contextWindow: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
});

export const modelCatalogSchema = z.object({
  catalogVersion: z.literal(MODEL_CATALOG_VERSION),
  providers: z.array(catalogProviderSchema).max(500),
  models: z.array(catalogModelSchema).max(5_000),
});

export const homesteadRegistrationSchema = messageBaseSchema.extend({
  type: z.literal("homestead.register"),
  homesteadId: outpostIdentifierSchema,
  homesteadVersion: z.string().min(1),
  harnesses: z.array(harnessKindSchema).min(1),
  catalog: modelCatalogSchema.optional(),
});

export const homesteadRegisteredSchema = messageBaseSchema.extend({
  type: z.literal("homestead.registered"),
  homesteadId: outpostIdentifierSchema,
  connectionId: identifierSchema,
  registeredAt: timestampSchema,
  heartbeatIntervalMs: z.number().int().positive(),
});

export const homesteadHeartbeatSchema = messageBaseSchema.extend({
  type: z.literal("homestead.heartbeat"),
  homesteadId: outpostIdentifierSchema,
  sentAt: timestampSchema,
});

export const homesteadHeartbeatAcknowledgedSchema = messageBaseSchema.extend({
  type: z.literal("homestead.heartbeat_ack"),
  homesteadId: outpostIdentifierSchema,
  receivedAt: timestampSchema,
});

export const homesteadErrorSchema = messageBaseSchema.extend({
  type: z.literal("homestead.error"),
  code: z.enum([
    "invalid_message",
    "registration_required",
    "identity_mismatch",
    "unsupported_message",
    /**
     * The homestead id this connection claimed is already held by another live
     * connection. The registry refuses the newcomer instead of rebinding the
     * id, so two processes can never both believe they are the same homestead.
     *
     * Added without a protocol version bump: it widens a control-to-homestead
     * vocabulary and changes the meaning of no existing message. A homestead built
     * before it cannot parse the error but is closed with
     * {@link HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE} and its reason string
     * regardless, so the refusal is never silent.
     */
    "duplicate_identity",
  ]),
  message: z.string().min(1),
});

/**
 * WebSocket close codes the homestead registry uses, in the application range.
 *
 * They are here rather than in either endpoint because a homestead has to tell
 * them apart to react correctly: being refused means another process owns this
 * identity and reconnecting fast only produces a hot loop, while being
 * superseded means this connection was already judged dead and a normal
 * reconnect is right. Both differ from the protocol-error close (4002).
 */
export const HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE = 4004;
export const HOMESTEAD_SUPERSEDED_CLOSE_CODE = 4000;

export const assignedRepositorySchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  cloneUrl: z.string().min(1),
});

export const sessionAssignSchema = messageBaseSchema.extend({
  type: z.literal("session.assign"),
  assignmentId: identifierSchema,
  productSessionId: identifierSchema,
  sandboxId: identifierSchema,
  // The bridge credential the homestead uses to connect back to the session's
  // WebSocket as its execution side. Plaintext by design: the control plane
  // stores only its hash, and this channel is the delivery mechanism, exactly
  // like the env-var delivery to a provisioned sandbox.
  sandboxAuthToken: z.string().min(1),
  // The credential the harness uses to fetch this session's model credential,
  // and nothing else. Deliberately a second token rather than a reuse of
  // sandboxAuthToken: that one also authorizes PR creation, media upload,
  // child-session spawn and Slack notification, which is far more reach than a
  // key fetch needs — and it is the token that ends up inside the agent's own
  // process, where the model can see it.
  //
  // Required, not optional. A control plane that could omit it and a homestead
  // that could fall back to the bridge token would reintroduce the very reach
  // this field removes, silently. A homestead speaking this schema against an
  // older control plane fails to parse the assignment and rejects it loudly.
  credentialFetchToken: z.string().min(1),
  controlPlaneUrl: z.string().min(1),
  harness: harnessKindSchema,
  model: z.string().min(1).optional(),
  outpostId: outpostIdentifierSchema,
  workspacePath: z.string().min(1),
  // Repositories to clone into the workspace before the harness starts.
  // Clone authentication is the homestead's concern (machine credentials by
  // default; brokered short-lived tokens opt-in) — the URL carries none.
  repositories: z.array(assignedRepositorySchema).optional(),
});

export const sessionAssignAcceptedSchema = messageBaseSchema.extend({
  type: z.literal("session.assign_accepted"),
  assignmentId: identifierSchema,
});

export const sessionAssignRejectedSchema = messageBaseSchema.extend({
  type: z.literal("session.assign_rejected"),
  assignmentId: identifierSchema,
  reason: z.string().min(1),
});

/**
 * Restart recovery is a separate HTTP exchange from the homestead WebSocket
 * protocol. Version it independently so adding it does not pretend the v3
 * message contract changed, while still making both endpoints refuse a
 * recovery shape they were not built for.
 */
export const HOMESTEAD_RECOVERY_VERSION = 1 as const;
const homesteadRecoveryVersionSchema = z.literal(HOMESTEAD_RECOVERY_VERSION);

export const homesteadRecoveryRequestSchema = z.object({
  recoveryVersion: homesteadRecoveryVersionSchema,
  productSessionId: identifierSchema,
  sandboxId: identifierSchema,
});

export const homesteadRecoveryResponseSchema = z.object({
  recoveryVersion: homesteadRecoveryVersionSchema,
  productSessionId: identifierSchema,
  sandboxId: identifierSchema,
  sandboxAuthToken: z.string().min(1),
  credentialFetchToken: z.string().min(1),
});

/**
 * The product's reasoning vocabulary, and what each effort means to a harness.
 *
 * It lives here rather than in either endpoint because both need the same
 * answer: the control plane maps efforts onto thinking levels to decide which
 * efforts a model can be offered at, and the homestead maps the same efforts onto
 * the same levels to actually run the turn. Two copies would be two answers,
 * and the one that disagreed would be the one nobody noticed.
 */
export const reasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);

export const REASONING_EFFORT_TO_THINKING_LEVEL = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const satisfies Record<ReasoningEffort, ModelThinkingLevel>;

/**
 * The harness thinking level a product effort asks for, or null when the effort
 * is not one this contract knows.
 *
 * Null rather than a default: a caller handed an effort nobody agreed on must
 * say so, because silently running at some other level is precisely the failure
 * this contract exists to prevent.
 */
export function thinkingLevelForReasoningEffort(effort: string): ModelThinkingLevel | null {
  const parsed = reasoningEffortSchema.safeParse(effort);
  return parsed.success ? REASONING_EFFORT_TO_THINKING_LEVEL[parsed.data] : null;
}

/** How a turn's commits are attributed on the machine that runs them. */
export const promptGitIdentitySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("attributed-user"),
    name: z.string().min(1),
    email: z.string().min(1),
  }),
  z.object({ mode: z.literal("agent-only") }),
]);

/** The person whose message this turn is answering. */
export const promptAuthorSchema = z.object({
  userId: z.string().min(1),
  gitIdentity: promptGitIdentitySchema,
});

/**
 * An image the author attached, as metadata only — the bytes live in the
 * product's attachment store and no operation in this protocol can carry them.
 * A homestead that receives one must refuse the turn rather than answer a message
 * whose images the model never saw.
 */
export const promptAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
});

/**
 * One user turn, as the control plane hands it to whatever is serving the
 * session's execution side.
 *
 * It rides the inherited sandbox WebSocket rather than the homestead control
 * socket, which is why it carries no `protocolVersion` of its own: that channel
 * is shared with provisioned sandboxes and predates this package. The contract
 * is versioned all the same — by `OUTPOST_PROTOCOL_VERSION`, which reached 2
 * when this schema was introduced — and both sides are expected to move
 * together.
 *
 * The object is strict on purpose. A field the control plane sends and the
 * homestead quietly ignores is exactly the defect this schema was written for: the
 * model, the reasoning effort and the author were all being dropped on the
 * floor while the product's UI showed them as honoured. An unrecognised field
 * must fail the turn loudly, not be discarded.
 */
export const bridgePromptCommandSchema = z
  .object({
    type: z.literal("prompt"),
    messageId: identifierSchema,
    content: z.string(),
    /** `provider/model-id`. The turn's model, which may differ from the last one. */
    model: z.string().min(1).optional(),
    /**
     * A product reasoning effort. Deliberately a plain string rather than
     * `reasoningEffortSchema`: an effort this contract does not know must be
     * reported by name to the user, and a schema rejection here would only say
     * that the prompt was unreadable.
     */
    reasoningEffort: z.string().min(1).optional(),
    author: promptAuthorSchema.optional(),
    attachments: z.array(promptAttachmentSchema).optional(),
  })
  .strict();

export const homesteadToControlMessageSchema = z.discriminatedUnion("type", [
  homesteadRegistrationSchema,
  homesteadHeartbeatSchema,
  sessionAssignAcceptedSchema,
  sessionAssignRejectedSchema,
]);

export const controlToHomesteadMessageSchema = z.discriminatedUnion("type", [
  homesteadRegisteredSchema,
  homesteadHeartbeatAcknowledgedSchema,
  homesteadErrorSchema,
  sessionAssignSchema,
]);

export const controlToWorkerMessageSchema = z.discriminatedUnion("type", [
  outpostRegisteredSchema,
  outpostHeartbeatAcknowledgedSchema,
  outpostErrorSchema,
  leaseOfferSchema,
  leaseReleaseSchema,
  toolRequestSchema,
  toolCancelSchema,
  contextRequestSchema,
]);

// Tool operation payloads. Every path is resolved by the worker relative to
// the lease's workspacePath; absolute paths and traversal outside it are
// rejected with path_outside_workspace.
const workspaceRelativePathSchema = z.string().min(1).max(4096);

export const bashInputSchema = z.object({
  command: z.string().min(1),
  cwd: workspaceRelativePathSchema.optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

export const bashResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const readInputSchema = z.object({
  path: workspaceRelativePathSchema,
  offsetLines: z.number().int().nonnegative().optional(),
  limitLines: z.number().int().positive().optional(),
});

export const readResultSchema = z.object({
  content: z.string(),
  totalLines: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const writeInputSchema = z.object({
  path: workspaceRelativePathSchema,
  content: z.string(),
});

export const writeResultSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
  created: z.boolean(),
});

export const editInputSchema = z.object({
  path: workspaceRelativePathSchema,
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const editResultSchema = z.object({
  replacements: z.number().int().positive(),
});

export const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: workspaceRelativePathSchema.optional(),
  maxMatches: z.number().int().positive().max(1_000).optional(),
});

export const grepResultSchema = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      text: z.string(),
    })
  ),
  truncated: z.boolean(),
});

export const findInputSchema = z.object({
  glob: z.string().min(1),
  maxResults: z.number().int().positive().max(5_000).optional(),
});

export const findResultSchema = z.object({
  paths: z.array(z.string()),
  truncated: z.boolean(),
});

export const lsInputSchema = z.object({
  path: workspaceRelativePathSchema.optional(),
});

export const lsResultSchema = z.object({
  entries: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["file", "dir", "symlink", "other"]),
      sizeBytes: z.number().int().nonnegative().optional(),
    })
  ),
  // Listing a directory is bounded like searching one. Without this field the
  // schema would strip the worker's marker and a truncated listing would reach
  // the model looking complete.
  truncated: z.boolean(),
});

export const toolInputSchemas = {
  bash: bashInputSchema,
  read: readInputSchema,
  write: writeInputSchema,
  edit: editInputSchema,
  grep: grepInputSchema,
  find: findInputSchema,
  ls: lsInputSchema,
} as const satisfies Record<OutpostOperation, z.ZodType>;

export const toolResultSchemas = {
  bash: bashResultSchema,
  read: readResultSchema,
  write: writeResultSchema,
  edit: editResultSchema,
  grep: grepResultSchema,
  find: findResultSchema,
  ls: lsResultSchema,
} as const satisfies Record<OutpostOperation, z.ZodType>;

export type OutpostOperation = z.infer<typeof outpostOperationSchema>;
export type OutpostCapabilities = z.infer<typeof outpostCapabilitiesSchema>;
export type OutpostRegistration = z.infer<typeof outpostRegistrationSchema>;
export type OutpostHeartbeat = z.infer<typeof outpostHeartbeatSchema>;
export type OutpostRegistered = z.infer<typeof outpostRegisteredSchema>;
export type OutpostHeartbeatAcknowledged = z.infer<typeof outpostHeartbeatAcknowledgedSchema>;
export type OutpostError = z.infer<typeof outpostErrorSchema>;
export type LeaseOffer = z.infer<typeof leaseOfferSchema>;
export type LeaseAccepted = z.infer<typeof leaseAcceptedSchema>;
export type LeaseRejected = z.infer<typeof leaseRejectedSchema>;
export type LeaseRelease = z.infer<typeof leaseReleaseSchema>;
export type ToolRequest = z.infer<typeof toolRequestSchema>;
export type ToolCancel = z.infer<typeof toolCancelSchema>;
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
export type AgentContextFile = z.infer<typeof agentContextFileSchema>;
export type ContextRequest = z.infer<typeof contextRequestSchema>;
export type ContextResult = z.infer<typeof contextResultSchema>;
export type BashInput = z.infer<typeof bashInputSchema>;
export type BashResult = z.infer<typeof bashResultSchema>;
export type ReadInput = z.infer<typeof readInputSchema>;
export type ReadResult = z.infer<typeof readResultSchema>;
export type WriteInput = z.infer<typeof writeInputSchema>;
export type WriteResult = z.infer<typeof writeResultSchema>;
export type EditInput = z.infer<typeof editInputSchema>;
export type EditResult = z.infer<typeof editResultSchema>;
export type GrepInput = z.infer<typeof grepInputSchema>;
export type GrepResult = z.infer<typeof grepResultSchema>;
export type FindInput = z.infer<typeof findInputSchema>;
export type FindResult = z.infer<typeof findResultSchema>;
export type LsInput = z.infer<typeof lsInputSchema>;
export type LsResult = z.infer<typeof lsResultSchema>;
export type WorkerToControlMessage = z.infer<typeof workerToControlMessageSchema>;
export type ControlToWorkerMessage = z.infer<typeof controlToWorkerMessageSchema>;
export type ProtocolHarnessKind = z.infer<typeof harnessKindSchema>;
export type ModelThinkingLevel = z.infer<typeof modelThinkingLevelSchema>;
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type HomesteadRegistration = z.infer<typeof homesteadRegistrationSchema>;
export type HomesteadRegistered = z.infer<typeof homesteadRegisteredSchema>;
export type HomesteadHeartbeat = z.infer<typeof homesteadHeartbeatSchema>;
export type HomesteadError = z.infer<typeof homesteadErrorSchema>;
export type AssignedRepository = z.infer<typeof assignedRepositorySchema>;
export type SessionAssign = z.infer<typeof sessionAssignSchema>;
export type SessionAssignAccepted = z.infer<typeof sessionAssignAcceptedSchema>;
export type SessionAssignRejected = z.infer<typeof sessionAssignRejectedSchema>;
export type HomesteadRecoveryRequest = z.infer<typeof homesteadRecoveryRequestSchema>;
export type HomesteadRecoveryResponse = z.infer<typeof homesteadRecoveryResponseSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type PromptGitIdentity = z.infer<typeof promptGitIdentitySchema>;
export type PromptAuthor = z.infer<typeof promptAuthorSchema>;
export type PromptAttachment = z.infer<typeof promptAttachmentSchema>;
export type BridgePromptCommand = z.infer<typeof bridgePromptCommandSchema>;
export type HomesteadToControlMessage = z.infer<typeof homesteadToControlMessageSchema>;
export type ControlToHomesteadMessage = z.infer<typeof controlToHomesteadMessageSchema>;

export * from "./service-signature";
