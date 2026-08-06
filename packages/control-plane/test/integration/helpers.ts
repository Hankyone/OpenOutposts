import { SELF, env, runInDurableObject } from "cloudflare:test";
import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared";
import type { SandboxStatus } from "../../src/types";
import type { SessionDO } from "../../src/session/durable-object";
import { hashToken } from "../../src/auth/crypto";
import { ApiTokenStore } from "../../src/db/api-tokens";
import { UserStore } from "../../src/db/user-store";
import { WebSessionTokenService } from "../../src/auth/web-session-tokens";
import { base64UrlEncode } from "../../src/auth/encoding";
import { canonicalOutpostProof } from "../../src/auth/outpost";

const DEFAULT_WAIT_FOR_SANDBOX_STATUS_TIMEOUT_MS = 3000;

/**
 * Fetch a control-plane route as a service principal. Signs per request —
 * sig1 binds method, URL, and body, so headers can never be reused across
 * calls. Defaults to the `web` service; secrets follow the
 * `test-service-secret-<service>` bindings in vitest.integration.config.ts.
 */
export async function serviceFetch(
  url: string,
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    service?: ServiceName;
    actor?: string;
  }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const service = init?.service ?? "web";
  const auth = await buildServiceAuthHeaders({
    service,
    secret: `test-service-secret-${service}`,
    method,
    url,
    body: init?.body,
    actor: init?.actor,
  });
  return SELF.fetch(url, {
    method,
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
      ...auth,
    },
    body: init?.body,
  });
}

/**
 * Create a canonical user and mint a web session token for them, so a test can
 * call the control plane as that signed-in user. Takes the same path
 * production does — a real `api_tokens` row and a real `oi_at_` token — rather
 * than fabricating a principal.
 */
export async function createSignedInUser(providerUserId: string): Promise<{
  userId: string;
  accessToken: string;
}> {
  const user = await new UserStore(env.DB).resolveOrCreateUser({
    provider: "github",
    providerUserId,
    providerLogin: `user-${providerUserId}`,
  });
  const pair = await new WebSessionTokenService(new ApiTokenStore(env.DB)).mintPair(user.id, {
    provider: "github",
    providerUserId,
  });
  return { userId: user.id, accessToken: pair.accessToken };
}

export interface TestMachineIdentity {
  outpostId: string;
  ownerUserId: string;
  ownerAccessToken: string;
  keyFingerprint: string;
  privateKey: CryptoKey;
}

/** Seed a fully confirmed machine with a real Ed25519 identity. */
export async function seedConfirmedOutpost(
  outpostId: string,
  owner?: { userId: string; accessToken: string }
): Promise<TestMachineIdentity> {
  const machineOwner = owner ?? (await createSignedInUser(`owner-${outpostId}`));
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const keyFingerprint = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey))
  );
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO outposts (
       id, name, worker_version, platform, architecture, connected,
       connected_at, last_seen_at, disconnected_at, owner_user_id,
       public_key, key_algorithm, key_fingerprint, enrolled_at,
       enrolled_by_user_id, confirmed_at, access_scope, workspace_roots_json
     ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, 'ed25519', ?, ?, ?, ?, 'full', ?)`
  )
    .bind(
      outpostId,
      "Test workstation",
      "0.1.0-test",
      "darwin",
      "arm64",
      now,
      now,
      machineOwner.userId,
      base64UrlEncode(publicKey),
      keyFingerprint,
      now,
      machineOwner.userId,
      now,
      JSON.stringify(["/workspace"])
    )
    .run();
  return {
    outpostId,
    ownerUserId: machineOwner.userId,
    ownerAccessToken: machineOwner.accessToken,
    keyFingerprint,
    privateKey: keyPair.privateKey,
  };
}

/** Seed a confirmed execution target when a test exercises session ownership only. */
export async function seedSessionOutpost(
  ownerUserId: string,
  outpostId = "integration-outpost"
): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO outposts (
       id, name, worker_version, platform, architecture, connected,
       connected_at, last_seen_at, disconnected_at, owner_user_id,
       enrolled_at, enrolled_by_user_id, confirmed_at, access_scope,
       workspace_roots_json
     ) VALUES (?, ?, 'test', 'linux', 'amd64', 0, ?, ?, NULL, ?, ?, ?, ?, 'full', ?)
     ON CONFLICT(id) DO UPDATE SET
       owner_user_id = excluded.owner_user_id,
       enrolled_by_user_id = excluded.enrolled_by_user_id,
       confirmed_at = excluded.confirmed_at,
       revoked_at = NULL`
  )
    .bind(
      outpostId,
      `Session target ${outpostId}`,
      now,
      now,
      ownerUserId,
      now,
      ownerUserId,
      now,
      JSON.stringify(["/workspace"])
    )
    .run();
  return outpostId;
}

