import { dirname, basename } from "node:path";

import {
  OUTPOST_PROTOCOL_VERSION,
  HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE,
  MAX_SESSION_STARTUP_ERROR_LENGTH,
  controlToHomesteadMessageSchema,
  type ModelCatalog,
  type HomesteadRegistration,
  type SessionAssign,
  type SessionStartupFailureRequest,
} from "@openoutposts/outpost-protocol";

import { buildServiceAuthHeaders } from "@openoutposts/outpost-protocol";
import { OutpostClient } from "../outpost-client.js";
import { PiHarnessFactory } from "../pi/factory.js";
import { BridgeSession } from "./bridge-session.js";
import { SessionDiffPublisher, type WorkspaceHomestead } from "./diff-capture.js";
import { indexSessionHarnessFactories, type SessionHarnessFactory } from "./harness-factory.js";
import { shellQuote } from "./shell.js";
import { SessionStateStore } from "./state-store.js";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * Period of the keepalive handle. Its only job is to keep a reference on the
 * event loop, so the interval is long enough to be free and short enough that
 * a stop() during one period is not noticeable.
 */
const KEEPALIVE_INTERVAL_MS = 60_000;
const WORKSPACE_SETUP_LEASE_TTL_MS = 60_000;
const CLONE_LEASE_TTL_MS = 15 * 60 * 1000;
const CLONE_TIMEOUT_MS = 300_000;

export type CloneAuthMode = "machine" | "brokered";

export interface ClonedRepository {
  position: number;
  repoOwner: string;
  repoName: string;
  baseSha: string;
}

export interface HomesteadDaemonOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  homesteadId: string;
  homesteadVersion: string;
  /**
   * The harness's model catalog, reported at every registration so the product
   * can only ever offer a model this homestead can reach. A homestead that could not
   * read one still registers; it simply contributes nothing to the list.
   */
  catalog?: ModelCatalog;
  /**
   * DEVELOPMENT ONLY. A shell command whose stdout is a provider API key,
   * used for **every** session this homestead serves instead of the session
   * owner's own credential.
   *
   * This is the single-tenant assumption the per-user vault replaced, kept
   * only so the local quickstart can run before a user has connected a
   * provider. It is never silent: setting it is logged at startup and again on
   * every session start. It has no place in a deployment serving anyone but
   * the operator.
   */
  devPiKeyCommand?: string;
  /**
   * How repository clones authenticate on the outpost. "machine" (default)
   * sends only the clone URL — the machine's own git credentials (SSH keys,
   * credential helpers) do the rest, and nothing secret transits the wire.
   * "brokered" fetches a short-lived, repo-scoped token from the control
   * plane's credential broker for machines with no ambient git access.
   */
  cloneAuth?: CloneAuthMode;
  /**
   * Directory persisting session state across homestead restarts: one recovery
   * record per session, plus the Pi conversations under `pi-sessions/` that let
   * a restarted homestead carry on rather than begin again. Without it both are
   * in memory only, which is what the local demo wants.
   */
  stateDir?: string;
  /** Maximum concurrent sessions (central harness processes). Default 8. */
  maxSessions?: number;
  /**
   * Composition seam for tests and future built-in adapters. Production omits
   * this and receives the single Pi factory. Each factory must create a fresh
   * adapter for every product session.
   */
  harnessFactories?: readonly SessionHarnessFactory[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_MAX_SESSIONS = 8;

/**
 * Resolves the concurrent-session cap from configuration, accepting the raw
 * environment string as well as a number.
 *
 * A value that is not a positive whole number stops the homestead rather than
 * falling back, because the fallback is invisible and worse than a crash:
 * `Number("eigth")` is NaN, every `>=` comparison against NaN is false — so
 * the capacity guard admits sessions without limit — and `slice(0, NaN)`
 * returns nothing, so restart recovery silently adopts none of the sessions
 * that were running.
 */
export function resolveMaxSessions(configured: string | number | undefined): number {
  if (configured === undefined) return DEFAULT_MAX_SESSIONS;
  if (typeof configured === "string" && configured.trim() === "") return DEFAULT_MAX_SESSIONS;
  const value = typeof configured === "number" ? configured : Number(configured);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `maximum sessions must be a positive whole number; got ${JSON.stringify(configured)}`
    );
  }
  return value;
}

