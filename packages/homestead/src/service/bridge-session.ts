import {
  bridgePromptCommandSchema,
  thinkingLevelForReasoningEffort,
  OUTPOST_PROTOCOL_VERSION,
  type BridgePromptCommand,
  type ModelThinkingLevel,
  type SessionAssign,
} from "@openoutposts/outpost-protocol";

import type { AgentHarness, HarnessSessionReference, TurnRequest } from "../index.js";
import { BridgeTurnTranslator, type BridgeEvent } from "./bridge-events.js";
import { shellQuote } from "./shell.js";

const BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Sustained rejection means the product has put the session to sleep (or
// ended it): stop holding the machine and go dormant. The product wakes a
// dormant session by re-assigning it with fresh credentials.
const MAX_CONSECUTIVE_RECONNECT_FAILURES = 15;
/**
 * How many events a session holds while its socket is down.
 *
 * The harness keeps working through a disconnect, and reconnect backoff runs
 * to 30s, so a turn can produce its entire answer with nowhere to put it. 500
 * is chosen against what a turn actually queues: `token` events collapse onto
 * one another (each carries the whole message so far), leaving tool-call
 * lifecycle events as the bulk, and 500 of those is several minutes of a busy
 * turn while still bounding one session to a few megabytes of held output.
 */
const MAX_BUFFERED_EVENTS = 500;

/**
 * A prompt command read into a turn, or the reason the user is getting a
 * refusal instead of an answer.
 */
export type TurnReadResult = { turn: TurnRequest } | { refusal: string };

/**
 * Reads the control plane's prompt command into a turn request.
 *
 * Everything the product decided about the message is here — the model, the
 * reasoning effort, who sent it, and any images — and until this existed the
 * bridge took the text and dropped the rest. A user switching models mid
 * session watched the UI and the database record the change while the original
 * model kept answering; a user attaching a screenshot was answered by a model
 * that never saw it. So each field is either carried or refused by name.
 */
export function readTurnRequest(command: unknown): TurnReadResult {
  const parsed = bridgePromptCommandSchema.safeParse(command);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(message)"}: ${issue.message}`)
      .join("; ");
    return {
      refusal:
        `This session's homestead could not read the message the control plane sent it ` +
        `(outpost protocol v${OUTPOST_PROTOCOL_VERSION}): ${detail}. The turn was stopped ` +
        `rather than run on the part of the message the homestead did understand.`,
    };
  }
  const prompt: BridgePromptCommand = parsed.data;

  const attachments = prompt.attachments ?? [];
  if (attachments.length > 0) {
    // The protocol's write operation carries a string, and no operation carries
    // bytes; delivering these needs a wire change that has not been made. Until
    // it is, the only honest thing is to say the model did not see them.
    return {
      refusal:
        `This message came with ${attachments.length} attachment(s) — ` +
        `${attachments.map((attachment) => attachment.name).join(", ")} — and this session runs ` +
        `on your own machine through the outpost protocol, which cannot carry image data yet. ` +
        `The model was not given them, and the turn was stopped rather than answered as though ` +
        `it had seen them. Describe the image or paste its contents as text and send again.`,
    };
  }

  let thinkingLevel: ModelThinkingLevel | undefined;
  if (prompt.reasoningEffort !== undefined) {
    const level = thinkingLevelForReasoningEffort(prompt.reasoningEffort);
    if (level === null) {
      return {
        refusal:
          `This message asked for the reasoning effort "${prompt.reasoningEffort}", which this ` +
          `homestead does not know. The turn was stopped rather than run at a reasoning level ` +
          `nobody chose.`,
      };
    }
    thinkingLevel = level;
  }

  return {
    turn: {
      content: prompt.content,
      ...(prompt.model === undefined ? {} : { model: prompt.model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(prompt.author === undefined ? {} : { author: prompt.author }),
    },
  };
}

export interface BridgeSessionOptions {
  assignment: SessionAssign;
  harness: AgentHarness;
  harnessSession: HarnessSessionReference;
  /** Repositories cloned into the workspace, announced in the ready event. */
  repositories?: Array<{
    position: number;
    repoOwner: string;
    repoName: string;
    baseSha: string;
  }>;
  /**
   * Runs a shell command in the session's workspace on the outpost (the
   * daemon backs this with a short-lived lease). Used for git operations
   * the product requests over the bridge: pushes and diff refreshes.
   */
  runWorkspaceCommand?: (
    command: string,
    timeoutMs: number
  ) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
  /** Requests a session diff capture (after turns and on refresh_diff). */
  onDiffRefreshRequested?: (triggerMessageId: string | null) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
  onClosed: (productSessionId: string) => void;
}

interface GitPushSpec {
  remoteUrl: string;
  redactedRemoteUrl: string;
  refspec: string;
  targetBranch: string;
  repoOwner?: string;
  repoName?: string;
  force?: boolean;
}

/**
 * The homestead's side of one product session: connects to the session's
 * WebSocket exactly like a provisioned sandbox bridge would, announces
 * readiness, receives prompt commands, and streams the central harness's
 * work back as sandbox events.
 */
export class BridgeSession {
  readonly #options: BridgeSessionOptions;
  #ws: WebSocket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
  #consecutiveFailures = 0;
  #shuttingDown = false;
  #promptActive = false;
  readonly #pendingCritical = new Map<string, BridgeEvent>();
  /** Events produced while the socket was down, in the order they were made. */
  readonly #outbox: BridgeEvent[] = [];
  /** What the buffer had to throw away, so the user is told instead of guessing. */
  #dropped: { count: number; messageId: string | null } = { count: 0, messageId: null };

  constructor(options: BridgeSessionOptions) {
    this.#options = options;
  }

  start(): void {
    this.#connect();
  }

  /** The bridge credential generation this session is serving. */
  get sandboxId(): string {
    return this.#options.assignment.sandboxId;
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#stopHeartbeat();
    // Nothing will reconnect to deliver these.
    this.#outbox.length = 0;
    this.#dropped = { count: 0, messageId: null };
    try {
      this.#ws?.close(1000, "homestead shutting down");
    } catch {
      // socket may already be closed
    }
    await this.#options.harness.close(this.#options.harnessSession).catch(() => {});
    this.#options.onClosed(this.#options.assignment.productSessionId);
  }

  #connect(): void {
    const { assignment } = this.#options;
    const base = assignment.controlPlaneUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    const url = `${base}/sessions/${assignment.productSessionId}/ws?type=sandbox`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${assignment.sandboxAuthToken}`,
        "X-Sandbox-ID": assignment.sandboxId,
      },
      // Node's undici WebSocket supports the headers option.
    } as unknown as string[]);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
      this.#consecutiveFailures = 0;
      this.#options.log("bridge connected", {
        session: assignment.productSessionId,
      });
      // `opencodeSessionId` is the inherited sandbox contract's name for
      // "the harness session id", carried by the shared event schemas, the
      // sessions table column and the web UI. It is a wire field, not a
      // harness choice: renaming it is a cross-package migration, so the Pi
      // session id travels under the old name.
      this.#send({
        type: "ready",
        opencodeSessionId: this.#options.harnessSession.harnessSessionId,
        repositories: this.#options.repositories ?? [],
      });
      this.#flushBuffered();
      this.#startHeartbeat();
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let command: Record<string, unknown>;
      try {
        command = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      // Nothing awaits this, so a rejection here would reach the process's
      // fatal unhandled-rejection handler and end every session on the machine.
      void this.#handleCommand(command).catch((error: unknown) => {
        this.#options.log("bridge command failed", {
          session: assignment.productSessionId,
          command: typeof command.type === "string" ? command.type : "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    ws.addEventListener("close", (event) => {
      this.#stopHeartbeat();
      if (this.#shuttingDown) return;
      // Fatal rejections (bad token, stopped session) must not loop forever.
      // Upgrade rejections surface as abnormal closes (1006), so sustained
      // failure is the dormancy signal even without a distinct close code.
      this.#consecutiveFailures += 1;
      if (
        event.code === 4001 ||
        event.code === 1008 ||
        this.#consecutiveFailures >= MAX_CONSECUTIVE_RECONNECT_FAILURES
      ) {
        this.#options.log("bridge unreachable; session going dormant", {
          session: assignment.productSessionId,
          code: event.code,
          attempts: this.#consecutiveFailures,
        });
        void this.shutdown();
        return;
      }
      this.#options.log("bridge disconnected; reconnecting", {
        session: assignment.productSessionId,
        code: event.code,
        delay_ms: this.#reconnectDelayMs,
      });
      setTimeout(() => {
        if (!this.#shuttingDown) this.#connect();
      }, this.#reconnectDelayMs);
      this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
    });

    ws.addEventListener("error", () => {
      // close fires afterwards; reconnect is handled there
    });
  }

  async #handleCommand(command: Record<string, unknown>): Promise<void> {
    switch (command.type) {
      case "prompt":
        await this.#handlePrompt(command);
        return;
      case "stop":
        await this.#options.harness.interrupt(this.#options.harnessSession).catch(() => {});
        return;
      case "shutdown":
        await this.shutdown();
        return;
      case "ack": {
        if (typeof command.ackId === "string") this.#pendingCritical.delete(command.ackId);
        return;
      }
      case "push":
        await this.#handlePush(command.pushSpec as unknown as GitPushSpec);
        return;
      case "refresh_diff":
        this.#options.onDiffRefreshRequested?.(null);
        return;
      default:
        return;
    }
  }

  async #handlePush(spec: GitPushSpec | undefined): Promise<void> {
    const identity = {
      branchName: spec?.targetBranch ?? "unknown",
      ...(spec?.repoOwner ? { repoOwner: spec.repoOwner } : {}),
      ...(spec?.repoName ? { repoName: spec.repoName } : {}),
    };
    const fail = (error: string) => {
      this.#send({
        type: "push_error",
        error,
        ...identity,
        ackId: `push_error:${identity.branchName}:${Date.now()}`,
      });
    };

    if (!spec) {
      fail("push command carried no push spec");
      return;
    }
    const run = this.#options.runWorkspaceCommand;
    if (!run) {
      fail("this session cannot run git operations");
      return;
    }

    try {
      const result = await run(
        `git push ${spec.force ? "--force " : ""}-- ${shellQuote(spec.remoteUrl)} ${shellQuote(spec.refspec)}`,
        180_000
      );
      if (!result.ok || result.exitCode !== 0) {
        // The remote URL may embed a brokered token — redact before surfacing.
        const detail = (result.stderr || result.stdout || "git push failed")
          .split(spec.remoteUrl)
          .join(spec.redactedRemoteUrl || "<remote>");
        fail(detail.slice(0, 2_000));
        return;
      }
      this.#send({
        type: "push_complete",
        ...identity,
        ackId: `push_complete:${identity.branchName}:${Date.now()}`,
      });
      this.#options.log("branch pushed", {
        session: this.#options.assignment.productSessionId,
        branch: spec.targetBranch,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  async #handlePrompt(command: Record<string, unknown>): Promise<void> {
    const messageId = typeof command.messageId === "string" ? command.messageId : null;
    if (messageId === null) {
      // Every event a turn produces is filed under its message id, so there is
      // nowhere to put a refusal for a prompt that has none.
      this.#options.log("prompt command carried no message id; ignoring", {
        session: this.#options.assignment.productSessionId,
      });
      return;
    }
    if (this.#promptActive) {
      this.#options.log("prompt arrived while another is active; ignoring", {
        session: this.#options.assignment.productSessionId,
        message_id: messageId,
      });
      return;
    }
    this.#promptActive = true;
    const translator = new BridgeTurnTranslator(messageId);
    const fail = (message: string): void => {
      for (const event of translator.translate({ type: "turn.failed", message })) {
        this.#send(event);
      }
    };
    try {
      for (const event of translator.start()) this.#send(event);
      const read = readTurnRequest(command);
      if ("refusal" in read) {
        this.#options.log("prompt refused", {
          session: this.#options.assignment.productSessionId,
          message_id: messageId,
          reason: read.refusal,
        });
        fail(read.refusal);
        return;
      }
      for await (const harnessEvent of this.#options.harness.sendPrompt(
        this.#options.harnessSession,
        read.turn
      )) {
        for (const event of translator.translate(harnessEvent)) this.#send(event);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.#promptActive = false;
      this.#options.onDiffRefreshRequested?.(messageId);
    }
  }

  #send(event: BridgeEvent): void {
    const enriched: BridgeEvent = {
      ...event,
      sandboxId: this.#options.assignment.sandboxId,
      // Seconds, fractional. Every timestamp the control plane synthesizes is
      // in seconds and the web client multiplies by 1000 to render, so
      // milliseconds here would date each event tens of millennia ahead and
      // sort it inconsistently against the events around it. The fraction is
      // kept so events inside one turn still order against each other.
      timestamp: Date.now() / 1000,
    };
    if (typeof enriched.ackId === "string") {
      this.#pendingCritical.set(enriched.ackId, enriched);
    }
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#write(enriched);
      return;
    }
    this.#buffer(enriched);
  }

  /**
   * Hands one event to the socket. `send` throws on a socket that closed
   * between the readyState check and the call, and this runs from timers and
   * from a floating prompt loop, where a throw would reach the process's fatal
   * handlers. A failed write is a disconnect: the close listener is already
   * arming the reconnect, and the event is held for it.
   */
  #write(event: BridgeEvent): void {
    try {
      this.#ws?.send(JSON.stringify(event));
    } catch {
      this.#buffer(event);
    }
  }

  /**
   * Holds an event until the socket is back.
   *
   * Only ack-carrying events used to survive a disconnect, which meant a
   * reconnect mid-turn erased the assistant's answer and every tool call in
   * the gap from the live view and from storage alike, with nothing left to
   * say a gap had happened.
   */
  #buffer(event: BridgeEvent): void {
    // Heartbeats are a liveness ping, not a record. Replaying a stale one on
    // reconnect tells the control plane about a moment that has already passed.
    if (event.type === "heartbeat") return;
    if (typeof event.messageId === "string" && event.type === "token") {
      // Token content is cumulative, so a later token for the same message
      // contains everything an earlier one said. Superseding in place is what
      // keeps a long answer from filling the buffer by itself.
      const existing = this.#outbox.findIndex(
        (queued) => queued.type === "token" && queued.messageId === event.messageId
      );
      if (existing !== -1) {
        this.#outbox[existing] = event;
        return;
      }
    }
    this.#outbox.push(event);
    while (this.#outbox.length > MAX_BUFFERED_EVENTS) {
      const evicted = this.#outbox.shift();
      this.#dropped.count += 1;
      if (evicted && typeof evicted.messageId === "string") {
        this.#dropped.messageId = evicted.messageId;
      }
    }
  }

  /**
   * Sends everything held during the outage, oldest first, then any critical
   * event still waiting to be acknowledged that the buffer did not already
   * carry — a critical event is in both places and must go out once.
   */
  #flushBuffered(): void {
    const buffered = this.#outbox.splice(0);
    if (this.#dropped.count > 0) {
      const { count, messageId } = this.#dropped;
      this.#options.log("buffered events were dropped during a bridge outage", {
        session: this.#options.assignment.productSessionId,
        dropped: count,
      });
      if (messageId !== null) {
        // A gap the user can see. Silently short transcripts are worse than an
        // acknowledged hole: the agent's work continued, and only the record of
        // it was lost.
        this.#write({
          type: "error",
          messageId,
          sandboxId: this.#options.assignment.sandboxId,
          timestamp: Date.now() / 1000,
          error:
            `The connection between this session and the machine running it dropped, and ` +
            `${count} event(s) from this turn could not be held while it was down. The agent ` +
            `kept working — part of what it did is missing from this transcript, not undone.`,
        });
      }
      this.#dropped = { count: 0, messageId: null };
    }
    const flushed = new Set<string>();
    for (const event of buffered) {
      if (typeof event.ackId === "string") flushed.add(event.ackId);
      this.#write(event);
    }
    for (const [ackId, event] of this.#pendingCritical) {
      if (!flushed.has(ackId)) this.#write(event);
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      this.#send({ type: "heartbeat", status: "ready" });
    }, BRIDGE_HEARTBEAT_INTERVAL_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
}
