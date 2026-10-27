// The Ad insights report as an Excel file — the same for a project and for All Leads (insights.js).
// Written row by row straight into the download: all leads can mean 100,000+ hooks and advertisers, and the
// whole workbook must not have to fit in the server's memory.
import ExcelJS from 'exceljs';

const taka = (n) => (n == null ? '' : `৳${Number(n).toLocaleString('en')}`);

/**
 * `d`: the complete insights (every hook, advertiser and category — insights.js result).
 * `summary`: the first rows of the Summary sheet ([label, value] pairs) — what the report is about.
 */
export async function sendInsightsWorkbook(res, d, summary, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map(([header, key, width, wrap]) => ({ header, key, width, ...(wrap ? { style: { alignment: { wrapText: true, vertical: 'top' } } } : {}) }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FF3730A3' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    head.commit();
    for (const row of rows) ws.addRow(row).commit();
    ws.commit();
  };
  sheet('Summary', [['Item', 'k', 34], ['Value', 'v', 70]], [
    ...summary.map(([k, v]) => ({ k, v })),
    { k: 'Report date', v: new Date().toISOString().slice(0, 10) },
    { k: 'Ads', v: d.ads },
    { k: 'Advertisers', v: d.advertisers.length },
    { k: 'Different hooks', v: d.hooks.length },
    { k: 'Running 30+ days', v: d.longRunning },
    { k: 'Ads naming an offer', v: d.adsWithOffer },
    { k: 'Ads with a price', v: d.adsWithPrice },
    { k: 'Most used offer', v: d.offers?.[0]?.ads ? `${d.offers[0].offer} (${d.offers[0].pct}% of the ads)` : '—' },
    { k: 'Typical price', v: d.prices ? `${taka(d.prices.median)} (most between ${taka(d.prices.low)} and ${taka(d.prices.high)})` : '—' },
    { k: 'Note', v: 'Read from the ads’ own text and dates — nothing estimated. Every hook and every advertiser is in this file.' },
  ]);
  sheet('Hooks', [['Days running', 'days', 13], ['Hook (opening line)', 'hook', 90, true], ['Advertiser', 'pageName', 32], ['Ads with this hook', 'ads', 16], ['Advertisers using it', 'pages', 18], ['Ad link', 'link', 50]],
    d.hooks.map((h) => ({ ...h, link: `https://www.facebook.com/ads/library/?id=${h.adId}` })));
  sheet('Offers', [['Offer', 'offer', 24], ['Ads', 'ads', 10], ['% of all ads', 'pct', 12], ['% of ads with an offer', 'pctOfOffers', 20]], d.offers);
  sheet('Prices', [['Price level', 'k', 18], ['Price', 'v', 16]], d.prices
    ? [['Lowest', d.prices.min], ['Low (25%)', d.prices.low], ['Typical', d.prices.median], ['High (75%)', d.prices.high], ['Highest', d.prices.max], ['Prices found', d.prices.count]].map(([k, v]) => ({ k, v: k === 'Prices found' ? v : taka(v) }))
    : [{ k: 'No prices in the ads' }]);
  const share = (name, rows) => sheet(name, [[name, 'name', 24], ['Ads', 'ads', 10], ['% of ads', 'pct', 10]], rows);
  share('Formats', d.formats);
  share('Order via', d.orderVia);
  share('Languages', d.languages);
  if (d.categories) sheet('Categories', [['Category', 'name', 36], ['Leads', 'leads', 10], ['% of leads', 'pct', 12]], d.categories);
  // every advertiser (most ads first), with a link to its ads
  sheet('Advertisers', [['Advertiser', 'pageName', 40], ['Ads', 'ads', 10], ['Days advertising', 'days', 16], ['Page ID', 'pageId', 20], ['Ads in the Library', 'link', 50]],
    d.advertisers.map((a) => ({ ...a, link: /^\d+$/.test(a.pageId) ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=${a.pageId}` : '' })));
  await wb.commit();
}
