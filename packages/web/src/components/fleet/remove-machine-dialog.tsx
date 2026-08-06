"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface RemoveMachineDialogProps {
  /** The machine awaiting confirmation, or null when the dialog is closed. */
  machineName: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * Confirms removal, and says plainly what removal does and does not do:
 * running sessions lose their machine, and the machine can come back on its
 * own because enrollment credentials are still deployment-wide.
 */
export function RemoveMachineDialog({
  machineName,
  onOpenChange,
  onConfirm,
}: RemoveMachineDialogProps) {
  return (
    <AlertDialog open={machineName !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {machineName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Sessions running on this machine lose it and stop where they are, and it disappears from
            the machine picker. Removal does not revoke the enrollment credential yet, so a worker
            left running on the machine will reappear here when it reconnects.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
