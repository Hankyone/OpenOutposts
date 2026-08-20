import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentContextFile, PromptGitIdentity } from "@openoutposts/outpost-protocol";

import type {
  AgentHarness,
  CreateHarnessSessionInput,
  HarnessEvent,
  HarnessSessionReference,
  TurnRequest,
} from "../index.js";
import type { OutpostClient } from "../outpost-client.js";
import { shellQuote } from "../service/shell.js";
import { createPiAgentHome, type PiAgentHome } from "./agent-home.js";
import { loadHomesteadContext } from "./context.js";
import { unconfiguredCredentialStore, type SessionCredentialStore } from "./credential-store.js";
import {
  createOutpostAgentSession,
  type OutpostAgentSessionResult,
  type PiThinkingLevel,
} from "./session.js";
import { createLeaseTransport, type OutpostToolTransport } from "./tools.js";
import { applyTurnModel, applyTurnThinkingLevel, currentModelSpec } from "./turn-settings.js";
import { streamTurn } from "./turn.js";

// Renew the session lease at a third of its default one-hour life, so long
// sessions never run into expiry even across two missed attempts.
const LEASE_RENEW_INTERVAL_MS = 20 * 60 * 1000;
const PI_CLOSE_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Who commits when the control plane resolved no user to attribute the turn
 * to. It is a deliberate identity rather than a missing one: without it git
 * falls back to whatever the outpost's own configuration says, so an
 * unattributed commit would be signed by the machine's owner, and on a machine
 * with no git identity configured at all the commit would fail outright.
 *
 * Kept in step with the control plane's own unattributed author, which is what
 * the product shows next to those commits.
 */
const AGENT_GIT_IDENTITY = {
  name: "OpenOutposts",
  email: "openoutposts@noreply.github.com",
} as const;

interface GitIdentity {
  name: string;
  email: string;
}

function resolveGitIdentity(identity: PromptGitIdentity | undefined): GitIdentity {
  if (identity?.mode === "attributed-user") {
    return { name: identity.name, email: identity.email };
  }
  return AGENT_GIT_IDENTITY;
}

/**
 * Puts the turn's author into the environment of a command running on the
 * outpost. `GIT_*` variables are used rather than `git -c user.*` because the
 * agent composes its own git command lines and there is no place to inject
 * flags into them; the environment reaches every git invocation in the shell,
 * including one inside a script the agent wrote.
 *
 * Both name and email pass through `shellQuote`: they originate in a source
 * control profile, which is user-controlled text.
 */
function gitIdentityEnvPrefix(identity: GitIdentity): string {
  const name = shellQuote(identity.name);
  const email = shellQuote(identity.email);
  return (
    `export GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} ` +
    `GIT_COMMITTER_NAME=${name} GIT_COMMITTER_EMAIL=${email}; `
  );
}

export interface PiHarnessOptions {
  outposts: OutpostClient;
  outpostId: string;
  /** `provider/model-id`, e.g. `anthropic/claude-sonnet-4-5`. */
  defaultModel?: string;
  /**
   * Where the session's provider key comes from. Built by the caller so the
   * harness never needs to know whether it is brokered from the session
   * owner's vault or an operator's development key.
   */
  credentials?: SessionCredentialStore;
  thinkingLevel?: PiThinkingLevel;
  leaseTtlMs?: number;
  /**
   * Where this session's Pi conversation is kept between homestead restarts.
   * One file per product session, supplied by the daemon from its state
   * directory. Without it the conversation stays in memory and a restart meets
   * the user with an agent that remembers nothing.
   */
  piSessionFile?: string;
  /** Test seam for the homestead-global Pi instruction file. */
  loadGlobalContext?: () => Promise<AgentContextFile[]>;
  onLog?: (line: string) => void;
}

interface SessionRuntime {
  session: AgentSession;
  home: PiAgentHome;
  credentials: SessionCredentialStore;
  leaseId: string;
  renewTimer: ReturnType<typeof setInterval>;
  /** Whose turn is running, for the log line each outpost call writes. */
  actor: TurnActor;
}

/**
 * The author of the turn currently running, held in a box the tool transport
 * closes over: the transport is built before the session exists and outlives
 * every turn, while the author changes with each one.
 */
