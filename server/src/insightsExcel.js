// The Ad insights report as an Excel workbook — the same for a project and for All Leads (insights.js).
import ExcelJS from 'exceljs';

const taka = (n) => (n == null ? '' : `৳${Number(n).toLocaleString('en')}`);

/** `summary`: the first rows of the Summary sheet ([label, value] pairs) — what the report is about. */
export function insightsWorkbook(d, summary) {
  const wb = new ExcelJS.Workbook();
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FF3730A3' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of rows) ws.addRow(row);
    return ws;
  };
  sheet('Summary', [['Item', 'k', 34], ['Value', 'v', 70]], [
    ...summary.map(([k, v]) => ({ k, v })),
    { k: 'Report date', v: new Date().toISOString().slice(0, 10) },
    { k: 'Ads', v: d.ads },
    { k: 'Advertisers', v: d.advertisers ?? '' },
    { k: 'Running 30+ days', v: d.longRunning },
    { k: 'Most used offer', v: d.offers?.[0]?.ads ? `${d.offers[0].offer} (${d.offers[0].pct}% of the ads)` : '—' },
    { k: 'Typical price', v: d.prices ? `${taka(d.prices.median)} (most between ${taka(d.prices.low)} and ${taka(d.prices.high)})` : '—' },
    { k: 'Note', v: 'Read from the ads’ own text and dates — nothing estimated.' },
  ]);
  const hooks = sheet('Hooks', [['Days running', 'days', 13], ['Hook (opening line)', 'hook', 90], ['Advertiser', 'pageName', 32], ['Ads with this hook', 'ads', 16], ['Advertisers using it', 'pages', 18], ['Ad link', 'link', 50]],
    d.hooks.map((h) => ({ ...h, link: `https://www.facebook.com/ads/library/?id=${h.adId}` })));
  hooks.getColumn('hook').alignment = { wrapText: true, vertical: 'top' };
  sheet('Offers', [['Offer', 'offer', 24], ['Ads', 'ads', 10], ['% of ads', 'pct', 10]], d.offers);
  sheet('Prices', [['Price level', 'k', 18], ['Price', 'v', 16]], d.prices
    ? [['Lowest', d.prices.min], ['Low (25%)', d.prices.low], ['Typical', d.prices.median], ['High (75%)', d.prices.high], ['Highest', d.prices.max], ['Prices found', d.prices.count]].map(([k, v]) => ({ k, v: k === 'Prices found' ? v : taka(v) }))
    : [{ k: 'No prices in the ads' }]);
  const share = (name, rows) => sheet(name, [[name, 'name', 24], ['Ads', 'ads', 10], ['% of ads', 'pct', 10]], rows);
  share('Formats', d.formats);
  share('Order via', d.orderVia);
  share('Languages', d.languages);
  if (d.categories) sheet('Categories', [['Category', 'name', 36], ['Leads', 'leads', 10], ['% of leads', 'pct', 12]], d.categories);
  sheet('Top advertisers', [['Advertiser', 'pageName', 40], ['Ads', 'ads', 10], ['Days advertising', 'days', 16]],
    [...new Map([...d.topByAds, ...d.topByDays].map((x) => [x.pageId, x])).values()].sort((a, b) => b.ads - a.ads));
  return wb;
}

/** Sends the workbook as a download. */
export async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  await wb.xlsx.write(res);
  res.end();
}
