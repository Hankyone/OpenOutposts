"use client";

import Link from "next/link";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { ModelIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";

export const PROVIDER_SETTINGS_HREF = "/settings?tab=providers";

interface ModelPickerProps {
  selectedModel: string;
  onSelect: (model: string) => void;
  items: ComboboxGroup[];
  disabled?: boolean;
  /**
   * Nothing is reachable for this user: the harness catalog answered and no
   * connected provider offers a model. Showing the dropdown here would either
   * be empty or list models that cannot answer, so the control becomes the one
   * thing that resolves it.
   */
  needsProviderConnection?: boolean;
}

const TRIGGER_CLASS =
  "flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition";

/**
 * The model selector in both prompt composers.
 *
 * The list it is given is already the reachable one — see `useModelPicker` —
 * so this component's only judgement is what to render when there is nothing
 * to choose from.
 */
export function ModelPicker({
  selectedModel,
  onSelect,
  items,
  disabled = false,
  needsProviderConnection = false,
}: ModelPickerProps) {
  if (needsProviderConnection) {
    return (
      <Link
        href={PROVIDER_SETTINGS_HREF}
        className="flex items-center gap-1 text-sm text-warning hover:text-foreground transition"
        title="No provider is connected, so no model can answer. Add a provider key in settings."
      >
        <ModelIcon className="w-3.5 h-3.5" />
        <span>connect a provider</span>
      </Link>
    );
  }

  // The bundled display-name map does not know a model that only the harness
  // reports, so prefer the label the list itself carries.
  const label =
    items
      .flatMap((group) => group.options)
      .find((option) => option.value === selectedModel)
      ?.label.toLowerCase() ?? formatModelNameLower(selectedModel);

  return (
    <Combobox
      value={selectedModel}
      onChange={onSelect}
      items={items}
      direction="up"
      dropdownWidth="w-56"
      disabled={disabled}
      triggerClassName={TRIGGER_CLASS}
    >
      <ModelIcon className="w-3.5 h-3.5" />
      <span className="truncate max-w-[9rem] sm:max-w-none">{label}</span>
    </Combobox>
  );
}
