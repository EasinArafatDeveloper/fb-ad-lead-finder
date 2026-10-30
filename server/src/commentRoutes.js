import express from 'express';
import { col, httpError, oid } from './db.js';
import { scrapePostComments } from './commentExtractor.js';
import ExcelJS from 'exceljs';
import { once } from 'node:events';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

// List all comment scrape runs for current workspace
r.get('/', ah(async (req) => {
  const items = await col('comment_scrapes')
    .find({ workspaceId: req.ws })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  return items.map(item => ({
    id: String(item._id),
    url: item.url,
    title: item.title,
    totalComments: item.totalComments,
    extractedCount: item.extractedCount,
    phonesCount: item.phonesCount,
    buyerIntentCount: item.buyerIntentCount,
    status: item.status,
    createdAt: item.createdAt
  }));
}));

// Get a single scrape run with all extracted comments
r.get('/:id', ah(async (req) => {
  const item = await col('comment_scrapes').findOne({ _id: oid(req.params.id), workspaceId: req.ws });
  if (!item) throw httpError(404, 'Scrape record not found');
  return {
    ...item,
    id: String(item._id),
    _id: undefined
  };
}));

// Run a new comment scrape
r.post('/', ah(async (req) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !url.includes('facebook.com')) {
    throw httpError(400, 'Please provide a valid Facebook post, video, or reel link.');
  }

  // Scrape comments using our connected FB session
  const data = await scrapePostComments(url);

  let phonesCount = 0;
  let buyerIntentCount = 0;

  for (const c of data.comments) {
    if (c.phone) phonesCount++;
    if (c.intentTag && c.intentTag.includes('Intent') || c.intentTag === 'Phone Found') buyerIntentCount++;
    for (const rep of c.replies || []) {
      if (rep.phone) phonesCount++;
      if (rep.intentTag && rep.intentTag.includes('Intent') || rep.intentTag === 'Phone Found') buyerIntentCount++;
    }
  }

  const doc = {
    workspaceId: req.ws,
    userId: req.user._id,
    url: data.post.url,
    originalUrl: url,
    title: data.post.pageTitle || 'Facebook Post',
    totalReactions: data.post.totalReactions || 0,
    totalComments: data.post.totalComments || data.comments.length,
    extractedCount: data.comments.length,
    phonesCount,
    buyerIntentCount,
    comments: data.comments,
    status: 'done',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const res = await col('comment_scrapes').insertOne(doc);

  return {
    id: String(res.insertedId),
    ...doc,
    _id: undefined
  };
}));

// Delete a scrape run
r.delete('/:id', ah(async (req) => {
  await col('comment_scrapes').deleteOne({ _id: oid(req.params.id), workspaceId: req.ws });
  return { ok: true };
}));

// Export comments to Excel
r.get('/:id/export.xlsx', ah(async (req, res) => {
  const item = await col('comment_scrapes').findOne({ _id: oid(req.params.id), workspaceId: req.ws });
  if (!item) throw httpError(404, 'Not found');

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="comments-${String(item._id).slice(-6)}.xlsx"`);

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet('Comments', { views: [{ state: 'frozen', ySplit: 1 }] });

  const headers = ['Type', 'Name', 'FB Profile Link', 'Comment / Reply', 'Phone / WhatsApp', 'Intent Tag', 'Reactions', 'Replies Count', 'Date'];
  ws.columns = [
    { width: 10 }, { width: 25 }, { width: 45 }, { width: 50 }, { width: 20 }, { width: 22 }, { width: 12 }, { width: 14 }, { width: 20 }
  ];

  const head = ws.addRow(headers);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  head.commit();

  for (const c of item.comments || []) {
    const row = ws.addRow([
      'Comment',
      c.authorName,
      c.authorUrl,
      c.commentText,
      c.phone || '',
      c.intentTag || 'General',
      c.reactionsCount || 0,
      c.replyCount || (c.replies ? c.replies.length : 0),
      c.createdTime ? new Date(c.createdTime).toLocaleString() : ''
    ]);
    row.commit();

    // Include replies as sub-rows
    for (const r of c.replies || []) {
      const repRow = ws.addRow([
        '↳ Reply',
        r.authorName,
        r.authorUrl,
        r.text,
        r.phone || '',
        r.intentTag || 'General',
        r.reactions || 0,
        0,
        r.createdTime ? new Date(r.createdTime).toLocaleString() : ''
      ]);
      repRow.commit();
    }
  }

  await wb.commit();
}));

// Export comments to CSV
r.get('/:id/export.csv', ah(async (req, res) => {
  const item = await col('comment_scrapes').findOne({ _id: oid(req.params.id), workspaceId: req.ws });
  if (!item) throw httpError(404, 'Not found');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="comments-${String(item._id).slice(-6)}.csv"`);

  const csvCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  const headers = ['Type', 'Name', 'FB Profile Link', 'Comment / Reply', 'Phone / WhatsApp', 'Intent Tag', 'Reactions', 'Replies Count', 'Date'];
  res.write('\uFEFF' + headers.map(csvCell).join(',') + '\r\n');

  for (const c of item.comments || []) {
    const line = [
      'Comment',
      c.authorName,
      c.authorUrl,
      c.commentText,
      c.phone || '',
      c.intentTag || 'General',
      c.reactionsCount || 0,
      c.replyCount || (c.replies ? c.replies.length : 0),
      c.createdTime ? new Date(c.createdTime).toLocaleString() : ''
    ].map(csvCell).join(',') + '\r\n';
    if (!res.write(line)) await once(res, 'drain');

    for (const r of c.replies || []) {
      const repLine = [
        '↳ Reply',
        r.authorName,
        r.authorUrl,
        r.text,
        r.phone || '',
        r.intentTag || 'General',
        r.reactions || 0,
        0,
        r.createdTime ? new Date(r.createdTime).toLocaleString() : ''
      ].map(csvCell).join(',') + '\r\n';
      if (!res.write(repLine)) await once(res, 'drain');
    }
  }

  res.end();
}));

export default r;
