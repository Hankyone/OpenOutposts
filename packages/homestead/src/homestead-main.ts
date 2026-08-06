#!/usr/bin/env node
/**
 * The OpenOutposts central homestead service.
 *
 * Connects outbound to the control plane, registers as a homestead, and serves
 * assigned product sessions: central Pi brain, outpost-executed tools, events
 * bridged into the product session stream.
 *
 * Provider credentials are not configured here. Each session fetches one from
 * the control plane, scoped to that session and answered from its owner's
 * vault, so this process holds no model credential of its own and one homestead
 * serves every user's keys without ever seeing them at rest.
 *
 * The state directory is where the agent actually lives between restarts. It
 * holds one recovery record per session and, under `pi-sessions/`, that
 * session's Pi conversation — so a restarted homestead carries on the
 * conversation rather than meeting the user as a stranger. Both are owner-only
 * and neither holds a credential.
 *
 * Environment:
 *   OPENOUTPOSTS_CONTROL_PLANE_URL   control plane base URL
 *   OPENOUTPOSTS_INTERNAL_SECRET     this homestead's sig1 signing secret
 *   OPENOUTPOSTS_HOMESTEAD_ID           optional homestead identity (default: hostname)
 *   OPENOUTPOSTS_STATE_DIR           optional directory for session recovery
 *                                    records and resumable Pi conversations
 *                                    (default: ~/.openoutposts/homestead-sessions)
 *   OPENOUTPOSTS_MAX_SESSIONS        optional concurrent session cap, a positive
 *                                    whole number (default: 8)
 *   OPENOUTPOSTS_CLONE_AUTH          optional "brokered" to fetch repo tokens
 *                                    from the control plane instead of using
 *                                    the outpost's own git credentials
 *   OPENOUTPOSTS_DEV_PI_KEY_COMMAND  DEVELOPMENT ONLY: a shell command printing
 *                                    one provider key to use for every session,
 *                                    bypassing per-user credentials entirely
 */
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "@openoutposts/outpost-protocol";

import { collectPiModelCatalog } from "./pi/catalog.js";
import { HomesteadDaemon, resolveMaxSessions } from "./service/homestead-daemon.js";

const VERSION = "0.1.0";

/**
 * Exit code for an unrecoverable crash, distinct from the exit code for bad
 * configuration so a supervisor's logs tell the two apart. Both are non-zero:
 * a homestead that stops for any reason other than being asked to must look like
 * a failure, or systemd/launchd treat it as a completed job and leave the
 * deployment with no homestead.
 */
const FATAL_EXIT_CODE = 70;
const CONFIG_EXIT_CODE = 1;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(CONFIG_EXIT_CODE);
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return String(value);
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error(`[homestead] fatal: unhandled rejection: ${describeError(reason)}`);
  process.exit(FATAL_EXIT_CODE);
});

process.on("uncaughtException", (error: unknown) => {
  console.error(`[homestead] fatal: uncaught exception: ${describeError(error)}`);
  process.exit(FATAL_EXIT_CODE);
});

async function main(): Promise<void> {
  const controlPlaneUrl = process.env.OPENOUTPOSTS_CONTROL_PLANE_URL;
  const internalSecret = process.env.OPENOUTPOSTS_INTERNAL_SECRET;
  if (!controlPlaneUrl) fail("OPENOUTPOSTS_CONTROL_PLANE_URL is not set");
  if (!internalSecret) fail("OPENOUTPOSTS_INTERNAL_SECRET is not set");

  const devPiKeyCommand = process.env.OPENOUTPOSTS_DEV_PI_KEY_COMMAND;
  if (devPiKeyCommand) {
    // Loud on purpose. This is the deployment-wide single credential the
    // per-user vault exists to remove, and nothing about a running session
    // would otherwise reveal that every user is sharing one key.
    console.warn(
      "[homestead] WARNING: OPENOUTPOSTS_DEV_PI_KEY_COMMAND is set. Every session this homestead serves " +
        "will use that one key instead of the session owner's own credential. This is a local " +
        "development setting; unset it for any deployment with more than one user."
    );
  }

  let maxSessions: number;
  try {
    maxSessions = resolveMaxSessions(process.env.OPENOUTPOSTS_MAX_SESSIONS);
  } catch (error) {
    fail(`OPENOUTPOSTS_MAX_SESSIONS: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Read once at startup: Pi's registry does not change within a process, and
  // the control plane needs it to offer only models a session could run.
  let catalog: ModelCatalog | undefined;
  try {
    catalog = await collectPiModelCatalog();
    console.log(
      `[homestead] pi model catalog: ${catalog.providers.length} providers, ${catalog.models.length} models`
    );
  } catch (error: unknown) {
    // Not fatal: a homestead with no catalog still serves sessions, and the
    // control plane keeps whatever catalog it already had.
    console.error(`[homestead] could not read Pi's model catalog: ${describeError(error)}`);
  }

  const daemon = new HomesteadDaemon({
    controlPlaneUrl,
    internalSecret,
    homesteadId: process.env.OPENOUTPOSTS_HOMESTEAD_ID || hostname(),
    homesteadVersion: VERSION,
    ...(catalog === undefined ? {} : { catalog }),
    ...(devPiKeyCommand ? { devPiKeyCommand } : {}),
    ...(process.env.OPENOUTPOSTS_CLONE_AUTH === "brokered"
      ? { cloneAuth: "brokered" as const }
      : {}),
    stateDir:
      process.env.OPENOUTPOSTS_STATE_DIR || join(homedir(), ".openoutposts", "homestead-sessions"),
    maxSessions,
    log: (message, fields) => {
      const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
      console.log(`[homestead] ${message}${suffix}`);
    },
  });

  const shutdown = () => {
    console.log("[homestead] shutting down");
    // An asked-for shutdown is the one case that may exit 0, so a failure
    // while draining must not be re-raised into the fatal handlers above.
    void daemon
      .stop()
      .catch((error: unknown) => {
        console.error(`[homestead] shutdown error: ${describeError(error)}`);
      })
      .then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await daemon.start();
  console.log(`[homestead] started (control plane: ${controlPlaneUrl})`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
