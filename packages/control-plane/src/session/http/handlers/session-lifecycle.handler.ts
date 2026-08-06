import type { EncryptionContext } from "../../../auth/crypto";
import { scmOAuthContext } from "../../../auth/encryption-contexts";
import type { Logger } from "../../../logger";
import type { ParticipantRow, SandboxRow, SessionRow } from "../../types";
import {
  DEFAULT_MODEL,
  isModelReference,
  isValidModel,
  normalizeModelId,
  type RepositoryRef,
  type SandboxSettings,
} from "@open-inspect/shared";
import type { SandboxStatus, SessionStatus, SpawnSource } from "../../../types";
import type { SessionRepository } from "../../repository";
import type { SessionStatusService } from "../../session-status-service";
import {
  normalizeSessionTitle,
  type SessionTitleUpdateOptions,
  type SessionTitleUpdateResult,
} from "../../title";
import { z } from "zod";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "archived", "cancelled", "failed"]);

/**
 * Request body for the /internal/init endpoint.
 * The router constructs this from SessionInitInput — see session/initialize.ts.
 * Note: `userId` here is the participantUserId from SessionInitInput.
 */
interface InitRequest {
  sessionName: string;
  repoOwner: string | null;
  repoName: string | null;
  repoId?: number | null;
  defaultBranch?: string | null;
  branch?: string | null;
  /**
   * Ordered member list ([0] = primary, matching the scalar fields).
   * initialize.ts always sends it for repository sessions (synthesizing a
   * one-entry list for scalar callers) and an empty list for repo-less ones.
   */
  repositories?: RepositoryRef[];
  /** Launch environment provenance; null for repo-launched/ad-hoc sessions. */
  environmentId?: string | null;
  /** Pinned outpost execution target; null uses the deployment default. */
  outpostId?: string | null;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  userId: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  scmToken?: string | null;
  scmTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
  scmUserId?: string | null;
  parentSessionId?: string | null;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  codeServerEnabled?: boolean;
  sandboxSettings?: SandboxSettings;
}

export interface SessionLifecycleHandlerDeps {
  repository: Pick<
    SessionRepository,
    "upsertSession" | "replaceSessionRepositories" | "createSandbox" | "createParticipant"
  >;
  getDurableObjectId: () => string;
  tokenEncryptionKey?: string;
  /**
   * Seal a plaintext SCM token for this participant. The context binds it to
   * the SCM identity it belongs to, so it cannot later be read out of another
   * user's participant row.
   */
  encryptToken: (
    token: string,
    encryptionKey: string,
    context: EncryptionContext
  ) => Promise<string>;
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  generateId: (bytes?: number) => string;
  now: () => number;
  scheduleWarmSandbox: () => void;
  getSession: () => SessionRow | null;
  getSandbox: () => SandboxRow | null;
  getPublicSessionId: (session: SessionRow) => string;
  getParticipantByUserId: (userId: string) => ParticipantRow | null;
  statusService: SessionStatusService;
  applySessionTitleUpdate: (
    title: string,
    options?: SessionTitleUpdateOptions
  ) => SessionTitleUpdateResult;
  stopExecution: (options?: { suppressStatusReconcile?: boolean }) => Promise<void>;
  getSandboxSocket: () => WebSocket | null;
  sendToSandbox: (ws: WebSocket, message: string | object) => boolean;
  updateSandboxStatus: (status: SandboxStatus) => void;
}

function sessionTitleUpdateStatus(
  result: Extract<SessionTitleUpdateResult, { ok: false }>
): 400 | 404 | 409 {
  switch (result.reason) {
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "already_set":
      return 409;
  }
}

export interface SessionLifecycleHandler {
  init: (request: Request, log: Logger) => Promise<Response>;
  getState: () => Response;
  updateTitle: (request: Request) => Promise<Response>;
  archive: (request: Request) => Promise<Response>;
  unarchive: (request: Request) => Promise<Response>;
  cancel: () => Promise<Response>;
}

function parseUserIdBody(body: unknown): { userId?: string } {
  return body as { userId?: string };
}

const titleUpdateBodySchema = z.object({
  userId: z.string().optional(),
  title: z.string().optional(),
});

type TitleUpdateBody = z.infer<typeof titleUpdateBodySchema>;

