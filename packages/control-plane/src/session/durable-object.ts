/**
 * Session Durable Object implementation.
 *
 * Each session gets its own Durable Object instance with:
 * - SQLite database for persistent state
 * - WebSocket connections with hibernation support
 * - Prompt queue and event streaming
 */

import { DurableObject } from "cloudflare:workers";
import {
  HOMESTEAD_RECOVERY_VERSION,
  homesteadRecoveryRequestSchema,
} from "@openoutposts/outpost-protocol";
import { initSchema } from "./schema";
import {
  DEFAULT_MODEL,
  clientMessageSchema,
  resolveAppName,
  sandboxEventSchema,
  timingSafeEqual,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
import { generateId, hashToken, decryptToken } from "../auth/crypto";
import { sandboxSecretContext } from "../auth/encryption-contexts";
import { resolveSandboxBackendName } from "../sandbox/provider-name";
import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
} from "../sandbox/lifecycle/manager";
import { SessionIndexStore } from "../db/session-index";
import { DEFAULT_EXECUTION_TIMEOUT_MS } from "../sandbox/lifecycle/decisions";
import {
  createSourceControlProviderFromEnv,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
  type GitPushSpec,
} from "../source-control";
import type {
  Env,
  ClientInfo,
  ServerMessage,
  SandboxEvent,
  SessionRepositoryState,
  SessionState,
  SandboxStatus,
} from "../types";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionRow, ArtifactRow, SandboxRow } from "./types";
import { SessionRepository } from "./repository";
import { collectSessionObjectKeys, purgeSessionStorage } from "./purge";
import { createMediaObjectStorage } from "../storage/object-storage";
import { resolveEventRetentionConfig, type EventRetentionConfig } from "./event-persistence";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import { resolveParticipantName } from "./participant-name";
import { validateReasoningEffort } from "./reasoning-effort";
import { parseTunnelUrls } from "./tunnel-urls";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { PullRequestCreationClaims, SessionPullRequestService } from "./pull-request-service";
import { refreshSessionPullRequests } from "./pull-request-refresh";
import { findPrArtifactForRepo } from "./pr-artifacts";
import { EnvironmentStore } from "../db/environments";
import {} from "../db/secrets-validation";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { ScmCredentialsService } from "./scm-credentials-service";
import { ParticipantService, getAvatarUrl } from "./participant-service";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import { CallbackNotificationService } from "./callback-notification-service";
import { DOFetcherAdapter } from "../scheduler/do-fetcher-adapter";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import { SessionEventStream } from "./event-stream";
import { createSessionInternalRoutes } from "./http/routes";
import { createMessagesHandler, type MessagesHandler } from "./http/handlers/messages.handler";
import {
  createChildSessionsHandler,
  type ChildSessionsHandler,
} from "./http/handlers/child-sessions.handler";
import { createSandboxHandler, type SandboxHandler } from "./http/handlers/sandbox.handler";
import { AttachmentsHandler } from "./http/handlers/attachments.handler";
import { createWsTokenHandler, type WsTokenHandler } from "./http/handlers/ws-token.handler";
import {
  createSessionLifecycleHandler,
  type SessionLifecycleHandler,
} from "./http/handlers/session-lifecycle.handler";
import {
  normalizeSessionTitle,
  type SessionTitleUpdateOptions,
  type SessionTitleUpdateResult,
} from "./title";
import {
  createPullRequestHandler,
  type PullRequestHandler,
} from "./http/handlers/pull-request.handler";
import {
  createParticipantsHandler,
  type ParticipantsHandler,
} from "./http/handlers/participants.handler";
import { MessageService } from "./services/message.service";
import { createAlarmHandler, type AlarmHandler } from "./alarm/handler";
import { SessionDiffStore } from "./diffs/store";
import { SessionDiffService } from "./diffs/service";
import { SessionDiffsHandler } from "./http/handlers/session-diffs.handler";
import { SessionMessengerImpl, type SessionMessenger } from "./messenger";
import { SessionStatusService } from "./session-status-service";
import { SessionInternalPaths } from "./contracts";

/**
 * Timeout for WebSocket authentication (in milliseconds).
 * Client WebSockets must send a valid 'subscribe' message within this time
 * or the connection will be closed. This prevents resource abuse from
 * unauthenticated connections that never complete the handshake.
 */
const WS_AUTH_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Maximum age of a WebSocket authentication token (in milliseconds).
 * Tokens older than this are rejected with close code 4001, forcing
 * the client to fetch a fresh token on reconnect.
 */
