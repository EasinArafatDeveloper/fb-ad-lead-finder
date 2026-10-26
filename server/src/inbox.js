// The in-app notification box (the bell in the dashboard header). Everything a customer should know lands here:
// a search ready, credits running low / out, an order or a payment, a plan started or ending, and notices the
// team sends (to everybody or to one account).
//
//   inbox: { to: 'all' | 'ws', workspaceId?, kind, level, title, body, link, at, by? }
//   a user's "read up to" time is users.inboxReadAt — everything newer is unread.
import { col, log } from './db.js';

export const LEVELS = ['info', 'success', 'warn', 'error'];

/** One notification for a workspace (every user of it sees it). Never throws — a lost notice must not break work. */
export async function notifyWorkspace(workspaceId, { kind = 'info', level = 'info', title, body = '', link = null }) {
  try {
    if (!workspaceId || !title) return;
    await col('inbox').insertOne({ to: 'ws', workspaceId, kind, level: LEVELS.includes(level) ? level : 'info', title: String(title).slice(0, 160), body: String(body).slice(0, 1000), link, at: new Date() });
  } catch (e) {
    log('warn', `Inbox: ${e.message}`);
  }
}

/** A notice from the team: to everybody, or to one account. */
export async function announce({ title, body = '', link = null, level = 'info', workspaceId = null, by }) {
  const doc = {
    to: workspaceId ? 'ws' : 'all', ...(workspaceId ? { workspaceId } : {}), kind: 'notice', level: LEVELS.includes(level) ? level : 'info',
    title: String(title || '').trim().slice(0, 160), body: String(body || '').trim().slice(0, 2000), link: link ? String(link).slice(0, 300) : null, at: new Date(), by,
  };
  if (!doc.title) throw Object.assign(new Error('Write a title'), { status: 400 });
  const { insertedId } = await col('inbox').insertOne(doc);
  return { ...doc, _id: insertedId };
}

const mine = (user) => ({ $or: [{ to: 'all', at: { $gte: user.createdAt || new Date(0) } }, { to: 'ws', workspaceId: user.workspaceId }] });

export async function unreadCount(user) {
  return col('inbox').countDocuments({ $and: [mine(user), { at: { $gt: user.inboxReadAt || new Date(0) } }] });
}

export async function listInbox(user, limit = 50) {
  const items = await col('inbox').find(mine(user)).sort({ at: -1 }).limit(limit).toArray();
  const readAt = user.inboxReadAt ? new Date(user.inboxReadAt) : new Date(0);
  return items.map((x) => ({ id: String(x._id), kind: x.kind, level: x.level, title: x.title, body: x.body, link: x.link, at: x.at, unread: new Date(x.at) > readAt, fromTeam: x.kind === 'notice' }));
}

export async function markRead(user) {
  await col('users').updateOne({ _id: user._id }, { $set: { inboxReadAt: new Date() } });
}
