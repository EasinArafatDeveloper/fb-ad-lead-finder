/**
 * FB Ad Lead Finder — Google Sheet endpoint
 * 1) Change SECRET  2) Deploy → New deployment → Web app (Execute as: Me, Access: Anyone)
 * 3) Put the Web App URL + SECRET in the dashboard Settings
 */
const SECRET = 'change-this-secret';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET === 'change-this-secret') return out({ ok: false, error: 'Change SECRET in the Apps Script code first (it is still the default)' });
    if (body.secret !== SECRET) return out({ ok: false, error: 'Wrong secret key' });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'ping') return out({ ok: true, sheet: ss.getName() });
    if (body.action === 'upsert') return out(Object.assign({ ok: true }, upsert(ss, body.sheet, body.key, body.headers, body.rows, body.keep || [])));
    if (body.action === 'pull') return out({ ok: true, rows: pull(ss, body.sheet, body.fields) });
    return out({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() {
  return out({ ok: true, msg: 'FB Ad Lead Finder endpoint is live' });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Upsert by the key column: update the row if it exists, else append a new one. Your own extra columns are left alone,
 * and the `keep` columns (Status, Notes — what your team types) are only filled when the cell is still empty.
 */
function upsert(ss, name, key, headers, rows, keep) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const lastCol = sh.getLastColumn();
    const cur = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    headers.forEach(function (h) { if (cur.indexOf(h) === -1) cur.push(h); });
    sh.getRange(1, 1, 1, cur.length).setValues([cur]).setFontWeight('bold').setBackground('#e8eef7');
    sh.setFrozenRows(1);
    // plain text everywhere: long Page IDs and +880 numbers must not turn into numbers
    sh.getRange(1, 1, sh.getMaxRows(), cur.length).setNumberFormat('@');

    const keyCol = cur.indexOf(key);
    const keyIdx = headers.indexOf(key);
    const colMap = headers.map(function (h) { return cur.indexOf(h); });
    const lastRow = sh.getLastRow();
    const data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, cur.length).getValues() : [];
    const index = {};
    data.forEach(function (r, i) { index[String(r[keyCol])] = i; });

    let updated = 0;
    const appends = [];
    const keepIdx = headers.map(function (h) { return keep.indexOf(h) !== -1; });
    const appendedAt = {};
    rows.forEach(function (r) {
      const k = String(r[keyIdx]);
      let target;
      let existing = false;
      if (index[k] !== undefined) {
        target = data[index[k]];
        existing = true;
        updated++;
      } else if (appendedAt[k] !== undefined) {
        target = appends[appendedAt[k]];
      } else {
        target = new Array(cur.length).fill('');
        appendedAt[k] = appends.length;
        appends.push(target);
      }
      colMap.forEach(function (c, i) {
        if (existing && keepIdx[i] && String(target[c]) !== '') return; // the team's edit wins
        target[c] = r[i] == null ? '' : String(r[i]);
      });
    });
    if (data.length && updated) sh.getRange(2, 1, data.length, cur.length).setValues(data);
    if (appends.length) {
      if (sh.getMaxRows() < sh.getLastRow() + appends.length) sh.insertRowsAfter(sh.getMaxRows(), appends.length);
      sh.getRange(sh.getLastRow() + 1, 1, appends.length, cur.length).setNumberFormat('@').setValues(appends);
    }
    return { updated: updated, inserted: appends.length };
  } finally {
    lock.releaseLock();
  }
}

function pull(ss, name, fields) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const head = values[0].map(String);
  return values.slice(1).map(function (r) {
    const o = {};
    fields.forEach(function (f) { const i = head.indexOf(f); o[f] = i >= 0 ? r[i] : ''; });
    return o;
  });
}
