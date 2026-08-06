"use client";

import { useIsMobile } from "@/hooks/use-media-query";
import {
  ModelIcon,
  FolderIcon,
  KeyboardIcon,
  DataControlsIcon,
  IntegrationsIcon,
  AppearanceIcon,
  LinkIcon,
  ChevronRightIcon,
} from "@/components/ui/icons";

export type SettingsCategory =
  | "secrets"
  | "environments"
  | "providers"
  | "models"
  | "appearance"
  | "keyboard-shortcuts"
  | "data-controls"
  | "sandbox"
  | "integrations"
  | "mcp-servers";

const NAV_ITEMS = [
  {
    id: "environments",
    label: "Environments",
    icon: FolderIcon,
  },
  {
    id: "providers",
    label: "Providers",
    icon: LinkIcon,
  },
  {
    id: "models",
    label: "Models",
    icon: ModelIcon,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: AppearanceIcon,
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard",
    icon: KeyboardIcon,
  },
  {
    id: "data-controls",
    label: "Data Controls",
    icon: DataControlsIcon,
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: IntegrationsIcon,
  },
] as const satisfies ReadonlyArray<{
  id: SettingsCategory;
  label: string;
  icon: typeof FolderIcon;
}>;

interface SettingsNavProps {
  activeCategory: SettingsCategory;
  onSelect: (category: SettingsCategory) => void;
  onNavigate?: () => void;
}

export function SettingsNav({ activeCategory, onSelect, onNavigate }: SettingsNavProps) {
  const isMobile = useIsMobile();
  const navItems = NAV_ITEMS;

  if (isMobile) {
    return (
      <nav className="p-4">
        <h2 className="text-lg font-semibold text-foreground mb-4">Settings</h2>
        <ul className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(item.id);
                    onNavigate?.();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-3 text-sm rounded transition text-foreground hover:bg-muted"
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-left">{item.label}</span>
                  <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav className="w-48 flex-shrink-0 border-r border-border-muted p-4">
      <h2 className="text-lg font-semibold text-foreground mb-4">Settings</h2>
      <ul className="space-y-1">
        {navItems.map((item) => {
          const isActive = activeCategory === item.id;
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={isActive ? "page" : undefined}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded transition ${
                  isActive
                    ? "text-foreground bg-muted font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
