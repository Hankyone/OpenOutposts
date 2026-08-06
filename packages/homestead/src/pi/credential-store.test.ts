import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  createSessionCredentialStore,
  IssuedCredentialStore,
  ModelCredentialUnavailableError,
  unconfiguredCredentialStore,
  type ResolvedModelCredential,
} from "./credential-store.js";
import { ModelCredentialError, type ModelCredentialRequest } from "./model-credential.js";

/**
 * The behaviour these tests exist for: Pi caches an auth command's stdout in a
 * process-lifetime Map keyed on the command string, so under the mechanism this
 * store replaces an expiry bounded nothing, a revoked credential kept working
 * until the homestead restarted, and one transient failure was cached as the
 * session's answer forever. Each of those three is asserted against here.
 */

const HOUR_MS = 60 * 60 * 1000;

/** A clock the test moves by hand, so expiry is exercised rather than waited for. */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/**
 * An issuer under the test's control. Each call returns the next key and, by
 * default, an hour of life from the current clock reading.
 */
function fakeIssuer(clock: { now: () => number }) {
  const state = {
    calls: 0,
    ttlMs: HOUR_MS as number | undefined,
    fail: null as Error | null,
  };
  const issue = (): Promise<ResolvedModelCredential> => {
    state.calls += 1;
    if (state.fail) return Promise.reject(state.fail);
    return Promise.resolve({
      apiKey: `sk-key-${state.calls}`,
      ...(state.ttlMs === undefined ? {} : { expiresAtEpochMs: clock.now() + state.ttlMs }),
    });
  };
  return { state, issue };
}

function storeFor(clock: ReturnType<typeof fakeClock>, issuer: ReturnType<typeof fakeIssuer>) {
  return new IssuedCredentialStore({
    providerId: "anthropic",
    issue: issuer.issue,
    now: clock.now,
    // A skew of zero keeps these tests about the expiry itself; the skew has
    // its own test below.
    refreshSkewMs: 0,
  });
}

