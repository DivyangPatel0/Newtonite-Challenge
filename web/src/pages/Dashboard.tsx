import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export function Dashboard() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.dashboard.get(),
    refetchInterval: 15000,
  });

  if (isLoading) return <div className="loading">Loading dashboard...</div>;
  if (error) return <div className="banner error">Failed to load dashboard</div>;

  const sections = [
    { key: 'assigned_to_me', title: 'Assigned to me' },
    { key: 'awaiting_my_approval', title: 'Awaiting my approval' },
    { key: 'unassigned_high_priority', title: 'Unassigned high priority' },
    { key: 'stale_items', title: 'Stale (no update in 7 days)' },
  ];

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
      </div>
      <div className="dashboard-grid">
        {sections.map(s => {
          const section = data[s.key];
          return (
            <div key={s.key} className="card">
              <div className="card-header">
                <div className="dashboard-card-title">
                  <span>{s.title}</span>
                  <span className="dashboard-count">{section.count}</span>
                </div>
              </div>
              <div className="item-list">
                {section.items.length === 0 && (
                  <div className="empty-state">None right now</div>
                )}
                {section.items.map((item: any) => (
                  <div
                    key={item.id}
                    className="item-row"
                    onClick={() => navigate(`/items/${item.id}`)}
                  >
                    <span className="item-title">{item.title}</span>
                    <div className="item-meta">
                      <span className={`badge ${item.priority}`}>{item.priority}</span>
                      <span className={`badge ${item.status}`}>{item.status.replace('_', ' ')}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
