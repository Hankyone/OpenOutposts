import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentContextFile } from "@openoutposts/outpost-protocol";

import { OUTPOST_TOOL_NAMES } from "./tools.js";

/**
 * The central Pi agent runs out of a scratch home, not the workspace: the real
 * files live on the outpost. Two directories are created per session —
 * an agent directory (Pi's own config) and a working directory that stays
 * empty. Neither is where the model can do useful work, which is the point:
 * the only reachable filesystem is the outpost's.
 *
 * This is also what keeps Pi from discovering arbitrary resources in the
 * operator's own installation. Pi falls back to `~/.pi/agent` only when no
 * agent directory is given; every path a session reads — agent directory, auth
 * file, models file — is passed explicitly, settings are in-memory, and the
 * discovery switches below are off. The one intentional exception is global
 * AGENTS.md/CLAUDE.md content: the harness reads that configuration itself and
 * injects it as a virtual context file, alongside context delivered by the
 * leased outpost.
 *
 * Nothing about the session's credential lives here. The key, and the token
 * that fetches it, are held in memory by the session's credential store (see
 * credential-store.ts) and handed to Pi through the store it reads on every
 * model request. Neither ever touches this directory.
 */

export interface PiAgentHome {
  /** Pi's config directory for this session: models.json and nothing secret. */
  agentDir: string;
  /** The session working directory. Deliberately empty and deliberately unused. */
  cwd: string;
  /**
   * Where Pi would keep an auth file. Nothing writes it and nothing should:
   * the session's credential store replaces it entirely. It is still handed to
   * Pi so that a future change reintroducing a file-backed store lands inside
   * this session's own directory rather than in the operator's `~/.pi`.
   */
  authPath: string;
  modelsPath: string;
  remove(): Promise<void>;
}

const OUTPOST_INSTRUCTIONS = `# Remote outpost workspace

You are working on a workspace that lives on a different machine, reached
through the outpost_* tools. Every file and shell operation must go through
them:

- outpost_bash: run a shell command in the workspace
- outpost_read / outpost_write / outpost_edit: file contents
- outpost_grep / outpost_find / outpost_ls: search and discovery

All paths are relative to the workspace root. Do not use absolute paths.

Your own current directory is a scratch directory on the machine running the
agent. It is not the workspace, and nothing written there reaches the user. You
have no local shell and no local file tools; if an outpost_* tool fails, report
the failure rather than looking for another way to do the work.`;

/** The instruction block appended to Pi's system prompt for outpost sessions. */
export const outpostSystemPromptAppendix = OUTPOST_INSTRUCTIONS;

/**
 * Resource-loader settings for an outpost session.
 *
 * Extension discovery is off because it is the one mechanism that can inject
 * tools Pi's `noTools` suppression would still leave model-visible — the same
 * failure the harness this one replaced hit, where a permissive configuration
 * let the model reach a local write tool and edit the homestead's own disk while
 * reporting success. The allowlist already blocks such a tool from reaching
 * the model, so this is defence in depth; it also removes an extension's
 * ability to shrink the tool set to nothing. Skill, automatic context-file,
 * prompt-template and theme discovery stay off. Context is supplied explicitly
 * from the homestead's global agent instructions and the leased outpost, which
 * prevents Pi from treating its local scratch directory as the workspace.
 */
export function buildPiResourceLoaderOptions(contextFiles: AgentContextFile[] = []): {
  noExtensions: true;
  noSkills: true;
  noContextFiles: true;
  noPromptTemplates: true;
  noThemes: true;
  appendSystemPrompt: string[];
  agentsFilesOverride: () => { agentsFiles: AgentContextFile[] };
} {
  return {
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [OUTPOST_INSTRUCTIONS],
    agentsFilesOverride: () => ({
      agentsFiles: contextFiles.map((file) => ({ ...file })),
    }),
  };
}

/**
 * Tool settings for an outpost session.
 *
 * `tools` is an explicit allowlist, and that is the whole boundary. The
 * `noTools: "builtin"` flag is NOT used and must not be: it suppresses the
 * built-ins but by design keeps extension-registered tools enabled, so a tool
 * file dropped into the working directory becomes model-visible under it.
 * Pi intersects the allowlist with any later request, so no extension and no
 * runtime tool call can widen past these seven names.
 */
export function buildPiToolOptions(customTools: ToolDefinition[]): {
  tools: string[];
  customTools: ToolDefinition[];
} {
  return { tools: [...OUTPOST_TOOL_NAMES], customTools };
}

/**
 * OpenRouter app-attribution headers, sent on every OpenRouter request.
 *
 * OpenRouter attributes usage to an app through two request headers: the
 * app's URL (its identity key — without it no app page exists and usage
 * stays out of the rankings) and a display title. `X-Title` is the legacy
 * spelling of the title header; both are sent so attribution holds across
 * doc generations. These are public metadata, not credentials, which is why
 * they may live in models.json while keys never do.
 */
export const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openoutposts.com",
  "X-OpenRouter-Title": "OpenOutposts",
  "X-Title": "OpenOutposts",
};

/**
 * The models.json written into every session's agent directory. A provider
 * entry whose id matches a built-in Pi provider extends it: the headers here
 * are merged into each request's resolved headers, and nothing else about
 * the provider (base URL, auth, model catalog) changes.
 */
const MODELS_JSON_CONTENT = `${JSON.stringify(
  { providers: { openrouter: { headers: OPENROUTER_ATTRIBUTION_HEADERS } } },
  null,
  2
)}\n`;

export async function createPiAgentHome(): Promise<PiAgentHome> {
  const dir = await mkdtemp(join(tmpdir(), "openoutposts-pi-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "scratch");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "models.json"), MODELS_JSON_CONTENT, "utf8");

  return {
    agentDir,
    cwd,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