/**
 * The central homestead service. Maintains an outbound registration to the
 * control plane, accepts product-session assignments, prepares the session's
 * workspace on the target outpost, boots a central harness, and bridges the
 * session back to the product over the sandbox WebSocket contract.
 */
export class HomesteadDaemon {
  readonly #options: HomesteadDaemonOptions;
  readonly #outposts: OutpostClient;
  readonly #sessions = new Map<string, BridgeSession>();
  readonly #reservedSessionIds = new Set<string>();
  readonly #assignmentTails = new Map<string, Promise<void>>();
  readonly #stateStore: SessionStateStore | null;
  readonly #harnessFactories: ReadonlyMap<SessionHarnessFactory["kind"], SessionHarnessFactory>;
  readonly #maxSessions: number;
  #ws: WebSocket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
  #stopped = false;
  /**
   * Background work that touches the state directory — session startups and
   * dormant-marking writes — is fire-and-forget for its caller, but never
   * for stop(): an untracked write can land after shutdown has released the
   * state directory to whoever owns it next.
   */
  readonly #pendingWork = new Set<Promise<unknown>>();

  constructor(options: HomesteadDaemonOptions) {
    this.#options = options;
    this.#maxSessions = resolveMaxSessions(options.maxSessions);
    this.#outposts = new OutpostClient({
      controlPlaneUrl: options.controlPlaneUrl,
      internalSecret: options.internalSecret,
    });
    this.#stateStore = options.stateDir ? new SessionStateStore(options.stateDir) : null;
    const factories = options.harnessFactories ?? [
      new PiHarnessFactory({
        outposts: this.#outposts,
        controlPlaneUrl: options.controlPlaneUrl,
        ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        ...(options.devPiKeyCommand === undefined
          ? {}
          : { devPiKeyCommand: options.devPiKeyCommand }),
        ...(options.log === undefined ? {} : { log: options.log }),
      }),
    ];
    this.#harnessFactories = indexSessionHarnessFactories(factories);
  }

  async start(): Promise<void> {
    this.#stopped = false;
    this.#startKeepalive();
    await this.#recoverPersistedSessions();
    await this.#connect();
  }

  /**
   * Holds one explicit reference on the event loop for the daemon's whole
   * life. Without it the homestead can reach an empty event loop — between a
   * lost connection and its retry, or while every live session is idle — and
   * Node exits 0, which a process supervisor reads as an intentional
   * shutdown and does not restart.
   */
  #startKeepalive(): void {
    if (this.#keepaliveTimer) return;
    this.#keepaliveTimer = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
  }

  /**
   * Re-adopts sessions that were being served when the homestead stopped: the
   * workspace metadata survives, but neither credential does. The control
   * plane must rotate both credentials for the still-active generation before
   * a fresh harness starts. The agent's conversation survives too, in its own
   * file, so the recovered session continues rather than restarts.
   *
   * Dormant records are left alone: they exist for their diff baselines, and
   * waking a sleeping session is the product's decision, not the homestead's.
   */
  async #recoverPersistedSessions(): Promise<void> {
    if (!this.#stateStore) return;
    const pruned = await this.#stateStore
      .pruneDormant({
        beforeRemove: (productSessionIds) =>
          this.#removePersistedHarnessSessions(productSessionIds),
      })
      .catch((): string[] => []);
    if (pruned.length > 0) {
      this.#log("pruned expired dormant session records", { count: pruned.length });
    }

    const persisted = await this.#stateStore.loadAll();
    const active = persisted.filter((entry) => entry.status === "active");
    const capacity = this.#maxSessions;
    const recovering = active.slice(0, capacity);
    for (const entry of recovering) {
      this.#reservedSessionIds.add(entry.assignment.productSessionId);
    }
    await Promise.all(
      recovering.map(async (entry) => {
        const session = entry.assignment.productSessionId;
        this.#log("rotating session credentials for restart recovery", { session });
        try {
          const rotated = await this.#outposts.recoverSession(
            entry.assignment.productSessionId,
            entry.assignment.sandboxId
          );
          const assignment: SessionAssign = {
            ...entry.assignment,
            sandboxAuthToken: rotated.sandboxAuthToken,
            credentialFetchToken: rotated.credentialFetchToken,
          };
          this.#log("session credentials rotated; recovering after restart", { session });
          void this.#track(
            this.#queueAssignment(session, () =>
              this.#startSession(assignment, entry.repositories)
            ).finally(() => {
              this.#reservedSessionIds.delete(session);
            }),
            `restart recovery for session ${session}`
          );
        } catch (error) {
          this.#reservedSessionIds.delete(session);
          this.#log("session restart recovery failed; no stored or stale credential will be used", {
            session,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
    if (active.length > capacity) {
      // Beyond capacity we leave sessions to the product's watchdogs rather
      // than exceeding the process cap this homestead promised.
      this.#log("some sessions were not recovered: homestead capacity reached", {
        recovered: capacity,
        skipped: active.length - capacity,
      });
    }
  }

  /**
   * Gives every adapter factory a chance to remove its retained session state.
   * One failed factory does not prevent the others from running, but it does
   * retain the recovery record so the failed cleanup is retried next startup.
   */
  async #removePersistedHarnessSessions(productSessionIds: readonly string[]): Promise<boolean> {
    let complete = true;
    await Promise.all(
      [...this.#harnessFactories.values()].map(async (factory) => {
        if (!factory.removePersistedSessions) return;
        try {
          await factory.removePersistedSessions(productSessionIds);
        } catch (error) {
          complete = false;
          this.#log("harness persisted-session cleanup failed; retaining recovery record", {
            harness: factory.kind,
            sessions: productSessionIds.length,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
    return complete;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    if (this.#keepaliveTimer) clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = null;
    this.#ws?.close(1000, "homestead stopping");
    // A startup that is mid-flight when stop() lands finishes registering its
    // session, and a shutdown queues its own dormant-marking write, so drain
    // and sweep until both are empty rather than sweeping once.
    do {
      await Promise.all([...this.#sessions.values()].map((session) => session.shutdown()));
      await Promise.all([...this.#pendingWork]);
    } while (this.#pendingWork.size > 0 || this.#sessions.size > 0);
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const httpBase = this.#options.controlPlaneUrl.replace(/\/+$/, "");
    const base = httpBase.replace(/^http/, "ws");
    // The upgrade is signed like every other call: the signature binds this
    // method and this path, so a captured header cannot be pointed at a lease.
    const headers = await buildServiceAuthHeaders({
      service: "homestead",
      secret: this.#options.internalSecret,
      method: "GET",
      url: `${httpBase}/homesteads/connect`,
    });
    // stop() can land while the credential is being minted; opening the socket
    // now would leave a live registration nothing owns.
    if (this.#stopped) return;
    const ws = new WebSocket(`${base}/homesteads/connect`, {
      headers,
    } as unknown as string[]);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
      const registration: HomesteadRegistration = {
        type: "homestead.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        homesteadId: this.#options.homesteadId,
        homesteadVersion: this.#options.homesteadVersion,
        harnesses: [...this.#harnessFactories.keys()],
        ...(this.#options.catalog === undefined ? {} : { catalog: this.#options.catalog }),
      };
      this.#safeSend(ws, registration, "registration");
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = controlToHomesteadMessageSchema.safeParse(decoded);
      if (!parsed.success) return;
      const message = parsed.data;

      if (message.type === "homestead.registered") {
        this.#log("homestead registered", { homestead_id: message.homesteadId });
        this.#startHeartbeat(message.heartbeatIntervalMs);
        return;
      }
      if (message.type === "homestead.error") {
        this.#log("control plane error", { code: message.code, message: message.message });
        return;
      }
      if (message.type === "session.assign") {
        // Tracked, not floated. The handler's first act is a reply on this
        // socket, and `send` throws once the socket is closing — an assignment
        // that arrives a moment too late used to become an unhandled rejection,
        // which this process treats as fatal and answers by ending every
        // session it was serving.
        void this.#track(
          this.#handleAssignment(ws, message),
          `assignment ${message.assignmentId} for session ${message.productSessionId}`
        );
      }
    });

    ws.addEventListener("close", (event) => {
      if (this.#ws === ws) this.#ws = null;
      if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
      if (this.#stopped) return;
      if (event.code === HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE) {
        // Another process is registered under this homestead id and is being left
        // to serve. Retrying every second would only produce a hot loop against
        // a refusal that cannot change until that process goes away, so the
        // backoff goes straight to its ceiling — while still retrying, because
        // the holder may be the dying half of a rollover.
        this.#reconnectDelayMs = RECONNECT_MAX_DELAY_MS;
        this.#log(
          "control plane refused this homestead id: another live connection holds it; retrying slowly",
          { homestead_id: this.#options.homesteadId, delay_ms: this.#reconnectDelayMs }
        );
        this.#scheduleReconnect();
        return;
      }
      this.#log("control connection lost; reconnecting", {
        code: event.code,
        delay_ms: this.#reconnectDelayMs,
      });
      this.#scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close follows; reconnect handled there
    });
  }

  /**
   * Arms the next connection attempt, and re-arms it if that attempt throws
   * before a socket exists to close. Minting the internal token or building
   * the socket URL can both fail; an unhandled rejection there would leave
   * the homestead with no armed timer, silently detached from the control plane
   * for as long as the process survives.
   */
  #scheduleReconnect(): void {
    if (this.#stopped) return;
    if (this.#reconnectTimer) return;
    const delayMs = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect().catch((error: unknown) => {
        this.#log("reconnect attempt failed; retrying", {
          error: error instanceof Error ? error.message : String(error),
          delay_ms: this.#reconnectDelayMs,
        });
        this.#scheduleReconnect();
      });
    }, delayMs);
  }

  async #handleAssignment(ws: WebSocket, assignment: SessionAssign): Promise<void> {
    const respond = (accepted: boolean, reason?: string) => {
      ws.send(
        JSON.stringify(
          accepted
            ? {
                type: "session.assign_accepted",
                protocolVersion: OUTPOST_PROTOCOL_VERSION,
                assignmentId: assignment.assignmentId,
              }
            : {
                type: "session.assign_rejected",
                protocolVersion: OUTPOST_PROTOCOL_VERSION,
                assignmentId: assignment.assignmentId,
                reason: reason ?? "unknown",
              }
        )
      );
    };

    // Validate before disturbing anything: a rejected assignment must leave
    // an already-running session untouched.
    if (!this.#harnessFactories.has(assignment.harness)) {
      respond(false, `harness ${assignment.harness} is not available on this homestead`);
      return;
    }
    if ((assignment.repositories?.length ?? 0) > 1) {
      respond(false, "multi-repository sessions are not supported on outposts yet");
      return;
    }

    return this.#queueAssignment(assignment.productSessionId, async () => {
      if (this.#stopped) return;
      const existing = this.#sessions.get(assignment.productSessionId);
      if (existing?.sandboxId === assignment.sandboxId) {
        // Same credential generation (lifecycle retry): the existing bridge
        // keeps serving it.
        respond(true);
        return;
      }
      if (!this.#hasCapacityFor(assignment.productSessionId)) {
        respond(false, "homestead is at capacity; retry when a session ends");
        return;
      }

      // The reservation survives every await through bridge registration. It
      // counts pending starts and keeps a replacement's outgoing slot claimed.
      this.#reservedSessionIds.add(assignment.productSessionId);
      try {
        if (existing) {
          // The session is waking (or being re-issued) with fresh credentials:
          // retire the old bridge, then start anew in the same workspace.
          this.#log("session waking with new credentials; replacing bridge", {
            session: assignment.productSessionId,
          });
          await existing.shutdown();
        }

        try {
          await this.#ensureWorkspace(assignment);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#log("workspace preparation failed", {
            session: assignment.productSessionId,
            error: message,
          });
          respond(false, `workspace preparation failed: ${message}`);
          return;
        }

        // Accept before the harness boots. The reservation and per-session
        // queue remain held until startup settles, so no second assignment can
        // race the adapter or its transcript.
        respond(true);
        await this.#startSession(assignment);
      } finally {
        this.#reservedSessionIds.delete(assignment.productSessionId);
      }
    });
  }

  #hasCapacityFor(productSessionId: string): boolean {
    const occupied = new Set([...this.#sessions.keys(), ...this.#reservedSessionIds]);
    return occupied.has(productSessionId) || occupied.size < this.#maxSessions;
  }

  /** Runs assignment and recovery starts for one product session in order. */
  #queueAssignment<T>(productSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#assignmentTails.get(productSessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result
      .then(
        () => {},
        () => {}
      )
      .finally(() => {
        if (this.#assignmentTails.get(productSessionId) === tail) {
          this.#assignmentTails.delete(productSessionId);
        }
      });
    this.#assignmentTails.set(productSessionId, tail);
    return result;
  }

  /**
   * Registers background work so stop() can drain it, and gives that work its
   * only failure route.
   *
   * What is tracked is the settled promise, never the caller's: a rejection
   * that reached the drain would turn one failed piece of background work into
   * a failed shutdown, and a rejection nobody handled would reach the process's
   * fatal handler.
   */
  #track(work: Promise<unknown>, description: string): Promise<void> {
    const tracked = work
      .then(
        () => {},
        (error: unknown) => {
          this.#log("background work failed", {
            work: description,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      )
      .finally(() => {
        this.#pendingWork.delete(tracked);
      });
    this.#pendingWork.add(tracked);
    return tracked;
  }

  async #startSession(
    assignment: SessionAssign,
    recoveredRepositories?: ClonedRepository[]
  ): Promise<void> {
    if (this.#stopped) return;
    let repositories: ClonedRepository[] = recoveredRepositories ?? [];
    if (!recoveredRepositories && assignment.repositories && assignment.repositories.length > 0) {
      // A session that already ran keeps the baseline it was cloned at. Its
      // Changes view diffs against session start, so re-deriving a baseline
      // from the current HEAD on wake would silently discard everything the
      // session did before it slept.
      const known = await this.#stateStore?.get(assignment.productSessionId).catch(() => null);
      if (known && known.repositories.length > 0) {
        repositories = known.repositories;
        this.#log("reusing the session's original diff baseline", {
          session: assignment.productSessionId,
          base_sha: known.repositories[0].baseSha,
        });
      } else {
        try {
          repositories = [await this.#cloneRepository(assignment, assignment.repositories[0])];
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#log("repository clone failed; session will not start", {
            session: assignment.productSessionId,
            error: message,
          });
          await this.#reportStartupFailure(
            assignment,
            "repository_clone",
            `Repository clone failed: ${message}`
          );
          return;
        }
      }
    }

    let stage: SessionStartupFailureRequest["stage"] = "harness_start";
    try {
      const factory = this.#harnessFactories.get(assignment.harness);
      if (!factory) {
        throw new Error(`harness ${assignment.harness} is not available on this homestead`);
      }
      const harness = factory.create({
        productSessionId: assignment.productSessionId,
        outpostId: assignment.outpostId,
        credentialFetchToken: assignment.credentialFetchToken,
        ...(assignment.model === undefined ? {} : { model: assignment.model }),
      });
      if (harness.kind !== assignment.harness) {
        throw new Error(
          `harness factory ${assignment.harness} created an adapter of kind ${harness.kind}`
        );
      }
      const harnessSession = await harness.createSession({
        productSessionId: assignment.productSessionId,
        workspacePath: assignment.workspacePath,
        ...(assignment.model === undefined ? {} : { model: assignment.model }),
      });
      const diffs = new SessionDiffPublisher({
        controlPlaneUrl: this.#options.controlPlaneUrl,
        productSessionId: assignment.productSessionId,
        sandboxAuthToken: assignment.sandboxAuthToken,
        repositories: repositories.map((repo) => ({
          position: repo.position,
          repoOwner: repo.repoOwner,
          repoName: repo.repoName,
          baseSha: repo.baseSha,
        })),
        run: (fn, signal) => this.#withWorkspaceHomestead(assignment, 10 * 60 * 1000, fn, signal),
        log: (message, fields) => this.#log(message, fields),
      });
      const bridge = new BridgeSession({
        assignment,
        harness,
        harnessSession,
        repositories,
        runWorkspaceCommand: (command, timeoutMs, signal) =>
          this.#runWorkspaceCommand(assignment, command, timeoutMs, signal),
        onDiffRefreshRequested: (triggerMessageId, signal) =>
          diffs.refresh(triggerMessageId, signal),
        onStartupFailure: (error) => this.#reportStartupFailure(assignment, "bridge_start", error),
        log: (message, fields) => this.#log(message, fields),
        onClosed: (productSessionId) => {
          if (this.#sessions.get(productSessionId) === bridge) {
            this.#sessions.delete(productSessionId);
          }
          // Keep the record, marked dormant: a session can sleep for months
          // and must wake against its original baseline. Expired dormant
          // records are pruned at startup.
          if (this.#stateStore) {
            void this.#track(
              this.#stateStore.markDormant(productSessionId, assignment.sandboxId),
              `dormant marking for session ${productSessionId}`
            );
          }
        },
      });
      this.#sessions.set(assignment.productSessionId, bridge);
      await this.#stateStore?.save({ assignment, repositories, status: "active" }).catch(() => {});
      stage = "bridge_start";
      bridge.start();
      this.#log("session started", {
        session: assignment.productSessionId,
        outpost: assignment.outpostId,
        workspace: assignment.workspacePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log("session start failed", {
        session: assignment.productSessionId,
        stage,
        error: message,
      });
      const bridge = this.#sessions.get(assignment.productSessionId);
      if (bridge?.sandboxId === assignment.sandboxId) {
        this.#sessions.delete(assignment.productSessionId);
        await bridge.shutdown().catch((shutdownError: unknown) => {
          this.#log("failed session cleanup did not finish", {
            session: assignment.productSessionId,
            error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
          });
        });
      }
      await this.#reportStartupFailure(
        assignment,
        stage,
        `${stage === "bridge_start" ? "Session bridge" : "Session harness"} failed to start: ${message}`
      );
    }
  }

  /**
   * Tell the session lifecycle that an accepted assignment never became
   * usable. A reporting outage is logged locally and never allowed to take
   * down this homestead or another session it serves.
   */
  async #reportStartupFailure(
    assignment: SessionAssign,
    stage: SessionStartupFailureRequest["stage"],
    error: string
  ): Promise<void> {
    const boundedError =
      error.length <= MAX_SESSION_STARTUP_ERROR_LENGTH
        ? error
        : `${error.slice(0, MAX_SESSION_STARTUP_ERROR_LENGTH - 1)}…`;
    const base = this.#options.controlPlaneUrl.replace(/\/+$/, "");
    try {
      const response = await fetch(
        `${base}/sessions/${encodeURIComponent(assignment.productSessionId)}/startup-failure`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${assignment.sandboxAuthToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            stage,
            error: boundedError,
            sandboxId: assignment.sandboxId,
            timestamp: Date.now(),
          } satisfies SessionStartupFailureRequest),
        }
      );
      if (!response.ok) {
        this.#log("control plane refused session startup failure report", {
          session: assignment.productSessionId,
          sandbox_id: assignment.sandboxId,
          stage,
          http_status: response.status,
        });
      }
    } catch (reportError) {
      this.#log("session startup failure could not be reported", {
        session: assignment.productSessionId,
        sandbox_id: assignment.sandboxId,
        stage,
        error: reportError instanceof Error ? reportError.message : String(reportError),
      });
    }
  }

  /**
   * Clones the session's repository into its workspace on the outpost and
   * returns its identity with the checked-out base commit. With machine
   * auth the command carries only the public clone URL; with brokered auth
   * a short-lived token from the control plane's credential broker rides in
   * the URL for this one command.
   */
  async #cloneRepository(
    assignment: SessionAssign,
    repository: NonNullable<SessionAssign["repositories"]>[number]
  ): Promise<ClonedRepository> {
    let cloneUrl = repository.cloneUrl;
    if ((this.#options.cloneAuth ?? "machine") === "brokered") {
      const credentials = await this.#fetchBrokeredCredentials(assignment);
      const url = new URL(repository.cloneUrl);
      url.username = encodeURIComponent(credentials.username);
      url.password = encodeURIComponent(credentials.password);
      cloneUrl = url.toString();
    }

    const lease = await this.#outposts.createLease({
      outpostId: assignment.outpostId,
      productSessionId: `${assignment.productSessionId}-clone`,
      workspacePath: assignment.workspacePath,
      ttlMs: CLONE_LEASE_TTL_MS,
    });
    try {
      const branchArgs = repository.baseBranch
        ? `--branch ${shellQuote(repository.baseBranch)} `
        : "";
      const clone = await this.#outposts.callTool(
        assignment.outpostId,
        lease.leaseId,
        "bash",
        {
          // After a brokered clone the credentialed URL would persist in
          // .git/config; reset the remote to the clean URL in the same
          // command so no credential outlives the clone.
          command: `if [ -d .git ]; then git rev-parse HEAD; else git clone ${branchArgs}-- ${shellQuote(cloneUrl)} . && git remote set-url origin ${shellQuote(repository.cloneUrl)} && git rev-parse HEAD; fi`,
          timeoutMs: CLONE_TIMEOUT_MS,
        },
        CLONE_TIMEOUT_MS
      );
      if (!clone.ok) {
        throw new Error(clone.error ?? "git clone failed on the outpost");
      }
      const output = clone.output as { stdout: string; stderr: string; exitCode: number };
      if (output.exitCode !== 0) {
        // stderr may mention the URL; with brokered auth it could carry the
        // token, so redact before logging or surfacing.
        throw new Error(`git clone exited ${output.exitCode}: ${redact(output.stderr, cloneUrl)}`);
      }
      const baseSha = output.stdout.trim().split("\n").pop() ?? "";
      if (!/^[0-9a-f]{40}$/.test(baseSha)) {
        throw new Error("could not determine the cloned base commit");
      }
      this.#log("repository cloned", {
        session: assignment.productSessionId,
        repo: `${repository.repoOwner}/${repository.repoName}`,
        base_sha: baseSha,
      });
      return {
        position: 0,
        repoOwner: repository.repoOwner,
        repoName: repository.repoName,
        baseSha,
      };
    } finally {
      await this.#outposts
        .releaseLease(assignment.outpostId, lease.leaseId, "completed")
        .catch(() => {});
    }
  }

  /**
   * Holds one workspace lease for the duration of `fn`, handing it a homestead
   * that executes bash in the session workspace. Multi-command operations
   * (diff capture) share the lease instead of taking one per command.
   */
  async #withWorkspaceHomestead<T>(
    assignment: SessionAssign,
    ttlMs: number,
    fn: (run: WorkspaceHomestead) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const lease = await this.#outposts.createLease({
      outpostId: assignment.outpostId,
      productSessionId: `${assignment.productSessionId}-git`,
      workspacePath: assignment.workspacePath,
      ttlMs,
    });
    let cancellation: Promise<void> | null = null;
    const cancel = (): Promise<void> => {
      cancellation ??= this.#outposts
        .cancelLeaseWork(assignment.outpostId, lease.leaseId)
        .catch(() => {});
      return cancellation;
    };
    const onAbort = (): void => {
      void cancel();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const run: WorkspaceHomestead = async (command, timeoutMs) => {
      if (signal?.aborted) throw new Error("workspace work cancelled during shutdown");
      const result = await this.#outposts.callTool(
        assignment.outpostId,
        lease.leaseId,
        "bash",
        { command, timeoutMs },
        timeoutMs + 15_000
      );
      if (signal?.aborted) throw new Error("workspace work cancelled during shutdown");
      if (!result.ok) {
        return {
          ok: false,
          stdout: "",
          stderr: result.error ?? "workspace command failed",
          exitCode: -1,
        };
      }
      const output = result.output as {
        stdout: string;
        stderr: string;
        exitCode: number;
        truncated?: boolean;
      };
      return { ok: true, ...output };
    };
    try {
      if (signal?.aborted) {
        await cancel();
        throw new Error("workspace work cancelled during shutdown");
      }
      return await fn(run);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) await cancel();
      await this.#outposts
        .releaseLease(assignment.outpostId, lease.leaseId, "completed")
        .catch(() => {});
    }
  }

  /** Runs one shell command in a session's workspace under its own lease. */
  #runWorkspaceCommand(
    assignment: SessionAssign,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
    return this.#withWorkspaceHomestead(
      assignment,
      Math.max(timeoutMs + 60_000, 120_000),
      (run) => run(command, timeoutMs),
      signal
    );
  }

  async #fetchBrokeredCredentials(
    assignment: SessionAssign
  ): Promise<{ username: string; password: string }> {
    const base = this.#options.controlPlaneUrl.replace(/\/+$/, "");
    const response = await fetch(
      `${base}/sessions/${assignment.productSessionId}/scm-credentials`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${assignment.sandboxAuthToken}` },
      }
    );
    if (!response.ok) {
      throw new Error(`credential broker refused: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      throw new Error("credential broker returned an incomplete credential");
    }
    return { username: body.username, password: body.password };
  }

  /**
   * Creates the per-session workspace directory on the outpost. The lease
   * protocol requires an existing directory, so the parent (the configured
   * workspace root) is leased briefly to create the child.
   */
  async #ensureWorkspace(assignment: SessionAssign): Promise<void> {
    const parent = dirname(assignment.workspacePath);
    const child = basename(assignment.workspacePath);
    const lease = await this.#outposts.createLease({
      outpostId: assignment.outpostId,
      productSessionId: `${assignment.productSessionId}-setup`,
      workspacePath: parent,
      ttlMs: WORKSPACE_SETUP_LEASE_TTL_MS,
    });
    try {
      const result = await this.#outposts.callTool(assignment.outpostId, lease.leaseId, "bash", {
        command: `mkdir -p ${shellQuote(child)}`,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "mkdir failed on the outpost");
      }
    } finally {
      await this.#outposts
        .releaseLease(assignment.outpostId, lease.leaseId, "completed")
        .catch(() => {});
    }
  }

  #startHeartbeat(intervalMs: number): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => {
      const ws = this.#ws;
      if (ws?.readyState !== WebSocket.OPEN) return;
      this.#safeSend(
        ws,
        {
          type: "homestead.heartbeat",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          homesteadId: this.#options.homesteadId,
          sentAt: new Date().toISOString(),
        },
        "heartbeat"
      );
    }, intervalMs);
  }

  /**
   * Writes one control message.
   *
   * `send` throws on a socket that closed between the check and the call, and
   * both callers run from places — a socket event listener, a timer — where a
   * throw escapes into the process's fatal handlers and takes every session
   * down. A failed write is a lost connection, which the close listener is
   * already handling by reconnecting and re-registering.
   */
  #safeSend(ws: WebSocket, payload: unknown, description: string): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      this.#log("control message could not be sent", {
        message: description,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #log(message: string, fields?: Record<string, unknown>): void {
    (this.#options.log ?? (() => {}))(message, fields);
  }
}

/** Removes a sensitive URL (which may embed a brokered token) from text. */
function redact(text: string, secretUrl: string): string {
  return text.split(secretUrl).join("<clone-url>");
}
