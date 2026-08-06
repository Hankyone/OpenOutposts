/**
 * Direct REST client for the E2B instance API.
 *
 * RETAINED FOR FLEET-MEMBER PROVISIONING. E2B no longer hosts an agent: the
 * agent runs centrally and execution happens on a machine the user owns. What
 * survives here is the instance lifecycle — create, describe, pause, connect,
 * kill, set TTL — which the (not yet built) fleet-member creator will use with
 * the *user's own* E2B credential to stand up a machine running the outpost
 * worker. Nothing in the control plane constructs this client today.
 *
 * The per-session env upload (`writeSessionEnv`) went with the in-sandbox
 * runtime: it existed only to hand the supervisor its session config.
 *
 * Wire-level details verified against the E2B API reference:
 * https://e2b.dev/docs/api-reference
 */

import { createLogger } from "../logger";

const log = createLogger("e2b-rest-client");

export interface E2BRestConfig {
  apiUrl: string;
  apiKey: string;
  templateId: string;
}

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_CONNECT_MS = 60_000;
const TIMEOUT_PAUSE_MS = 30_000;
const TIMEOUT_KILL_MS = 30_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_SETTTL_MS = 15_000;

export interface E2BSandboxDetail {
  sandboxID: string;
  templateID: string;
  state: "running" | "paused" | "killed" | string;
  startedAt?: string;
  endAt?: string;
  /** Custom sandbox domain for dedicated clusters; null/absent on the default cloud. */
  domain?: string | null;
}

export interface E2BSandboxCreated {
  sandboxID: string;
  templateID: string;
  /** Custom envd domain for dedicated clusters; null/absent on the default cloud. */
  domain?: string | null;
  /** envd access token; returned only when the sandbox is created with secure:true, null otherwise. */
  envdAccessToken?: string | null;
}

/** Default sandbox host suffix (overridden by the create response `domain`). */
const DEFAULT_SANDBOX_DOMAIN = "e2b.app";
export interface E2BCreateSandboxParams {
  templateID: string;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutSeconds?: number;
  /** Pause (not kill) the sandbox when its timeout expires. */
  autoPause?: boolean;
  /** Wake a paused sandbox on inbound activity (only meaningful with autoPause). */
  autoResume?: boolean;
  /**
   * Require an access token to reach envd (returned as `envdAccessToken`). Without it,
   * envd accepts unauthenticated reads/writes of the uploaded session env.
   */
  secure?: boolean;
}

export class E2BNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BNotFoundError";
  }
}

export class E2BConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BConflictError";
  }
}

export class E2BApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: { code?: string; message?: string } | string
  ) {
    super(message);
    this.name = "E2BApiError";
  }
}

export class E2BRestClient {
  private readonly baseUrl: string;

  constructor(public readonly config: E2BRestConfig) {
    if (!config.apiUrl) throw new Error("E2BRestClient requires apiUrl");
    if (!config.apiKey) throw new Error("E2BRestClient requires apiKey");
    if (!config.templateId) throw new Error("E2BRestClient requires templateId");
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
  }

  async createSandbox(params: E2BCreateSandboxParams): Promise<E2BSandboxCreated> {
    const startMs = Date.now();
    try {
      return await this.request<E2BSandboxCreated>("POST", "/sandboxes", TIMEOUT_CREATE_MS, {
        templateID: params.templateID,
        envVars: params.envVars,
        metadata: params.metadata,
        timeout: params.timeoutSeconds,
        secure: params.secure ?? false,
        autoPause: params.autoPause ?? false,
        autoResume: { enabled: params.autoResume ?? false },
      });
    } finally {
      log.info("e2b.create_sandbox", {
        duration_ms: Date.now() - startMs,
        template_id: params.templateID,
      });
    }
  }

  async getSandbox(id: string): Promise<E2BSandboxDetail> {
    return this.request<E2BSandboxDetail>("GET", `/sandboxes/${id}`, TIMEOUT_GET_MS);
  }

  async pauseSandbox(id: string): Promise<void> {
    await this.request<void>("POST", `/sandboxes/${id}/pause`, TIMEOUT_PAUSE_MS);
  }

  async connectSandbox(id: string, timeoutSeconds: number): Promise<E2BSandboxDetail> {
    return this.request<E2BSandboxDetail>("POST", `/sandboxes/${id}/connect`, TIMEOUT_CONNECT_MS, {
      timeout: timeoutSeconds,
    });
  }

  async killSandbox(id: string): Promise<void> {
    await this.request<void>("DELETE", `/sandboxes/${id}`, TIMEOUT_KILL_MS);
  }

  async setSandboxTimeout(id: string, timeoutSeconds: number): Promise<void> {
    await this.request<void>("POST", `/sandboxes/${id}/timeout`, TIMEOUT_SETTTL_MS, {
      timeout: timeoutSeconds,
    });
  }

  getHostnameForPort(sandboxId: string, port: number, domain?: string | null): string {
    return `https://${port}-${sandboxId}.${domain || DEFAULT_SANDBOX_DOMAIN}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.config.apiKey,
    };
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    timeoutMs: number,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: this.getHeaders(),
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);

      const response = await fetch(url, init);

      if (response.status === 404) {
        throw new E2BNotFoundError((await response.text()) || `Not found: ${path}`);
      }
      if (response.status === 409) {
        throw new E2BConflictError((await response.text()) || `Conflict: ${path}`);
      }
      if (!response.ok) {
        const text = await response.text();
        let parsedBody: { code?: string; message?: string } | string | undefined = text;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json") && text) {
          try {
            parsedBody = JSON.parse(text) as { code?: string; message?: string };
          } catch {
            parsedBody = text;
          }
        }
        throw new E2BApiError(text || response.statusText, response.status, parsedBody);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }
      return undefined as T;
    } catch (error) {
      // A timeout fires controller.abort(); the resulting AbortError — from
      // fetch OR a body read — must surface as a transient timeout so it isn't
      // classified permanent and trip the circuit breaker. Our typed API errors
      // (E2B*Error) have distinct names and rethrow unchanged.
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`E2B request timeout after ${timeoutMs}ms (${method} ${path})`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createE2BRestClient(config: E2BRestConfig): E2BRestClient {
  return new E2BRestClient(config);
}
