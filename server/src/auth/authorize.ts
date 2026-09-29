import { query } from '../db/pool.js';
import type { AuthUser } from '../middleware/auth-hook.js';

export type Action =
  | 'view'
  | 'create'
  | 'edit'
  | 'claim'
  | 'assign'
  | 'transition'
  | 'approve'
  | 'set_critical'
  | 'close'
  | 'comment';

export interface Membership {
  team_id: string;
  role: 'member' | 'lead' | 'admin';
}

export async function getUserMemberships(userId: string): Promise<Membership[]> {
  const { rows } = await query<Membership>(
    'SELECT team_id, role FROM memberships WHERE user_id = $1',
    [userId],
  );
  return rows;
}

export async function getMembershipForTeam(
  userId: string,
  teamId: string,
  client?: { query: typeof query },
): Promise<Membership | null> {
  const runner = client || { query };
  const { rows } = await runner.query<Membership>(
    'SELECT team_id, role FROM memberships WHERE user_id = $1 AND team_id = $2',
    [userId, teamId],
  );
  return rows[0] || null;
}

// returns the membership if the user has access, or null (caller should return 404)
export async function requireTeamAccess(
  userId: string,
  teamId: string,
  client?: { query: typeof query },
): Promise<Membership | null> {
  return getMembershipForTeam(userId, teamId, client);
}

const LEAD_ONLY_ACTIONS: Action[] = ['approve', 'set_critical', 'close'];

interface WorkItem {
  team_id: string;
  assignee_id: string | null;
  created_by: string;
  status: string;
  requires_approval: boolean;
}

export function authorize(
  membership: Membership,
  action: Action,
  workItem?: WorkItem,
  user?: AuthUser,
): { allowed: boolean; reason?: string } {
  const role = membership.role;
  const isLeadOrAdmin = role === 'lead' || role === 'admin';

  if (action === 'view' || action === 'create' || action === 'comment') {
    return { allowed: true };
  }

  if (action === 'claim') {
    return { allowed: true };
  }

  if (action === 'set_critical' || action === 'close' || action === 'approve') {
    if (!isLeadOrAdmin) {
      return { allowed: false, reason: 'Requires lead or admin role' };
    }
    return { allowed: true };
  }

  if (action === 'assign') {
    if (!workItem || !user) return { allowed: false, reason: 'Missing context' };
    // members can only claim (assign to self) unassigned items; reassigning needs lead/admin
    if (!isLeadOrAdmin) {
      return { allowed: false, reason: 'Requires lead or admin role to reassign' };
    }
    return { allowed: true };
  }

  if (action === 'edit') {
    if (!workItem || !user) return { allowed: false, reason: 'Missing context' };
    if (isLeadOrAdmin) return { allowed: true };
    // members can edit their own assigned items
    if (workItem.assignee_id === user.id || workItem.created_by === user.id) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'Can only edit your own items' };
  }

  if (action === 'transition') {
    if (!workItem || !user) return { allowed: false, reason: 'Missing context' };
    if (isLeadOrAdmin) return { allowed: true };
    // members can transition their own assigned items
    if (workItem.assignee_id === user.id) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'Can only transition your own assigned items' };
  }

  return { allowed: false, reason: 'Unknown action' };
}
