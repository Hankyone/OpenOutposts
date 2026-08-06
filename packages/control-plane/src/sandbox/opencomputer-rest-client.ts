/**
 * Direct REST client for OpenComputer instances.
 *
 * RETAINED FOR FLEET-MEMBER PROVISIONING. OpenComputer no longer hosts an
 * agent: the agent runs centrally and execution happens on a machine the user
 * owns. What survives here is the instance lifecycle — create, describe, wake,
 * hibernate, delete — which the (not yet built) fleet-member creator will use
 * with the *user's own* OpenComputer credential to stand up a machine running
 * the outpost worker. Nothing in the control plane constructs this client
 * today.
 *
 * The in-sandbox supervisor launch (`startRuntime` / `runRuntimeForeground`)
 * and the checkpoint (snapshot) calls went with the in-sandbox runtime.
 *
 * The path names are intentionally configurable because OpenComputer
 * deployments may expose versioned or compatibility routes.
 */

import { createLogger } from "../logger";

const log = createLogger("opencomputer-rest-client");

export interface OpenComputerRestConfig {
  /** OpenComputer API base URL, e.g. https://api.opencomputer.dev */
  apiUrl: string;
  /** OpenComputer API key */
  apiKey: string;
  /** Declarative template identifier containing the OpenInspect runtime */
  template: string;
  /** Header used for API key authentication. Defaults to X-API-Key. */
  authHeaderName?: string;
  /** Optional prefix for the API key header value, e.g. "Bearer ". */
  authHeaderValuePrefix?: string;
  /** Optional route path overrides */
  paths?: Partial<OpenComputerApiPaths>;
}

export interface OpenComputerApiPaths {
  sandboxes: string;
  sandbox: string;
  wake: string;
  hibernate: string;
  timeout: string;
  tunnel: string;
  exec: string;
  secretStores: string;
  secretStore: string;
  secret: string;
}

export interface OpenComputerSandboxResponse {
  id: string;
  sandboxID?: string;
  state?: string;
  status?: string;
  sandboxDomain?: string;
  routes?: Array<{ port: number; url: string }>;
  tunnelUrls?: Record<string, string>;
}

export interface OpenComputerCreateSandboxParams {
  name: string;
  template: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  timeoutSeconds?: number;
  secretStore?: string;
}

export interface OpenComputerDeleteSandboxOptions {
  deleteSecretStore?: boolean;
}

export interface OpenComputerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface OpenComputerSecretStoreResponse {
  id: string;
  name: string;
  egressAllowlist?: string[];
}

export interface OpenComputerCreateSecretStoreParams {
  name: string;
  egressAllowlist?: string[];
}

export interface OpenComputerSetSecretParams {
  storeId: string;
  name: string;
  value: string;
  allowedHosts?: string[];
}

export interface OpenComputerTunnelResponse {
  url: string;
  hostname?: string;
}

export class OpenComputerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenComputerNotFoundError";
  }
}

export class OpenComputerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "OpenComputerApiError";
  }
}

const DEFAULT_PATHS: OpenComputerApiPaths = {
  sandboxes: "/sandboxes",
  sandbox: "/sandboxes/:id",
  wake: "/sandboxes/:id/wake",
  hibernate: "/sandboxes/:id/hibernate",
  timeout: "/sandboxes/:id/timeout",
  tunnel: "/sandboxes/:id/preview",
  exec: "/sandboxes/:id/exec/run",
  secretStores: "/secret-stores",
  secretStore: "/secret-stores/:id",
  secret: "/secret-stores/:id/secrets/:name",
};

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_WAKE_MS = 60_000;
const TIMEOUT_HIBERNATE_MS = 30_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_TUNNEL_MS = 15_000;
const TIMEOUT_SECRET_STORE_MS = 30_000;
export class OpenComputerRestClient {
  private readonly baseUrl: string;
  private readonly paths: OpenComputerApiPaths;

  constructor(public readonly config: OpenComputerRestConfig) {
    if (!config.apiUrl) throw new Error("OpenComputerRestClient requires apiUrl");
    if (!config.apiKey) throw new Error("OpenComputerRestClient requires apiKey");
    if (!config.template) throw new Error("OpenComputerRestClient requires template");

    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.paths = { ...DEFAULT_PATHS, ...(config.paths ?? {}) };
  }

  async createSandbox(
    params: OpenComputerCreateSandboxParams
  ): Promise<OpenComputerSandboxResponse> {
    const startMs = Date.now();
    const body: Record<string, unknown> = {
      templateID: "base",
      snapshot: params.template,
      envs: params.env,
      metadata: params.labels,
    };
    if (params.timeoutSeconds !== undefined) {
      body.timeout = params.timeoutSeconds;
    }
    if (params.secretStore) {
      body.secretStore = params.secretStore;
    }

    try {
      const response = await this.request<OpenComputerSandboxResponse>(
        "POST",
        this.paths.sandboxes,
        TIMEOUT_CREATE_MS,
        body
      );
      return this.normalizeSandbox(response);
    } finally {
      log.info("opencomputer.create_sandbox", {
        duration_ms: Date.now() - startMs,
        sandbox_name: params.name,
      });
    }
  }

