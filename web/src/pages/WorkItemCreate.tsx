import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

export function WorkItemCreate() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const teams = user?.memberships || [];
  const [teamId, setTeamId] = useState(teams[0]?.team_id || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (data: any) => api.workItems.create(data),
    onSuccess: (result) => {
      navigate(`/items/${result.id}`);
    },
    onError: (err: any) => {
      setError(err instanceof ApiError ? err.message : 'Failed to create item');
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    mutation.mutate({ team_id: teamId, title, description, priority, requires_approval: requiresApproval });
  }

  return (
    <div>
      <div className="page-header">
        <h2>New Work Item</h2>
      </div>

      <div className="card">
        <div className="card-body">
          {error && <div className="banner error">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="team">Team</label>
              <select id="team" value={teamId} onChange={e => setTeamId(e.target.value)} required>
                <option value="">Select team</option>
                {teams.map((t: any) => (
                  <option key={t.team_id} value={t.team_id}>{t.team_name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="title">Title</label>
              <input id="title" value={title} onChange={e => setTitle(e.target.value)} required maxLength={500} />
            </div>
            <div className="form-group">
              <label htmlFor="description">Description</label>
              <textarea id="description" value={description} onChange={e => setDescription(e.target.value)} rows={4} />
            </div>
            <div className="form-group">
              <label htmlFor="priority">Priority</label>
              <select id="priority" value={priority} onChange={e => setPriority(e.target.value)}>
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
                  checked={requiresApproval}
                  onChange={e => setRequiresApproval(e.target.checked)}
                  style={{ width: 'auto', marginRight: 6 }}
                />
                Requires approval before resolving
              </label>
            </div>
            <div className="form-actions">
              <button type="submit" className="primary" disabled={mutation.isPending}>
                {mutation.isPending ? 'Creating...' : 'Create'}
              </button>
              <button type="button" className="secondary" onClick={() => navigate(-1)}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
