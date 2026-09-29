import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Login } from './pages/Login';
import { Layout } from './pages/Layout';
import { Dashboard } from './pages/Dashboard';
import { WorkItemList } from './pages/WorkItemList';
import { WorkItemDetail } from './pages/WorkItemDetail';
import { WorkItemCreate } from './pages/WorkItemCreate';

function AppRoutes() {
  const { user, loading, checkAuth } = useAuth();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/items" element={<WorkItemList />} />
        <Route path="/items/new" element={<WorkItemCreate />} />
        <Route path="/items/:id" element={<WorkItemDetail />} />
      </Route>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