export function createSessionLifecycleHandler(
  deps: SessionLifecycleHandlerDeps
): SessionLifecycleHandler {
  return {
    async init(request: Request, log: Logger): Promise<Response> {
      const body = (await request.json()) as InitRequest;

      const sessionId = deps.getDurableObjectId();
      const sessionName = body.sessionName;
      const now = deps.now();
      const repoOwner = body.repoOwner?.trim() || null;
      const repoName = body.repoName?.trim() || null;
      const hasRepoOwner = repoOwner !== null;
      const hasRepoName = repoName !== null;
      const hasRepoId = body.repoId != null;
      if (
        hasRepoOwner !== hasRepoName ||
        (!hasRepoOwner && hasRepoId) ||
        (hasRepoOwner && !hasRepoId)
      ) {
        return Response.json(
          { error: "Repository context must include repoOwner, repoName, and repoId together" },
          { status: 400 }
        );
      }

      let encryptedToken = body.scmTokenEncrypted ?? null;
      if (body.scmToken && deps.tokenEncryptionKey) {
        if (!body.scmUserId) {
          // Nothing to bind the ciphertext to. Storing it unbound would make it
          // relocatable onto any other participant row, so the token is
          // dropped and said so rather than stored weaker than the rest.
          log.error("Refusing to store SCM token with no SCM user id to bind it to");
        } else {
          try {
            encryptedToken = await deps.encryptToken(
              body.scmToken,
              deps.tokenEncryptionKey,
              scmOAuthContext(body.scmUserId, "access_token")
            );
            log.debug("Encrypted SCM token for storage");
          } catch (error) {
            log.error("Failed to encrypt SCM token", {
              error: error instanceof Error ? error : String(error),
            });
          }
        }
      }

      // The model arrives already resolved: whichever route created this
      // session checked it against the homestead catalog or the hardcoded list and
      // refused by name if it did not hold up. Re-checking it here against the
      // hardcoded list is what rewrote a legitimate homestead-catalog model to the
      // deployment default, silently, on the way into storage. So it is stored
      // as given, and only an id that names no provider at all — which nothing
      // downstream could route — is refused.
      let model: string;
      if (body.model) {
        if (!isModelReference(body.model)) {
          return Response.json(
            {
              error:
                `Invalid model "${body.model}": expected "provider/model-id". ` +
                "The session was not created.",
            },
            { status: 400 }
          );
        }
        model = normalizeModelId(body.model);
      } else {
        // The one place a default is the right answer: nobody chose a model.
        // Logged so that "which model is this session on, and who decided" is
        // always answerable from the record.
        model = DEFAULT_MODEL;
        log.info("Session created with no model; applying the product default", {
          default_model: model,
        });
      }

      // The hardcoded catalog only gets to judge the effort for models it
      // actually names. For anything else — a model a homestead offers that this
      // package has never heard of — the effort is stored as chosen and the
      // harness is the one that accepts or refuses it, by name.
      const reasoningEffort = isValidModel(model)
        ? deps.validateReasoningEffort(model, body.reasoningEffort)
        : (body.reasoningEffort ?? null);
      const baseBranch = hasRepoOwner ? body.branch || body.defaultBranch || "main" : null;

      const repositories = body.repositories ?? [];
      if (repositories.length > 0) {
        const primary = repositories[0];
        if (
          !hasRepoOwner ||
          primary.repoOwner !== repoOwner ||
          primary.repoName !== repoName ||
          primary.repoId !== body.repoId ||
          primary.baseBranch !== baseBranch
        ) {
          return Response.json(
            { error: "repositories[0] must match the scalar repository mirror" },
            { status: 400 }
          );
        }
      } else if (hasRepoOwner && body.repositories !== undefined) {
        // An explicit empty list alongside scalar context is a producer bug —
        // initialize.ts synthesizes a one-entry list for scalar callers.
        return Response.json(
          { error: "repositories must include the scalar repository" },
          { status: 400 }
        );
      }

      deps.repository.upsertSession({
        id: sessionId,
        sessionName,
        title: body.title ?? null,
        repoOwner,
        repoName,
        repoId: hasRepoOwner ? body.repoId : null,
        baseBranch,
        model,
        reasoningEffort,
        status: "created",
        parentSessionId: body.parentSessionId ?? null,
        spawnSource: body.spawnSource ?? "user",
        spawnDepth: body.spawnDepth ?? 0,
        codeServerEnabled: body.codeServerEnabled ?? false,
        sandboxSettings: body.sandboxSettings ? JSON.stringify(body.sandboxSettings) : null,
        environmentId: body.environmentId ?? null,
        outpostId: body.outpostId ?? null,
        createdAt: now,
        updatedAt: now,
      });

      // Legacy scalar producers (spawn paths not yet list-aware) still get a
      // member row so spawn/read paths have one source of truth.
      const memberRepositories: RepositoryRef[] =
        repositories.length > 0
          ? repositories
          : repoOwner !== null && repoName !== null && body.repoId != null && baseBranch !== null
            ? [{ repoOwner, repoName, repoId: body.repoId, baseBranch }]
            : [];
      deps.repository.replaceSessionRepositories(
        memberRepositories.map((repo, position) => ({
          position,
          repoOwner: repo.repoOwner,
          repoName: repo.repoName,
          repoId: repo.repoId,
          baseBranch: repo.baseBranch,
        }))
      );
      const sandboxId = deps.generateId();
      deps.repository.createSandbox({
        id: sandboxId,
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 0,
      });

      const participantId = deps.generateId();
      deps.repository.createParticipant({
        id: participantId,
        userId: body.userId,
        scmUserId: body.scmUserId ?? null,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        scmAccessTokenEncrypted: encryptedToken,
        scmRefreshTokenEncrypted: body.scmRefreshTokenEncrypted ?? null,
        scmTokenExpiresAt: body.scmTokenExpiresAt ?? null,
        role: "owner",
        joinedAt: now,
      });

      log.info("Triggering sandbox spawn for new session");
      deps.scheduleWarmSandbox();

      return Response.json({ sessionId, status: "created" });
    },

    getState(): Response {
      const session = deps.getSession();
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }

      const sandbox = deps.getSandbox();

      return Response.json({
        id: deps.getPublicSessionId(session),
        title: session.title,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        baseBranch: session.base_branch,
        branchName: session.branch_name,
        baseSha: session.base_sha,
        currentSha: session.current_sha,
        opencodeSessionId: session.opencode_session_id,
        status: session.status,
        model: session.model,
        reasoningEffort: session.reasoning_effort ?? undefined,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        sandbox: sandbox
          ? {
              id: sandbox.id,
              modalSandboxId: sandbox.modal_sandbox_id,
              status: sandbox.status,
              gitSyncStatus: sandbox.git_sync_status,
              lastHeartbeat: sandbox.last_heartbeat,
            }
          : null,
      });
    },

    async updateTitle(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const parseResult = titleUpdateBodySchema.safeParse(raw);
      if (!parseResult.success) {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const body: TitleUpdateBody = parseResult.data;

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const normalizedTitle = normalizeSessionTitle(body.title);
      if (!normalizedTitle.ok) {
        return Response.json({ error: normalizedTitle.error }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json(
          { error: "Not authorized to update the session title" },
          { status: 403 }
        );
      }

      const result = deps.applySessionTitleUpdate(normalizedTitle.title, { onlyIfUnset: false });
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: sessionTitleUpdateStatus(result) });
      }

      return Response.json({ title: result.title });
    },

    async archive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { userId?: string };
      try {
        body = parseUserIdBody(await request.json());
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json({ error: "Not authorized to archive this session" }, { status: 403 });
      }

      await deps.statusService.transition("archived");

      return Response.json({ status: "archived" });
    },

    async unarchive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { userId?: string };
      try {
        body = parseUserIdBody(await request.json());
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json(
          { error: "Not authorized to unarchive this session" },
          { status: 403 }
        );
      }

      await deps.statusService.transition("active");

      return Response.json({ status: "active" });
    },

    async cancel(): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      if (TERMINAL_STATUSES.has(session.status)) {
        return Response.json({ error: `Session already ${session.status}` }, { status: 409 });
      }

      await deps.stopExecution({ suppressStatusReconcile: true });
      await deps.statusService.transition("cancelled");

      const sandbox = deps.getSandbox();
      if (sandbox && sandbox.status !== "stopped") {
        const sandboxWs = deps.getSandboxSocket();
        if (sandboxWs) {
          deps.sendToSandbox(sandboxWs, { type: "shutdown" });
        }
        deps.updateSandboxStatus("stopped");
      }

      return Response.json({ status: "cancelled" });
    },
  };
}
