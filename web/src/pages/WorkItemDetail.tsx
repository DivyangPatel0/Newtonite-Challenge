import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

export function WorkItemDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPriority, setEditPriority] = useState('medium');
  const [editRequiresApproval, setEditRequiresApproval] = useState(false);
  const [editing, setEditing] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [conflictBanner, setConflictBanner] = useState('');
  const [errorBanner, setErrorBanner] = useState('');
  const [versionChanged, setVersionChanged] = useState(false);
  const lastKnownVersion = useRef<number>(0);

  const { data: item, isLoading, error } = useQuery({
    queryKey: ['work-item', id],
    queryFn: () => api.workItems.get(id!),
    refetchInterval: 12000,
    refetchOnWindowFocus: true,
    enabled: !!id,
  });

  const { data: teamMembersData } = useQuery({
    queryKey: ['team-members', item?.team_id],
    queryFn: () => api.teams.members(item!.team_id),
    enabled: !!item?.team_id,
  });

  const { data: eventsData } = useQuery({
    queryKey: ['events', id],
    queryFn: () => api.events.list(id!, { limit: '100' }),
    enabled: !!id,
    refetchInterval: 12000,
  });

  const { data: commentsData } = useQuery({
    queryKey: ['comments', id],
    queryFn: () => api.comments.list(id!, { limit: '100' }),
    enabled: !!id,
    refetchInterval: 12000,
  });

  // Detect version change while editing
  useEffect(() => {
    if (item && lastKnownVersion.current > 0 && item.version !== lastKnownVersion.current) {
      setVersionChanged(true);
    }
    if (item) {
      lastKnownVersion.current = item.version;
    }
  }, [item?.version]);

  function startEdit() {
    if (!item) return;
    setEditTitle(item.title);
    setEditDesc(item.description);
    setEditPriority(item.priority);
    setEditRequiresApproval(item.requires_approval);
    setEditing(true);
    setConflictBanner('');
    setVersionChanged(false);
  }

  const patchMutation = useMutation({
    mutationFn: (data: any) => api.workItems.patch(id!, data),
    onSuccess: () => {
      setEditing(false);
      setConflictBanner('');
      queryClient.invalidateQueries({ queryKey: ['work-item', id] });
      queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        const current = err.details?.current;
        setConflictBanner(`This item was updated by someone else. Current title: "${current?.title}". Please review and try again.`);
        if (current) {
          lastKnownVersion.current = current.version;
        }
      } else {
        setErrorBanner(err.message || 'Failed to update');
      }
    },
  });

  const claimMutation = useMutation({
    mutationFn: () => api.workItems.claim(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-item', id] });
      queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError && err.code === 'ALREADY_CLAIMED') {
        setErrorBanner(`Already claimed by ${err.details?.assignee_name || 'someone else'}`);
      } else {
        setErrorBanner(err.message || 'Failed to claim');
      }
      queryClient.invalidateQueries({ queryKey: ['work-item', id] });
    },
  });

  const assignMutation = useMutation({
    mutationFn: (assignee_id: string | null) =>
      api.workItems.assign(id!, { assignee_id, version: item!.version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-item', id] });
      queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
    onError: (err: any) => {
      setErrorBanner(err instanceof ApiError ? err.message : 'Failed to assign');
      queryClient.invalidateQueries({ queryKey: ['work-item', id] });
    },
  });

  const transitionMutation = useMutation({
    mutationFn: (status: string) => api.workItems.transition(id!, { status, version: item!.version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-item', id] });
      queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
    onError: (err: any) => {
      if (err instanceof ApiError) {
        setErrorBanner(err.message);
        if (err.code === 'VERSION_CONFLICT') {
          queryClient.invalidateQueries({ queryKey: ['work-item', id] });
        }
      }
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => api.workItems.approve(id!, { version: item!.version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-item', id] });
      queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
    onError: (err: any) => {
      setErrorBanner(err instanceof ApiError ? err.message : 'Failed to approve');
    },
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) => api.comments.create(id!, body),
    onSuccess: () => {
      setCommentBody('');
      queryClient.invalidateQueries({ queryKey: ['comments', id] });
      queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
    onError: (err: any) => {
      setErrorBanner(err instanceof ApiError ? err.message : 'Failed to add comment');
    },
  });

  if (isLoading) return <div className="loading">Loading...</div>;
  if (error) return <div className="banner error">Failed to load work item</div>;
  if (!item) return <div className="banner error">Item not found</div>;

  const membership = user?.memberships?.find((m: any) => m.team_id === item.team_id);
  const isLeadOrAdmin = membership?.role === 'lead' || membership?.role === 'admin';
  const isAssignee = item.assignee_id === user?.id;
  const canApprove = isLeadOrAdmin && item.status === 'pending_approval' && item.requires_approval && !isAssignee && !item.approved_by;
  const teamMembers = teamMembersData?.members || [];

  // Merge events and comments into a timeline
  const events = (eventsData?.items || []).map((e: any) => ({ ...e, _type: 'event' }));
  const comments = (commentsData?.items || []).map((c: any) => ({ ...c, _type: 'comment' }));
  const timeline = [...events, ...comments].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const anyMutating = patchMutation.isPending || claimMutation.isPending || assignMutation.isPending ||
    transitionMutation.isPending || approveMutation.isPending || commentMutation.isPending;

  return (
    <div>
      <div className="page-header">
        <h2>
          {editing ? 'Editing: ' : ''}{item.title}
        </h2>
        <button className="secondary" onClick={() => navigate(-1)}>Back</button>
      </div>

      {versionChanged && !editing && (
        <div className="banner warning">
          This item was updated by someone else. The page has been refreshed.
        </div>
      )}

      {conflictBanner && <div className="banner warning">{conflictBanner}</div>}
      {errorBanner && (
        <div className="banner error">
          {errorBanner}
          <button
            style={{ marginLeft: 8, fontSize: 11 }}
            className="secondary"
            onClick={() => setErrorBanner('')}
          >
            dismiss
          </button>
        </div>
      )}

      {editing ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body">
            <div className="form-group">
              <label htmlFor="edit-title">Title</label>
              <input id="edit-title" value={editTitle} onChange={e => setEditTitle(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="edit-desc">Description</label>
              <textarea id="edit-desc" value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={4} />
            </div>
            <div className="form-group">
              <label htmlFor="edit-priority">Priority</label>
              <select id="edit-priority" value={editPriority} onChange={e => setEditPriority(e.target.value)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={editRequiresApproval}
                  onChange={e => setEditRequiresApproval(e.target.checked)}
                  style={{ width: 'auto', marginRight: 6 }}
                />
                Requires approval before resolving
              </label>
            </div>
            <div className="form-actions">
              <button
                className="primary"
                disabled={patchMutation.isPending}
                onClick={() => patchMutation.mutate({
                  title: editTitle,
                  description: editDesc,
                  priority: editPriority,
                  requires_approval: editRequiresApproval,
                  version: item.version,
                })}
              >
                {patchMutation.isPending ? 'Saving...' : 'Save'}
              </button>
              <button className="secondary" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body">
            <div className="detail-meta">
              <dt>Status</dt>
              <dd><span className={`badge ${item.status}`}>{item.status.replace('_', ' ')}</span></dd>
              <dt>Priority</dt>
              <dd><span className={`badge ${item.priority}`}>{item.priority}</span></dd>
              <dt>Team</dt>
              <dd>{item.team_name}</dd>
              <dt>Assignee</dt>
              <dd>
                {isLeadOrAdmin ? (
                  <select
                    aria-label="Reassign work item"
                    value={item.assignee_id || ''}
                    disabled={anyMutating}
                    onChange={e => assignMutation.mutate(e.target.value || null)}
                    style={{ width: 'auto', padding: '2px 8px', fontSize: 13 }}
                  >
                    <option value="">Unassigned</option>
                    {teamMembers.map((m: any) => (
                      <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
                    ))}
                  </select>
                ) : (
                  item.assignee_name || 'Unassigned'
                )}
              </dd>
              <dt>Created by</dt>
              <dd>{item.creator_name}</dd>
              {item.approved_by && (
                <>
                  <dt>Approved by</dt>
                  <dd>{item.approver_name}</dd>
                </>
              )}
              <dt>Approval</dt>
              <dd>{item.requires_approval ? 'Required' : 'Not required'}</dd>
              <dt>Version</dt>
              <dd>{item.version}</dd>
              <dt>Updated</dt>
              <dd>{new Date(item.updated_at).toLocaleString()}</dd>
              <dt>Created</dt>
              <dd>{new Date(item.created_at).toLocaleString()}</dd>
            </div>
            {item.description && (
              <div style={{ marginTop: 12, whiteSpace: 'pre-wrap', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                {item.description}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="actions-bar" style={{ marginBottom: 16 }}>
        {!editing && (
          <button className="secondary" onClick={startEdit} disabled={anyMutating}>Edit</button>
        )}

        {!item.assignee_id && (
          <button
            className="primary"
            onClick={() => claimMutation.mutate()}
            disabled={anyMutating}
          >
            {claimMutation.isPending ? 'Claiming...' : 'Claim'}
          </button>
        )}

        {(item.allowed_transitions || []).map((t: string) => (
          <button
            key={t}
            className={t === 'closed' ? 'danger' : 'secondary'}
            onClick={() => transitionMutation.mutate(t)}
            disabled={anyMutating}
          >
            {transitionMutation.isPending ? '...' : t.replace('_', ' ')}
          </button>
        ))}

        {canApprove && (
          <button
            className="primary"
            onClick={() => approveMutation.mutate()}
            disabled={anyMutating}
          >
            {approveMutation.isPending ? 'Approving...' : 'Approve'}
          </button>
        )}
      </div>

      <div className="detail-section">
        <h3>Activity</h3>
        <div className="card">
          <div className="card-body" style={{ maxHeight: 400, overflowY: 'auto' }}>
            {timeline.length === 0 && <div className="empty-state">No activity yet</div>}
            {timeline.map((entry: any) => (
              <div key={entry._type + (entry.id)} className="timeline-item">
                {entry._type === 'event' ? (
                  <div>
                    <span className="timeline-actor">{entry.actor_name}</span>
                    {' '}{formatEventType(entry.type, entry.payload)}
                    <div className="timeline-time">{new Date(entry.created_at).toLocaleString()}</div>
                  </div>
                ) : (
                  <div>
                    <span className="timeline-actor">{entry.author_name}</span> commented
                    <div className="timeline-time">{new Date(entry.created_at).toLocaleString()}</div>
                    <div className="timeline-comment">{entry.body}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Add comment</h3>
        <form
          onSubmit={e => {
            e.preventDefault();
            if (commentBody.trim()) commentMutation.mutate(commentBody);
          }}
        >
          <textarea
            value={commentBody}
            onChange={e => setCommentBody(e.target.value)}
            rows={3}
            placeholder="Write a comment..."
          />
          <div className="form-actions">
            <button
              type="submit"
              className="primary"
              disabled={commentMutation.isPending || !commentBody.trim()}
            >
              {commentMutation.isPending ? 'Posting...' : 'Post comment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatEventType(type: string, payload: any): string {
  switch (type) {
    case 'created': return 'created this item';
    case 'updated': {
      const changes = payload?.changes;
      if (changes) {
        const fields = Object.keys(changes);
        return `updated ${fields.join(', ')}`;
      }
      return 'updated this item';
    }
    case 'claimed': return 'claimed this item';
    case 'assigned': return `assigned this item`;
    case 'transitioned': return `changed status from ${payload?.from} to ${payload?.to}`;
    case 'approved': return 'approved this item';
    case 'commented': return 'added a comment';
    default: return type;
  }
}
