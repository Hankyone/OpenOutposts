import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { OutpostClient } from "../outpost-client.js";
import type {
  CreateSessionHarnessInput,
  SessionHarnessFactory,
} from "../service/harness-factory.js";
import {
  createSessionCredentialStore,
  unconfiguredCredentialStore,
  type PiCredential,
  type SessionCredentialStore,
} from "./credential-store.js";
import { PiHarness } from "./harness.js";
import { splitModelSpec } from "./session.js";

const PI_SESSION_SUBDIR = "pi-sessions";

export interface PiHarnessFactoryOptions {
  outposts: OutpostClient;
  controlPlaneUrl: string;
  stateDir?: string;
  devPiKeyCommand?: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Creates assignment-scoped Pi adapters while keeping Pi's credential and
 * transcript details out of the homestead daemon.
 */
export class PiHarnessFactory implements SessionHarnessFactory {
  readonly kind = "pi" as const;
  readonly #options: PiHarnessFactoryOptions;

  constructor(options: PiHarnessFactoryOptions) {
    this.#options = options;
  }

  create(input: CreateSessionHarnessInput): PiHarness {
    const credential = this.#credential(input);
    const onPiLog = (line: string): void =>
      this.#options.log?.("pi", { line, session: input.productSessionId });

    let credentials: SessionCredentialStore;
    if (!credential) {
      this.#options.log?.(
        "no provider could be derived from the session's model; every turn of this session will refuse",
        { session: input.productSessionId, model: input.model ?? null }
      );
      credentials = unconfiguredCredentialStore(
        `no provider could be derived from the session's model (${input.model ?? "none chosen"})`
      );
    } else {
      if (credential.kind === "key-command") {
        this.#options.log?.(
          "DEVELOPMENT credential override in use: this session runs on the homestead operator's key, not the session owner's",
          { session: input.productSessionId, provider: credential.providerId }
        );
      }
      credentials = createSessionCredentialStore(credential, { onLog: onPiLog });
    }

    const piSessionFile = this.#sessionFile(input.productSessionId);
    return new PiHarness({
      outposts: this.#options.outposts,
      outpostId: input.outpostId,
      ...(input.model === undefined ? {} : { defaultModel: input.model }),
      ...(piSessionFile === null ? {} : { piSessionFile }),
      credentials,
      onLog: onPiLog,
    });
  }

  /**
   * Deletes conversations whose product-session recovery records expired,
   * including copies set aside because Pi could not read them.
   */
  async removePersistedSessions(productSessionIds: readonly string[]): Promise<void> {
    const dir = this.#sessionDir();
    if (!dir) return;

    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }

    const names = productSessionIds.map((id) => `${encodeURIComponent(id)}.jsonl`);
    for (const file of files) {
      const owned = names.some((name) => file === name || file.startsWith(`${name}.corrupt-`));
      if (!owned) continue;
      await rm(join(dir, file), { force: true }).catch(() => {});
    }
  }

  /**
   * Resolves how this Pi session obtains a provider key. The fetch bearer is
   * scoped to this one operation and the session's owner; the bridge bearer
   * never reaches this factory or the harness.
   */
  #credential(input: CreateSessionHarnessInput): PiCredential | undefined {
    const providerId = providerOf(input.model);
    if (providerId === undefined) return undefined;

    const devKeyCommand = this.#options.devPiKeyCommand;
    if (devKeyCommand) return { kind: "key-command", providerId, keyCommand: devKeyCommand };

    return {
      kind: "brokered",
      providerId,
      request: {
        controlPlaneUrl: this.#options.controlPlaneUrl,
        productSessionId: input.productSessionId,
        provider: providerId,
        credentialFetchToken: input.credentialFetchToken,
      },
    };
  }

  #sessionDir(): string | null {
    return this.#options.stateDir ? join(this.#options.stateDir, PI_SESSION_SUBDIR) : null;
  }

  #sessionFile(productSessionId: string): string | null {
    const dir = this.#sessionDir();
    return dir ? join(dir, `${encodeURIComponent(productSessionId)}.jsonl`) : null;
  }
}

/** Provider half of a `provider/model-id` spec. */
function providerOf(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  try {
    return splitModelSpec(model).providerId;
  } catch {
    return undefined;
  }
}