describe("IssuedCredentialStore", () => {
  it("issues once and serves that credential until it expires", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);

    await store.revalidate();
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-key-1" });

    clock.advance(HOUR_MS - 1);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-key-1" });
    expect(issuer.state.calls).toBe(1);
  });

  // The headline property. Under the mechanism this replaces, the credential
  // read here would still be sk-key-1 for as long as the homestead process lived.
  it("re-fetches the credential once it has expired, mid-session", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);

    await store.revalidate();
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-key-1" });

    clock.advance(HOUR_MS);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-key-2" });
    expect(issuer.state.calls).toBe(2);
  });

  it("treats a credential inside the refresh skew as already due", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = new IssuedCredentialStore({
      providerId: "anthropic",
      issue: issuer.issue,
      now: clock.now,
      refreshSkewMs: 60_000,
    });

    await store.revalidate();
    // Still valid by the issuer's clock, but not for long enough to cover a
    // request that is about to be made.
    clock.advance(HOUR_MS - 30_000);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-key-2" });
  });

  it("coalesces concurrent reads onto one issuance", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);

    const [first, second] = await Promise.all([store.read("anthropic"), store.read("anthropic")]);

    expect(first).toEqual(second);
    expect(issuer.state.calls).toBe(1);
  });

  describe("when the credential is revoked", () => {
    it("stops serving the credential it is holding", async () => {
      const clock = fakeClock();
      const issuer = fakeIssuer(clock);
      const store = storeFor(clock, issuer);

      await store.revalidate();
      expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-key-1" });

      // The vault entry is removed between turns; the next issuance is refused.
      issuer.state.fail = new ModelCredentialError(
        "control plane refused to issue a credential (HTTP 404): No credential is connected for provider 'anthropic'",
        { retryable: false, status: 404 }
      );

      await expect(store.revalidate()).rejects.toBeInstanceOf(ModelCredentialUnavailableError);
      // The key it was holding a moment ago must not answer the next request.
      await expect(store.read("anthropic")).rejects.toBeInstanceOf(ModelCredentialUnavailableError);
    });

    it("says whose credential it was and what the control plane said", async () => {
      const clock = fakeClock();
      const issuer = fakeIssuer(clock);
      const store = storeFor(clock, issuer);
      issuer.state.fail = new ModelCredentialError(
        "control plane refused to issue a credential (HTTP 404): No credential is connected for provider 'anthropic'",
        { retryable: false, status: 404 }
      );

      const failure = (await store
        .revalidate()
        .catch((error: unknown) => error)) as ModelCredentialUnavailableError;

      expect(failure.providerId).toBe("anthropic");
      expect(failure.retryable).toBe(false);
      expect(failure.message).toContain("No credential is connected");
      expect(failure.message).toContain("account that owns this session");
      // Never a generic transient error: a refusal about this user's own vault
      // must not read like the deployment being briefly broken.
      expect(failure.message).not.toContain("could not be refreshed");
      expect(store.failure()).toBe(failure);
    });

    it("keeps the reason available for the turn that hits it", async () => {
      const clock = fakeClock();
      const issuer = fakeIssuer(clock);
      const store = storeFor(clock, issuer);

      await store.revalidate();
      expect(store.failure()).toBeNull();

      clock.advance(HOUR_MS);
      issuer.state.fail = new ModelCredentialError("credential storage unavailable", {
        retryable: true,
      });
      await expect(store.read("anthropic")).rejects.toThrow();

      const failure = store.failure();
      expect(failure?.retryable).toBe(true);
      expect(failure?.message).toContain("could not be refreshed");
    });
  });

  // The other half of Pi's cache: a failure was cached exactly like a success,
  // so one bad moment at first use poisoned the session permanently.
  it("does not keep a failure as the answer once an issuance succeeds", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);

    issuer.state.fail = new ModelCredentialError("could not reach the control plane", {
      retryable: true,
    });
    await expect(store.revalidate()).rejects.toThrow();
    expect(store.failure()).not.toBeNull();

    issuer.state.fail = null;
    await store.revalidate();

    expect(store.failure()).toBeNull();
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-key-2" });
  });

  it("replays a recorded refusal instead of re-asking within the same turn", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);
    issuer.state.fail = new ModelCredentialError("No credential is connected", {
      retryable: false,
      status: 404,
    });

    await expect(store.revalidate()).rejects.toThrow();
    await expect(store.read("anthropic")).rejects.toThrow();
    await expect(store.read("anthropic")).rejects.toThrow();

    // One refusal, not one per model request the doomed turn would have made.
    expect(issuer.state.calls).toBe(1);
  });

  it("answers for no provider but the session's own", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);
    await store.revalidate();

    expect(await store.read("openai")).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
  });

  it("lists without spending an issuance", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);

    await store.list();

    expect(issuer.state.calls).toBe(0);
  });

  it("refuses to be written from the agent process", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);

    await expect(store.modify()).rejects.toThrow(/cannot be written from the agent process/);
  });
});

describe("unconfiguredCredentialStore", () => {
  /**
   * Reporting "nothing stored" is how a pi-ai credential store sends resolution
   * to the ambient environment. On a shared homestead that is the operator's own
   * key answering for a user who configured none, which is precisely the
   * substitution this product refuses to make.
   */
  it("refuses rather than reporting nothing stored", async () => {
    const store = unconfiguredCredentialStore("the session's model names no provider");

    await expect(store.read("anthropic")).rejects.toBeInstanceOf(ModelCredentialUnavailableError);
    await expect(store.revalidate()).rejects.toThrow(/no model credential configured/);
    expect(store.failure()?.message).toContain("nothing can be used in its place");
    expect(await store.list()).toEqual([]);
  });
});

