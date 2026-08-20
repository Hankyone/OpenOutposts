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
  parseTargetSelectValue,
  setSessionTargetOutpost,
} from "@/lib/session-target";
import { useOutposts, type OutpostSummary } from "@/hooks/use-outposts";

// Holds the picker's last-selected target as a select value — a repo fullName
// or an `env:<id>` environment value. The key literal predates environments
// (it stored only repo names) and is kept so stored repo values keep working.
const LAST_SELECTED_TARGET_STORAGE_KEY = "openoutposts-last-selected-repo";
const LAST_SELECTED_OUTPOST_STORAGE_KEY = "openoutposts-last-selected-outpost";

/** Picker subtitle for an environment: its repository count. */
export function describeEnvironment(environment: Environment): string {
  const count = environment.repositories.length;
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

/** Picker subtitle for a repository: owner, and whether it is private. */
export function describeRepository(repo: Repo): string {
  return `${repo.owner}${repo.private ? " • private" : ""}`;
}

/** Prefer a valid remembered machine, then the first connected machine. */
export function chooseDefaultOutpostId(
  outposts: OutpostSummary[],
  storedOutpostId: string | null
): string | null {
  if (storedOutpostId && outposts.some((outpost) => outpost.id === storedOutpostId)) {
    return storedOutpostId;
  }
  return outposts.find((outpost) => outpost.connected)?.id ?? null;
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
  selectedOutpostId: string | null;
  outpostOptions: ComboboxOption[];
  displayOutpostName: string;
  onOutpostSelectValueChange: (outpostId: string) => void;
  loadingOutposts: boolean;
  outpostsUnavailable: boolean;
}

/** Launch-facing selection state for the page: warming identity and request construction. */
export interface SessionTargetSelection {
  sessionTarget: SessionTarget | null;
  selectedBranch: string;
  repos: Repo[];
  loadingRepos: boolean;
  /** The selected repository's metadata when the target is a single repo. */
  selectedRepo: Repo | undefined;
  /** The selected machine's current fleet metadata, when it remains listed. */
  selectedOutpost: OutpostSummary | undefined;
  /** The fleet list is still resolving. */
  loadingOutposts: boolean;
  /** The fleet list could not be read, which is different from an empty list. */
  outpostsUnavailable: boolean;
  isLaunchable: boolean;
  /** Selection identity for the sandbox-warming config check. */
  configKey: string;
  /** Request-body fields for the current target, or null when not launchable. */
  buildRequestFields: () => SessionTargetRequestFields | null;
  /** Everything SessionTargetPicker needs to render the controls. */
  pickerProps: SessionTargetPickerProps;
}

/**
 * Owns the new-session repository and machine selections, branch and
 * multi-repo handling, and request-field construction. The controls render
 * through SessionTargetPicker via `pickerProps`; the page keeps model, prompt,
 * and warming.
 */
export function useSessionTargetPicker(): SessionTargetSelection {
  const { repos, loading: loadingRepos } = useRepos();
  const { environments, loading: loadingEnvironments } = useEnvironments();
  const { outposts, loading: loadingOutposts, unavailable: outpostsUnavailable } = useOutposts();
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

  // Machine placement is independent of the repository target. Restore a
  // still-listed machine first; otherwise choose a connected machine. Leaving
  // the field absent keeps deployments with no outpost fleet compatible.
  useEffect(() => {
    if (!sessionTarget || loadingOutposts || outpostsUnavailable) return;
    if (
      sessionTarget.outpostId &&
      outposts.some((outpost) => outpost.id === sessionTarget.outpostId)
    ) {
      return;
    }

    const defaultOutpostId = chooseDefaultOutpostId(
      outposts,
      localStorage.getItem(LAST_SELECTED_OUTPOST_STORAGE_KEY)
    );
    if ((sessionTarget.outpostId ?? null) === defaultOutpostId) return;
    setSessionTarget((current) =>
      current ? setSessionTargetOutpost(current, defaultOutpostId) : current
    );
  }, [sessionTarget, loadingOutposts, outpostsUnavailable, outposts]);

  useEffect(() => {
    if (!sessionTarget?.outpostId) return;
    localStorage.setItem(LAST_SELECTED_OUTPOST_STORAGE_KEY, sessionTarget.outpostId);
  }, [sessionTarget?.outpostId]);

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
    setSessionTarget((current) => ({
      kind: "repos",
      repoFullNames,
      ...(current?.outpostId ? { outpostId: current.outpostId } : {}),
    }));
  }, []);

  const onOutpostSelectValueChange = useCallback((outpostId: string) => {
    setSessionTarget((current) =>
      current ? setSessionTargetOutpost(current, outpostId) : current
    );
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
  const selectedOutpost = sessionTarget?.outpostId
    ? outposts.find((outpost) => outpost.id === sessionTarget.outpostId)
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
  const groups = [...(environmentGroup ? [environmentGroup] : [])];
  const targetOptions: ComboboxOption[] | ComboboxGroup[] =
    groups.length > 0
      ? [...groups, { category: "Repositories", options: repositoryOptions }]
      : repositoryOptions;
  const outpostOptions: ComboboxOption[] = outposts.map((outpost) => ({
    value: outpost.id,
    label: outpost.name,
    description: outpost.connected
      ? `${outpost.platform}/${outpost.architecture}, connected`
      : `${outpost.platform}/${outpost.architecture}, offline`,
  }));
  const displayOutpostName = loadingOutposts
    ? "Loading machines..."
    : outpostsUnavailable
      ? "Machines unavailable"
      : (selectedOutpost?.name ?? (outposts.length > 0 ? "Select machine" : "No machines"));

  return {
    sessionTarget,
    selectedBranch,
    repos,
    loadingRepos,
    selectedRepo,
    selectedOutpost,
    loadingOutposts,
    outpostsUnavailable,
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
      selectedOutpostId: sessionTarget?.outpostId ?? null,
      outpostOptions,
      displayOutpostName,
      onOutpostSelectValueChange,
      loadingOutposts,
      outpostsUnavailable,
    },
  };
}
