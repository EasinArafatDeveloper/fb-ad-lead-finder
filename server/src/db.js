import { MongoClient } from 'mongodb';

let client;
let db;
let ready = null;

/** Connect once and reuse it. A failed attempt is forgotten so the next request tries again. */
export function connect() {
  if (!ready) {
    ready = open().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

async function open() {
  client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 20 });
  await client.connect();
  db = client.db(process.env.DB_NAME || 'fb_ad_leads');
  await Promise.all([
    // accounts
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('sessions').createIndex({ userId: 1 }),
    // shared — every page and ad is scraped once, for everybody
    db.collection('pages').createIndex({ pageId: 1 }, { unique: true }),
    db.collection('pages').createIndex({ scrapeStatus: 1, createdAt: 1 }),
    db.collection('pages').createIndex({ scrapedAt: -1 }),
    db.collection('ads').createIndex({ adId: 1 }, { unique: true }),
    db.collection('ads').createIndex({ pageId: 1 }),
    db.collection('ads').createIndex({ projectIds: 1 }),
    // per workspace
    db.collection('leads').createIndex({ workspaceId: 1, pageId: 1 }, { unique: true }),
    db.collection('leads').createIndex({ workspaceId: 1, updatedAt: -1 }),
    db.collection('leads').createIndex({ workspaceId: 1, keywords: 1 }),
    db.collection('leads').createIndex({ workspaceId: 1, projectIds: 1 }),
    db.collection('leads').createIndex({ workspaceId: 1, jobIds: 1 }),
    db.collection('leads').createIndex({ pageId: 1 }),
    db.collection('jobs').createIndex({ phase: 1, createdAt: 1 }),
    db.collection('jobs').createIndex({ workspaceId: 1, createdAt: -1 }),
    db.collection('projects').createIndex({ workspaceId: 1, key: 1 }, { unique: true }),
    db.collection('items').createIndex({ projectId: 1, parentId: 1 }),
    db.collection('items').createIndex({ workspaceId: 1 }),
    db.collection('logs').createIndex({ ts: -1 }),
    db.collection('activity').createIndex({ workspaceId: 1, ts: -1 }),
    db.collection('activity').createIndex({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }),
  ]);
  return db;
}

export const col = (name) => db.collection(name);

/** An error with an HTTP status (400 = bad input, 404, 429 …). Its message is shown to the user. */
export const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Human-readable timeline on the dashboard. `workspaceId: null` = a system event everybody sees
 * (e.g. the worker was paused); otherwise only that workspace sees it.
 */
export async function activity(type, msg, { workspaceId = null, ...meta } = {}) {
  try {
    await col('activity').insertOne({ ts: new Date(), type, msg: String(msg).slice(0, 300), workspaceId, ...meta });
  } catch {
    // never break a request because of the timeline
  }
}

/** The same event for every workspace that has this page as a lead. */
export async function pageActivity(pageId, type, msg) {
  try {
    const wss = await col('leads').distinct('workspaceId', { pageId });
    if (!wss.length) return;
    const ts = new Date();
    await col('activity').insertMany(wss.map((workspaceId) => ({ ts, type, msg: String(msg).slice(0, 300), workspaceId })));
  } catch {
    // never break a request because of the timeline
  }
}

export async function log(level, msg) {
  console[level === 'error' ? 'error' : 'log'](`[${level}] ${msg}`);
  try {
    await col('logs').insertOne({ ts: new Date(), level, msg: String(msg).slice(0, 2000) });
  } catch {
    // logging must never break a request
  }
}
