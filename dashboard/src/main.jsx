import { Component, StrictMode, Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import './index.css';

// Guard against Chrome Google Translate & third-party extensions mutating text nodes inside React-managed DOM
if (typeof Node === 'function' && Node.prototype) {
  const origRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child && child.parentNode !== this) return child;
    return origRemoveChild.apply(this, arguments);
  };
  const origInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) return newNode;
    return origInsertBefore.apply(this, arguments);
  };
}
import Layout from './components/Layout';
import Auth from './pages/Auth';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import Explorer from './pages/Explorer';
import Insights from './pages/Insights';
import Searches from './pages/Searches';
import PasteLinks from './pages/PasteLinks';
import Leads from './pages/Leads';
import Settings from './pages/Settings';
import Billing from './pages/Billing';
import ConnectExtension from './pages/ConnectExtension';
import VerifyEmail from './pages/VerifyEmail';
import Logs from './pages/Logs';
import Users from './pages/Users';
import AdminOverview from './pages/admin/AdminOverview';
import AdminAccount from './pages/admin/AdminAccount';
import AdminLive from './pages/admin/AdminLive';
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
          <Route path="links" element={<PasteLinks />} />
          <Route path="leads" element={<Leads />} />
          <Route path="leads/insights" element={<Insights scope="leads" />} />
          <Route path="settings" element={<Settings />} />
          <Route path="billing" element={<Billing />} />
          <Route path="connect-extension" element={<ConnectExtension />} />

          {/* the admin panel — the team only */}
          {admin && <Route path="admin" element={<AdminOverview />} />}
          {admin && <Route path="admin/live" element={<AdminLive />} />}
          {admin && <Route path="admin/accounts/:ws" element={<AdminAccount />} />}
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

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { retries: 0, error: null };
  }
  componentDidCatch(error) {
    if (this.state.retries < 2) {
      this.setState((s) => ({ retries: s.retries + 1, error: null }));
      return;
    }
    try {
      const key = 'fblf_err_reload';
      const now = Date.now();
      const last = Number(sessionStorage.getItem(key) || 0);
      if (now - last > 15000) {
        sessionStorage.setItem(key, String(now));
        window.location.reload();
        return;
      }
    } catch {
      /* ignore storage errors */
    }
    this.setState({ error });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
          <h1 className="font-display text-lg font-bold text-slate-900 dark:text-white">Something interrupted this page</h1>
          <p className="max-w-md text-sm text-slate-500">{this.state.error?.message || 'A browser extension or translator modified the page.'}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => this.setState({ retries: 0, error: null })}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Try again
            </button>
            <a href="/projects" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              Back to Projects
            </a>
          </div>
        </div>
      );
    }
    return <div key={this.state.retries}>{this.props.children}</div>;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
        <Toaster position="bottom-right" richColors closeButton />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
