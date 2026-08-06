import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SandboxProvider,
} from "../provider";

export interface AssignedRepositoryInfo {
  repoOwner: string;
  repoName: string;
  baseBranch?: string;
  cloneUrl: string;
}

export interface OutpostProviderConfig {
  /** The well-known homestead registry Durable Object namespace. */
  homesteadNamespace: DurableObjectNamespace;
  /** Outpost that hosts this deployment's session workspaces. */
  outpostId: string;
  /** Directory on the outpost under which per-session workspaces live. */
  workspaceRoot: string;
  /**
   * Template for repository clone URLs with {owner} and {name} placeholders.
   * Defaults to GitHub over https; ssh templates and other hosts work the
   * same way. The URL carries no credentials — clone auth is the homestead's
   * concern (machine credentials by default, brokered tokens opt-in).
   */
  cloneUrlTemplate?: string;
}

const DEFAULT_CLONE_URL_TEMPLATE = "https://github.com/{owner}/{name}.git";

/**
 * Execution backend that provisions nothing. Creating a "sandbox" hands the
 * session to a connected central homestead, which takes an execution lease
 * on the configured outpost and connects back to the session as its bridge.
 * The homestead receives the session's bridge credential the same way a
 * provisioned sandbox would receive it through its environment.
 */
export class OutpostSandboxProvider implements SandboxProvider {
  readonly name = "outpost";

  constructor(private readonly config: OutpostProviderConfig) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const workspaceRoot = this.config.workspaceRoot.replace(/\/+$/, "");
    const outpostId = config.outpostId ?? this.config.outpostId;
    const cloneUrlTemplate = this.config.cloneUrlTemplate ?? DEFAULT_CLONE_URL_TEMPLATE;
    const members =
      config.repositories ??
      (config.repoOwner && config.repoName
        ? [
            {
              repoOwner: config.repoOwner,
              repoName: config.repoName,
              baseBranch: config.branch ?? undefined,
            },
          ]
        : []);
    const repositories: AssignedRepositoryInfo[] = members.map((member) => ({
      repoOwner: member.repoOwner,
      repoName: member.repoName,
      ...(member.baseBranch ? { baseBranch: member.baseBranch } : {}),
      cloneUrl: cloneUrlTemplate
        .replaceAll("{owner}", member.repoOwner)
        .replaceAll("{name}", member.repoName),
    }));
    const stub = this.config.homesteadNamespace.get(
      this.config.homesteadNamespace.idFromName("default")
    );

    let response: Response;
    try {
      response = await stub.fetch("http://internal/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productSessionId: config.sessionId,
          sandboxId: config.sandboxId,
          sandboxAuthToken: config.sandboxAuthToken,
          credentialFetchToken: config.credentialFetchToken,
          controlPlaneUrl: config.controlPlaneUrl,
          harness: "pi",
          model: `${config.provider}/${config.model}`,
          outpostId,
          workspacePath: `${workspaceRoot}/${config.sessionId}`,
          ...(repositories.length > 0 ? { repositories } : {}),
        }),
      });
    } catch (error) {
      throw new SandboxProviderError(
        "Failed to reach the homestead registry",
        "transient",
        error instanceof Error ? error : undefined
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      const message = body?.error ?? `Homestead assignment failed: HTTP ${response.status}`;
      // Every failure here (no homestead connected, homestead rejected, timeout) is
      // an availability problem, not a permanent session defect.
      throw new SandboxProviderError(message, "transient");
    }

    return {
      sandboxId: config.sandboxId,
      status: "connecting",
      createdAt: Date.now(),
    };
  }
}

export function createOutpostProvider(config: OutpostProviderConfig): OutpostSandboxProvider {
  return new OutpostSandboxProvider(config);
}
