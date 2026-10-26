import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import './index.css';
import Layout from './components/Layout';
import Auth from './pages/Auth';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import Explorer from './pages/Explorer';
import Insights from './pages/Insights';
import Searches from './pages/Searches';
import Leads from './pages/Leads';
import Settings from './pages/Settings';
import Billing from './pages/Billing';
import ConnectExtension from './pages/ConnectExtension';
import VerifyEmail from './pages/VerifyEmail';
import Logs from './pages/Logs';
import Users from './pages/Users';
import AdminOverview from './pages/admin/AdminOverview';
import AdminOrders from './pages/admin/AdminOrders';
import AdminPlans from './pages/admin/AdminPlans';
import AdminNotices from './pages/admin/AdminNotices';
import { api } from './lib/api';
import { AuthCtx } from './lib/auth';
import { Skeleton } from './components/ui';

// the spreadsheet editor is heavy — load it only when a sheet is opened
const SheetView = lazy(() => import('./pages/SheetView'));

/** Pages behind the login: a visitor goes to /login and comes back afterwards. */
function NeedLogin() {
  const loc = useLocation();
  return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
}

function App() {
  const [me, setMe] = useState(undefined); // undefined = checking, null = logged out

  useEffect(() => {
    api('/auth/me').then(setMe, () => setMe(null));
    const out = () => setMe(null);
    window.addEventListener('fblf:logout', out);
    return () => window.removeEventListener('fblf:logout', out);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
  }, []);
  const refreshMe = useCallback(() => api('/auth/me').then(setMe, () => {}), []);

  if (me === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8">
        <Skeleton className="h-40 w-full max-w-md" />
      </div>
    );
  }
  const admin = me?.user.role === 'admin';
  // no way into the app before the email is confirmed with the code
  const app = !me ? <NeedLogin /> : me.user.emailVerified === false ? <Navigate to="/verify-email" replace /> : <Layout />;
  return (
    <AuthCtx.Provider value={{ me, setMe, logout, refreshMe }}>
      <Routes>
        {/* public: the home page with prices, and the account pages */}
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<Landing scrollTo="pricing" />} />
        <Route path="/login" element={<Auth mode="login" onLogin={setMe} />} />
        <Route path="/signup" element={<Auth mode="signup" onLogin={setMe} />} />
        <Route path="/forgot" element={<Auth mode="forgot" onLogin={setMe} />} />
        <Route path="/reset-password" element={<Auth mode="reset" onLogin={setMe} />} />
        <Route path="/verify-email" element={<VerifyEmail />} />

        {/* the app */}
        <Route element={app}>
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="projects" element={<Explorer />} />
          <Route path="projects/:pid" element={<Explorer />} />
          <Route path="projects/:pid/insights" element={<Insights />} />
          <Route path="projects/:pid/f/:fid" element={<Explorer />} />
          <Route
            path="projects/:pid/s/:sid"
            element={
              <Suspense fallback={<div className="p-8"><Skeleton className="h-[70vh]" /></div>}>
                <SheetView />
              </Suspense>
            }
          />
          <Route path="search" element={<Searches />} />
          <Route path="leads" element={<Leads />} />
          <Route path="settings" element={<Settings />} />
          <Route path="billing" element={<Billing />} />
          <Route path="connect-extension" element={<ConnectExtension />} />

          {/* the admin panel — the team only */}
          {admin && <Route path="admin" element={<AdminOverview />} />}
          {admin && <Route path="admin/users" element={<Users />} />}
          {admin && <Route path="admin/orders" element={<AdminOrders />} />}
          {admin && <Route path="admin/plans" element={<AdminPlans />} />}
          {admin && <Route path="admin/logs" element={<Logs />} />}
          {admin && <Route path="admin/notices" element={<AdminNotices />} />}
          {/* old addresses */}
          <Route path="users" element={<Navigate to="/admin/users" replace />} />
          <Route path="logs" element={<Navigate to="/admin/logs" replace />} />
        </Route>
        <Route path="*" element={<Navigate to={me ? '/dashboard' : '/'} replace />} />
      </Routes>
    </AuthCtx.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <Toaster position="bottom-right" richColors closeButton />
    </BrowserRouter>
  </StrictMode>,
);