/**
 * Call the control plane the way the homestead does: a sig1 signature that
 * covers the method, the path and this exact body.
 *
 * There is no standing bearer to forge any more, so a test that reaches a
 * machine route has to sign for the request it is actually making.
 */
export async function homesteadFetch(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const auth = await homesteadHeaders(method, url, init?.body);
  return SELF.fetch(url, {
    method,
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
      ...auth,
    },
    body: init?.body,
  });
}

/** The sig1 headers the homestead would send for one request. */
export async function homesteadHeaders(
  method: string,
  url: string,
  body?: string
): Promise<Record<string, string>> {
  return buildServiceAuthHeaders({
    service: "homestead",
    secret: "test-service-secret-homestead",
    method,
    url,
    body,
  });
}

/**
 * Seed the session-index row a lease is taken for.
 *
 * A lease is only granted when the session's owner also owns the machine, so a
 * test that takes a lease has to model both halves. Passing a session id that
 * has no row is what an attacker's request looks like, not what the product's
 * does.
 */
export async function seedIndexedSession(sessionId: string, userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, title, repo_owner, repo_name, model, status, created_at, updated_at, user_id)
     VALUES (?, ?, 'acme', 'web-app', 'test-model', 'created', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id`
  )
    .bind(sessionId, `Session ${sessionId}`, now, now, userId)
    .run();
}

/** Build one-use signed headers for a machine HTTP or WebSocket request. */
export async function machineProofHeaders(
  machine: TestMachineIdentity,
  method: string,
  path: string
): Promise<Record<string, string>> {
  const timestamp = Date.now().toString();
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    machine.privateKey,
    new TextEncoder().encode(
      canonicalOutpostProof(method, path, machine.outpostId, timestamp, nonce)
    )
  );
  return {
    "X-OpenOutposts-Timestamp": timestamp,
    "X-OpenOutposts-Nonce": nonce,
    "X-OpenOutposts-Signature": base64UrlEncode(new Uint8Array(signature)),
    "X-OpenOutposts-Key-Fingerprint": machine.keyFingerprint,
  };
}

export async function connectConfirmedOutpost(machine: TestMachineIdentity): Promise<{
  response: Response;
  ws: WebSocket | null;
}> {
  const path = `/outposts/${machine.outpostId}/connect`;
  const response = await SELF.fetch(`https://test.local${path}`, {
    headers: {
      Upgrade: "websocket",
      ...(await machineProofHeaders(machine, "GET", path)),
    },
  });
  const ws = response.webSocket;
  if (ws) ws.accept();
  return { response, ws };
}

/**
 * Create a fresh DO, call /internal/init, return the stub and id.
 */
