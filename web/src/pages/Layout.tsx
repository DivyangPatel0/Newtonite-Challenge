import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { api } from '../api';

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showNotifications, setShowNotifications] = useState(false);
  const queryClient = useQueryClient();

  const { data: notifData } = useQuery({
    queryKey: ['notifications', { limit: '10' }],
    queryFn: () => api.notifications.list({ limit: '10' }),
    refetchInterval: 15000,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const unreadCount = notifData?.unread_count || 0;

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>WorkTracker</h1>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/items">Work Items</NavLink>
        <NavLink to="/items/new">New Item</NavLink>
        <div style={{ position: 'relative', marginTop: 8 }}>
          <button
            className="sidebar-link"
            onClick={() => setShowNotifications(!showNotifications)}
            style={{ display: 'flex', alignItems: 'center' }}
          >
            Notifications
            {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
          </button>
          {showNotifications && (
            <NotificationDropdown
              items={notifData?.items || []}
              onClose={() => setShowNotifications(false)}
              onMarkAllRead={() => markAllRead.mutate()}
              onNavigate={(id: string) => {
                setShowNotifications(false);
                navigate(`/items/${id}`);
              }}
            />
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-user">{user?.name} ({user?.email})</div>
          <button className="sidebar-link" onClick={handleLogout}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function NotificationDropdown({
  items,
  onClose,
  onMarkAllRead,
  onNavigate,
}: {
  items: any[];
  onClose: () => void;
  onMarkAllRead: () => void;
  onNavigate: (id: string) => void;
}) {
  const queryClient = useQueryClient();

  const markRead = useMutation({
    mutationFn: (ids: string[]) => api.notifications.markRead(ids),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  function formatKind(kind: string): string {
    return kind.replace(/_/g, ' ');
  }

  return (
    <div className="notification-dropdown" style={{ left: 0, top: 'auto', marginTop: 4 }}>
      <div className="notification-header">
        <span>Notifications</span>
        <button className="secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onMarkAllRead}>
          Mark all read
        </button>
      </div>
      {items.length === 0 && <div className="empty-state">No notifications</div>}
      {items.map((n: any) => (
        <div
          key={n.id}
          className={`notification-item ${n.read_at ? '' : 'unread'}`}
          onClick={() => {
            if (!n.read_at) markRead.mutate([n.id]);
            if (n.work_item_id) onNavigate(n.work_item_id);
          }}
        >
          {!n.read_at && <span className="notification-dot" />}
          <div>
            <div>{formatKind(n.kind)}</div>
            {n.work_item_title && (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {n.work_item_title}
              </div>
            )}
            <div className="timeline-time">{new Date(n.created_at).toLocaleString()}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
