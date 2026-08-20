/**
 * The new-session picker's repository selection: nothing, a single repository
 * (branch dropdown included), a named environment, or an ad-hoc ordered
 * repository list ([0] = primary). Machine placement is orthogonal: each
 * repository form may carry an outpost id without becoming a fifth target
 * mode. This keeps repository and machine selection independent while one
 * object still identifies the full in-flight session configuration.
 */

import { parseRepositoryFullName } from "@open-inspect/shared";

type SessionRepositoryTarget =
  | { kind: "none" }
  | { kind: "repo"; repoFullName: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "repos"; repoFullNames: string[] };

export type SessionTarget = SessionRepositoryTarget & { outpostId?: string };

export const NO_REPOSITORY_OPTION_VALUE = "__no_repository__";
export const MULTIPLE_REPOSITORIES_OPTION_VALUE = "__multiple_repositories__";
const ENVIRONMENT_OPTION_PREFIX = "env:";

export function environmentOptionValue(environmentId: string): string {
  return `${ENVIRONMENT_OPTION_PREFIX}${environmentId}`;
}

/**
 * The environment id encoded in an `env:<id>` option value, or null for any
 * other value. The inverse of {@link environmentOptionValue} — for callers
 * (like the Slack routing-rules settings) that only deal in repo/environment
 * values and must not inherit the picker's sentinel semantics.
 */
export function parseEnvironmentOptionValue(value: string): string | null {
  return value.startsWith(ENVIRONMENT_OPTION_PREFIX)
    ? value.slice(ENVIRONMENT_OPTION_PREFIX.length)
    : null;
}

export function getTargetSelectValue(target: SessionTarget | null): string {
  if (!target) return "";
  switch (target.kind) {
    case "none":
      return NO_REPOSITORY_OPTION_VALUE;
    case "repo":
      return target.repoFullName;
    case "environment":
      return environmentOptionValue(target.environmentId);
    case "repos":
      return MULTIPLE_REPOSITORIES_OPTION_VALUE;
  }
}

function retainOutpost(
  target: SessionRepositoryTarget,
  previous: SessionTarget | null
): SessionTarget {
  return previous?.outpostId ? { ...target, outpostId: previous.outpostId } : target;
}

/**
 * Parse a picker option value back into a target. The multi-repository
 * sentinel seeds the list from the previous selection so switching modes
 * keeps the current repo instead of starting empty.
 */
export function parseTargetSelectValue(
  value: string,
  previous: SessionTarget | null
): SessionTarget {
  if (value === NO_REPOSITORY_OPTION_VALUE) {
    return retainOutpost({ kind: "none" }, previous);
  }
  if (value === MULTIPLE_REPOSITORIES_OPTION_VALUE) {
    if (previous?.kind === "repos") return previous;
    return retainOutpost(
      {
        kind: "repos",
        repoFullNames: previous?.kind === "repo" ? [previous.repoFullName.toLowerCase()] : [],
      },
      previous
    );
  }
  const environmentId = parseEnvironmentOptionValue(value);
  if (environmentId !== null) {
    return retainOutpost({ kind: "environment", environmentId }, previous);
  }
  return retainOutpost({ kind: "repo", repoFullName: value }, previous);
}

/** Return the same repository target with a new independent machine choice. */
export function setSessionTargetOutpost(
  target: SessionTarget,
  outpostId: string | null
): SessionTarget {
  const { outpostId: _previousOutpostId, ...repositoryTarget } = target;
  return outpostId ? { ...repositoryTarget, outpostId } : repositoryTarget;
}

/**
 * Identity of a selection for the sandbox-warming config check — unlike
 * getTargetSelectValue it distinguishes different ad-hoc lists, so editing
 * the list invalidates a warmed session.
 */
export function getTargetConfigKey(target: SessionTarget | null): string {
  if (!target) return "";
  const repositoryKey =
    target.kind === "repos"
      ? `repos:${target.repoFullNames.join(",")}`
      : getTargetSelectValue(target);
  return `${repositoryKey}|outpost:${target.outpostId ?? ""}`;
}

/** Whether the selection is complete enough to create a session from. */
export function isSessionTargetLaunchable(target: SessionTarget | null): boolean {
  if (!target) return false;
  return target.kind !== "repos" || target.repoFullNames.length > 0;
}

/**
 * The target's fields for the POST /api/sessions body: exactly one of the
 * scalar repo form, `environmentId`, or `repositories` (design §5.5). Mirrors
 * the mutually exclusive modes of createSessionRequestSchema.
 */
type SessionRepositoryRequestFields =
  | { repoOwner: null; repoName: null }
  | { repoOwner: string; repoName: string; branch?: string }
  | { environmentId: string }
  | { repositories: Array<{ repoOwner: string; repoName: string }> };

export type SessionTargetRequestFields = SessionRepositoryRequestFields & {
  outpostId?: string;
};

function includeOutpost(
  fields: SessionRepositoryRequestFields,
  outpostId: string | undefined
): SessionTargetRequestFields {
  return outpostId ? { ...fields, outpostId } : fields;
}

export function buildSessionTargetRequestFields(
  target: SessionTarget,
  selectedBranch: string
): SessionTargetRequestFields {
  switch (target.kind) {
    case "none":
      return includeOutpost({ repoOwner: null, repoName: null }, target.outpostId);
    case "repo": {
      const repository = parseRepositoryFullName(target.repoFullName);
      if (!repository) {
        return includeOutpost({ repoOwner: null, repoName: null }, target.outpostId);
      }
      return includeOutpost(
        {
          repoOwner: repository.repoOwner,
          repoName: repository.repoName,
          branch: selectedBranch || undefined,
        },
        target.outpostId
      );
    }
    case "environment":
      return includeOutpost({ environmentId: target.environmentId }, target.outpostId);
    case "repos":
      return includeOutpost(
        {
          repositories: target.repoFullNames
            .map(parseRepositoryFullName)
            .filter((repository) => repository !== null),
        },
        target.outpostId
      );
  }
}
