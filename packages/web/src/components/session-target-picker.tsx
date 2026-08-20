"use client";

import { RepositoryMultiSelect } from "@/components/repository-multi-select";
import { Combobox } from "@/components/ui/combobox";
import { BranchIcon, ChevronDownIcon, MonitorIcon, RepoIcon } from "@/components/ui/icons";
import type { SessionTargetPickerProps } from "@/hooks/use-session-target-picker";

/**
 * The new-session target controls: the environment/repository selector, the
 * ad-hoc repository set editor, the branch selector, and an independent
 * machine selector. State and option building live in useSessionTargetPicker.
 */
export function SessionTargetPicker({
  sessionTarget,
  targetSelectValue,
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
  selectedOutpostId,
  outpostOptions,
  displayOutpostName,
  onOutpostSelectValueChange,
  loadingOutposts,
  outpostsUnavailable,
  disabled,
}: SessionTargetPickerProps & { disabled: boolean }) {
  return (
    <>
      {/* Target selector */}
      <Combobox
        value={targetSelectValue}
        onChange={(value) => onTargetSelectValueChange(value)}
        items={targetOptions}
        searchable
        searchPlaceholder="Search environments and repositories..."
        filterFn={(option, query) =>
          option.label.toLowerCase().includes(query) ||
          (option.description?.toLowerCase().includes(query) ?? false) ||
          String(option.value).toLowerCase().includes(query)
        }
        direction="up"
        dropdownWidth="w-72"
        disabled={disabled || loadingRepos}
        triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        <RepoIcon className="w-4 h-4" />
        <span className="truncate max-w-[12rem] sm:max-w-none">
          {loadingRepos ? "Loading..." : displayTargetName}
        </span>
        <ChevronDownIcon className="w-3 h-3" />
      </Combobox>

      {/* Ad-hoc repository set editor */}
      {sessionTarget?.kind === "repos" && (
        <RepositoryMultiSelect
          repos={repos}
          loadingRepos={loadingRepos}
          selected={sessionTarget.repoFullNames}
          onChange={onMultiSelectionChange}
          disabled={disabled || loadingRepos}
          triggerLabel={
            sessionTarget.repoFullNames.length === 0
              ? "Choose repositories"
              : sessionTarget.repoFullNames.join(", ")
          }
          triggerClassName="max-w-[16rem] border-0 bg-transparent px-0 py-0 text-sm text-muted-foreground hover:text-foreground"
        />
      )}

      {/* Branch selector */}
      {sessionTarget?.kind === "repo" && (
        <Combobox
          value={selectedBranch}
          onChange={(value) => setSelectedBranch(value)}
          items={branches.map((b) => ({
            value: b.name,
            label: b.name,
          }))}
          searchable
          searchPlaceholder="Search branches..."
          filterFn={(option, query) => option.label.toLowerCase().includes(query)}
          direction="up"
          dropdownWidth="w-56"
          disabled={disabled || loadingBranches}
          triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <BranchIcon className="w-3.5 h-3.5" />
          <span className="truncate max-w-[9rem] sm:max-w-none">
            {loadingBranches ? "Loading..." : selectedBranch || "branch"}
          </span>
          <ChevronDownIcon className="w-3 h-3" />
        </Combobox>
      )}

      {/* Machine placement stays independent from the repository target. */}
      {(loadingOutposts || outpostsUnavailable || outpostOptions.length > 0) && (
        <Combobox
          value={selectedOutpostId ?? ""}
          onChange={onOutpostSelectValueChange}
          items={outpostOptions}
          searchable
          searchPlaceholder="Search machines..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            (option.description?.toLowerCase().includes(query) ?? false)
          }
          direction="up"
          dropdownWidth="w-64"
          disabled={
            disabled || loadingOutposts || outpostsUnavailable || outpostOptions.length === 0
          }
          triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <MonitorIcon className="w-4 h-4" />
          <span className="truncate max-w-[12rem] sm:max-w-none">{displayOutpostName}</span>
          {!loadingOutposts && !outpostsUnavailable && outpostOptions.length > 0 && (
            <ChevronDownIcon className="w-3 h-3" />
          )}
        </Combobox>
      )}
    </>
  );
}