  async createSecretStore(
    params: OpenComputerCreateSecretStoreParams
  ): Promise<OpenComputerSecretStoreResponse> {
    return await this.request<OpenComputerSecretStoreResponse>(
      "POST",
      this.paths.secretStores,
      TIMEOUT_SECRET_STORE_MS,
      {
        name: params.name,
        egressAllowlist: params.egressAllowlist,
      }
    );
  }

  async setSecret(params: OpenComputerSetSecretParams): Promise<void> {
    await this.request<void>(
      "PUT",
      this.expandPath(this.paths.secret, {
        id: params.storeId,
        name: params.name,
      }),
      TIMEOUT_SECRET_STORE_MS,
      {
        value: params.value,
        allowedHosts: params.allowedHosts,
      }
    );
  }

  async deleteSecretStore(id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      this.expandPath(this.paths.secretStore, { id }),
      TIMEOUT_SECRET_STORE_MS
    );
  }

  async getSandbox(id: string): Promise<OpenComputerSandboxResponse> {
    const response = await this.request<OpenComputerSandboxResponse>(
      "GET",
      this.expandPath(this.paths.sandbox, { id }),
      TIMEOUT_GET_MS
    );
    return this.normalizeSandbox(response);
  }

  async wakeSandbox(id: string): Promise<OpenComputerSandboxResponse | void> {
    const response = await this.request<OpenComputerSandboxResponse | void>(
      "POST",
      this.expandPath(this.paths.wake, { id }),
      TIMEOUT_WAKE_MS
    );
    return response ? this.normalizeSandbox(response) : response;
  }

  async hibernateSandbox(id: string): Promise<void> {
    await this.request<void>(
      "POST",
      this.expandPath(this.paths.hibernate, { id }),
      TIMEOUT_HIBERNATE_MS
    );
  }

  async setSandboxTimeout(id: string, timeoutSeconds: number): Promise<void> {
    await this.request<void>("POST", this.expandPath(this.paths.timeout, { id }), TIMEOUT_GET_MS, {
      timeout: timeoutSeconds,
    });
  }

  async deleteSandbox(id: string, options?: OpenComputerDeleteSandboxOptions): Promise<void> {
    const params = new URLSearchParams();
    if (options?.deleteSecretStore) params.set("deleteSecretStore", "true");
    const query = params.toString() ? `?${params.toString()}` : "";
    await this.request<void>(
      "DELETE",
      `${this.expandPath(this.paths.sandbox, { id })}${query}`,
      TIMEOUT_GET_MS
    );
  }

  async getTunnelUrl(id: string, port: number): Promise<OpenComputerTunnelResponse> {
    const response = await this.request<OpenComputerTunnelResponse>(
      "POST",
      this.expandPath(this.paths.tunnel, { id, port: String(port) }),
      TIMEOUT_TUNNEL_MS,
      { port }
    );
    return {
      ...response,
      url: response.url ?? (response.hostname ? `https://${response.hostname}` : ""),
    };
  }

  private getHeaders(): Record<string, string> {
    const authHeaderName = this.config.authHeaderName ?? "X-API-Key";
    return {
      "Content-Type": "application/json",
      [authHeaderName]: `${this.config.authHeaderValuePrefix ?? ""}${this.config.apiKey}`,
    };
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
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
        const text = await response.text();
        throw new OpenComputerNotFoundError(text || `Not found: ${path}`);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new OpenComputerApiError(text || response.statusText, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }
      return undefined as T;
    } catch (error) {
      // The per-call timeout fires controller.abort(); the resulting AbortError
      // — from fetch OR a body read — must surface as an attributed timeout so
      // it is actionable in logs and build error_messages. The message must
      // contain "timeout" so SandboxProviderError classifies it transient
      // (isTransientNetworkError), not permanent — otherwise it trips the
      // circuit breaker. Our typed API errors (OpenComputer*Error) have
      // distinct names and rethrow unchanged.
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`OpenComputer request timeout after ${timeoutMs}ms (${method} ${path})`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private expandPath(path: string, params: Record<string, string>): string {
    let expanded = path;
    for (const [key, value] of Object.entries(params)) {
      expanded = expanded.replace(`:${key}`, encodeURIComponent(value));
    }
    return expanded;
  }

  private shellExportEnv(env: Record<string, string>): string {
    const entries = Object.entries(env).filter(([, value]) => value.length > 0);
    if (entries.length === 0) return "";
    return `${entries.map(([key, value]) => `${key}=${this.shellQuote(value)}`).join(" ")} `;
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private normalizeSandbox(response: OpenComputerSandboxResponse): OpenComputerSandboxResponse {
    const id = response.id || response.sandboxID;
    if (!id) return response;
    return { ...response, id };
  }
}

export function createOpenComputerRestClient(
  config: OpenComputerRestConfig
): OpenComputerRestClient {
  return new OpenComputerRestClient(config);
}
