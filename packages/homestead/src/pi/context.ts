import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AGENT_CONTEXT_MAX_BYTES, type AgentContextFile } from "@openoutposts/outpost-protocol";

const CONTEXT_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export interface HomesteadContextOptions {
  agentDir?: string;
  onWarning?: (message: string) => void;
}

/**
 * Loads the one global instruction file a local Pi process would find in its
 * agent directory. The real path stays on the homestead; Pi receives a virtual
 * label and the contents, never authority to inspect that directory itself.
 */
export async function loadHomesteadContext(
  options: HomesteadContextOptions = {}
): Promise<AgentContextFile[]> {
  const agentDir = options.agentDir ?? getAgentDir();
  for (const name of CONTEXT_CANDIDATES) {
    try {
      const content = await readFile(join(agentDir, name), "utf8");
      if (Buffer.byteLength(content, "utf8") > AGENT_CONTEXT_MAX_BYTES) {
        options.onWarning?.(
          `homestead context ${name} exceeds ${AGENT_CONTEXT_MAX_BYTES} bytes and was skipped`
        );
        continue;
      }
      return [{ path: `homestead:/${name}`, content }];
    } catch (error) {
      if (isMissingFile(error)) continue;
      options.onWarning?.(
        `homestead context ${name} could not be read${
          errorCode(error) === null ? "" : ` (${errorCode(error)})`
        }`
      );
    }
  }
  return [];
}

function errorCode(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}
