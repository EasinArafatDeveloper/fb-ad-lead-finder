import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
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
import { getKey } from './lib/api';
import { Skeleton } from './components/ui';

// the spreadsheet editor is heavy — load it only when a sheet is opened
const SheetView = lazy(() => import('./pages/SheetView'));

function App() {
  const [authed, setAuthed] = useState(() => !!getKey());
  useEffect(() => {
    const out = () => setAuthed(false);
    window.addEventListener('fblf:logout', out);
    return () => window.removeEventListener('fblf:logout', out);
  }, []);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return (
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
        <Route path="logs" element={<Logs />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
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