interface TurnActor {
  userId: string | null;
  /** Who git commits made during this turn are attributed to. */
  gitIdentity: GitIdentity;
}

/**
 * Runs Pi centrally as the agent brain for a product session.
 *
 * Pi is embedded in-process through its SDK: no per-session server, no port,
 * and no generated tool files on disk. The seven outpost operations are passed
 * in as plain closures that call this homestead's own lease client, so the
 * model's only filesystem and shell are the leased outpost's.
 */
export class PiHarness implements AgentHarness {
  readonly kind = "pi" as const;
  readonly #options: PiHarnessOptions;
  readonly #sessions = new Map<string, SessionRuntime>();

  constructor(options: PiHarnessOptions) {
    this.#options = options;
  }

  async createSession(input: CreateHarnessSessionInput): Promise<HarnessSessionReference> {
    const modelSpec = input.model ?? this.#options.defaultModel;
    const lease = await this.#options.outposts.createLease({
      outpostId: this.#options.outpostId,
      productSessionId: input.productSessionId,
      workspacePath: input.workspacePath,
      ...(this.#options.leaseTtlMs === undefined ? {} : { ttlMs: this.#options.leaseTtlMs }),
    });

    const credentials =
      this.#options.credentials ??
      unconfiguredCredentialStore("this harness was given no credential store");

