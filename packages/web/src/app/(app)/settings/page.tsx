"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { SettingsNav, type SettingsCategory } from "@/components/settings/settings-nav";
import { EnvironmentsSettings } from "@/components/settings/environments-settings";
import { ModelsSettings } from "@/components/settings/models-settings";
import { ProvidersSettings } from "@/components/settings/providers-settings";
import { DataControlsSettings } from "@/components/settings/data-controls-settings";
import { KeyboardShortcutsSettings } from "@/components/settings/keyboard-shortcuts-settings";
import { IntegrationsSettings } from "@/components/settings/integrations-settings";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { SidebarIcon, BackIcon } from "@/components/ui/icons";
import { useIsMobile } from "@/hooks/use-media-query";

const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  secrets: "Secrets",
  environments: "Environments",
  providers: "Providers",
  models: "Models",
  appearance: "Appearance",
  "keyboard-shortcuts": "Keyboard",
  "data-controls": "Data Controls",
  sandbox: "Sandbox",
  integrations: "Integrations",
  "mcp-servers": "MCP Servers",
};

const VALID_CATEGORIES = new Set<string>([
  "secrets",
  "environments",
  "providers",
  "models",
  "appearance",
  "keyboard-shortcuts",
  "data-controls",
  "sandbox",
  "integrations",
  "mcp-servers",
]);

function isValidCategory(tab: string | null): tab is SettingsCategory {
  return tab !== null && VALID_CATEGORIES.has(tab);
}

function UnavailableSettings({ title }: { title: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">{title}</h2>
      <p className="text-sm text-muted-foreground">
        Not available on the outpost execution path yet. Existing saved settings remain unchanged.
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const { isOpen, toggle } = useSidebarContext();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialCategory = isValidCategory(tabParam) ? tabParam : "environments";
  const [activeCategory, setActiveCategoryRaw] = useState<SettingsCategory>(initialCategory);

  function setActiveCategory(category: SettingsCategory) {
    setActiveCategoryRaw(category);
    window.history.replaceState(null, "", `/settings?tab=${category}`);
  }
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"list" | "detail">(
    isValidCategory(tabParam) ? "detail" : "list"
  );

  // Sync state when searchParams change via client-side navigation
  useEffect(() => {
    if (isValidCategory(tabParam)) {
      setActiveCategoryRaw(tabParam);
      setMobileView("detail");
      return;
    }

    setActiveCategoryRaw("environments");
    setMobileView("list");
  }, [tabParam]);

  const content = (
    <>
      {activeCategory === "secrets" && <UnavailableSettings title="Secrets" />}
      {activeCategory === "environments" && <EnvironmentsSettings />}
      {activeCategory === "providers" && <ProvidersSettings />}
      {activeCategory === "models" && <ModelsSettings />}
      {activeCategory === "appearance" && <AppearanceSettings />}
      {activeCategory === "keyboard-shortcuts" && <KeyboardShortcutsSettings />}
      {activeCategory === "data-controls" && <DataControlsSettings />}
      {activeCategory === "sandbox" && <UnavailableSettings title="Sandbox" />}
      {activeCategory === "integrations" && <IntegrationsSettings />}
      {activeCategory === "mcp-servers" && <UnavailableSettings title="MCP Servers" />}
    </>
  );

  if (isMobile) {
    return (
      <div className="h-full flex flex-col">
        {mobileView === "list" ? (
          <>
            <header className="border-b border-border-muted flex-shrink-0">
              <div className="px-4 py-3">
                <button
                  type="button"
                  onClick={toggle}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                  title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                  aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                >
                  <SidebarIcon className="w-4 h-4" />
                </button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto">
              <SettingsNav
                activeCategory={activeCategory}
                onSelect={setActiveCategory}
                onNavigate={() => setMobileView("detail")}
              />
            </div>
          </>
        ) : (
          <>
            <header className="border-b border-border-muted flex-shrink-0">
              <div className="px-4 py-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggle}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                  title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                  aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                >
                  <SidebarIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setMobileView("list")}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                  aria-label="Back to settings"
                >
                  <BackIcon className="w-4 h-4" />
                </button>
                <h2 className="text-sm font-medium text-foreground">
                  {CATEGORY_LABELS[activeCategory]}
                </h2>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="max-w-2xl">{content}</div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}

      <div className="flex-1 flex overflow-hidden">
        <SettingsNav activeCategory={activeCategory} onSelect={setActiveCategory} />
        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-2xl">{content}</div>
        </div>
      </div>
    </div>
  );
}
