import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CircleX, Info, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/utils';
import { Button, EmptyState, PageHeader, Skeleton } from '../components/ui';

const LEVEL = {
  error: { icon: CircleX, cls: 'text-rose-600 bg-rose-50 dark:bg-rose-500/10' },
  warn: { icon: AlertTriangle, cls: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10' },
  info: { icon: Info, cls: 'text-indigo-600 bg-indigo-50 dark:bg-indigo-500/10' },
};

export default function Logs() {
  const [logs, setLogs] = useState(null);
  const load = () => api('/logs').then(setLogs).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <div>
      <PageHeader
        icon={ScrollText}
        title="Logs"
        subtitle="History of errors, pauses and syncs"
        actions={
          <>
            <Button onClick={load}><RefreshCw className="h-4 w-4" /> Refresh</Button>
            <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={async () => { await api('/logs', { method: 'DELETE' }); load(); }}>
              <Trash2 className="h-4 w-4" /> Clear
            </Button>
          </>
        }
      />
      {!logs ? (
        <Skeleton className="h-64" />
      ) : !logs.length ? (
        <EmptyState icon={ScrollText} title="No logs" text="Everything is running fine." />
      ) : (
        <ul className="card divide-y divide-slate-100 dark:divide-white/5">
          {logs.map((l) => {
            const lv = LEVEL[l.level] || LEVEL.info;
            return (
              <li key={l._id} className="flex items-start gap-3 px-4 py-3">
                <span className={`mt-0.5 rounded-lg p-1.5 ${lv.cls}`}><lv.icon className="h-4 w-4" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm">{l.msg}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{fmtDate(l.ts)} · {l.level}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
