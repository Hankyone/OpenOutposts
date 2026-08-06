/**
 * The model catalog this homestead reports to the control plane.
 *
 * The product's model list has to come from what the harness can actually
 * reach, or a user picks something in the UI that no session can run. Pi owns
 * that registry and Pi lives here, so the homestead reads it once at startup and
 * reports it at registration.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  MODEL_CATALOG_VERSION,
  type CatalogModel,
  type ModelCatalog,
  type ModelThinkingLevel,
} from "@openoutposts/outpost-protocol";

/** The subset of Pi's ModelRuntime a catalog is built from. */
export interface PiModelRegistry {
  getProviders(): readonly { id: string; name: string }[];
  getModels(providerId?: string): readonly {
    id: string;
    name: string;
    provider: string;
    reasoning: boolean;
    thinkingLevelMap?: Partial<Record<string, string | null>>;
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
  }[];
}

const THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Reads Pi's registry with no credentials and no network.
 *
 * The auth path is a scratch file that will never exist and the models path is
 * suppressed, so the reported catalog is Pi's own — never the operator's
 * personal Pi configuration on the homestead host, which no customer's product UI
 * should be shaped by.
 */
export async function collectPiModelCatalog(): Promise<ModelCatalog> {
  const dir = await mkdtemp(join(tmpdir(), "openoutposts-pi-catalog-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
    });
    return buildModelCatalog(runtime);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Maps a Pi registry onto the wire shape.
 *
 * Deliberately `getModels()` and not `getAvailable()`: availability is decided
 * by the credentials configured in the process reading it, and this homestead
 * holds none — every credential is session-scoped and arrives long after
 * registration. Which of these a given user may actually use is a question
 * only the control plane can answer, from that user's connected providers.
 */
export function buildModelCatalog(registry: PiModelRegistry): ModelCatalog {
  const models: CatalogModel[] = registry.getModels().map((model) => ({
    providerId: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(thinkingLevels(model.thinkingLevelMap) ?? {}),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));

  return {
    catalogVersion: MODEL_CATALOG_VERSION,
    providers: registry.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
    })),
    models,
  };
}

/**
 * Carries across only the levels Pi states an opinion about. A level Pi omits
 * means "provider default", which is not the same as unsupported, so inventing
 * an entry for it would tell the product something Pi never said.
 */
function thinkingLevels(
  map: Partial<Record<string, string | null>> | undefined
): { thinkingLevels: Partial<Record<ModelThinkingLevel, string | null>> } | undefined {
  if (!map) return undefined;
  const levels: Partial<Record<ModelThinkingLevel, string | null>> = {};
  let stated = false;
  for (const level of THINKING_LEVELS) {
    const value = map[level];
    if (value === undefined) continue;
    levels[level] = value;
    stated = true;
  }
  return stated ? { thinkingLevels: levels } : undefined;
}