const WS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type BoundarySchema<T> = {
  safeParse(
    input: unknown
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
};

export class SessionDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /**
   * The DO's global-database handle — the single point where env.DB is read.
   * Nullable to preserve the existing defensive guards against a missing
   * binding at runtime. Distinct from `this.sql`, the DO-embedded SQLite.
   */
  private readonly db: SqlDatabase | null;
  private repository: SessionRepository;
  private attachmentRepository: SessionAttachmentRepository;
  /**
   * How large this session's transcript may grow. Read once at construction:
   * every write path shares one policy, so the truncation ceiling a stored
   * event was measured against is the same one the pruner budgets with.
   */
  private readonly eventRetention: EventRetentionConfig;
  private initialized = false;
  private purged = false;
  // Session-scoped logger. Assigned during initialization only — never
  // per-request. Request-serving code receives a request-scoped child
  // (with trace_id / request_id) threaded explicitly from fetch().
  private log: Logger;
  // WebSocket manager (lazily initialized like lifecycleManager)
  private _wsManager: SessionWebSocketManager | null = null;
  // Session messenger (constructed in ensureInitialized once the session logger exists)
  private messenger!: SessionMessenger;
  // Session diff service (constructed in ensureInitialized once the session logger exists)
  private diffService!: SessionDiffService;
  // Session diffs HTTP handler (constructed in ensureInitialized alongside the service)
  private diffsHandler!: SessionDiffsHandler;
  // Lifecycle manager (lazily initialized)
  private _lifecycleManager: SandboxLifecycleManager | null = null;
  // Source control provider (lazily initialized)
  private _sourceControlProvider: SourceControlProvider | null = null;
  // Participant service (lazily initialized)
  private _participantService: ParticipantService | null = null;
  // Callback notification service (lazily initialized)
  private _callbackService: CallbackNotificationService | null = null;
  // Presence service (lazily initialized)
  private _presenceService: PresenceService | null = null;
  // Message queue service (lazily initialized)
  private _messageQueue: SessionMessageQueue | null = null;
  // Message service (lazily initialized)
  private _messageService: MessageService | null = null;
  private _eventStream: SessionEventStream | null = null;
  // Messages handler (lazily initialized)
  private _messagesHandler: MessagesHandler | null = null;
  // Child sessions handler (lazily initialized)
  private _childSessionsHandler: ChildSessionsHandler | null = null;
  // Sandbox handler (lazily initialized)
  private _sandboxHandler: SandboxHandler | null = null;
  // Session attachments handler (lazily initialized)
  private _attachmentsHandler: AttachmentsHandler | null = null;
  // WebSocket token handler (lazily initialized)
  private _wsTokenHandler: WsTokenHandler | null = null;
  // Session lifecycle handler (lazily initialized)
  private _sessionLifecycleHandler: SessionLifecycleHandler | null = null;
  // Pull request handler (lazily initialized)
  private _pullRequestHandler: PullRequestHandler | null = null;
  private readonly prCreationClaims = new PullRequestCreationClaims();
  // Participants handler (lazily initialized)
  private _participantsHandler: ParticipantsHandler | null = null;
  // Alarm handler (lazily initialized)
  private _alarmHandler: AlarmHandler | null = null;
  // Sandbox event processor (lazily initialized)
  private _sandboxEventProcessor: SessionSandboxEventProcessor | null = null;
  // Session status service (lazily initialized)
  private _statusService: SessionStatusService | null = null;

  // Internal HTTP route table (transport wiring only; handlers remain on SessionDO).
  private readonly routes = createSessionInternalRoutes({
    init: (request, _url, log) => this.sessionLifecycleHandler.init(request, log),
    state: () => this.sessionLifecycleHandler.getState(),
    prompt: (request, _url, log) => this.messagesHandler.enqueuePrompt(request, log),
    stop: () => this.messagesHandler.stop(),
    sandboxEvent: (request) => this.sandboxHandler.sandboxEvent(request),
    createMediaArtifact: (request) => this.sandboxHandler.createMediaArtifact(request),
    recordAttachment: (request) => {
      const session = this.getSession();
      return this.attachmentsHandler.recordAttachment(
        request,
        session ? this.getPublicSessionId(session) : null
      );
    },
    listParticipants: () => this.participantsHandler.listParticipants(),
    addParticipant: (request) => this.sandboxHandler.addParticipant(request),
    listEvents: (_request, url) => this.messagesHandler.listEvents(url),
    listArtifacts: (_request, url) => this.messagesHandler.listArtifacts(url),
    listMessages: (_request, url) => this.messagesHandler.listMessages(url),
    createPr: (request, _url, log) => this.pullRequestHandler.createPr(request, log),
    pullRequestArtifactSnapshot: (request, url) =>
      this.pullRequestHandler.pullRequestArtifactSnapshot(request, url),
    pullRequestsRefresh: () => this.pullRequestHandler.refreshPullRequests(),
    wsToken: (request, _url, log) => this.wsTokenHandler.generateWsToken(request, log),
    updateTitle: (request) => this.sessionLifecycleHandler.updateTitle(request),
    archive: (request) => this.sessionLifecycleHandler.archive(request),
    unarchive: (request) => this.sessionLifecycleHandler.unarchive(request),
    verifySandboxToken: (request, _url, log) =>
      this.sandboxHandler.verifySandboxToken(request, log),
    rotateSandboxCredentials: (request, _url, log) =>
      this.rotateSandboxCredentialsForRecovery(request, log),
    openaiTokenRefresh: (_request, _url, log) => this.sandboxHandler.openaiTokenRefresh(log),
    scmCredentials: (_request, _url, log) => this.sandboxHandler.scmCredentials(log),
    tunnelUrls: (_request, _url, log) => this.sandboxHandler.tunnelUrls(log),
    spawnContext: () => this.childSessionsHandler.getSpawnContext(),
    childSummary: (_request, url) => this.childSessionsHandler.getChildSummary(url),
    cancel: () => this.sessionLifecycleHandler.cancel(),
    childSessionUpdate: (request) => this.childSessionsHandler.childSessionUpdate(request),
    diffState: () => this.diffsHandler.state(),
    diffStore: (request) => this.diffsHandler.storeBundle(request),
    diffFailure: (request) => this.diffsHandler.recordFailure(request),
    diffResolveFile: (_request, url) => this.diffsHandler.resolveFile(url),
    diffRetry: () => this.diffsHandler.retry(),
    purge: (_request, _url, log) => this.purgeSessionStorage(log),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // eslint-disable-next-line no-restricted-syntax -- composition root: the DO's one env.DB read
    this.db = env.DB ?? null;
    this.sql = ctx.storage.sql;
    this.attachmentRepository = new SessionAttachmentRepository(this.sql);
    this.eventRetention = resolveEventRetentionConfig(env);
    this.repository = new SessionRepository(
      this.sql,
      (closure) => ctx.storage.transactionSync(closure),
      this.attachmentRepository,
      this.eventRetention
    );
    this.log = createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL));
    // Note: session_id context is set in ensureInitialized() once DB is ready
  }

  /**
   * Get the lifecycle manager, creating it lazily if needed.
   * The manager is created with adapters that delegate to the DO's methods.
   */
  private get lifecycleManager(): SandboxLifecycleManager {
    if (!this._lifecycleManager) {
      this._lifecycleManager = this.createLifecycleManager();
    }
    return this._lifecycleManager;
  }

  /**
   * Get the source control provider, creating it lazily if needed.
   */
  private get sourceControlProvider(): SourceControlProvider {
    if (!this._sourceControlProvider) {
      this._sourceControlProvider = this.createSourceControlProvider();
    }
    return this._sourceControlProvider;
  }

  /**
   * Get the participant service, creating it lazily if needed.
   */
  private get participantService(): ParticipantService {
    if (!this._participantService) {
      const userScmTokenStore =
        this.db && this.env.TOKEN_ENCRYPTION_KEY
          ? new UserScmTokenStore(this.db, this.env.TOKEN_ENCRYPTION_KEY)
          : null;
      this._participantService = new ParticipantService({
        repository: this.repository,
        env: this.env,
        log: this.log,
        generateId: () => generateId(),
        userScmTokenStore,
      });
    }
    return this._participantService;
  }

  /**
   * Get the callback notification service, creating it lazily if needed.
   */
  private get callbackService(): CallbackNotificationService {
    if (!this._callbackService) {
      // Wrap SchedulerDO namespace as a Fetcher for automation callbacks
      const schedulerCallback = this.env.SCHEDULER
        ? new DOFetcherAdapter(this.env.SCHEDULER, "global-scheduler")
        : undefined;

      this._callbackService = new CallbackNotificationService({
        repository: this.repository,
        env: {
          ...this.env,
          SCHEDULER_CALLBACK: schedulerCallback,
        },
        log: this.log,
        getSessionId: () => {
          const session = this.getSession();
          return session?.session_name || session?.id || this.ctx.id.toString();
        },
      });
    }
    return this._callbackService;
  }

  /**
   * Get the presence service, creating it lazily if needed.
   */
  private get presenceService(): PresenceService {
    if (!this._presenceService) {
      this._presenceService = new PresenceService({
        getAuthenticatedClients: () => this.wsManager.getAuthenticatedClients(),
        getClientInfo: (ws) => this.getClientInfo(ws),
        messenger: this.messenger,
        send: (ws, msg) => this.safeSend(ws, msg),
        getSandboxSocket: () => this.wsManager.getSandboxSocket(),
        isSpawning: () => this.lifecycleManager.isSpawning(),
        spawnSandbox: () => this.spawnSandbox(),
        log: this.log,
      });
    }
    return this._presenceService;
  }

  /**
   * Get the WebSocket manager, creating it lazily if needed.
   * Lazy initialization ensures the logger has session_id context
   * (set by ensureInitialized()) by the time the manager is created.
   */
  private get wsManager(): SessionWebSocketManager {
    if (!this._wsManager) {
      this._wsManager = new SessionWebSocketManagerImpl(this.ctx, this.repository, this.log, {
        authTimeoutMs: WS_AUTH_TIMEOUT_MS,
      });
    }
    return this._wsManager;
  }

  private get executionTimeoutMs(): number {
    return parseInt(this.env.EXECUTION_TIMEOUT_MS || String(DEFAULT_EXECUTION_TIMEOUT_MS), 10);
  }

  private get messageQueue(): SessionMessageQueue {
    if (!this._messageQueue) {
      this._messageQueue = new SessionMessageQueue(
        this.ctx,
        this.log,
        this.repository,
        this.attachmentRepository,
        this.wsManager,
        this.messenger,
        this.participantService,
        this.callbackService,
        this.statusService,
        this.lifecycleManager,
        this.db ? new SessionIndexStore(this.db) : null,
        resolveScmProviderFromEnv(this.env.SCM_PROVIDER),
        this.executionTimeoutMs,
        this.eventRetention
      );
    }

    return this._messageQueue;
  }

  private get messageService(): MessageService {
    if (!this._messageService) {
      this._messageService = new MessageService({
        repository: this.repository,
        messageQueue: this.messageQueue,
        stopExecution: () => this.stopExecution(),
        parseArtifactMetadata: (artifact) => this.parseArtifactMetadata(artifact),
      });
    }

    return this._messageService;
  }

  private get eventStream(): SessionEventStream {
    if (!this._eventStream) {
      this._eventStream = new SessionEventStream(this.repository);
    }

    return this._eventStream;
  }

  private get messagesHandler(): MessagesHandler {
    if (!this._messagesHandler) {
      this._messagesHandler = createMessagesHandler({
        messageService: this.messageService,
      });
    }

    return this._messagesHandler;
  }

  private get childSessionsHandler(): ChildSessionsHandler {
    if (!this._childSessionsHandler) {
      this._childSessionsHandler = createChildSessionsHandler({
        repository: this.repository,
        getSession: () => this.getSession(),
        getSandbox: () => this.getSandbox(),
        getPublicSessionId: (session) => this.getPublicSessionId(session),
        parseArtifactMetadata: (artifact) => this.parseArtifactMetadata(artifact),
        messenger: this.messenger,
      });
    }

    return this._childSessionsHandler;
  }

  private get sandboxHandler(): SandboxHandler {
    if (!this._sandboxHandler) {
      this._sandboxHandler = createSandboxHandler({
        repository: this.repository,
        processSandboxEvent: (event) => this.processSandboxEvent(event),
        getSandbox: () => this.getSandbox(),
        isValidSandboxToken: (token, sandbox) => this.isValidSandboxToken(token, sandbox),
        isValidCredentialFetchToken: (token, sandbox) =>
          this.isValidCredentialFetchToken(token, sandbox),
        getSession: () => this.getSession(),
        refreshOpenAIToken: async (session, log) => {
          const service = new OpenAITokenRefreshService(
            this.db!,
            this.env.REPO_SECRETS_ENCRYPTION_KEY!,
            (sessionRow) => this.ensureRepoId(sessionRow),
            log
          );
          return service.refresh(session);
        },
        isOpenAISecretsConfigured: () => Boolean(this.db && this.env.REPO_SECRETS_ENCRYPTION_KEY),
        getScmCredentials: (log) =>
          new ScmCredentialsService(this.sourceControlProvider, log).getCredentials(),
        messenger: this.messenger,
        generateId: () => generateId(),
        now: () => Date.now(),
        retention: this.eventRetention,
      });
    }

    return this._sandboxHandler;
  }

  private get attachmentsHandler(): AttachmentsHandler {
    if (!this._attachmentsHandler) {
      this._attachmentsHandler = new AttachmentsHandler(this.attachmentRepository, this.log);
    }

    return this._attachmentsHandler;
  }

  private get wsTokenHandler(): WsTokenHandler {
    if (!this._wsTokenHandler) {
      this._wsTokenHandler = createWsTokenHandler({
        repository: this.repository,
        getParticipantByUserId: (userId) => this.participantService.getByUserId(userId),
        generateId: (bytes) => generateId(bytes),
        hashToken: (token) => hashToken(token),
        now: () => Date.now(),
      });
    }

    return this._wsTokenHandler;
  }

  private get sessionLifecycleHandler(): SessionLifecycleHandler {
    if (!this._sessionLifecycleHandler) {
      this._sessionLifecycleHandler = createSessionLifecycleHandler({
        repository: this.repository,
        getDurableObjectId: () => this.ctx.id.toString(),
        tokenEncryptionKey: this.env.TOKEN_ENCRYPTION_KEY,
        encryptToken: async (token, encryptionKey, context) => {
          const { encryptToken } = await import("../auth/crypto");
          return encryptToken(token, encryptionKey, context);
        },
        validateReasoningEffort: (model, effort) =>
          validateReasoningEffort(model, effort, this.log),
        generateId: (bytes) => generateId(bytes),
        now: () => Date.now(),
        scheduleWarmSandbox: () => this.ctx.waitUntil(this.warmSandbox()),
        getSession: () => this.getSession(),
        getSandbox: () => this.getSandbox(),
        getPublicSessionId: (session) => this.getPublicSessionId(session),
        getParticipantByUserId: (userId) => this.participantService.getByUserId(userId),
        statusService: this.statusService,
        applySessionTitleUpdate: (title, options) => this.applySessionTitleUpdate(title, options),
        stopExecution: (options) => this.stopExecution(options),
        getSandboxSocket: () => this.wsManager.getSandboxSocket(),
        sendToSandbox: (ws, message) => this.wsManager.send(ws, message),
        updateSandboxStatus: (status) => this.updateSandboxStatus(status),
      });
    }

    return this._sessionLifecycleHandler;
  }

  private get pullRequestHandler(): PullRequestHandler {
    if (!this._pullRequestHandler) {
      this._pullRequestHandler = createPullRequestHandler({
        getSession: () => this.getSession(),
        getSessionRepositories: () => this.repository.getSessionRepositories(),
        getPromptingParticipantForPR: () => this.participantService.getPromptingParticipantForPR(),
        resolveAuthForPR: (participant) => this.participantService.resolveAuthForPR(participant),
        getSessionUrl: (session) => {
          const sessionId = session.session_name || session.id;
          const webAppUrl = this.env.WEB_APP_URL || this.env.WORKER_URL || "";
          return webAppUrl + "/session/" + sessionId;
        },
        createPullRequest: async (input, log) => {
          const pullRequestService = new SessionPullRequestService({
            repository: this.repository,
            claims: this.prCreationClaims,
            sourceControlProvider: this.sourceControlProvider,
            log,
            generateId: () => generateId(),
            pushBranchToRemote: (pushSpec) => this.pushBranchToRemote(pushSpec),
            messenger: this.messenger,
            appName: resolveAppName(this.env),
            sessionPullRequests: this.db ? new SessionPullRequestStore(this.db) : undefined,
          });

          return pullRequestService.createPullRequest(input);
        },
        getArtifactById: (artifactId) => this.repository.getArtifactById(artifactId),
        updateArtifact: (artifactId, data) => this.repository.updateArtifact(artifactId, data),
        messenger: this.messenger,
        now: () => Date.now(),
        triggerPullRequestRefresh: () => this.schedulePullRequestRefresh("manual"),
      });
    }

    return this._pullRequestHandler;
  }

  /** Fire a background read-through refresh; failures only log. */
  private schedulePullRequestRefresh(trigger: "open" | "manual"): void {
    this.ctx.waitUntil(
      refreshSessionPullRequests(
        this.repository,
        this.sourceControlProvider,
        this.db ? new SessionPullRequestStore(this.db) : null
      )
        .then(({ updated, failures }) => {
          for (const artifact of updated) {
            this.broadcast({ type: "artifact_updated", artifact });
          }
          for (const failure of failures) {
            this.log.error("Pull request refresh failed for artifact", {
              trigger,
              reason: failure.reason,
              artifact_id: failure.artifactId,
              pr_number: failure.prNumber,
              repo_owner: failure.repoOwner,
              repo_name: failure.repoName,
              error: failure.error instanceof Error ? failure.error : String(failure.error),
            });
          }
        })
        .catch((error) => {
          this.log.error("Pull request refresh failed", {
            trigger,
            error: error instanceof Error ? error : String(error),
          });
        })
    );
  }

  private get participantsHandler(): ParticipantsHandler {
    if (!this._participantsHandler) {
      this._participantsHandler = createParticipantsHandler({
        repository: this.repository,
      });
    }

    return this._participantsHandler;
  }

  private get alarmHandler(): AlarmHandler {
    if (!this._alarmHandler) {
      this._alarmHandler = createAlarmHandler({
        repository: this.repository,
        messageQueue: this.messageQueue,
        lifecycleManager: this.lifecycleManager,
        executionTimeoutMs: this.executionTimeoutMs,
        now: () => Date.now(),
        log: this.log,
      });
    }

    return this._alarmHandler;
  }

  private get sandboxEventProcessor(): SessionSandboxEventProcessor {
    if (!this._sandboxEventProcessor) {
      this._sandboxEventProcessor = new SessionSandboxEventProcessor(
        this.ctx,
        () => this.log,
        this.repository,
        this.callbackService,
        this.wsManager,
        this.messenger,
        this.diffService,
        (title, options) => this.applySessionTitleUpdate(title, options),
        this.statusService,
        (timestamp) => this.updateLastActivity(timestamp),
        () => this.scheduleInactivityCheck(),
        () => this.messageQueue.processMessageQueue(),
        this.eventRetention
      );
    }

    return this._sandboxEventProcessor;
  }

  /**
   * Get the session status service, creating it lazily if needed.
   * Lazy initialization ensures the session-scoped logger and messenger
   * (set by ensureInitialized()) exist by the time the service is created.
   */
  private get statusService(): SessionStatusService {
    if (!this._statusService) {
      this._statusService = new SessionStatusService(
        this.ctx,
        this.log,
        this.repository,
        this.messenger,
        this.db ? new SessionIndexStore(this.db) : null,
        this.env.SESSION ?? null
      );
    }

    return this._statusService;
  }

  /**
   * Create the source control provider.
   */
  private createSourceControlProvider(): SourceControlProvider {
    return createSourceControlProviderFromEnv(this.env);
  }

  /**
   * Create the lifecycle manager with all required adapters.
   */
  private createLifecycleManager(): SandboxLifecycleManager {
    const sandboxBackend = resolveSandboxBackendName(this.env.SANDBOX_PROVIDER);

    const provider = createSandboxProviderFromEnv(this.env, sandboxBackend);

    // Storage adapter
    const storage: SandboxStorage = {
      getSandbox: () => this.repository.getSandbox(),
      getSandboxWithCircuitBreaker: () => this.repository.getSandboxWithCircuitBreaker(),
      getSession: () => this.repository.getSession(),
      getSessionRepositories: () =>
        this.repository.getSessionRepositories().map((entry) => ({
          repoOwner: entry.repoOwner,
          repoName: entry.repoName,
          baseBranch: entry.baseBranch ?? "main",
          baseSha: entry.row?.base_sha ?? null,
        })),
      updateSandboxStatus: (status) => this.updateSandboxStatus(status),
      updateSandboxForSpawn: (data) => this.repository.updateSandboxForSpawn(data),
      updateSandboxLastActivity: (timestamp) =>
        this.repository.updateSandboxLastActivity(timestamp),
      incrementCircuitBreakerFailure: (timestamp) =>
        this.repository.incrementCircuitBreakerFailure(timestamp),
      resetCircuitBreaker: () => this.repository.resetCircuitBreaker(),
      setLastSpawnError: (error, timestamp) =>
        this.repository.updateSandboxSpawnError(error, timestamp),
      clearLegacySandboxAccessState: () => {
        this.repository.clearSandboxCodeServer();
        this.repository.clearSandboxTunnelUrls();
        this.repository.clearSandboxTtyd();
      },
    };

    // Broadcaster adapter
    const broadcaster: SandboxBroadcaster = {
      broadcast: (message) => this.broadcast(message as ServerMessage),
    };

    // WebSocket manager adapter — thin delegation to wsManager
    const wsManager: WebSocketManager = {
      getSandboxWebSocket: () => this.wsManager.getSandboxSocket(),
      closeSandboxWebSocket: (code, reason) => {
        const ws = this.wsManager.getSandboxSocket();
        if (ws) {
          this.wsManager.close(ws, code, reason);
          this.wsManager.clearSandboxSocket();
        }
      },
      sendToSandbox: (message) => {
        const ws = this.wsManager.getSandboxSocket();
        return ws ? this.wsManager.send(ws, message) : false;
      },
      getConnectedClientCount: () => this.wsManager.getConnectedClientCount(),
    };

    // Alarm scheduler adapter
    const alarmScheduler: AlarmScheduler = {
      scheduleAlarm: async (timestamp) => {
        await this.ctx.storage.setAlarm(timestamp);
      },
    };

    // ID generator adapter
    const idGenerator: IdGenerator = {
      generateId: () => generateId(),
    };

    // Build configuration
    const controlPlaneUrl =
      this.env.WORKER_URL ||
      `https://openoutposts-control-plane.${this.env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

    // Resolve sessionId for lifecycle manager logging context
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();

    const config = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl,
      model: DEFAULT_MODEL,
      sessionId,
      inactivity: {
        ...DEFAULT_LIFECYCLE_CONFIG.inactivity,
        timeoutMs: parseInt(this.env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10),
      },
    };

    return new SandboxLifecycleManager(
      provider,
      storage,
      broadcaster,
      wsManager,
      alarmScheduler,
      idGenerator,
      config,
      {
        onSandboxTerminating: () => this.messageQueue.failStuckProcessingMessage(),
      }
    );
  }

  /**
   * Safely send a message over a WebSocket.
   */
  private safeSend(ws: WebSocket, message: string | object): boolean {
    return this.wsManager.send(ws, message);
  }

  /**
   * Initialize the session with required data.
   */
  private ensureInitialized(): void {
    if (this.purged) {
      throw new Error("Cannot initialize a deleted session");
    }
    if (this.initialized) return;
    initSchema(this.sql);
    this.initialized = true;
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();
    this.log = createLogger(
      "session-do",
      { session_id: sessionId },
      parseLogLevel(this.env.LOG_LEVEL)
    );
    // Constructed here rather than in the constructor so they (and the
    // WebSocket manager they force) capture the session-scoped logger,
    // never the request-scoped child installed by fetch().
    this.messenger = new SessionMessengerImpl(this.wsManager);
    this.diffService = new SessionDiffService(
      new SessionDiffStore(this.sql),
      this.repository,
      this.messenger,
      this.log
    );
    this.diffsHandler = new SessionDiffsHandler(this.diffService);
    this.wsManager.enableAutoPingPong();
  }

  /**
   * Handle incoming HTTP requests.
   */
  async fetch(request: Request): Promise<Response> {
    const fetchStart = performance.now();
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === SessionInternalPaths.purge) {
      const traceId = request.headers.get("x-trace-id");
      const requestId = request.headers.get("x-request-id");
      const correlationCtx: Record<string, unknown> = {};
      if (traceId) correlationCtx.trace_id = traceId;
      if (requestId) correlationCtx.request_id = requestId;
      const purgeLog = traceId || requestId ? this.log.child(correlationCtx) : this.log;
      return this.purgeSessionStorage(purgeLog);
    }

    if (this.purged) {
      return Response.json({ error: "Session deleted" }, { status: 410 });
    }

    this.ensureInitialized();
    const initMs = performance.now() - fetchStart;

    // Derive a request-scoped logger from correlation headers and thread it
    // explicitly to request-serving code. `this.log` stays session-scoped —
    // it is never reassigned per request, so nothing that captures it can
    // pin another request's correlation ids.
    const traceId = request.headers.get("x-trace-id");
    const requestId = request.headers.get("x-request-id");
    let requestLog = this.log;
    if (traceId || requestId) {
      const correlationCtx: Record<string, unknown> = {};
      if (traceId) correlationCtx.trace_id = traceId;
      if (requestId) correlationCtx.request_id = requestId;
      requestLog = this.log.child(correlationCtx);
    }

    // Ahead of every path that can verify a sandbox token — the bridge's
    // WebSocket connect and the internal verify endpoint alike — so no request
    // can be judged against a row that still holds its credential in the clear.
    await this.retireLegacySandboxAuthToken(requestLog);
    // Builds before credential revocation left hashes on dormant rows. They
    // authorize nothing, but clearing them makes the dormant record carry
    // metadata only and completes the migration whenever that session wakes.
    this.repository.revokeDormantSandboxCredentials();

    // WebSocket upgrade (special case - header-based, not path-based)
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request, url, requestLog);
    }

    // Match route from table
    const route = this.routes.find((r) => r.path === path && r.method === request.method);

    if (route) {
      const handlerStart = performance.now();
      let status = 500;
      let outcome: "success" | "error" = "error";
      try {
        const response = await route.handler(request, url, requestLog);
        status = response.status;
        outcome = status >= 500 ? "error" : "success";
        return response;
      } catch (e) {
        status = 500;
        outcome = "error";
        throw e;
      } finally {
        const handlerMs = performance.now() - handlerStart;
        const totalMs = performance.now() - fetchStart;
        requestLog.info("do.request", {
          event: "do.request",
          http_method: request.method,
          http_path: path,
          http_status: status,
          duration_ms: Math.round(totalMs * 100) / 100,
          init_ms: Math.round(initMs * 100) / 100,
          handler_ms: Math.round(handlerMs * 100) / 100,
          outcome,
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Handle WebSocket upgrade request. `log` is the request-scoped logger.
   */
  private async handleWebSocketUpgrade(request: Request, url: URL, log: Logger): Promise<Response> {
    log.debug("WebSocket upgrade requested");
    const isSandbox = url.searchParams.get("type") === "sandbox";

    // Validate sandbox authentication
    if (isSandbox) {
      const wsStartTime = Date.now();
      const authHeader = request.headers.get("Authorization");
      const sandboxId = request.headers.get("X-Sandbox-ID");
      const providedToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

      // Get expected values from DB
      const sandbox = this.getSandbox();
      const expectedSandboxId = sandbox?.modal_sandbox_id;

      // Reject connection if sandbox should be stopped (prevents reconnection after inactivity timeout).
      // Deliberately narrower than isDeadSandboxStatus: a "failed" sandbox may
      // still connect — a slow boot that outlived the connecting watchdog
      // self-heals here by flipping the status back to ready.
      if (sandbox?.status === "stopped" || sandbox?.status === "stale") {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "rejected",
          reject_reason: "sandbox_stopped",
          sandbox_status: sandbox.status,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Sandbox is stopped", { status: 410 });
      }

      // Validate sandbox ID first (catches stale sandboxes reconnecting after restore)
      if (expectedSandboxId && sandboxId !== expectedSandboxId) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "sandbox_id_mismatch",
          expected_sandbox_id: expectedSandboxId,
          sandbox_id: sandboxId,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Forbidden: Wrong sandbox ID", { status: 403 });
      }

      // Validate auth token
      const tokenMatches = await this.isValidSandboxToken(providedToken, sandbox);
      if (!tokenMatches) {
        log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "token_mismatch",
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Unauthorized: Invalid auth token", { status: 401 });
      }

      // Auth passed — continue to WebSocket accept below
      // The success ws.connect event is emitted after the WebSocket is accepted
    }

    try {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const sandboxId = request.headers.get("X-Sandbox-ID");

      if (isSandbox) {
        const { replaced } = this.wsManager.acceptAndSetSandboxSocket(
          server,
          sandboxId ?? undefined
        );

        // Notify manager that sandbox connected so it can reset the spawning flag
        this.lifecycleManager.onSandboxConnected();
        this.updateSandboxStatus("ready");
        this.broadcast({ type: "sandbox_status", status: "ready" });

        // Set initial activity timestamp and schedule inactivity check
        // IMPORTANT: Must await to ensure alarm is scheduled before returning
        const now = Date.now();
        this.updateLastActivity(now);
        await this.scheduleInactivityCheck();

        log.info("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "success",
          sandbox_id: sandboxId,
          replaced_existing: replaced,
          duration_ms: Date.now() - now,
        });

        // Process any pending messages now that sandbox is connected
        this.processMessageQueue();
      } else {
        const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        this.wsManager.acceptClientSocket(server, wsId);
        this.ctx.waitUntil(this.wsManager.enforceAuthTimeout(server, wsId));
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      log.error("WebSocket upgrade failed", {
        error: error instanceof Error ? error : String(error),
      });
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  /**
   * Handle WebSocket message (with hibernation support).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.purged) return;
    this.ensureInitialized();
    if (typeof message !== "string") return;

    const { kind } = this.wsManager.classify(ws);
    if (kind === "sandbox") {
      await this.handleSandboxMessage(ws, message);
    } else {
      await this.handleClientMessage(ws, message);
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (this.purged) return;
    this.ensureInitialized();
    const socket = this.wsManager.classify(ws);
    const { kind } = socket;

    try {
      if (kind === "sandbox") {
        const wasActive = this.wsManager.clearSandboxSocketIfMatch(ws);
        if (!wasActive) {
          // sandboxWs points to a different socket — this close is for a replaced connection.
          this.log.debug("Ignoring close for replaced sandbox socket", { code });
          return;
        }

        const currentSandboxId = this.getSandbox()?.modal_sandbox_id;
        if (socket.sandboxId && currentSandboxId && socket.sandboxId !== currentSandboxId) {
          // A new generation was minted before the old bridge finished its
          // close handshake. That old close must not stop the new generation
          // or revoke the fresh hashes it has not used yet.
          this.log.debug("Ignoring close for retired sandbox generation", {
            closed_sandbox_id: socket.sandboxId,
            current_sandbox_id: currentSandboxId,
          });
          return;
        }

        const isNormalClose = code === 1000 || code === 1001;
        if (isNormalClose) {
          this.updateSandboxStatus("stopped");
        } else {
          // Abnormal close (e.g., 1006): leave status unchanged so the bridge can reconnect.
          // Schedule a heartbeat check to detect truly dead sandboxes.
          this.log.warn("Sandbox WebSocket abnormal close", {
            event: "sandbox.abnormal_close",
            code,
            reason,
          });
          await this.lifecycleManager.scheduleDisconnectCheck();
        }
      } else {
        const client = this.wsManager.removeClient(ws);
        if (client) {
          // If the participant still has other authenticated sockets (e.g. another
          // browser tab), don't send presence_leave — the client filters by userId
          // and would remove them entirely. Broadcast a refresh instead.
          const stillPresent = Array.from(this.wsManager.getAuthenticatedClients()).some(
            (c) => c.participantId === client.participantId
          );
          if (stillPresent) {
            this.presenceService.broadcastPresence();
          } else {
            this.broadcast({ type: "presence_leave", userId: client.userId });
          }
        }
      }
    } finally {
      // Reciprocate the peer close to complete the WebSocket close handshake.
      this.wsManager.close(ws, code, reason);
    }
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    if (this.purged) return;
    this.ensureInitialized();
    this.log.error("WebSocket error", { error });
    ws.close(1011, "Internal error");
  }

  /**
   * Durable Object alarm handler.
   *
   * Checks for stuck processing messages (defense-in-depth execution timeout)
   * BEFORE delegating to the lifecycle manager for inactivity and heartbeat
   * monitoring. This ensures stuck messages are failed even when the sandbox
   * is already dead and handleAlarm() returns early.
   */
  async alarm(): Promise<void> {
    if (this.purged) return;
    this.ensureInitialized();
    await this.alarmHandler.handle();
  }

  /**
   * Update the last activity timestamp.
   * Delegates to the lifecycle manager.
   */
  private updateLastActivity(timestamp: number): void {
    this.lifecycleManager.updateLastActivity(timestamp);
  }

  /**
   * Schedule the inactivity check alarm.
   * Delegates to the lifecycle manager.
   */
  private async scheduleInactivityCheck(): Promise<void> {
    await this.lifecycleManager.scheduleInactivityCheck();
  }

  /**
   * Handle messages from sandbox.
   */
  private async handleSandboxMessage(ws: WebSocket, message: string): Promise<void> {
    const event = this.parseWebSocketMessage(message, "sandbox", sandboxEventSchema);
    if (!event) return;

    try {
      await this.processSandboxEvent(event);
    } catch (e) {
      this.log.error("Error processing sandbox message", {
        error: e instanceof Error ? e : String(e),
      });
    }
  }

  /**
   * Handle messages from clients.
   */
  private async handleClientMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const data = this.parseWebSocketMessage(message, "client", clientMessageSchema);
      if (!data) {
        this.safeSend(ws, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Failed to process message",
        });
        return;
      }

      switch (data.type) {
        case "ping":
          this.safeSend(ws, { type: "pong", timestamp: Date.now() });
          break;

        case "subscribe":
          await this.handleSubscribe(ws, data);
          break;

        case "prompt":
          await this.handlePromptMessage(ws, data);
          break;

        case "stop":
          if (!this.requireSubscribedClient(ws)) break;
          await this.stopExecution();
          break;

        case "typing":
          if (!this.requireSubscribedClient(ws)) break;
          await this.presenceService.handleTyping();
          break;

        case "fetch_history":
          this.handleFetchHistory(ws, data);
          break;

        case "presence":
          this.presenceService.updatePresence(ws, data);
          break;
      }
    } catch (e) {
      this.log.error("Error processing client message", {
        error: e instanceof Error ? e : String(e),
      });
      this.safeSend(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Failed to process message",
      });
    }
  }

  private parseWebSocketMessage<T>(
    message: string,
    boundary: "client" | "sandbox",
    schema: BoundarySchema<T>
  ): T | null {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch (e) {
      this.log.error("Invalid WebSocket JSON", {
        boundary,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      this.log.warn("Invalid WebSocket message", {
        boundary,
        issues: result.error.issues,
      });
      return null;
    }

    return result.data;
  }

  /**
   * Handle client subscription with token validation.
   */
  private async handleSubscribe(
    ws: WebSocket,
    data: { token: string; clientId: string }
  ): Promise<void> {
    // Validate the WebSocket auth token
    if (!data.token) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "no_token",
      });
      ws.close(4001, "Authentication required");
      return;
    }

    // Hash the incoming token and look up participant
    const tokenHash = await hashToken(data.token);
    const participant = this.participantService.getByWsTokenHash(tokenHash);

    if (!participant) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "invalid_token",
      });
      ws.close(4001, "Invalid authentication token");
      return;
    }

    // Reject tokens older than the TTL
    if (
      participant.ws_token_created_at === null ||
      Date.now() - participant.ws_token_created_at > WS_TOKEN_TTL_MS
    ) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "token_expired",
        participant_id: participant.id,
        user_id: participant.user_id,
      });
      ws.close(4001, "Token expired");
      return;
    }

    this.log.info("ws.connect", {
      event: "ws.connect",
      ws_type: "client",
      outcome: "success",
      participant_id: participant.id,
      user_id: participant.user_id,
      client_id: data.clientId,
    });

    // Build client info from participant data
    const clientInfo: ClientInfo = {
      participantId: participant.id,
      userId: participant.user_id,
      name: resolveParticipantName(participant),
      avatar: getAvatarUrl(participant.scm_login, resolveScmProviderFromEnv(this.env.SCM_PROVIDER)),
      status: "active",
      lastSeen: Date.now(),
      clientId: data.clientId,
      ws,
    };

    this.wsManager.setClient(ws, clientInfo);

    const parsed = this.wsManager.classify(ws);
    if (parsed.kind === "client" && parsed.wsId) {
      this.wsManager.persistClientMapping(parsed.wsId, participant.id, data.clientId);
      this.log.debug("Stored ws_client_mapping", {
        ws_id: parsed.wsId,
        participant_id: participant.id,
      });
    }

    // Gather session state and replay events, then send as a single message.
    // Fetch sandbox once and thread it through to avoid a redundant SQLite read.
    const sandbox = this.getSandbox();
    const state = await this.getSessionState(sandbox);
    const artifacts = this.messageService.listArtifacts();
    const replay = this.eventStream.getReplay();

    this.safeSend(ws, {
      type: "subscribed",
      sessionId: state.id,
      state,
      artifacts: artifacts.artifacts,
      participantId: participant.id,
      participant: {
        participantId: participant.id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(
          participant.scm_login,
          resolveScmProviderFromEnv(this.env.SCM_PROVIDER)
        ),
      },
      replay,
      spawnError: sandbox?.last_spawn_error ?? null,
    } as ServerMessage);

    // Send current presence
    this.presenceService.sendPresence(ws);

    // Notify others
    this.presenceService.broadcastPresence();

    // Read-through backstop (design §5.3): opening the session refreshes its
    // PR state from the provider; changes arrive as artifact_updated.
    this.schedulePullRequestRefresh("open");
  }

  /**
   * Resolve the subscriber behind a socket, refusing the command if there is none.
   *
   * A client socket is accepted before it proves anything, because the token
   * arrives in the `subscribe` frame rather than the upgrade. Every command that
   * acts on the session therefore has to ask who is sending it; the socket being
   * open is not an answer. `ping` and `subscribe` are the only two that may run
   * unattributed, since one carries the proof and the other carries nothing.
   */
  private requireSubscribedClient(ws: WebSocket): ClientInfo | null {
    const client = this.getClientInfo(ws);
    if (!client) {
      this.safeSend(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return null;
    }
    return client;
  }

  /**
   * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
   */
  private getClientInfo(ws: WebSocket): ClientInfo | null {
    // 1. In-memory cache (manager)
    const cached = this.wsManager.getClient(ws);
    if (cached) return cached;

    // 2. DB recovery (manager handles tag parsing + DB lookup)
    const mapping = this.wsManager.recoverClientMapping(ws);
    if (!mapping) {
      this.log.warn("No client mapping found after hibernation, closing WebSocket");
      this.wsManager.close(ws, 4002, "Session expired, please reconnect");
      return null;
    }

    // 3. Build ClientInfo (DO owns domain logic)
    this.log.info("Recovered client info from DB", { user_id: mapping.user_id });
    const clientInfo: ClientInfo = {
      participantId: mapping.participant_id,
      userId: mapping.user_id,
      name: resolveParticipantName(mapping),
      avatar: getAvatarUrl(mapping.scm_login, resolveScmProviderFromEnv(this.env.SCM_PROVIDER)),
      status: "active",
      lastSeen: Date.now(),
      clientId: mapping.client_id || `client-${Date.now()}`,
      ws,
    };

    // 4. Re-cache
    this.wsManager.setClient(ws, clientInfo);
    return clientInfo;
  }

  /**
   * Handle prompt message from client.
   */
  private async handlePromptMessage(
    ws: WebSocket,
    data: {
      content: string;
      model?: string;
      reasoningEffort?: string;
      attachments?: SessionAttachmentReference[];
    }
  ): Promise<void> {
    const client = this.getClientInfo(ws);
    if (!client) {
      this.safeSend(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    await this.messageQueue.handlePromptMessage(ws, client, data);
  }

  /**
   * Handle fetch_history request from client for paginated history loading.
   */
  private handleFetchHistory(
    ws: WebSocket,
    data: { cursor?: { timestamp: number; id: string }; limit?: number }
  ): void {
    const client = this.getClientInfo(ws);
    if (!client) {
      this.safeSend(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    // Validate cursor
    if (
      !data.cursor ||
      typeof data.cursor.timestamp !== "number" ||
      typeof data.cursor.id !== "string"
    ) {
      this.safeSend(ws, {
        type: "error",
        code: "INVALID_CURSOR",
        message: "Invalid cursor",
      });
      return;
    }

    // Rate limit: reject if < 200ms since last fetch
    const now = Date.now();
    if (client.lastFetchHistoryAt && now - client.lastFetchHistoryAt < 200) {
      this.safeSend(ws, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many requests",
      });
      return;
    }
    client.lastFetchHistoryAt = now;

    const page = this.eventStream.getHistoryPage({
      cursor: data.cursor,
      limit: data.limit,
    });

    this.safeSend(ws, {
      type: "history_page",
      items: page.items,
      hasMore: page.hasMore,
      cursor: page.cursor,
    } as ServerMessage);
  }

  /**
   * Process sandbox event.
   */
  private async processSandboxEvent(event: SandboxEvent): Promise<void> {
    await this.sandboxEventProcessor.processSandboxEvent(event);
  }

  /**
   * Push a branch to remote via the sandbox.
   * Sends push command to sandbox and waits for completion or error.
   *
   * @returns Success result or error message
   */
  private async pushBranchToRemote(
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    return await this.sandboxEventProcessor.pushBranchToRemote(pushSpec);
  }

  /**
   * Warm sandbox proactively.
   * Delegates to the lifecycle manager.
   */
  private async warmSandbox(): Promise<void> {
    await this.lifecycleManager.warmSandbox();
  }

  /**
   * Process message queue.
   */
  private async processMessageQueue(): Promise<void> {
    await this.messageQueue.processMessageQueue();
  }

  /**
   * Spawn a sandbox via Modal.
   * Delegates to the lifecycle manager.
   */
  private async spawnSandbox(): Promise<void> {
    await this.lifecycleManager.spawnSandbox();
  }

  /**
   * Stop current execution.
   * Marks the processing message as failed, upserts synthetic execution_complete,
   * broadcasts synthetic execution_complete
   * so all clients flush buffered tokens, and forwards stop to the sandbox.
   */
  private async stopExecution(options?: { suppressStatusReconcile?: boolean }): Promise<void> {
    await this.messageQueue.stopExecution(options);
  }

  /**
   * Broadcast message to all authenticated clients.
   */
  private broadcast(message: ServerMessage): void {
    this.messenger.broadcast(message);
  }

  private getPublicSessionId(session?: SessionRow | null): string {
    const resolved = session ?? this.getSession();
    return resolved?.session_name || resolved?.id || this.ctx.id.toString();
  }

  private syncSessionIndexTitle(sessionId: string, title: string, updatedAt: number): void {
    if (!this.db) return;
    const sessionStore = new SessionIndexStore(this.db);
    this.ctx.waitUntil(
      sessionStore.updateTitleIfNewer(sessionId, title, updatedAt).catch((error) => {
        this.log.error("session_index.update_title.background_error", {
          session_id: sessionId,
          title,
          updated_at: updatedAt,
          error,
        });
      })
    );
  }

  private applySessionTitleUpdate(
    title: string,
    options: SessionTitleUpdateOptions = {}
  ): SessionTitleUpdateResult {
    const normalized = normalizeSessionTitle(title);
    if (!normalized.ok) {
      return { ok: false, reason: "invalid", error: normalized.error };
    }
    const titleText = normalized.title;

    const session = this.getSession();
    if (!session) {
      return { ok: false, reason: "not_found", error: "Session not found" };
    }

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    if (options.onlyIfUnset) {
      const didUpdate = this.repository.updateSessionTitleIfUnset(session.id, titleText, updatedAt);
      if (!didUpdate) {
        return { ok: false, reason: "already_set", error: "Session title is already set" };
      }
    } else {
      this.repository.updateSessionTitle(session.id, titleText, updatedAt);
    }

    const publicSessionId = this.getPublicSessionId(session);
    this.syncSessionIndexTitle(publicSessionId, titleText, updatedAt);
    this.broadcast({ type: "session_title", title: titleText });

    if (session.parent_session_id) {
      this.statusService.notifyParentOfChildUpdate(
        { ...session, title: titleText },
        publicSessionId,
        {
          status: session.status,
          title: titleText,
        }
      );
    }

    return { ok: true, title: titleText };
  }

  /**
   * Get current session state.
   * Accepts an optional pre-fetched sandbox row to avoid a redundant SQLite read.
   */
  private async getSessionState(sandbox?: SandboxRow | null): Promise<SessionState> {
    const session = this.getSession();
    sandbox ??= this.getSandbox();
    const messageCount = this.repository.getMessageCount();
    const isProcessing = this.getIsProcessing();

    // Decrypt code-server password if stored encrypted
    let codeServerPassword: string | null = sandbox?.code_server_password ?? null;
    if (codeServerPassword && this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      try {
        codeServerPassword = await decryptToken(
          codeServerPassword,
          this.env.REPO_SECRETS_ENCRYPTION_KEY,
          sandboxSecretContext(this.ctx.id.toString(), "code_server_password")
        );
      } catch {
        // Key mismatch or corruption — don't leak ciphertext to clients
        codeServerPassword = null;
      }
    }

    // Decrypt ttyd token if stored encrypted
    let ttydToken: string | null = sandbox?.ttyd_token ?? null;
    if (ttydToken && this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      try {
        ttydToken = await decryptToken(
          ttydToken,
          this.env.REPO_SECRETS_ENCRYPTION_KEY,
          sandboxSecretContext(this.ctx.id.toString(), "ttyd_token")
        );
      } catch {
        ttydToken = null;
      }
    }

    // Environment provenance: the id is stored on the session; the name is
    // resolved live (resolveEnvironmentName) so a deleted environment surfaces
    // as null — the UI renders "environment deleted" (§7.6).
    const environmentId = session?.environment_id ?? null;
    const environmentName = await this.resolveEnvironmentName(environmentId);

    return {
      id: this.getPublicSessionId(session),
      title: session?.title ?? null,
      repoOwner: session?.repo_owner ?? null,
      repoName: session?.repo_name ?? null,
      baseBranch: session?.base_branch ?? null,
      branchName: session?.branch_name ?? null,
      status: session?.status ?? "created",
      sandboxStatus: sandbox?.status ?? "pending",
      messageCount,
      createdAt: session?.created_at ?? Date.now(),
      model: session?.model ?? DEFAULT_MODEL,
      reasoningEffort: session?.reasoning_effort ?? undefined,
      isProcessing,
      parentSessionId: session?.parent_session_id ?? null,
      totalCost: session?.total_cost ?? 0,
      codeServerUrl: sandbox?.code_server_url ?? null,
      codeServerPassword,
      tunnelUrls: sandbox?.tunnel_urls ? this.safeParseTunnelUrls(sandbox.tunnel_urls) : null,
      ttydUrl: sandbox?.ttyd_url ?? null,
      ttydToken,
      sandboxDashboardUrl: null,
      repositories: this.getSessionRepositoryStates(session),
      environmentId,
      environmentName,
      outpostId: this.getExecutionOutpostId(session),
    };
  }

  /**
   * The outpost this session executes on, or null when it runs on a
   * provisioned sandbox.
   *
   * A session pinned at creation carries its own target. An unpinned session
   * only executes on a machine when the deployment's sandbox backend is the
   * outpost backend, in which case the pinned-less target is the deployment's
   * configured outpost — the same fallback the provider applies when it hands
   * the session to the homestead.
   */
  private getExecutionOutpostId(session: SessionRow | null): string | null {
    if (session?.outpost_id) return session.outpost_id;
    if (resolveSandboxBackendName(this.env.SANDBOX_PROVIDER) !== "outpost") return null;
    return this.env.OUTPOST_TARGET_ID ?? null;
  }

  /**
   * The launch environment's current display name, or null when the session has
   * no environment or the environment was deleted after launch (§7.6). Resolved
   * live rather than snapshotted so deletion is reflected; best-effort, so a
   * lookup failure resolves null rather than failing the whole state read.
   */
  private async resolveEnvironmentName(environmentId: string | null): Promise<string | null> {
    if (!environmentId || !this.db) {
      return null;
    }
    try {
      const environment = await new EnvironmentStore(this.db).getById(environmentId);
      return environment?.name ?? null;
    } catch (e) {
      this.log.warn("Failed to resolve environment name for session state", {
        environment_id: environmentId,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Member repositories for SessionState, in position order (see
   * buildSessionRepositories for the scalar-mirror fallback). Members synthesized
   * from the scalars — and member rows written before per-repo git state
   * existed, whose git columns are null while the scalars are set — have the
   * primary entry overlaid with the session scalars.
   */
  private getSessionRepositoryStates(session: SessionRow | null): SessionRepositoryState[] {
    const prUrlForRepo = this.getPrUrlLookup();
    return this.repository.getSessionRepositories().map((member) => ({
      position: member.position,
      repoOwner: member.repoOwner,
      repoName: member.repoName,
      repoId: member.row ? member.row.repo_id : (session?.repo_id ?? null),
      baseBranch: member.baseBranch ?? "main",
      branchName:
        member.row?.branch_name ?? (member.isPrimary ? (session?.branch_name ?? null) : null),
      baseSha: member.row?.base_sha ?? (member.isPrimary ? (session?.base_sha ?? null) : null),
      currentSha:
        member.row?.current_sha ?? (member.isPrimary ? (session?.current_sha ?? null) : null),
      prUrl: prUrlForRepo(member.repoOwner, member.repoName, member.isPrimary),
    }));
  }

  /** Per-repo PR URL lookup over the session's PR artifacts. */
  private getPrUrlLookup(): (
    repoOwner: string,
    repoName: string,
    isPrimary: boolean
  ) => string | null {
    const artifacts = this.repository.listArtifacts().filter((artifact) => artifact.url !== null);
    return (repoOwner, repoName, isPrimary) =>
      findPrArtifactForRepo(artifacts, { repoOwner, repoName }, isPrimary)?.url ?? null;
  }

  /**
   * Check if any message is currently being processed.
   */
  private getIsProcessing(): boolean {
    return this.repository.getProcessingMessage() !== null;
  }

  private safeParseTunnelUrls(raw: string): Record<string, string> | null {
    const urls = parseTunnelUrls(raw);
    if (!urls) {
      this.log.warn("Invalid sandbox tunnel_urls JSON");
    }
    return urls;
  }

  // Database helpers

  private getSession(): SessionRow | null {
    return this.repository.getSession();
  }

  private getSandbox(): SandboxRow | null {
    return this.repository.getSandbox();
  }

  private async ensureRepoId(session: SessionRow): Promise<number> {
    if (session.repo_id) {
      return session.repo_id;
    }
    if (!session.repo_owner || !session.repo_name) {
      throw new Error("Session has no repository context");
    }

    const result = await this.sourceControlProvider.checkRepositoryAccess({
      owner: session.repo_owner,
      name: session.repo_name,
    });
    if (!result) {
      throw new Error("Repository is not accessible for the configured SCM provider");
    }

    this.repository.updateSessionRepoId(result.repoId);
    return result.repoId;
  }

  /**
   * Verify a provided sandbox token against the stored hash.
   *
   * The hash is the only accepted credential. There was a fallback here that
   * compared a legacy plaintext `auth_token` column when no hash was present;
   * it is gone. This verifier gates the session's whole bridge surface — PR
   * creation, media upload, child-session spawn, Slack notification — and now
   * the credential-fetch route as well, so a comparison against a value stored
   * in the clear is not an acceptable second path to any of it.
   *
   * Rows that only had the plaintext column are not broken by the removal:
   * {@link retireLegacySandboxAuthToken} converts them to a hash of the same
   * token before this method can be reached, so the credential the bridge
   * already holds keeps working.
   */
  private async isValidSandboxToken(
    token: string | null,
    sandbox: SandboxRow | null
  ): Promise<boolean> {
    if (!token || !sandbox || !sandbox.auth_token_hash) {
      return false;
    }

    const tokenHash = await hashToken(token);
    return timingSafeEqual(tokenHash, sandbox.auth_token_hash);
  }

  /**
   * Verify a provided model-credential fetch token.
   *
   * A separate column, compared separately, with no fallback to the bridge
   * token's hash. The bridge token also authorizes PR creation, media upload,
   * child-session spawn and Slack notification; the harness process holds this
   * one instead, so anything that leaks out of the agent buys a key fetch for
   * one session and nothing more. A sandbox row minted before the column
   * existed has no fetch token, and refusing is the honest answer — the
   * alternative is accepting the wider credential in its place, which is the
   * substitution this change exists to remove.
   */
  private async isValidCredentialFetchToken(
    token: string | null,
    sandbox: SandboxRow | null
  ): Promise<boolean> {
    if (!token || !sandbox || !sandbox.credential_fetch_token_hash) {
      return false;
    }

    const tokenHash = await hashToken(token);
    return timingSafeEqual(tokenHash, sandbox.credential_fetch_token_hash);
  }

  /**
   * Give a restarted homestead fresh credentials for the exact generation it
   * was already serving.
   *
   * The repository performs the generation, status, and prior-live-credential
   * checks in the same statement that replaces both hashes. A stopped or
   * already-revoked generation cannot be revived through this endpoint. A
   * generation that merely went stale can, because losing a heartbeat is not
   * the same as being finished.
   */
  /**
   * Erases everything this session holds.
   *
   * Reached only from the public DELETE route, which does the ownership check
   * first: this endpoint takes no arguments and refuses nothing, because the
   * caller has already decided. It runs without `ensureInitialized` on purpose
   * — a session that never finished starting still has storage to release, and
   * initializing one in order to delete it would be absurd.
   */
  private async purgeSessionStorage(log: Logger): Promise<Response> {
    if (this.purged) {
      return Response.json({ purged: true, objectsDeleted: 0, objectsFailed: 0 });
    }

    const result = await purgeSessionStorage({
      storage: this.ctx.storage,
      sockets: {
        forEachClientSocket: (_mode, fn) => this.ctx.getWebSockets().forEach(fn),
        getSandboxSocket: () => null,
        close: (ws, code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            // WebSocket may already be closed.
          }
        },
      },
      objectKeys: () =>
        collectSessionObjectKeys({
          attachmentObjectKeys: this.attachmentRepository.listObjectKeys(),
          artifactUrls: this.repository.listArtifacts().map((artifact) => artifact.url),
        }),
      // A deployment with no media bucket bound still purges everything else.
      objects: this.env.MEDIA_BUCKET ? createMediaObjectStorage(this.env) : null,
      log,
    });
    this.purged = true;
    return Response.json(result);
  }

  private async rotateSandboxCredentialsForRecovery(
    request: Request,
    log: Logger
  ): Promise<Response> {
    const parsed = homesteadRecoveryRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid or unsupported recovery request" }, { status: 400 });
    }

    const sandboxAuthToken = generateId();
    const credentialFetchToken = generateId();
    const [authTokenHash, credentialFetchTokenHash] = await Promise.all([
      hashToken(sandboxAuthToken),
      hashToken(credentialFetchToken),
    ]);
    const rotated =
      this.repository.rotateSandboxCredentials({
        sandboxId: parsed.data.sandboxId,
        authTokenHash,
        credentialFetchTokenHash,
      }) ||
      // A generation that went stale had its credentials revoked, so rotation
      // finds nothing to replace. It is still a live session the homestead was
      // serving, and refusing here is what left a lost heartbeat permanently
      // unrecoverable.
      this.repository.reviveStaleSandboxCredentials({
        sandboxId: parsed.data.sandboxId,
        authTokenHash,
        credentialFetchTokenHash,
      });
    if (!rotated) {
      log.warn("Homestead restart recovery refused", {
        event: "sandbox.recovery_refused",
        sandbox_id: parsed.data.sandboxId,
      });
      return Response.json(
        { error: "Session generation is not active or no longer recoverable" },
        { status: 409 }
      );
    }

    log.info("Homestead restart credentials rotated", {
      event: "sandbox.recovery_credentials_rotated",
      sandbox_id: parsed.data.sandboxId,
    });
    return Response.json(
      {
        recoveryVersion: HOMESTEAD_RECOVERY_VERSION,
        productSessionId: parsed.data.productSessionId,
        sandboxId: parsed.data.sandboxId,
        sandboxAuthToken,
        credentialFetchToken,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  /**
   * Convert a surviving pre-hash plaintext sandbox token into a hash before
   * anything can try to authenticate with it.
   *
   * This is not a schema migration because it cannot be: hashing is async and
   * the Durable Object's migration runner is synchronous. It is also not
   * something a D1 migration could reach — the row lives in this session's own
   * SQLite, and there is no way to enumerate every session DO.
   *
   * Run on every request rather than memoized per instance. The steady-state
   * cost is one two-column read of a single-row table, and in exchange the
   * property is unconditional: at the moment any token is checked, no row in
   * this session holds a credential in the clear. A per-instance flag would
   * make that depend on how long the object had been awake, which is exactly
   * the kind of "usually true" security property worth avoiding.
   *
   * `COALESCE` in the write keeps an existing hash, so a row carrying both a
   * stale plaintext value and a current hash is emptied without its live
   * credential being replaced by the dead one.
   */
  private async retireLegacySandboxAuthToken(log: Logger): Promise<void> {
    const stored = this.repository.getLegacySandboxAuthToken();
    if (!stored?.auth_token) return;

    const hadHash = Boolean(stored.auth_token_hash);
    const hash = await hashToken(stored.auth_token);
    this.repository.retireLegacySandboxAuthToken(hash);
    log.warn("Retired plaintext sandbox auth token", {
      event: "sandbox.legacy_auth_token_retired",
      // False means this session's bridge was still authenticating against a
      // token stored in the clear until this moment, and now authenticates
      // against the hash of the same token — nothing the bridge holds changes.
      already_hashed: hadHash,
    });
  }

  private updateSandboxStatus(status: string): void {
    this.repository.updateSandboxStatus(status as SandboxStatus);
  }

  // HTTP handlers

  private parseArtifactMetadata(
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ): Record<string, unknown> | null {
    if (!artifact.metadata) {
      return null;
    }

    try {
      return JSON.parse(artifact.metadata) as Record<string, unknown>;
    } catch (error) {
      this.log.warn("Invalid artifact metadata JSON", {
        artifact_id: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
