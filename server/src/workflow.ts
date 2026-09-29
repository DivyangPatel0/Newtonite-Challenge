// All allowed status transitions in one place.
// Key is current status, value is set of statuses it can move to.
const TRANSITIONS: Record<string, Set<string>> = {
  open: new Set(['in_progress']),
  in_progress: new Set(['pending_approval', 'resolved']),
  pending_approval: new Set(['resolved', 'in_progress']),
  resolved: new Set(['closed', 'in_progress']),
  closed: new Set(),
};

export function isValidTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function getAllowedTransitions(from: string): string[] {
  return Array.from(TRANSITIONS[from] || []);
}

// Items with requires_approval must go through pending_approval before resolved.
// This means from in_progress, the only path to resolved is via pending_approval.
export function requiresApprovalStep(
  from: string,
  to: string,
  requiresApproval: boolean,
): boolean {
  if (!requiresApproval) return false;
  // Block direct in_progress -> resolved when approval is required
  return from === 'in_progress' && to === 'resolved';
}