    const actor: TurnActor = { userId: null, gitIdentity: AGENT_GIT_IDENTITY };
    let home: PiAgentHome | null = null;
    let session: AgentSession | null = null;
    try {
      this.#options.onLog?.("harness: lease acquired, preparing pi agent home");
      home = await createPiAgentHome();
      await this.#checkCredential(credentials);
      const [globalContext, outpostContext] = await Promise.all([
        this.#options.loadGlobalContext?.() ??
          loadHomesteadContext({
            onWarning: (message) => this.#options.onLog?.(`harness: ${message}`),
          }),
        this.#options.outposts.readContext(this.#options.outpostId, lease.leaseId),
      ]);
      this.#options.onLog?.(
        `harness: loaded ${globalContext.length} global and ${outpostContext.length} outpost context files`
      );
      const created = await createOutpostAgentSession({
        home,
        credentials,
        contextFiles: [...globalContext, ...outpostContext],
        transport: this.#attributedTransport(
          createLeaseTransport(this.#options.outposts, this.#options.outpostId, lease.leaseId),
          actor
        ),
        ...(modelSpec === undefined ? {} : { model: modelSpec }),
        ...(this.#options.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: this.#options.thinkingLevel }),
        ...(this.#options.piSessionFile === undefined
          ? {}
          : { persistence: { sessionFile: this.#options.piSessionFile } }),
      });
      session = created.session;
      this.#reportSessionOrigin(created);
      this.#options.onLog?.(
        `harness: pi session ${session.sessionId} ready with tools ${session.getActiveToolNames().join(", ")}`
      );

      const renewTimer = setInterval(() => {
        this.#options.outposts
          .renewLease(this.#options.outpostId, lease.leaseId)
          .catch((error: unknown) => {
            this.#options.onLog?.(
              `lease renewal failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
      }, LEASE_RENEW_INTERVAL_MS);

      this.#sessions.set(session.sessionId, {
        session,
        home,
        credentials,
        leaseId: lease.leaseId,
        renewTimer,
        actor,
      });
      return {
        productSessionId: input.productSessionId,
        harnessSessionId: session.sessionId,
        harness: "pi",
      };
    } catch (error) {
      session?.dispose();
      if (home) await home.remove().catch(() => {});
      await this.#options.outposts
        .releaseLease(this.#options.outpostId, lease.leaseId, "cancelled")
        .catch(() => {});
      throw error;
    }
  }

  /**
   * Says whether this session picked up a conversation or began one.
   *
   * Worth a log line of its own because the two are indistinguishable from the
   * product side and only one of them is what the user expects after a
   * homestead restart: an agent that silently forgot everything looks like an
   * agent that is ignoring the conversation so far.
   */
  #reportSessionOrigin(created: OutpostAgentSessionResult): void {
    if (this.#options.piSessionFile === undefined) {
      this.#options.onLog?.(
        "harness: this session is not persisted and will not survive a restart"
      );
      return;
    }
    if (created.recovered) {
      this.#options.onLog?.(
        `harness: the stored pi session could not be read and was set aside; starting fresh at ${this.#options.piSessionFile}`
      );
      return;
    }
    if (created.resumed) {
      this.#options.onLog?.(
        `harness: resumed the pi session from disk with ${created.entryCount} entries and ${created.messageCount} prior messages`
      );
      return;
    }
    this.#options.onLog?.(
      `harness: no stored pi session; starting fresh and persisting to ${this.#options.piSessionFile}`
    );
  }

  /**
   * Obtains the session's credential once before the model needs it.
   *
   * A failure here does not stop the session: the product session and its
   * history are worth more than a clean refusal, and the first turn refuses
   * with the same message the user would otherwise wait for. What this buys is
   * a log line naming the cause at the moment it is diagnosable, and a warm
   * credential so the first turn does not pay for its own issuance.
   */
  async #checkCredential(credentials: SessionCredentialStore): Promise<void> {
    try {
      await credentials.revalidate();
      this.#options.onLog?.("harness: provider credential resolved");
    } catch (error) {
      this.#options.onLog?.(
        `harness: this session has no usable provider credential and every turn will refuse: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  sendPrompt(session: HarnessSessionReference, turn: TurnRequest): AsyncIterable<HarnessEvent> {
    return this.#streamGuardedTurn(this.#requireRuntime(session), turn);
  }

  /**
   * Wraps the lease transport so every outpost operation a turn performs is
   * logged against the user who asked for it, and every shell it opens carries
   * that user as its git author. The log half stops at this homestead: the
   * protocol's `tool.request` carries no actor, and stamping one on the wire
   * that nothing reads would look like an audit trail without being one. The
   * git half has to reach the machine, because that is where the commit is
   * made and the product shows the user's name on it either way.
   */
  #attributedTransport(transport: OutpostToolTransport, actor: TurnActor): OutpostToolTransport {
    return {
      call: (operation, input, timeoutMs) => {
        this.#options.onLog?.(
          `outpost ${operation} requested by ${actor.userId ?? "no identified user"}`
        );
        if (operation !== "bash" || typeof input.command !== "string") {
          return transport.call(operation, input, timeoutMs);
        }
        return transport.call(
          operation,
          { ...input, command: `${gitIdentityEnvPrefix(actor.gitIdentity)}${input.command}` },
          timeoutMs
        );
      },
    };
  }

  /**
   * One turn, with the session's credential re-issued at its boundary and the
   * turn's own model and reasoning level applied before a word of it runs.
   *
   * Re-issuing per turn is what gives the credential's expiry and the vault's
   * revoked flag any effect on a session that is already running: every
   * issuance is a fresh ownership check at the control plane, so a credential
   * removed or rotated between turns stops the next one. It costs one
   * control-plane call per user turn, which is the same order as everything
   * else a turn already does.
   *
   * A turn that cannot be given a credential does not start. Continuing would
   * mean running on a credential the control plane declined to reconfirm, and
   * this product does not substitute quietly for what a user configured.
   */
  async *#streamGuardedTurn(
    runtime: SessionRuntime,
    turn: TurnRequest
  ): AsyncIterable<HarnessEvent> {
    try {
      await runtime.credentials.revalidate();
      await this.#applyTurnSettings(runtime, turn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#options.onLog?.(`harness: turn refused before it started: ${message}`);
      yield { type: "turn.failed", message };
      return;
    }

    runtime.actor.userId = turn.author?.userId ?? null;
    runtime.actor.gitIdentity = resolveGitIdentity(turn.author?.gitIdentity);
    for await (const event of streamTurn(runtime.session, turn.content)) {
      if (event.type !== "turn.failed") {
        yield event;
        continue;
      }
      // A credential that expired inside the turn surfaces through Pi's model
      // layer, which reports it as `Credential store read failed for
      // <provider>` and drops the cause. The store's own message is the only
      // one that says what happened and whose credential it was.
      const failure = runtime.credentials.failure();
      yield failure === null
        ? event
        : {
            type: "turn.failed",
            message: failure.message,
            ...(event.usage === undefined ? {} : { usage: event.usage }),
          };
      return;
    }
  }

  /**
   * Puts the session into the state this turn was asked for.
   *
   * Both settings are applied before the prompt is sent and both throw rather
   * than settle for something close: the product displays the model and the
   * reasoning effort next to the answer, so an answer produced under different
   * ones would be mislabelled everywhere it is shown.
   */
  async #applyTurnSettings(runtime: SessionRuntime, turn: TurnRequest): Promise<void> {
    if (turn.model !== undefined) {
      const previous = currentModelSpec(runtime.session);
      await applyTurnModel(runtime.session, turn.model, runtime.credentials.providerId);
      if (previous !== turn.model) {
        this.#options.onLog?.(
          `harness: turn model set to ${turn.model} (was ${previous ?? "unset"})`
        );
      }
    }
    if (turn.thinkingLevel !== undefined) {
      applyTurnThinkingLevel(runtime.session, turn.thinkingLevel);
    }
  }

  async interrupt(session: HarnessSessionReference): Promise<void> {
    const runtime = this.#requireRuntime(session);
    // Start the remote cancellation first. Waiting for Pi to finish aborting
    // before reaching the worker leaves queued and running machine work alive
    // during the exact window in which the user expects stop to take effect.
    const cancelOutpostWork = this.#options.outposts
      .cancelLeaseWork(this.#options.outpostId, runtime.leaseId)
      .catch(() => {});
    await Promise.all([runtime.session.abort(), cancelOutpostWork]);
  }

  /**
   * Ends this homestead's service of the session and leaves its conversation
   * where it is.
   *
   * The Pi session file survives on purpose, for the same reason the state
   * store keeps a dormant record rather than deleting it: a session that
   * sleeps can be woken months later, and it must wake into the conversation
   * it was having. Deleting the file here would make every sleep amnesia.
   */
  async close(session: HarnessSessionReference): Promise<void> {
    const runtime = this.#sessions.get(session.harnessSessionId);
    if (!runtime) return;
    this.#sessions.delete(session.harnessSessionId);
    clearInterval(runtime.renewTimer);

    // Pi abort and worker cancellation are independent drains. Start both
    // before awaiting either so model shutdown cannot leave an outpost command
    // running, and an unreachable outpost cannot hold model shutdown open.
    const cancelOutpostWork = this.#settleCloseWork(
      () => this.#options.outposts.cancelLeaseWork(this.#options.outpostId, runtime.leaseId),
      "outpost work cancellation"
    );
    const abortPi = this.#settleCloseWork(() => runtime.session.abort(), "pi abort");
    const drained = Promise.all([abortPi, cancelOutpostWork]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      drained.then(() => "drained" as const),
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), PI_CLOSE_DRAIN_TIMEOUT_MS);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (outcome === "timed-out") {
      this.#options.onLog?.(
        `harness: pi close drain timed out after ${PI_CLOSE_DRAIN_TIMEOUT_MS}ms`
      );
    }

    // Disposal and every resource cleanup are isolated. A stuck or failed
    // drain must not keep the lease or scratch home alive indefinitely, and a
    // failed release must not skip removal of the credential-free home.
    try {
      runtime.session.dispose();
    } catch (error) {
      this.#options.onLog?.(
        `harness: pi disposal failed during close: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await this.#settleCloseWork(
      () =>
        this.#options.outposts.releaseLease(this.#options.outpostId, runtime.leaseId, "completed"),
      "lease release"
    );
    await this.#settleCloseWork(() => runtime.home.remove(), "scratch home removal");
  }

  #settleCloseWork(work: () => Promise<void>, description: string): Promise<void> {
    let started: Promise<void>;
    try {
      started = work();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.catch((error: unknown) => {
      this.#options.onLog?.(
        `harness: ${description} failed during close: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  #requireRuntime(session: HarnessSessionReference): SessionRuntime {
    const runtime = this.#sessions.get(session.harnessSessionId);
    if (!runtime) {
      throw new Error(`Unknown harness session: ${session.harnessSessionId}`);
    }
    return runtime;
  }
}
