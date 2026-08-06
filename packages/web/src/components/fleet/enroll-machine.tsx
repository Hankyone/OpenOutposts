"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { browserApiFetch } from "@/lib/browser-api-fetch";

type OperatingSystem = "macos" | "linux";
type EnrollmentState = "issued" | "awaiting_confirmation" | "confirmed" | "expired" | "cancelled";

interface Enrollment {
  enrollmentId: string;
  expiresAt: string;
  commands: Record<OperatingSystem, string>;
}

interface EnrollmentStatus {
  enrollmentId: string;
  outpostId: string | null;
  state: EnrollmentState;
  expiresAt: string;
}

function errorMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

export function EnrollMachine({ onEnrolled }: { onEnrolled: () => void }) {
  const [operatingSystem, setOperatingSystem] = useState<OperatingSystem>("macos");
  const [name, setName] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [state, setState] = useState<EnrollmentState | null>(null);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!enrollment || state !== "issued") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkStatus = async () => {
      try {
        const response = await browserApiFetch(
          `/api/outposts/enrollments/${encodeURIComponent(enrollment.enrollmentId)}`
        );
        const body = (await response.json().catch(() => null)) as EnrollmentStatus | null;
        if (cancelled) return;
        if (!response.ok || !body) {
          setActionError(errorMessage(body, "Failed to check enrollment"));
          timer = setTimeout(checkStatus, 1_500);
          return;
        }
        setActionError(null);
        setState(body.state);
        if (body.state === "issued") {
          timer = setTimeout(checkStatus, 1_500);
        }
      } catch (error) {
        console.error("Failed to check enrollment:", error);
        if (!cancelled) {
          setActionError("Failed to check enrollment");
          timer = setTimeout(checkStatus, 1_500);
        }
      }
    };

    void checkStatus();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enrollment, state]);

  const createEnrollment = async () => {
    setCreating(true);
    setActionError(null);
    setConfirmationCode("");
    setCopied(false);

    try {
      const response = await browserApiFetch("/api/outposts/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(name.trim() ? { name: name.trim() } : {}),
      });
      const body = (await response.json().catch(() => null)) as Enrollment | null;
      if (!response.ok || !body) {
        setActionError(errorMessage(body, "Failed to create enrollment"));
        return;
      }
      setEnrollment(body);
      setState("issued");
    } catch (error) {
      console.error("Failed to create enrollment:", error);
      setActionError("Failed to create enrollment");
    } finally {
      setCreating(false);
    }
  };

  const copyCommand = async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.commands[operatingSystem]);
      setCopied(true);
    } catch (error) {
      console.error("Failed to copy enrollment command:", error);
      setActionError("Could not copy the command. Select it and copy it manually.");
    }
  };

  const confirmEnrollment = async () => {
    if (!enrollment) return;
    setConfirming(true);
    setActionError(null);

    try {
      const response = await browserApiFetch(
        `/api/outposts/enrollments/${encodeURIComponent(enrollment.enrollmentId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: confirmationCode }),
        }
      );
      const body = (await response.json().catch(() => null)) as {
        confirmed?: boolean;
        error?: string;
      } | null;
      if (!response.ok || !body?.confirmed) {
        setActionError(errorMessage(body, "Failed to confirm enrollment"));
        return;
      }
      setState("confirmed");
      onEnrolled();
    } catch (error) {
      console.error("Failed to confirm enrollment:", error);
      setActionError("Failed to confirm enrollment");
    } finally {
      setConfirming(false);
    }
  };

  const reset = () => {
    setEnrollment(null);
    setState(null);
    setConfirmationCode("");
    setActionError(null);
    setCopied(false);
  };

  return (
    <section className="mt-8 border border-border-muted rounded-md px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Add a machine</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run one command on the machine, then confirm the code it prints.
          </p>
        </div>
        {enrollment && state !== "confirmed" && (
          <Button type="button" variant="subtle" size="sm" onClick={reset}>
            Start over
          </Button>
        )}
      </div>

      {actionError && (
        <ErrorBanner className="mt-4" role="alert">
          {actionError}
        </ErrorBanner>
      )}

      {!enrollment && (
        <div className="mt-4 space-y-4">
          <div className="max-w-sm">
            <Label htmlFor="machine-name">Machine name (optional)</Label>
            <Input
              id="machine-name"
              className="mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Studio Mac mini"
              maxLength={200}
            />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Operating system</p>
            <ToggleGroup
              className="mt-1 justify-start"
              type="single"
              value={operatingSystem}
              onValueChange={(value) => {
                if (value === "macos" || value === "linux") {
                  setOperatingSystem(value);
                  setCopied(false);
                }
              }}
              aria-label="Operating system"
            >
              <ToggleGroupItem value="macos">macOS</ToggleGroupItem>
              <ToggleGroupItem value="linux">Linux</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <Button type="button" onClick={() => void createEnrollment()} disabled={creating}>
            {creating ? "Creating…" : "Generate command"}
          </Button>
        </div>
      )}

      {enrollment && state !== "confirmed" && (
        <div className="mt-4 space-y-4">
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">
                Run on {operatingSystem === "macos" ? "macOS" : "Linux"}
              </p>
              <Button type="button" variant="subtle" size="sm" onClick={() => void copyCommand()}>
                {copied ? "Copied" : "Copy command"}
              </Button>
            </div>
            <pre className="mt-1 overflow-x-auto rounded-sm bg-muted px-3 py-3 text-xs text-foreground">
              <code>{enrollment.commands[operatingSystem]}</code>
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              Run it from the folder this machine should expose. The openoutpost command must
              already be installed.
            </p>
          </div>

          {state === "issued" && (
            <p className="text-sm text-muted-foreground" role="status">
              Waiting for the machine to respond…
            </p>
          )}

          {state === "awaiting_confirmation" && (
            <div className="max-w-sm">
              <Label htmlFor="confirmation-code">Code shown on the machine</Label>
              <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id="confirmation-code"
                  value={confirmationCode}
                  onChange={(event) => setConfirmationCode(event.target.value)}
                  placeholder="123-456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                />
                <Button
                  type="button"
                  onClick={() => void confirmEnrollment()}
                  disabled={confirming || !/^\d{3}-?\d{3}$/.test(confirmationCode)}
                >
                  {confirming ? "Confirming…" : "Confirm"}
                </Button>
              </div>
            </div>
          )}

          {(state === "expired" || state === "cancelled") && (
            <p className="text-sm text-destructive">
              This enrollment can no longer be used. Start over to create a new command.
            </p>
          )}
        </div>
      )}

      {state === "confirmed" && (
        <div className="mt-4">
          <p className="text-sm text-foreground" role="status">
            Machine enrolled. Its private credential stays on that machine.
          </p>
          <Button type="button" variant="subtle" size="sm" className="mt-2" onClick={reset}>
            Add another machine
          </Button>
        </div>
      )}
    </section>
  );
}
