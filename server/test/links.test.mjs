// Paste links: every way people copy a Facebook Page link → the Page (fbLinks.js). No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFbLink, parseLinks, splitLinks } from '../src/fbLinks.js';

const id = (s) => parseFbLink(s).pageId;
const err = (s) => parseFbLink(s).error;

test('Page links by username — every host and form', () => {
  for (const s of [
    'https://www.facebook.com/ShopName',
    'https://www.facebook.com/ShopName/',
    'http://facebook.com/ShopName?ref=page_internal',
    'https://m.facebook.com/ShopName/',
    'https://web.facebook.com/ShopName/about',
    'https://mbasic.facebook.com/ShopName',
    'fb.com/ShopName',
    'www.facebook.com/ShopName/posts/pfbid02abc',
    'facebook.com/ShopName/photos/a.123/456/',
    'https://www.facebook.com/ShopName#reviews',
    '<https://www.facebook.com/ShopName>',
    'ShopName',
    '@ShopName',
  ]) assert.equal(id(s), '@shopname', s);
  assert.equal(parseFbLink('https://www.facebook.com/Shop.Name.BD').pageUrl, 'https://www.facebook.com/shop.name.bd/');
});

test('Page links by number — profile.php, /p/, /people/, /pages/, Name-123, bare number', () => {
  const ID = '100064123456789';
  for (const s of [
    `https://www.facebook.com/profile.php?id=${ID}`,
    `https://m.facebook.com/profile.php?id=${ID}&mibextid=abc`,
    `https://www.facebook.com/p/Shop-Name-${ID}/`,
    `https://www.facebook.com/people/Shop-Name/${ID}/`,
    `https://www.facebook.com/pages/Shop-Name/${ID}`,
    `https://www.facebook.com/pages/category/Shopping-Retail/Shop-Name-${ID}/`,
    `https://www.facebook.com/Shop-Name-${ID}/`,
    `https://www.facebook.com/${ID}`,
    `https://www.facebook.com/permalink.php?story_fbid=pfbid0abc&id=${ID}`,
    ID,
  ]) assert.equal(id(s), ID, s);
});

test('Links that are not a Page are refused with the reason', () => {
  assert.match(err('https://www.facebook.com/groups/12345678'), /group/);
  assert.match(err('https://www.facebook.com/share/1AbCdEf/'), /share link/);
  assert.match(err('https://fb.me/abc'), /short/);
  assert.match(err('https://www.facebook.com/events/123456789'), /event/);
  assert.match(err('https://www.facebook.com/marketplace/item/1'), /Marketplace/);
  assert.match(err('https://www.facebook.com/ads/library/?q=shoes'), /Ad Library/);
  assert.match(err('https://www.instagram.com/shop'), /Instagram/);
  assert.match(err('https://google.com/shop'), /not a Facebook link/);
  assert.match(err('https://www.facebook.com/'), /not a Page/);
  assert.match(err('Shop Name Dhaka'), /name, not a Facebook link/);
  assert.match(err('https://www.facebook.com/profile.php'), /without an id/);
});

test('A pasted text: links found inside lines, duplicates dropped, bad lines listed', () => {
  const text = [
    'Shop One - https://www.facebook.com/ShopOne',
    'https://facebook.com/shopone/',
    'https://www.facebook.com/profile.php?id=100064123456789 https://m.facebook.com/ShopTwo',
    '',
    'https://www.facebook.com/groups/9999999',
    'shopthree, shopfour',
  ].join('\n');
  assert.deepEqual(splitLinks('a - https://fb.com/x and https://facebook.com/y'), ['https://fb.com/x', 'https://facebook.com/y']);
  const r = parseLinks(text);
  assert.deepEqual(r.pages.map((p) => p.pageId), ['@shopone', '100064123456789', '@shoptwo', '@shopthree', '@shopfour']);
  assert.equal(r.duplicates, 1, 'ShopOne twice');
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0].reason, /group/);
  const capped = parseLinks(text, 2);
  assert.equal(capped.pages.length, 2);
  assert.equal(capped.tooMany, 3, 'the ones over the limit are counted');
});
