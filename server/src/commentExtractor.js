// Facebook Post / Video / Reel Comment & Profile Extractor
// Extracts comments, direct replies, reaction counts, and author profile links
import { openFbSession, markFbUsed } from './fbAccount.js';

const INTENT_KEYWORDS = {
  price: ['দাম', 'dam', 'price', 'koto', 'rate', 'কত', 'tk', 'টাকা', 'cost', 'pp', 'inbox'],
  order: ['order', 'অর্ডার', 'নিতে চাই', 'chai', 'want to buy', 'lagbe', 'লাগবে', 'deliver', 'send', 'address', 'ঠিকানা', 'details'],
};

export function detectIntent(text = '') {
  const clean = text.toLowerCase();
  const phoneMatch = text.match(/(?:\+?88)?01[3-9]\d{8}/);
  const phone = phoneMatch ? phoneMatch[0] : null;

  let isPrice = INTENT_KEYWORDS.price.some(k => clean.includes(k));
  let isOrder = INTENT_KEYWORDS.order.some(k => clean.includes(k));

  let tag = 'General';
  if (phone) tag = 'Phone Found';
  else if (isOrder) tag = 'High Intent (Order)';
  else if (isPrice) tag = 'Interested (Price)';

  return { tag, phone };
}

/** Recursively extract all Comment objects and Feedback summaries from Facebook JSON payload */
export function extractCommentsFromData(jsonData, targetMap = new Map()) {
  function walk(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 85) return;
    if (Array.isArray(o)) {
      for (const item of o) walk(item, depth + 1);
      return;
    }

    if (o.__typename === 'Comment' && (o.id || o.legacy_fbid)) {
      const id = String(o.id || o.legacy_fbid);
      const author = o.author;
      const text = o.body?.text || o.preferred_body?.text || '';
      const createdTime = o.created_time ? new Date(o.created_time * 1000).toISOString() : null;

      const authorName = author?.name || '';
      const authorId = author?.id || '';
      const authorUrl = author?.url || author?.profile_url || (authorId ? `https://www.facebook.com/${authorId}` : '');
      const authorPic = author?.profile_picture_depth_0?.uri || author?.profile_picture?.uri || '';
      const authorGender = author?.gender || '';

      const reactions = o.feedback?.reactors?.count ?? o.feedback?.reaction_count?.count ?? o.feedback?.unified_reactors?.count ?? 0;
      const topReactions = (o.feedback?.top_reactions?.edges || []).map(e => ({
        type: e.node?.localized_name || e.node?.reaction_type || '',
        count: e.reaction_count || 0
      }));

      const replyCount = o.feedback?.replies_fields?.total_count ?? o.feedback?.expansion_info?.total_comment_count ?? o.feedback?.comment_count?.total_count ?? 0;

      // Inline replies
      const inlineReplies = [];
      for (const re of o.feedback?.replies_connection?.edges || []) {
        if (re.node) {
          const rText = re.node.body?.text || re.node.preferred_body?.text || '';
          const { tag, phone } = detectIntent(rText);
          inlineReplies.push({
            id: String(re.node.id || ''),
            authorName: re.node.author?.name || '',
            authorUrl: re.node.author?.url || (re.node.author?.id ? `https://www.facebook.com/${re.node.author.id}` : ''),
            text: rText,
            phone,
            intentTag: tag,
            createdTime: re.node.created_time ? new Date(re.node.created_time * 1000).toISOString() : null,
            reactions: re.node.feedback?.reaction_count?.count ?? 0
          });
        }
      }

      const { tag, phone } = detectIntent(text);

      if (!targetMap.has(id)) {
        targetMap.set(id, {
          id,
          authorName,
          authorId,
          authorUrl,
          authorPic,
          authorGender,
          commentText: text,
          phone,
          intentTag: tag,
          createdTime,
          reactionsCount: reactions,
          topReactions,
          replyCount,
          replies: inlineReplies
        });
      }
    }

    for (const k in o) {
      if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
    }
  }

  walk(jsonData);
  return targetMap;
}

/** Scrape all available comments and post info from a Post, Reel, or Video URL */
export async function scrapePostComments(postUrl) {
  const sess = await openFbSession(postUrl);
  await markFbUsed();

  const commentsMap = new Map();
  const scripts = [...sess.html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

  let postInfo = {
    url: sess.url,
    originalUrl: postUrl,
    pageTitle: (sess.html.match(/<title[^>]*>([^<]+)<\/title>/) || [])[1] || '',
    totalReactions: 0,
    totalComments: 0,
  };

  for (const sc of scripts) {
    if (!sc.includes('Comment') && !sc.includes('feedback') && !sc.includes('ZmVlZGJhY2s')) continue;
    try {
      const data = JSON.parse(sc);
      extractCommentsFromData(data, commentsMap);

      // Extract feedback reaction counts
      function findTotals(o, d = 0) {
        if (!o || typeof o !== 'object' || d > 60) return;
        if (o.id && String(o.id).startsWith('ZmVlZGJhY2s')) {
          if (typeof o.reaction_count?.count === 'number') postInfo.totalReactions = Math.max(postInfo.totalReactions, o.reaction_count.count);
          if (typeof o.reactors?.count === 'number') postInfo.totalReactions = Math.max(postInfo.totalReactions, o.reactors.count);
          const cCount = o.total_comment_count ?? o.comment_rendering_instance_for_feed_location?.comments?.total_count ?? o.comments_count_summary_renderer?.feedback?.comment_rendering_instance?.comments?.total_count;
          if (typeof cCount === 'number') postInfo.totalComments = Math.max(postInfo.totalComments, cCount);
        }
        for (const k in o) if (o[k] && typeof o[k] === 'object') findTotals(o[k], d + 1);
      }
      findTotals(data);
    } catch {}
  }

  const commentsList = [...commentsMap.values()];
  postInfo.extractedComments = commentsList.length;

  return {
    post: postInfo,
    comments: commentsList
  };
}
