/**
 * Execution backend selection.
 *
 * There is exactly one execution backend: `outpost`. The agent runs centrally
 * and every file and shell operation executes on a machine the user owns.
 *
 * The cloud providers (Modal, E2B, Daytona, Vercel, OpenComputer) are NOT gone
 * — their REST clients are retained as the fleet-member provisioning
 * capability. They no longer host an agent, so they are no longer selectable
 * as an execution backend.
 */

export type SandboxBackendName = "outpost";

/**
 * Resolve the configured execution backend.
 *
 * `SANDBOX_PROVIDER` is accepted only when it names the outpost backend, or is
 * absent. A deployment still configured for a cloud sandbox backend fails
 * loudly here rather than silently running somewhere it was not told to.
 */
export function resolveSandboxBackendName(value: string | undefined): SandboxBackendName {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "outpost") {
    return "outpost";
  }

  throw new Error(
    `Unsupported SANDBOX_PROVIDER: ${value}. The agent runs centrally and executes on an ` +
      "outpost; cloud providers create fleet members rather than hosting sessions."
  );
}
