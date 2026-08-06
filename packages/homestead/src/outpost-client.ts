import { buildServiceAuthHeaders } from "@openoutposts/outpost-protocol";
import { z } from "zod";
import {
  HOMESTEAD_RECOVERY_VERSION,
  agentContextFileSchema,
  homesteadRecoveryResponseSchema,
  toolErrorCodeSchema,
  type AgentContextFile,
  type OutpostOperation,
  type HomesteadRecoveryResponse,
  type ToolErrorCode,
} from "@openoutposts/outpost-protocol";

const contextResponseSchema = z.object({
  ok: z.boolean(),
  files: z.array(agentContextFileSchema),
  error: z.string().optional(),
  errorCode: toolErrorCodeSchema.optional(),
});

export interface OutpostClientOptions {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}

export interface CreateLeaseInput {
  outpostId: string;
  productSessionId: string;
  workspacePath: string;
  ttlMs?: number;
}

export interface Lease {
  leaseId: string;
  expiresAt: string;
}

export interface ToolCallResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorCode?: ToolErrorCode;
}

export class OutpostClientError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "OutpostClientError";
  }
}

/**
 * HTTP client for the control plane's outpost registry: lease lifecycle and
 * lease-scoped tool execution. Authenticates with the deployment's internal
 * service secret; this client belongs in trusted homestead infrastructure only.
 */
export class OutpostClient {
  readonly #controlPlaneUrl: string;
  readonly #internalSecret: string;
  readonly #fetch: typeof fetch;

  constructor(options: OutpostClientOptions) {
    this.#controlPlaneUrl = options.controlPlaneUrl.replace(/\/+$/, "");
    this.#internalSecret = options.internalSecret;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async status(outpostId: string): Promise<Record<string, unknown>> {
    const response = await this.#request("GET", `/outposts/${encodeURIComponent(outpostId)}`);
    return (await response.json()) as Record<string, unknown>;
  }

  async createLease(input: CreateLeaseInput): Promise<Lease> {
    const response = await this.#request(
      "POST",
      `/outposts/${encodeURIComponent(input.outpostId)}/leases`,
      {
        productSessionId: input.productSessionId,
        workspacePath: input.workspacePath,
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      }
    );
    return (await response.json()) as Lease;
  }

  async releaseLease(
    outpostId: string,
    leaseId: string,
    reason: "completed" | "expired" | "moved" | "cancelled" = "completed"
  ): Promise<void> {
    await this.#request(
      "DELETE",
      `/outposts/${encodeURIComponent(outpostId)}/leases/${encodeURIComponent(leaseId)}`,
      { reason }
    );
  }

  async renewLease(outpostId: string, leaseId: string, ttlMs?: number): Promise<Lease> {
    const response = await this.#request(
      "POST",
      `/outposts/${encodeURIComponent(outpostId)}/leases/${encodeURIComponent(leaseId)}/renew`,
      ttlMs === undefined ? {} : { ttlMs }
    );
    return (await response.json()) as Lease;
  }

  /** Cancels in-flight operations under a lease without releasing it. */
  async cancelLeaseWork(outpostId: string, leaseId: string): Promise<void> {
    await this.#request(
      "POST",
      `/outposts/${encodeURIComponent(outpostId)}/leases/${encodeURIComponent(leaseId)}/cancel-work`,
      {}
    );
  }

  /**
   * Loads Pi's fixed project-context files for one leased workspace.
   *
   * This is harness startup data, not a model-visible operation. The worker
   * discovers the bounded AGENTS.md/CLAUDE.md hierarchy under its configured
   * workspace root and returns virtual paths rather than host paths.
   */
  async readContext(outpostId: string, leaseId: string): Promise<AgentContextFile[]> {
    const response = await this.#request(
      "POST",
      `/outposts/${encodeURIComponent(outpostId)}/leases/${encodeURIComponent(leaseId)}/context`,
      {}
    );
    const parsed = contextResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new OutpostClientError("Control plane returned invalid workspace context", 502);
    }
    if (!parsed.data.ok) {
      throw new OutpostClientError(
        `Outpost could not load workspace context: ${parsed.data.error ?? "unknown error"}`,
        502
      );
    }
    return parsed.data.files;
  }

  /**
   * Rotates both credentials for one still-active session generation.
   *
   * Restart state deliberately carries neither bearer. This exchange is the
   * only path by which a restarted homestead can re-adopt the generation, and an
   * unreadable response is a hard recovery failure rather than permission to
   * reuse anything from disk.
   */
  async recoverSession(
    productSessionId: string,
    sandboxId: string
  ): Promise<HomesteadRecoveryResponse> {
    const response = await this.#request("POST", "/outposts/session-recovery", {
      recoveryVersion: HOMESTEAD_RECOVERY_VERSION,
      productSessionId,
      sandboxId,
    });
    const parsed = homesteadRecoveryResponseSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (
      !parsed.success ||
      parsed.data.productSessionId !== productSessionId ||
      parsed.data.sandboxId !== sandboxId
    ) {
      throw new OutpostClientError(
        "Control plane returned an invalid session recovery response",
        502
      );
    }
    return parsed.data;
  }

  async callTool(
    outpostId: string,
    leaseId: string,
    operation: OutpostOperation,
    input: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<ToolCallResult> {
    const response = await this.#request(
      "POST",
      `/outposts/${encodeURIComponent(outpostId)}/tool`,
      {
        leaseId,
        operation,
        input,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      // Invalid input surfaces as a 400 whose body is a well-formed tool
      // failure; the caller turns it into model-visible feedback.
      [400]
    );
    return (await response.json()) as ToolCallResult;
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
    allowedErrorStatuses: number[] = []
  ): Promise<Response> {
    const url = `${this.#controlPlaneUrl}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // Signed per request rather than bearing a standing token: the signature
    // covers the method, the path and this exact body, so a captured header
    // authorizes one request and no other.
    const auth = await buildServiceAuthHeaders({
      service: "homestead",
      secret: this.#internalSecret,
      method,
      url,
      body: payload,
    });
    const response = await this.#fetch(url, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: payload }),
    });
    if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
      const text = await response.text().catch(() => "");
      throw new OutpostClientError(
        `Control plane request ${method} ${path} failed: HTTP ${response.status}${text ? `: ${text}` : ""}`,
        response.status
      );
    }
    return response;
  }
}
