/**
 * Git utilities for branch management.
 */

/**
 * Branch naming convention for OpenOutposts sessions.
 *
 * This lands in other people's repositories, so it is part of the product's
 * public identity. Changing it means branches pushed under the old prefix are
 * no longer recognized as session branches by isSessionBranch().
 */
export const BRANCH_PREFIX = "openoutposts";

/**
 * Normalize a git branch name for consistent OpenOutposts branch handling.
 */
export function normalizeBranchName(branchName: string): string {
  return branchName.trim().toLowerCase();
}

/**
 * Generate a branch name for a session.
 *
 * @param sessionId - Session ID
 * @param title - Optional title for the branch
 * @returns Branch name in format: openoutposts/{session-id}
 */
export function generateBranchName(sessionId: string, _title?: string): string {
  // Use just session ID to keep it short and unique
  return normalizeBranchName(`${BRANCH_PREFIX}/${sessionId}`);
}

/**
 * Extract session ID from a branch name.
 *
 * @param branchName - Branch name
 * @returns Session ID or null if not an OpenOutposts branch
 */
export function extractSessionIdFromBranch(branchName: string): string | null {
  const prefix = `${BRANCH_PREFIX}/`;
  const normalizedBranchName = normalizeBranchName(branchName);
  if (!normalizedBranchName.startsWith(prefix)) {
    return null;
  }
  return normalizedBranchName.slice(prefix.length);
}

/**
 * Check if a branch name is an OpenOutposts branch.
 */
export function isInspectBranch(branchName: string): boolean {
  return normalizeBranchName(branchName).startsWith(`${BRANCH_PREFIX}/`);
}
