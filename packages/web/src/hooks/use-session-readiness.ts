import type { ReadinessItem } from "@/components/session-readiness";
import { useHomesteadReadiness } from "@/hooks/use-homestead-readiness";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { useOutpostBoundSessions } from "@/hooks/use-outposts";
import { useProviderCredentials } from "@/hooks/use-provider-credentials";
import type { SessionTargetSelection } from "@/hooks/use-session-target-picker";

function providerName(providerId: string): string {
  return providerId ? providerId.charAt(0).toUpperCase() + providerId.slice(1) : "Provider";
}

/** The five facts a person needs before trying their first session. */
export function useSessionReadiness(
  picker: SessionTargetSelection,
  selectedModel: string
): ReadinessItem[] {
  const homestead = useHomesteadReadiness();
  const liveOutpost = useOutpostBoundSessions(picker.sessionTarget?.outpostId ?? null);
  const providerCredentials = useProviderCredentials();
  const modelCatalog = useModelCatalog();

  const providerId = selectedModel.split("/", 1)[0] ?? "";
  const selectedProvider = modelCatalog.view
    ? [
        ...modelCatalog.view.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
        })),
        ...modelCatalog.view.unconnectedProviders.map((provider) => ({
          id: provider.id,
          name: provider.name,
        })),
      ].find((provider) => provider.id === providerId)
    : null;
  const providerLabel = selectedProvider?.name ?? providerName(providerId);

  const homesteadItem: ReadinessItem = homestead.loading
    ? { label: "Homestead", value: "Checking...", tone: "neutral" }
    : homestead.unavailable
      ? { label: "Homestead", value: "Status unavailable", tone: "warning" }
      : homestead.connected
        ? { label: "Homestead", value: "Connected", tone: "ready" }
        : { label: "Homestead", value: "Not connected", tone: "blocked" };

  const machineItem: ReadinessItem = picker.loadingOutposts
    ? { label: "Machine", value: "Checking...", tone: "neutral" }
    : picker.outpostsUnavailable
      ? { label: "Machine", value: "Status unavailable", tone: "warning", href: "/machines" }
      : !picker.selectedOutpost
        ? { label: "Machine", value: "Choose a machine", tone: "blocked", href: "/machines" }
        : liveOutpost.loading
          ? { label: "Machine", value: `${picker.selectedOutpost.name}, checking`, tone: "neutral" }
          : liveOutpost.unavailable || liveOutpost.connected === null
            ? {
                label: "Machine",
                value: `${picker.selectedOutpost.name}, status unavailable`,
                tone: "warning",
                href: "/machines",
              }
            : liveOutpost.connected
              ? {
                  label: "Machine",
                  value: `${picker.selectedOutpost.name}, connected`,
                  tone: "ready",
                }
              : {
                  label: "Machine",
                  value: `${picker.selectedOutpost.name}, offline`,
                  tone: "blocked",
                  href: "/machines",
                };

  const hasProviderCredential = providerCredentials.credentials.some(
    (credential) => credential.provider === providerId
  );
  const providerItem: ReadinessItem = providerCredentials.loading
    ? { label: "Provider key", value: "Checking...", tone: "neutral" }
    : providerCredentials.unavailable
      ? { label: "Provider key", value: "Status unavailable", tone: "warning" }
      : hasProviderCredential
        ? { label: "Provider key", value: `${providerLabel} connected`, tone: "ready" }
        : {
            label: "Provider key",
            value: `Connect ${providerLabel}`,
            tone: "blocked",
            href: "/settings?tab=providers",
          };

  const selectedModelIsLive =
    modelCatalog.view?.source === "homestead" &&
    modelCatalog.view.providers.some((provider) =>
      provider.models.some((model) => model.id === selectedModel)
    );
  const modelItem: ReadinessItem = modelCatalog.loading
    ? { label: "Model", value: "Checking...", tone: "neutral" }
    : modelCatalog.source === "error"
      ? { label: "Model", value: "Status unavailable", tone: "warning" }
      : selectedModelIsLive
        ? { label: "Model", value: "Ready", tone: "ready" }
        : modelCatalog.source === "stale"
          ? { label: "Model", value: "Catalog stale", tone: "warning" }
          : modelCatalog.source === "unavailable"
            ? { label: "Model", value: "Not reported", tone: "warning" }
            : { label: "Model", value: "Not available", tone: "blocked" };

  const repositoryItem: ReadinessItem = !picker.sessionTarget
    ? { label: "Repository", value: "Checking...", tone: "neutral" }
    : picker.sessionTarget.kind === "none"
      ? { label: "Repository", value: "No repository", tone: "neutral" }
      : picker.sessionTarget.kind === "repo"
        ? {
            label: "Repository",
            value: picker.selectedRepo?.fullName ?? picker.sessionTarget.repoFullName,
            tone: "ready",
          }
        : {
            label: "Repository",
            value: picker.pickerProps.displayTargetName,
            tone: "ready",
          };

  return [homesteadItem, machineItem, providerItem, modelItem, repositoryItem];
}
