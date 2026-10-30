import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  ArrowDownToLine, Check, CircleAlert, Clock, ExternalLink, Eye, FileSpreadsheet, Loader2,
  MessageCircle, MessageSquareQuote, Phone, Plus, RefreshCw, Sparkles, Trash2, User, UserCheck
} from 'lucide-react';
import { api } from '../lib/api';
import { cn, formatNumber, timeAgo } from '../lib/utils';
import { Button, EmptyState, PageHeader, ShimmerButton, Skeleton } from '../components/ui';

export default function PostComments() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [filterTag, setFilterTag] = useState('all');

  const loadList = () => {
    api('/comments')
      .then(setItems)
      .catch((e) => toast.error(e.message));
  };

  useEffect(() => {
    loadList();
  }, []);

  const handleScrape = async (e) => {
    e?.preventDefault();
    const cleanUrl = url.trim();
    if (!cleanUrl || !cleanUrl.includes('facebook.com')) {
      toast.error('Please paste a valid Facebook post, reel, or video link');
      return;
    }

    setBusy(true);
    try {
      const res = await api('/comments', {
        method: 'POST',
        body: { url: cleanUrl }
      });
      toast.success(`Extracted ${res.extractedCount} comments!`);
      setUrl('');
      loadList();
      setSelected(res);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const openDetails = (id) => {
    setLoadingDetails(true);
    api(`/comments/${id}`)
      .then(setSelected)
      .catch((e) => toast.error(e.message))
      .finally(() => setLoadingDetails(false));
  };

  const deleteItem = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Delete this comment scrape?')) return;
    try {
      await api(`/comments/${id}`, { method: 'DELETE' });
      toast.success('Deleted');
      if (selected?.id === id) setSelected(null);
      loadList();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const filteredComments = (selected?.comments || []).filter((c) => {
    if (filterTag === 'phone') return Boolean(c.phone) || (c.replies || []).some(r => r.phone);
    if (filterTag === 'intent') return (c.intentTag && c.intentTag.includes('Intent')) || Boolean(c.phone) || (c.replies || []).some(r => r.phone || (r.intentTag && r.intentTag.includes('Intent')));
    if (filterTag === 'replies') return Boolean(c.replyCount > 0) || (c.replies && c.replies.length > 0);
    return true;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={MessageCircle}
        title="Post Comments & Profile Extractor"
        subtitle="Extract comments, replies, reactions and direct Facebook profile links from any Post, Reel or Video"
      />

      {/* Input Box */}
      <form onSubmit={handleScrape} className="card relative overflow-hidden p-6">
        <span aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-indigo-500/10 blur-3xl" />
        <label htmlFor="post-url" className="label text-base font-bold text-slate-800 dark:text-slate-100">
          Facebook Post / Video / Reel Link
        </label>
        <p className="mb-3 text-xs text-slate-500">
          Paste any Facebook post, reel or video URL (e.g. <code>https://www.facebook.com/share/p/...</code> or <code>https://www.facebook.com/reel/...</code>)
        </p>

        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="post-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.facebook.com/..."
            className="input flex-1 font-mono text-sm"
            required
          />
          <ShimmerButton type="submit" disabled={busy || !url.trim()} className="shrink-0">
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Scraping Comments…
              </>
            ) : (
              <>
                <MessageSquareQuote className="h-4 w-4" /> Extract Comments
              </>
            )}
          </ShimmerButton>
        </div>
      </form>

      {/* Main Grid: History List (Left) + Detailed Sheet (Right) */}
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        {/* Left: Previous Scrapes */}
        <section className="card p-4">
          <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2.5 dark:border-white/10">
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">History ({items?.length || 0})</h2>
            <button
              onClick={loadList}
              title="Refresh list"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {!items ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          ) : !items.length ? (
            <p className="py-8 text-center text-xs text-slate-400">No scrapes yet. Paste a link above.</p>
          ) : (
            <div className="max-h-[600px] space-y-2 overflow-y-auto pr-1">
              {items.map((it) => {
                const isCur = selected?.id === it.id;
                return (
                  <div
                    key={it.id}
                    onClick={() => openDetails(it.id)}
                    className={cn(
                      'group relative cursor-pointer rounded-xl border p-3 transition-all',
                      isCur
                        ? 'border-indigo-500 bg-indigo-50/50 ring-2 ring-indigo-500/20 dark:bg-indigo-500/10'
                        : 'border-slate-200 bg-white hover:border-indigo-300 dark:border-white/10 dark:bg-slate-900'
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <p className="line-clamp-2 text-xs font-semibold leading-tight text-slate-800 dark:text-slate-100">
                        {it.title || 'Facebook Post'}
                      </p>
                      <button
                        onClick={(e) => deleteItem(e, it.id)}
                        title="Delete"
                        className="rounded p-1 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="rounded-md bg-indigo-100 px-1.5 py-0.5 font-bold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                        {it.extractedCount} comments
                      </span>
                      {it.phonesCount > 0 && (
                        <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                          📞 {it.phonesCount}
                        </span>
                      )}
                      {it.buyerIntentCount > 0 && (
                        <span className="rounded-md bg-amber-100 px-1.5 py-0.5 font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                          🔥 {it.buyerIntentCount}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-400">{timeAgo(it.createdAt)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Right: Comments Sheet & Actions */}
        <section className="space-y-4">
          {loadingDetails ? (
            <div className="card flex h-96 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
            </div>
          ) : !selected ? (
            <div className="card flex h-96 flex-col items-center justify-center p-6 text-center">
              <MessageSquareQuote className="mb-3 h-12 w-12 text-slate-300" />
              <h3 className="font-display font-bold text-slate-700 dark:text-slate-200">Select a Scraped Post</h3>
              <p className="mt-1 max-w-sm text-xs text-slate-400">
                Click any post from the history on the left, or paste a new Facebook link above to inspect all extracted comments and profiles.
              </p>
            </div>
          ) : (
            <div className="card p-5">
              {/* Header Overview Card */}
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/10">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                      ✓ Done
                    </span>
                    <a
                      href={selected.url || selected.originalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      View on Facebook <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <h3 className="mt-1.5 font-display text-base font-bold text-slate-800 dark:text-slate-100">
                    {selected.title}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Extracted {selected.extractedCount} comments · {selected.totalReactions || 0} reactions · {timeAgo(selected.createdAt)}
                  </p>
                </div>

                {/* Export Buttons */}
                <div className="flex items-center gap-2">
                  <a
                    href={`/api/comments/${selected.id}/export.xlsx`}
                    download
                    className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow transition hover:bg-emerald-700"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Excel (.xlsx)
                  </a>
                  <a
                    href={`/api/comments/${selected.id}/export.csv`}
                    download
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50 dark:border-white/10 dark:bg-slate-800 dark:text-slate-200"
                  >
                    <ArrowDownToLine className="h-3.5 w-3.5" /> CSV
                  </a>
                </div>
              </div>

              {/* Filter Tabs */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {[
                  ['all', `All (${selected.comments?.length || 0})`],
                  ['intent', `🔥 Buyer Leads (${selected.buyerIntentCount || 0})`],
                  ['phone', `📞 With Phone (${selected.phonesCount || 0})`],
                  ['replies', '💬 With Replies']
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setFilterTag(k)}
                    className={cn(
                      'rounded-lg px-2.5 py-1 text-xs font-semibold transition',
                      filterTag === k
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/10 dark:text-slate-300'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Comments Table */}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:border-white/10">
                      <th className="py-2.5 pl-2 pr-3">Commenter</th>
                      <th className="px-3 py-2.5">Comment</th>
                      <th className="px-3 py-2.5">Intent / Contact</th>
                      <th className="px-3 py-2.5 text-right">Reactions</th>
                      <th className="py-2.5 pl-3 pr-2 text-right">Replies</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                    {filteredComments.map((c) => (
                      <tr key={c.id} className="hover:bg-slate-50/60 dark:hover:bg-white/[0.02]">
                        <td className="py-3 pl-2 pr-3 align-top">
                          <div className="flex items-center gap-2">
                            {c.authorPic ? (
                              <img
                                src={c.authorPic}
                                alt=""
                                className="h-7 w-7 rounded-full object-cover ring-1 ring-slate-200 dark:ring-white/10"
                              />
                            ) : (
                              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 font-bold text-slate-500 dark:bg-white/10">
                                <User className="h-4 w-4" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-slate-800 dark:text-slate-100">
                                {c.authorName || 'Facebook User'}
                              </p>
                              {c.authorUrl && (
                                <a
                                  href={c.authorUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-0.5 text-[10px] text-indigo-600 hover:underline dark:text-indigo-400"
                                >
                                  Profile <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-3 align-top">
                          <p className="text-sm font-medium leading-relaxed text-slate-700 dark:text-slate-200">
                            {c.commentText}
                          </p>
                          <p className="mt-1 text-[10px] text-slate-400">{timeAgo(c.createdTime)}</p>

                          {/* Direct Replies display if any */}
                          {c.replies?.length > 0 && (
                            <div className="mt-2 space-y-1.5 rounded-lg bg-slate-50 p-2 ring-1 ring-inset ring-slate-200/50 dark:bg-white/5 dark:ring-white/5">
                              {c.replies.map((rep) => (
                                <div key={rep.id} className="text-xs">
                                  <span className="font-bold text-indigo-600 dark:text-indigo-400">
                                    {rep.authorName}:{' '}
                                  </span>
                                  <span className="text-slate-600 dark:text-slate-300">{rep.text}</span>
                                  {rep.phone && (
                                    <span className="ml-2 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-bold text-emerald-800">
                                      📞 {rep.phone}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>

                        <td className="px-3 py-3 align-top">
                          <div className="space-y-1">
                            {c.phone ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
                                <Phone className="h-3 w-3" /> {c.phone}
                              </span>
                            ) : null}

                            {c.intentTag && c.intentTag !== 'General' && (
                              <div>
                                <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                                  {c.intentTag}
                                </span>
                              </div>
                            )}

                            {!c.phone && c.intentTag === 'General' && (
                              <span className="text-[11px] text-slate-400">Regular comment</span>
                            )}
                          </div>
                        </td>

                        <td className="px-3 py-3 text-right align-top tabular-nums font-semibold text-slate-600 dark:text-slate-300">
                          {c.reactionsCount || 0}
                        </td>

                        <td className="py-3 pl-3 pr-2 text-right align-top tabular-nums font-semibold text-indigo-600 dark:text-indigo-400">
                          {c.replyCount || (c.replies ? c.replies.length : 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
