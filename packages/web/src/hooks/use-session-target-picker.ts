"use client";

import { useCallback, useEffect, useState } from "react";
import { parseRepositoryFullName, type Environment } from "@open-inspect/shared";
import type { ComboboxGroup, ComboboxOption } from "@/components/ui/combobox";
import { useBranches } from "@/hooks/use-branches";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos, type Repo } from "@/hooks/use-repos";
import { NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import {
  type SessionTarget,
  type SessionTargetRequestFields,
  NO_REPOSITORY_OPTION_VALUE,
  MULTIPLE_REPOSITORIES_OPTION_VALUE,
  buildSessionTargetRequestFields,
  environmentOptionValue,
  getTargetConfigKey,
  getTargetSelectValue,
  isSessionTargetLaunchable,
  outpostOptionValue,
  parseTargetSelectValue,
} from "@/lib/session-target";
import { useOutposts } from "@/hooks/use-outposts";

// Holds the picker's last-selected target as a select value — a repo fullName
// or an `env:<id>` environment value. The key literal predates environments
// (it stored only repo names) and is kept so stored repo values keep working.
const LAST_SELECTED_TARGET_STORAGE_KEY = "openoutposts-last-selected-repo";

/** Picker subtitle for an environment: its repository count. */
export function describeEnvironment(environment: Environment): string {
  const count = environment.repositories.length;
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

/** Picker subtitle for a repository: owner, and whether it is private. */
export function describeRepository(repo: Repo): string {
  return `${repo.owner}${repo.private ? " • private" : ""}`;
}

/** Render contract for SessionTargetPicker: the target/branch/multi-select controls. */
export interface SessionTargetPickerProps {
  sessionTarget: SessionTarget | null;
  targetSelectValue: string;
  targetOptions: ComboboxOption[] | ComboboxGroup[];
  displayTargetName: string;
  onTargetSelectValueChange: (value: string) => void;
  onMultiSelectionChange: (repoFullNames: string[]) => void;
  selectedBranch: string;
  setSelectedBranch: (branch: string) => void;
  branches: { name: string }[];
  loadingBranches: boolean;
  repos: Repo[];
  loadingRepos: boolean;
}

/** Launch-facing selection state for the page: warming identity and request construction. */
export interface SessionTargetSelection {
  sessionTarget: SessionTarget | null;
  selectedBranch: string;
  repos: Repo[];
  loadingRepos: boolean;
  /** The selected repository's metadata when the target is a single repo. */
  selectedRepo: Repo | undefined;
  isLaunchable: boolean;
  /** Selection identity for the sandbox-warming config check. */
  configKey: string;
  /** Request-body fields for the current target, or null when not launchable. */
  buildRequestFields: () => SessionTargetRequestFields | null;
  /** Everything SessionTargetPicker needs to render the controls. */
  pickerProps: SessionTargetPickerProps;
}

/**
 * Owns the new-session target selection: SessionTarget state, the unified
 * environment/repository option list, branch and multi-repo handling, and
 * request-field construction. The controls render through SessionTargetPicker
 * via `pickerProps`; the page keeps model, prompt, and warming.
 */
export function useSessionTargetPicker(): SessionTargetSelection {
  const { repos, loading: loadingRepos } = useRepos();
  const { environments, loading: loadingEnvironments } = useEnvironments();
  const { outposts } = useOutposts();
  const [sessionTarget, setSessionTarget] = useState<SessionTarget | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>("");

  const selectedRepository =
    sessionTarget?.kind === "repo" ? parseRepositoryFullName(sessionTarget.repoFullName) : null;
  const { branches, loading: loadingBranches } = useBranches(
    selectedRepository?.repoOwner ?? "",
    selectedRepository?.repoName ?? ""
  );

  // Restore the last-selected target once data loads. This effect commits a
  // target exactly once (the guard blocks any later correction), so a stored
  // environment must not fall through to the repo default while environments
  // are still loading — wait for the fetch to settle before deciding.
  useEffect(() => {
    if (sessionTarget) return;

    const storedValue = localStorage.getItem(LAST_SELECTED_TARGET_STORAGE_KEY);
    const storedTarget = storedValue ? parseTargetSelectValue(storedValue, null) : null;

    if (storedTarget?.kind === "environment") {
      if (loadingEnvironments) return;
      if (environments.some((environment) => environment.id === storedTarget.environmentId)) {
        setSessionTarget(storedTarget);
        return;
      }
      // The stored environment was deleted — fall through to the repo default.
    }

    if (repos.length > 0) {
      // A stored `env:<id>` value never matches a fullName, so a deleted
      // environment lands on repos[0] here like any other stale value.
      const hasStoredRepo = repos.some((repo) => repo.fullName === storedValue);
      const defaultRepo = (hasStoredRepo ? storedValue : repos[0].fullName) ?? repos[0].fullName;
      setSessionTarget({ kind: "repo", repoFullName: defaultRepo });
      const repo = repos.find((r) => r.fullName === defaultRepo);
      if (repo) setSelectedBranch(repo.defaultBranch);
      return;
    }

    if (!loadingRepos) {
      setSessionTarget({ kind: "none" });
    }
  }, [loadingRepos, repos, loadingEnvironments, environments, sessionTarget]);

  // Persist launchable, restorable selections: repos and environments. Ad-hoc
  // lists and "no repository" keep whatever was stored before them.
  useEffect(() => {
    if (sessionTarget?.kind !== "repo" && sessionTarget?.kind !== "environment") return;
    localStorage.setItem(LAST_SELECTED_TARGET_STORAGE_KEY, getTargetSelectValue(sessionTarget));
  }, [sessionTarget]);

  const onTargetSelectValueChange = useCallback(
    (value: string) => {
      const nextTarget = parseTargetSelectValue(value, sessionTarget);
      setSessionTarget(nextTarget);
      if (nextTarget.kind !== "repo") {
        setSelectedBranch("");
        return;
      }
      const repo = repos.find((r) => r.fullName === nextTarget.repoFullName);
      if (repo) setSelectedBranch(repo.defaultBranch);
    },
    [repos, sessionTarget]
  );

  const onMultiSelectionChange = useCallback((repoFullNames: string[]) => {
    setSessionTarget({ kind: "repos", repoFullNames });
  }, []);

  const buildRequestFields = useCallback((): SessionTargetRequestFields | null => {
    if (!sessionTarget || !isSessionTargetLaunchable(sessionTarget)) return null;
    return buildSessionTargetRequestFields(sessionTarget, selectedBranch);
  }, [sessionTarget, selectedBranch]);

  const selectedRepo =
    sessionTarget?.kind === "repo"
      ? repos.find((r) => r.fullName === sessionTarget.repoFullName)
      : undefined;
  const selectedEnvironment =
    sessionTarget?.kind === "environment"
      ? environments.find((environment) => environment.id === sessionTarget.environmentId)
      : undefined;
  const displayTargetName = (() => {
    switch (sessionTarget?.kind) {
      case "none":
        return NO_REPOSITORY_LABEL;
      case "repo":
        return selectedRepo?.name ?? sessionTarget.repoFullName;
      case "environment":
        return selectedEnvironment?.name ?? "Environment";
      case "repos": {
        const count = sessionTarget.repoFullNames.length;
        if (count === 0) return "Select repositories";
        return `${count} ${count === 1 ? "repository" : "repositories"}`;
      }
      case "outpost": {
        const outpost = outposts.find((candidate) => candidate.id === sessionTarget.outpostId);
        return outpost?.name ?? sessionTarget.outpostId;
      }
      default:
        return "Select repo";
    }
  })();

  const repositoryOptions: ComboboxOption[] = [
    {
      value: NO_REPOSITORY_OPTION_VALUE,
      label: NO_REPOSITORY_LABEL,
      description: "Start without cloning a repository",
    },
    {
      value: MULTIPLE_REPOSITORIES_OPTION_VALUE,
      label: "Multiple repositories",
      description: "Pick an ad-hoc set of repositories",
    },
    ...repos.map((repo) => ({
      value: repo.fullName,
      label: repo.name,
      description: describeRepository(repo),
    })),
  ];
  // One unified list: outposts and environments (when any exist) alongside
  // the repositories. Outposts run the session on an enrolled machine.
  const outpostGroup: ComboboxGroup | null =
    outposts.length > 0
      ? {
          category: "Outposts",
          options: outposts.map((outpost) => ({
            value: outpostOptionValue(outpost.id),
            label: outpost.name,
            description: outpost.connected
              ? `${outpost.platform}/${outpost.architecture} — connected`
              : `${outpost.platform}/${outpost.architecture} — offline`,
          })),
        }
      : null;
  const environmentGroup: ComboboxGroup | null =
    environments.length > 0
      ? {
          category: "Environments",
          options: environments.map((environment) => ({
            value: environmentOptionValue(environment.id),
            label: environment.name,
            description: describeEnvironment(environment),
          })),
        }
      : null;
  const groups = [
    ...(outpostGroup ? [outpostGroup] : []),
    ...(environmentGroup ? [environmentGroup] : []),
  ];
  const targetOptions: ComboboxOption[] | ComboboxGroup[] =
    groups.length > 0
      ? [...groups, { category: "Repositories", options: repositoryOptions }]
      : repositoryOptions;

  return {
    sessionTarget,
    selectedBranch,
    repos,
    loadingRepos,
    selectedRepo,
    isLaunchable: isSessionTargetLaunchable(sessionTarget),
    configKey: getTargetConfigKey(sessionTarget),
    buildRequestFields,
    pickerProps: {
      sessionTarget,
      targetSelectValue: getTargetSelectValue(sessionTarget),
      targetOptions,
      displayTargetName,
      onTargetSelectValueChange,
      onMultiSelectionChange,
      selectedBranch,
      setSelectedBranch,
      branches,
      loadingBranches,
      repos,
      loadingRepos,
    },
  };
}
