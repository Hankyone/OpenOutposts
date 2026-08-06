import { MODEL_REASONING_CONFIG, type ValidModel } from "@open-inspect/shared";
import type { CatalogModelReasoning } from "@/hooks/use-model-catalog";

interface ReasoningEffortPillsProps {
  selectedModel: string;
  reasoningEffort: string | undefined;
  onSelect: (effort: string) => void;
  disabled: boolean;
  /**
   * What the harness catalog says this model supports, when the catalog names
   * it: a list of efforts, or null for a model with no thinking mode at all.
   * Undefined means the catalog has never heard of the model — a bundled model
   * on a deployment with no homestead — and the bundled table answers instead.
   *
   * The catalog wins wherever both can speak. It reports what a turn will
   * actually accept; the bundled table is a hand-maintained guess that goes
   * stale, and offering an effort it lists but the harness refuses is how a
   * turn dies on the effort the user picked.
   */
  catalogReasoning?: CatalogModelReasoning | null;
}

/** The two sources agree on shape, so the render below need not know which spoke. */
interface EffortChoices {
  efforts: readonly string[];
  default: string | null;
}

function effortChoices(
  selectedModel: string,
  catalogReasoning: CatalogModelReasoning | null | undefined
): EffortChoices | null {
  if (catalogReasoning !== undefined) return catalogReasoning;
  const bundled = MODEL_REASONING_CONFIG[selectedModel as ValidModel];
  return bundled ? { efforts: bundled.efforts, default: bundled.default ?? null } : null;
}

export function ReasoningEffortPills({
  selectedModel,
  reasoningEffort,
  onSelect,
  disabled,
  catalogReasoning,
}: ReasoningEffortPillsProps) {
  const config = effortChoices(selectedModel, catalogReasoning);
  if (!config || config.efforts.length === 0) return null;

  // If effort is not in the list (e.g. model just changed), -1 wraps to index 0 on cycle
  const currentIndex = reasoningEffort ? config.efforts.indexOf(reasoningEffort) : -1;
  const handleCycle = () => {
    const nextIndex = (currentIndex + 1) % config.efforts.length;
    onSelect(config.efforts[nextIndex]);
  };

  return (
    <button
      type="button"
      onClick={handleCycle}
      disabled={disabled}
      className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition disabled:opacity-50 disabled:cursor-not-allowed"
      aria-label={`Reasoning: ${reasoningEffort ?? config.default ?? "default"} (click to cycle)`}
      title={`Reasoning: ${reasoningEffort ?? config.default ?? "default"} (click to cycle)`}
    >
      {reasoningEffort ?? config.default ?? "default"}
    </button>
  );
}