export async function initSession(overrides?: {
  sessionName?: string;
  repoOwner?: string;
  repoName?: string;
  repoId?: number;
  defaultBranch?: string;
  repositories?: Array<{
    repoOwner: string;
    repoName: string;
    repoId: number;
    baseBranch: string;
  }>;
  environmentId?: string | null;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  userId?: string;
  scmLogin?: string;
}) {
  const id = env.SESSION.newUniqueId();
  const stub = env.SESSION.get(id);
  const defaults = {
    sessionName: `test-${Date.now()}`,
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    userId: "user-1",
    ...overrides,
  };
  const res = await stub.fetch("http://internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  if (res.status !== 200) throw new Error(`Init failed: ${res.status}`);
  return { stub, id };
}

/**
 * Query the DO's SQLite via runInDurableObject.
 */
export async function queryDO<T>(
  stub: DurableObjectStub,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  return runInDurableObject(stub, (instance: SessionDO) => {
    return instance.ctx.storage.sql.exec(sql, ...params).toArray() as T[];
  });
}

export async function waitForSandboxStatus(
  stub: DurableObjectStub,
  status: string,
  timeoutMs = DEFAULT_WAIT_FOR_SANDBOX_STATUS_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const rows = await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox");
    lastStatus = rows[0]?.status;
    if (lastStatus === status) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for sandbox status "${status}"; last status was "${lastStatus ?? "missing"}"`
  );
}

/**
 * Seed events directly into DO SQLite.
 */
export async function seedEvents(
  stub: DurableObjectStub,
  events: Array<{
    id: string;
    type: string;
    data: string;
    messageId?: string;
    createdAt: number;
  }>
): Promise<void> {
  await runInDurableObject(stub, (instance: SessionDO) => {
    for (const e of events) {
      instance.ctx.storage.sql.exec(
        "INSERT INTO events (id, type, data, message_id, created_at) VALUES (?, ?, ?, ?, ?)",
        e.id,
        e.type,
        e.data,
        e.messageId ?? null,
        e.createdAt
      );
    }
  });
}

/**
 * Seed a message directly into DO SQLite.
 */
export async function seedMessage(
  stub: DurableObjectStub,
  msg: {
    id: string;
    authorId: string;
    content: string;
    source: string;
    status: string;
    createdAt: number;
    startedAt?: number;
  }
): Promise<void> {
  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "INSERT INTO messages (id, author_id, content, source, status, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      msg.id,
      msg.authorId,
      msg.content,
      msg.source,
      msg.status,
      msg.createdAt,
      msg.startedAt ?? null
    );
  });
}

// ---------------------------------------------------------------------------
// WebSocket test helpers
// ---------------------------------------------------------------------------

/**
 * Create a session using idFromName() so the worker's /sessions/:name/ws
 * route can locate the DO via the same name. Returns stub + sessionName.
 */
export async function initNamedSession(
  sessionName: string,
  overrides?: {
    repoOwner?: string;
    repoName?: string;
    repoId?: number;
    defaultBranch?: string;
    repositories?: Array<{
      repoOwner: string;
      repoName: string;
      repoId: number;
      baseBranch: string;
    }>;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    userId?: string;
    scmLogin?: string;
    outpostId?: string;
  }
) {
  const id = env.SESSION.idFromName(sessionName);
  const stub = env.SESSION.get(id);
  const defaults = {
    sessionName,
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    userId: "user-1",
    ...overrides,
  };
  const res = await stub.fetch("http://internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  if (res.status !== 200) throw new Error(`Init failed: ${res.status}`);
  return { stub, id, sessionName };
}

/**
 * Collect JSON messages from a WebSocket until a predicate matches or timeout.
 * Starts listening immediately — call BEFORE sending the message that triggers responses.
 */
export function collectMessages(
  ws: WebSocket,
  opts?: { until?: (msg: Record<string, unknown>) => boolean; timeoutMs?: number }
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const messages: Record<string, unknown>[] = [];
    const timeout = opts?.timeoutMs ?? 2000;
    const timer = setTimeout(() => resolve(messages), timeout);

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");
      messages.push(msg);
      if (opts?.until?.(msg)) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}

/**
 * Open a client WebSocket via SELF.fetch (full worker routing path).
 * Optionally subscribe by generating a WS token and completing the subscribe flow.
 */
export async function openClientWs(
  sessionName: string,
  opts?: { subscribe?: boolean; userId?: string }
) {
  const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/ws`, {
    headers: { Upgrade: "websocket" },
  });

  const ws = response.webSocket;
  if (!ws) throw new Error("No webSocket on response");
  ws.accept();

  if (!opts?.subscribe) {
    return { ws };
  }

  // Generate a WS token via the DO
  const id = env.SESSION.idFromName(sessionName);
  const stub = env.SESSION.get(id);
  const tokenRes = await stub.fetch("http://internal/internal/ws-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: opts.userId ?? "user-1" }),
  });
  const { token, participantId } = await tokenRes.json<{
    token: string;
    participantId: string;
  }>();

  // Start collecting BEFORE sending subscribe to avoid race.
  // The subscribed message now includes batched replay data, so we terminate on it
  // (presence_sync follows but is not needed for most tests).
  const collector = collectMessages(ws, {
    until: (msg) => msg.type === "subscribed",
  });

  ws.send(
    JSON.stringify({
      type: "subscribe",
      token,
      clientId: `test-client-${Date.now()}`,
    })
  );

  const messages = await collector;
  return { ws, token, participantId, messages };
}

