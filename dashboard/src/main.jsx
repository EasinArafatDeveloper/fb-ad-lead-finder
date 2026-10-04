import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import './index.css';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Explorer from './pages/Explorer';
import Searches from './pages/Searches';
import Leads from './pages/Leads';
import Settings from './pages/Settings';
import Logs from './pages/Logs';
import Users from './pages/Users';
import { api } from './lib/api';
import { AuthCtx } from './lib/auth';
import { Skeleton } from './components/ui';

// the spreadsheet editor is heavy — load it only when a sheet is opened
const SheetView = lazy(() => import('./pages/SheetView'));

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

  if (me === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8">
        <Skeleton className="h-40 w-full max-w-md" />
      </div>
    );
  }
  if (!me) return <Login onLogin={setMe} />;
  const admin = me.user.role === 'admin';
  return (
    <AuthCtx.Provider value={{ me, setMe, logout }}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="projects" element={<Explorer />} />
          <Route path="projects/:pid" element={<Explorer />} />
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
          {admin && <Route path="users" element={<Users />} />}
          {admin && <Route path="logs" element={<Logs />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
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
