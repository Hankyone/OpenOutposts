import { resolveSandboxBackendName, type SandboxBackendName } from "./provider-name";
import type { SandboxProvider } from "./provider";
import { createOutpostProvider, type OutpostSandboxProvider } from "./providers/outpost-provider";
import type { Env } from "../types";

/**
 * Build the deployment's execution backend.
 *
 * There is one: the outpost backend, which hands a session to a connected
 * central homestead. Nothing here provisions a machine — the cloud provider
 * REST clients in this directory are the retained provisioning capability and
 * belong to the (not yet built) fleet-member creator, which constructs them
 * from a user's own provider credential rather than from the Worker
 * environment.
 */
export function createSandboxProviderFromEnv(
  env: Env,
  backend: SandboxBackendName = resolveSandboxBackendName(env.SANDBOX_PROVIDER)
): SandboxProvider {
  switch (backend) {
    case "outpost":
      return createOutpostProviderFromEnv(env);
  }
}

function createOutpostProviderFromEnv(env: Env): OutpostSandboxProvider {
  if (!env.HOMESTEAD) {
    throw new Error("The HOMESTEAD Durable Object binding is required for the outpost backend");
  }
  if (!env.OUTPOST_TARGET_ID || !env.OUTPOST_TARGET_WORKSPACE_ROOT) {
    throw new Error(
      "OUTPOST_TARGET_ID and OUTPOST_TARGET_WORKSPACE_ROOT are required for the outpost backend"
    );
  }
  return createOutpostProvider({
    homesteadNamespace: env.HOMESTEAD,
    outpostId: env.OUTPOST_TARGET_ID,
    workspaceRoot: env.OUTPOST_TARGET_WORKSPACE_ROOT,
    ...(env.OUTPOST_CLONE_URL_TEMPLATE ? { cloneUrlTemplate: env.OUTPOST_CLONE_URL_TEMPLATE } : {}),
  });
}