/**
 * Open a sandbox WebSocket via SELF.fetch (full worker routing path).
 * Returns the WebSocket (or null if upgrade failed) and the raw response.
 */
export async function openSandboxWs(
  sessionName: string,
  opts: { authToken: string; sandboxId: string }
) {
  const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/ws?type=sandbox`, {
    headers: {
      Upgrade: "websocket",
      Authorization: `Bearer ${opts.authToken}`,
      "X-Sandbox-ID": opts.sandboxId,
    },
  });
  return { ws: response.webSocket ?? null, response };
}

/**
 * Seed a sandbox with its bridge token's hash, optionally its credential-fetch
 * token's hash, and modal_sandbox_id so sandbox auth can pass, in the given
 * lifecycle status (default: the "ready" steady state). Waits out the
 * (always-failing) test spawn first so its status write can't clobber the
 * seeded status.
 */
export async function seedSandboxAuth(
  stub: DurableObjectStub,
  opts: {
    authToken: string;
    sandboxId: string;
    status?: SandboxStatus;
    credentialFetchToken?: string;
  }
): Promise<void> {
  await waitForSandboxStatus(stub, "failed");
  const tokenHash = await hashToken(opts.authToken);
  const fetchTokenHash = opts.credentialFetchToken
    ? await hashToken(opts.credentialFetchToken)
    : null;

  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "UPDATE sandbox SET auth_token_hash = ?, auth_token = NULL, credential_fetch_token_hash = ?, modal_sandbox_id = ?, status = ?",
      tokenHash,
      fetchTokenHash,
      opts.sandboxId,
      opts.status ?? "ready"
    );
  });
}

/**
 * Seed a sandbox the way rows looked before token hashing existed: the token
 * stored in the clear, with no hash beside it. Used to prove such a row is
 * refused rather than accepted by a plaintext comparison.
 */
export async function seedLegacyPlaintextSandboxAuth(
  stub: DurableObjectStub,
  opts: { authToken: string; sandboxId: string; status?: SandboxStatus }
): Promise<void> {
  await waitForSandboxStatus(stub, "failed");

  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "UPDATE sandbox SET auth_token = ?, auth_token_hash = NULL, modal_sandbox_id = ?, status = ?",
      opts.authToken,
      opts.sandboxId,
      opts.status ?? "ready"
    );
  });
}

/** Read a sandbox row's stored credential columns, for assertions about them. */
export async function readSandboxTokenColumns(stub: DurableObjectStub): Promise<{
  auth_token: string | null;
  auth_token_hash: string | null;
  credential_fetch_token_hash: string | null;
}> {
  return runInDurableObject(stub, (instance: SessionDO) => {
    const rows = instance.ctx.storage.sql
      .exec("SELECT auth_token, auth_token_hash, credential_fetch_token_hash FROM sandbox LIMIT 1")
      .toArray() as Array<{
      auth_token: string | null;
      auth_token_hash: string | null;
      credential_fetch_token_hash: string | null;
    }>;
    return (
      rows[0] ?? {
        auth_token: null,
        auth_token_hash: null,
        credential_fetch_token_hash: null,
      }
    );
  });
}

/**
 * Seed a sandbox with auth_token_hash and modal_sandbox_id, in the given
 * lifecycle status (default: the "ready" steady state). Waits out the
 * (always-failing) test spawn first so its status write can't clobber the
 * seeded status.
 */
export async function seedSandboxAuthHash(
  stub: DurableObjectStub,
  opts: { authToken: string; sandboxId: string; status?: SandboxStatus }
): Promise<void> {
  await waitForSandboxStatus(stub, "failed");
  const tokenHash = await hashToken(opts.authToken);

  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "UPDATE sandbox SET auth_token_hash = ?, auth_token = NULL, modal_sandbox_id = ?, status = ?",
      tokenHash,
      opts.sandboxId,
      opts.status ?? "ready"
    );
  });
}