describe("createSessionCredentialStore", () => {
  const request: ModelCredentialRequest = {
    controlPlaneUrl: "https://control.example",
    productSessionId: "session-01",
    provider: "anthropic",
    credentialFetchToken: "credential-fetch-token",
  };

  it("carries the control plane's own expiry, and re-fetches once it passes", async () => {
    const clock = fakeClock();
    let issued = 0;
    const store = createSessionCredentialStore(
      { kind: "brokered", providerId: "anthropic", request },
      {
        now: clock.now,
        refreshSkewMs: 0,
        fetchImpl: (() => {
          issued += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                provider: "anthropic",
                api_key: `sk-ant-${issued}`,
                expires_at_epoch_ms: clock.now() + HOUR_MS,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }) as unknown as typeof fetch,
      }
    );

    await store.revalidate();
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-1" });
    clock.advance(HOUR_MS);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-2" });
    expect(issued).toBe(2);
  });

  it("turns the control plane's refusal into an attributable message", async () => {
    const store = createSessionCredentialStore(
      { kind: "brokered", providerId: "anthropic", request },
      {
        fetchImpl: (() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: "No credential is connected for provider 'anthropic'" }),
              { status: 404, headers: { "Content-Type": "application/json" } }
            )
          )) as unknown as typeof fetch,
      }
    );

    await expect(store.revalidate()).rejects.toThrow(/No credential is connected/);
    expect(store.failure()?.retryable).toBe(false);
  });

  describe("the development key command", () => {
    it("runs the command and keeps its output for the session", async () => {
      const store = createSessionCredentialStore({
        kind: "key-command",
        providerId: "anthropic",
        keyCommand: "printf sk-dev-key",
      });

      await store.revalidate();
      expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-dev-key" });
      // A static operator key has no issued lifetime, so it never falls due
      // inside a turn; it is still re-run at every turn boundary.
      expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-dev-key" });
    });

    it("re-runs the command at every turn boundary", async () => {
      // A counter on disk, so "the command ran again" is asserted rather than
      // inferred: an operator who rotates the key must not have to restart the
      // homestead for a session to see it.
      const dir = await mkdtemp(join(tmpdir(), "openoutposts-keycmd-"));
      const counter = join(dir, "runs");
      try {
        const store = createSessionCredentialStore({
          kind: "key-command",
          providerId: "anthropic",
          keyCommand: `printf x >> '${counter}'; printf 'sk-dev-%s' "$(wc -c < '${counter}' | tr -d ' ')"`,
        });

        await store.revalidate();
        expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-dev-1" });
        await store.revalidate();
        expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-dev-2" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("reports a command that prints nothing rather than sending an empty key", async () => {
      const store = createSessionCredentialStore({
        kind: "key-command",
        providerId: "anthropic",
        keyCommand: "true",
      });

      await expect(store.revalidate()).rejects.toThrow(/printed nothing/);
    });

    it("reports the failing command's own diagnosis", async () => {
      const store = createSessionCredentialStore({
        kind: "key-command",
        providerId: "anthropic",
        keyCommand: "echo 'no key in this environment' >&2; exit 1",
      });

      await expect(store.revalidate()).rejects.toThrow(/no key in this environment/);
    });
  });
});

/**
 * The store only means anything if Pi actually reads it on the request path.
 * This asserts that against Pi itself rather than against our reading of it:
 * `getAuth` is exactly what `ModelRuntime.prepareRequest` calls before every
 * stream, so a key that changes here is a key the next model request would use.
 *
 * Offline: Pi resolves the model from its bundled catalogue and no request is
 * made.
 */
describe("Pi's own resolution path", () => {
  it("resolves the key through this store, and picks up a re-issue", async () => {
    const clock = fakeClock();
    const issuer = fakeIssuer(clock);
    const store = storeFor(clock, issuer);
    await store.revalidate();

    const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null });
    const model = runtime.getModel("anthropic", "claude-sonnet-4-5");
    if (!model) throw new Error("Pi's bundled catalogue no longer carries the offline test model");

    expect((await runtime.getAuth(model))?.auth.apiKey).toBe("sk-key-1");

    clock.advance(HOUR_MS);
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe("sk-key-2");
  });

  it("fails resolution rather than falling back to the ambient environment", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-operator-ambient-key";
    try {
      const store = unconfiguredCredentialStore("no credential for this session");
      const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null });
      const model = runtime.getModel("anthropic", "claude-sonnet-4-5");
      if (!model) throw new Error("Pi's bundled catalogue no longer carries the offline model");

      await expect(runtime.getAuth(model)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
