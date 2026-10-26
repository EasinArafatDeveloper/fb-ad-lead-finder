// Facts about an advertiser, taken from its ads (all real Facebook data, nothing estimated):
//   firstAdDate — the earliest start date of its ads we have seen ("advertising for N days")
//   orderVia    — how it takes orders: WhatsApp, Messenger, Call, Website, Marketplace, App
//   adFormats   — Video, Image, Carousel, Multi-image, Catalog …
//   siteType    — Own website, Marketplace, App, WhatsApp only, Facebook only
// plus sitePlatform (Shopify, WooCommerce …), read from the advertiser's own website's home page.
import { col } from './db.js';

const host = (u) => {
  try {
    return new URL(String(u || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const endsWith = (h, list) => list.some((d) => h === d || h.endsWith(`.${d}`));

const WHATSAPP = ['wa.me', 'whatsapp.com', 'api.whatsapp.com', 'chat.whatsapp.com'];
const FACEBOOK = ['facebook.com', 'fb.com', 'fb.me', 'm.me', 'messenger.com', 'instagram.com', 'fb.watch', 'l.facebook.com'];
const APP_STORES = ['play.google.com', 'apps.apple.com', 'itunes.apple.com', 'appgallery.huawei.com'];
// shops selling many sellers' goods — the advertiser has no shop of its own there
const MARKETPLACES = [
  'daraz.com.bd', 'daraz.com', 'othoba.com', 'shohoz.com', 'chaldal.com', 'pickaboo.com', 'rokomari.com', 'evaly.com.bd',
  'ajkerdeal.com', 'bikroy.com', 'shajgoj.com', 'foodpanda.com.bd', 'pathao.com', 'priyoshop.com', 'sindabad.com',
  'amazon.com', 'amazon.in', 'aliexpress.com', 'alibaba.com', 'ebay.com', 'etsy.com', 'flipkart.com', 'shopee.com', 'lazada.com',
];

// not a website of the advertiser's own: short links, link-in-bio pages, forms, social networks, music/video
const NOT_A_SITE = [
  'linktr.ee', 'bit.ly', 'tinyurl.com', 'cutt.ly', 'rebrand.ly', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'shorturl.at', 'rb.gy', 'beacons.ai',
  'linkin.bio', 'taplink.cc', 'bio.link', 'msha.ke', 'share.google', 'google.com', 'forms.gle', 'docs.google.com', 'drive.google.com',
  'maps.google.com', 'maps.app.goo.gl', 'g.page', 'youtube.com', 'youtu.be', 'tiktok.com', 'twitter.com', 'x.com', 'threads.com',
  'threads.net', 'linkedin.com', 'pinterest.com', 't.me', 'telegram.me', 'spotify.com', 'open.spotify.com', 'snapchat.com', 'imo.im',
  'viber.com', 'calendly.com', 'typeform.com', 'jotform.com', 'wa.link',
];

/** What kind of place a link goes to. */
export function linkKind(u) {
  const h = host(u);
  if (!h) return '';
  if (endsWith(h, WHATSAPP) || h === 'wa.link') return 'whatsapp';
  if (endsWith(h, FACEBOOK)) return 'facebook';
  if (endsWith(h, APP_STORES)) return 'app';
  if (h !== 'sites.google.com' && endsWith(h, NOT_A_SITE)) return 'link';
  if (endsWith(h, MARKETPLACES)) return 'marketplace';
  return 'site';
}

/** How one ad takes orders — from its button type (or the button text for ads saved before types were kept) and its link. */
export function orderChannel(ad) {
  const t = String(ad.ctaType || '').toUpperCase();
  const text = String(ad.cta || '').toLowerCase();
  const kind = linkKind(ad.linkUrl);
  if (t.includes('WHATSAPP') || kind === 'whatsapp' || /whatsapp/.test(text)) return 'WhatsApp';
  if (/MESSAGE|MESSENGER|INSTAGRAM_DIRECT/.test(t) || /message|মেসেজ|বার্তা/.test(text)) return 'Messenger';
  if (/CALL/.test(t) || /^call|কল/.test(text)) return 'Call';
  if (/INSTALL|USE_APP|PLAY_GAME|DOWNLOAD/.test(t) || kind === 'app') return 'App';
  if (kind === 'marketplace') return 'Marketplace';
  if (kind === 'site') return 'Website';
  return '';
}

const FORMATS = { VIDEO: 'Video', IMAGE: 'Image', CAROUSEL: 'Carousel', MULTI_IMAGES: 'Multi-image', DPA: 'Catalog', DCO: 'Catalog', TEXT: 'Text', EVENT: 'Event' };
export const formatName = (f) => {
  const k = String(f || '').toUpperCase();
  if (!k) return '';
  return FORMATS[k] || k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ');
};

/** The advertiser's kind of website, from its ad links and the websites found on its page. */
export function siteTypeOf(links = [], websites = []) {
  const kinds = new Set([...links, ...websites.map((w) => (/^https?:\/\//.test(w) ? w : `https://${w}`))].map(linkKind).filter(Boolean));
  if (kinds.has('site')) return 'Own website';
  if (kinds.has('marketplace')) return 'Marketplace';
  if (kinds.has('app')) return 'App';
  if (kinds.has('whatsapp')) return 'WhatsApp only';
  return 'Facebook only'; // (short links / link-in-bio / other social networks count as no website of its own)
}

/** The platform a website runs on, from its home page's HTML. */
export function detectPlatform(html) {
  const h = String(html || '');
  if (!h) return '';
  if (/cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(h)) return 'Shopify';
  if (/woocommerce|wc-ajax|wc_add_to_cart/i.test(h)) return 'WooCommerce';
  if (/static\.wixstatic\.com|wix\.com\/|_wixCIDX/i.test(h)) return 'Wix';
  if (/squarespace\.com|static1\.squarespace/i.test(h)) return 'Squarespace';
  if (/webflow\.(com|io)|data-wf-page/i.test(h)) return 'Webflow';
  if (/Magento|mage\/cookies|static\/version\d+\/frontend/i.test(h)) return 'Magento';
  if (/bigcommerce\.com/i.test(h)) return 'BigCommerce';
  if (/prestashop/i.test(h)) return 'PrestaShop';
  if (/route=common\/home|catalog\/view\/theme/i.test(h)) return 'OpenCart';
  if (/\/wp-content\/|\/wp-includes\/|wp-json/i.test(h)) return 'WordPress';
  if (/blogger\.com|blogspot\.com/i.test(h)) return 'Blogger';
  if (/weebly\.com/i.test(h)) return 'Weebly';
  return 'Custom';
}

/**
 * Work the ad facts out again for these pages from all their ads, store them on the page and copy them into
 * every workspace's lead (they come from the ads, not from reading the page — nothing to pay for).
 */
export async function refreshPageAdFacts(pageIds) {
  const ids = [...new Set((pageIds || []).map(String))];
  if (!ids.length) return 0;
  const rows = await col('ads')
    .aggregate([
      { $match: { pageId: { $in: ids } } },
      {
        $group: {
          _id: '$pageId',
          first: { $min: { $cond: [{ $gt: ['$startDate', ''] }, '$startDate', null] } },
          links: { $addToSet: '$linkUrl' },
          ctas: { $addToSet: { t: '$ctaType', c: '$cta', l: '$linkUrl' } },
          formats: { $addToSet: '$format' },
        },
      },
    ])
    .toArray();
  const pages = new Map((await col('pages').find({ pageId: { $in: ids } }).project({ pageId: 1, websites: 1, adLinks: 1 }).toArray()).map((p) => [p.pageId, p]));
  let n = 0;
  for (const r of rows) {
    const p = pages.get(r._id) || {};
    const orderVia = [...new Set(r.ctas.map((x) => orderChannel({ ctaType: x.t, cta: x.c, linkUrl: x.l })).filter(Boolean))].sort();
    const facts = {
      firstAdDate: r.first || '',
      orderVia,
      adFormats: [...new Set(r.formats.map(formatName).filter(Boolean))].sort(),
      siteType: siteTypeOf([...(r.links || []), ...(p.adLinks || [])].filter(Boolean), p.websites || []),
    };
    await col('pages').updateOne({ pageId: r._id }, { $set: facts });
    await col('leads').updateMany({ pageId: r._id }, { $set: facts });
    n++;
  }
  return n;
}

/** After the page was read: its own website may now be known → the site type may change. */
export async function refreshSiteType(pageId) {
  const p = await col('pages').findOne({ pageId: String(pageId) }, { projection: { websites: 1, adLinks: 1 } });
  if (!p) return;
  const siteType = siteTypeOf(p.adLinks || [], p.websites || []);
  await col('pages').updateOne({ pageId: p.pageId }, { $set: { siteType } });
  await col('leads').updateMany({ pageId: p.pageId }, { $set: { siteType } });
}
