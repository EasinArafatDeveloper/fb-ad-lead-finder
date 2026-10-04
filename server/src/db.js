import { MongoClient } from 'mongodb';

let client;
let db;
let ready = null;

/**
 * Connect once and reuse it. On Vercel every request may land on a fresh or a reused function
 * instance — the cached promise means a reused instance never reconnects.
 */
export function connect() {
  if (!ready) {
    ready = open().catch((e) => {
      ready = null; // let the next request try again
      throw e;
    });
  }
  return ready;
}

async function open() {
  client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 10 });
  await client.connect();
  db = client.db(process.env.DB_NAME || 'fb_ad_leads');
  await Promise.all([
    db.collection('leads').createIndex({ pageId: 1 }, { unique: true }),
    db.collection('leads').createIndex({ scrapeStatus: 1, createdAt: 1 }),
    db.collection('leads').createIndex({ updatedAt: -1 }),
    db.collection('leads').createIndex({ keywords: 1 }),
    db.collection('leads').createIndex({ scrapedAt: -1 }),
    db.collection('ads').createIndex({ adId: 1 }, { unique: true }),
    db.collection('ads').createIndex({ pageId: 1 }),
    db.collection('jobs').createIndex({ phase: 1, createdAt: 1 }),
    db.collection('logs').createIndex({ ts: -1 }),
    db.collection('activity').createIndex({ ts: -1 }),
    db.collection('activity').createIndex({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }),
  ]);
  return db;
}

export const col = (name) => db.collection(name);

/** Human-readable timeline shown on the dashboard ("what happened, what's happening"). */
export async function activity(type, msg, meta = {}) {
  try {
    await col('activity').insertOne({ ts: new Date(), type, msg: String(msg).slice(0, 300), ...meta });
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
