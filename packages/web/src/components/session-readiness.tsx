import Link from "next/link";
import { cn } from "@/lib/utils";

export type ReadinessTone = "ready" | "warning" | "blocked" | "neutral";

export interface ReadinessItem {
  label: string;
  value: string;
  tone: ReadinessTone;
  href?: string;
}

const TONE_CLASS: Record<ReadinessTone, string> = {
  ready: "text-success",
  warning: "text-warning",
  blocked: "text-destructive",
  neutral: "text-muted-foreground",
};

/** A terse preflight list that stays subordinate to the prompt composer. */
export function SessionReadiness({ items }: { items: ReadinessItem[] }) {
  return (
    <ul aria-label="Session readiness" className="mt-4 space-y-2 px-1 text-sm">
      {items.map((item) => {
        const valueClassName = cn("text-right", TONE_CLASS[item.tone]);
        return (
          <li key={item.label} className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{item.label}</span>
            {item.href ? (
              <Link href={item.href} className={cn(valueClassName, "hover:text-foreground")}>
                {item.value}
              </Link>
            ) : (
              <span className={valueClassName}>{item.value}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
