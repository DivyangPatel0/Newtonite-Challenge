import { useState, useCallback } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

export function WorkItemList() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const status = searchParams.get('status') || '';
  const priority = searchParams.get('priority') || '';
  const assignee = searchParams.get('assignee') || '';
  const teamId = searchParams.get('team_id') || '';
  const search = searchParams.get('search') || '';

  const [searchInput, setSearchInput] = useState(search);
  const [pages, setPages] = useState<any[][]>([]);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);

  const currentCursor = cursors[cursors.length - 1];

  const params: Record<string, string> = { limit: '25' };
  if (status) params.status = status;
  if (priority) params.priority = priority;
  if (assignee) params.assignee = assignee;
  if (teamId) params.team_id = teamId;
  if (search) params.search = search;
  if (currentCursor) params.cursor = currentCursor;

  const { data, isLoading, error } = useQuery({
    queryKey: ['work-items', params],
    queryFn: () => api.workItems.list(params),
    placeholderData: keepPreviousData,
  });

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    setSearchParams(next);
    setPages([]);
    setCursors([null]);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setFilter('search', searchInput);
  }

  function loadMore() {
    if (data?.next_cursor) {
      if (data.items) {
        setPages(prev => [...prev, data.items]);
      }
      setCursors(prev => [...prev, data.next_cursor]);
    }
  }

  const allItems = [...pages.flat(), ...(data?.items || [])];

  const teams = user?.memberships || [];

  return (
    <div>
      <div className="page-header">
        <h2>Work Items</h2>
        <button className="primary" onClick={() => navigate('/items/new')}>New Item</button>
      </div>

      <div className="filters">
        <select value={teamId} onChange={e => setFilter('team_id', e.target.value)}>
          <option value="">All teams</option>
          {teams.map((t: any) => (
            <option key={t.team_id} value={t.team_id}>{t.team_name}</option>
          ))}
        </select>

        <select value={status} onChange={e => setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="pending_approval">Pending approval</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>

        <select value={priority} onChange={e => setFilter('priority', e.target.value)}>
          <option value="">All priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        <select value={assignee} onChange={e => setFilter('assignee', e.target.value)}>
          <option value="">All assignees</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 4 }}>
          <input
            type="text"
            placeholder="Search..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ minWidth: 160 }}
          />
          <button type="submit" className="secondary">Search</button>
        </form>
      </div>

      <div className="card">
        {isLoading && pages.length === 0 && <div className="loading">Loading...</div>}
        {error && <div className="banner error">Failed to load work items</div>}

        <div className="item-list">
          {allItems.length === 0 && !isLoading && (
            <div className="empty-state">No work items found</div>
          )}
          {allItems.map((item: any) => (
            <div
              key={item.id}
              className="item-row"
              onClick={() => navigate(`/items/${item.id}`)}
            >
              <span className="item-title">{item.title}</span>
              <div className="item-meta">
                {item.team_name && <span style={{ fontSize: 11 }}>{item.team_name}</span>}
                {item.assignee_name && <span style={{ fontSize: 11 }}>{item.assignee_name}</span>}
                <span className={`badge ${item.priority}`}>{item.priority}</span>
                <span className={`badge ${item.status}`}>{item.status.replace('_', ' ')}</span>
              </div>
            </div>
          ))}
        </div>

        {data?.next_cursor && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button className="secondary" onClick={loadMore} disabled={isLoading}>
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
