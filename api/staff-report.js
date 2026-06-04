// 員工回報 LIFF 表單的後端接收端點（POST /api/staff-report）
// 自成一檔、不 require webhook.js，避免 serverless 互相污染（見 NEXT_PHASE 規格）。
// 重用的寫入邏輯（找訂單、寫 Sheet、上傳 Drive）是從 webhook.js 複製過來的，
// 兩邊邏輯若要改請一起改。
const { google } = require('googleapis');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const STAFF_REPORT_SPREADSHEET_ID = process.env.STAFF_REPORT_SPREADSHEET_ID;
const STAFF_REPORT_IMAGE_FOLDER_ID = process.env.STAFF_REPORT_IMAGE_FOLDER_ID;
const STAFF_REPORT_SHEET_NAME = process.env.STAFF_REPORT_SHEET_NAME || '員工問題回報';
const STAFF_REPORT_ORDER_SHEET_NAME = process.env.STAFF_REPORT_ORDER_SHEET_NAME || '所有訂單';
const STAFF_LIFF_CHANNEL_ID = process.env.STAFF_LIFF_CHANNEL_ID; // 選填：有設就驗證 LIFF idToken

const VALID_TYPES = ['少貨', '破損', '錯貨', '多貨', '未到貨', '其他'];

// --- Google clients ---
function getGoogleOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}
function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getGoogleOAuthClient() });
}
function getDriveClient() {
  return google.drive({ version: 'v3', auth: getGoogleOAuthClient() });
}

// --- 運單號處理（與 webhook.js 同邏輯）---
function cleanStaffKey(value) {
  return String(value || '').trim().replace(/^="?/, '').replace(/"$/, '').replace(/^["']|["']$/g, '').toUpperCase();
}
function splitStaffKeys(value) {
  return String(value || '').split(/[;；,，、\s]+/).map(cleanStaffKey).filter(Boolean);
}
function staffTrackingDistance(a, b) {
  const left = cleanStaffKey(a);
  const right = cleanStaffKey(b);
  if (!left || !right) return Infinity;
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return Infinity;
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i++) dp[i][0] = i;
  for (let j = 0; j <= right.length; j++) dp[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[left.length][right.length];
}
function isLikelyStaffTrackingMatch(target, candidate) {
  const left = cleanStaffKey(target);
  const right = cleanStaffKey(candidate);
  if (!left || !right) return false;
  if (left.length < 9 || right.length < 9) return false;
  return staffTrackingDistance(left, right) <= 1;
}
function staffOrderFromRow(row, rowNumber, trackingNo, rawTrackingNo, suspected = false) {
  return {
    found: true,
    suspected,
    rowNumber,
    orderNo: row[2] || '',
    trackingNo,
    rawTrackingNo: rawTrackingNo || '',
    productId: row[14] || '',
    productName: row[15] || row[4] || '',
    qty: row[6] || '',
    usage: row[13] || '',
    destination: row[12] || '',
    offerId: row[19] || '',
  };
}
async function findOrderByTrackingNo(trackingNo) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
    range: `${STAFF_REPORT_ORDER_SHEET_NAME}!A:T`,
  });
  const rows = res.data.values || [];
  const target = cleanStaffKey(trackingNo);
  let nearest = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const tracks = splitStaffKeys(row[3] || ''); // D 運單號碼
    if (tracks.includes(target)) {
      return staffOrderFromRow(row, i + 1, target, row[3] || '');
    }
    for (const track of tracks) {
      if (!isLikelyStaffTrackingMatch(target, track)) continue;
      const distance = staffTrackingDistance(target, track);
      if (!nearest || distance < nearest.distance) {
        nearest = { row, rowNumber: i + 1, track, distance };
      }
    }
  }
  if (nearest) {
    return staffOrderFromRow(nearest.row, nearest.rowNumber, nearest.track, nearest.row[3] || '', true);
  }
  return { found: false };
}

// --- 寫入 Sheet ---
async function ensureStaffReportSheet() {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: STAFF_REPORT_SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === STAFF_REPORT_SHEET_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: STAFF_REPORT_SHEET_NAME } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
      range: `${STAFF_REPORT_SHEET_NAME}!A1:R1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          '回報時間', '員工', 'LINE來源', '運單號', '1688訂單號', '商品編號',
          '商品名稱', '原訂數量', '用途', '問題類型', '問題數量', '員工文字',
          '運單照片', '問題照片', '狀態', '備註', '所有訂單列號', 'Offer ID',
        ]],
      },
    });
  }
}
async function appendStaffReportRows(rows) {
  if (!rows.length) return;
  await ensureStaffReportSheet();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
    range: `${STAFF_REPORT_SHEET_NAME}!A:R`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// --- 照片上傳 Drive ---
async function uploadStaffImageBufferToDrive(buffer, filename) {
  if (!STAFF_REPORT_IMAGE_FOLDER_ID) return '';
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [STAFF_REPORT_IMAGE_FOLDER_ID] },
    media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(buffer) },
    fields: 'id,webViewLink',
  });
  return res.data.webViewLink || (res.data.id ? `https://drive.google.com/file/d/${res.data.id}/view` : '');
}

// --- LIFF idToken 驗證（選填）---
async function verifyLiffIdToken(idToken) {
  if (!idToken || !STAFF_LIFF_CHANNEL_ID) return null;
  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: STAFF_LIFF_CHANNEL_ID }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { sub: data.sub || '', name: data.name || '' };
  } catch {
    return null;
  }
}

function sanitizeKey(s) {
  return String(s || '').replace(/[^\w-]/g, '_');
}

// 把多筆運單號正規化成陣列（接受陣列或換行/逗號分隔字串）
function normalizeTrackingNos(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (input) list = String(input).split(/[\n\r;；,，、\s]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const key = cleanStaffKey(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// --- 核心：建立回報（每個運單號各一列，共用同一問題與照片）---
async function createStaffReports({ type, qty, trackingNos, note, employeeName, sourceKey, photoBase64List }) {
  // 照片只上傳一次，所有運單列共用
  const photoUrls = [];
  for (const b64 of (photoBase64List || [])) {
    const clean = String(b64 || '').replace(/^data:image\/\w+;base64,/, '');
    if (!clean) continue;
    try {
      const buffer = Buffer.from(clean, 'base64');
      const url = await uploadStaffImageBufferToDrive(buffer, `${Date.now()}_${sanitizeKey(sourceKey)}_${photoUrls.length + 1}.jpg`);
      if (url) photoUrls.push(url);
    } catch (e) {
      console.error('staff_photo_upload_error', e?.message);
    }
  }
  const problemPhotoCell = photoUrls.join('\n');
  const noteCell = note ? `（表單）${note}` : '（表單回報）';
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  const tnList = (trackingNos && trackingNos.length) ? trackingNos : [''];
  const rows = [];
  const results = [];
  for (const tn of tnList) {
    const order = tn ? await findOrderByTrackingNo(tn) : { found: false };
    rows.push([
      now,
      employeeName || '',
      sourceKey,
      tn,
      order.orderNo || '',
      order.productId || '',
      order.productName || '',
      order.qty || '',
      order.usage || '',
      type,
      qty,
      noteCell,
      '', // 運單照片：表單走掃碼/打字，照片都歸到問題照片
      problemPhotoCell,
      tn ? (order.found ? (order.suspected ? '疑似運單' : '未處理') : '找不到運單') : '未填運單',
      tn
        ? (order.found ? (order.suspected ? `表單運單 ${tn}，系統疑似比對到 ${order.trackingNo}` : '') : '所有訂單找不到這個運單號')
        : '員工未填運單號',
      order.rowNumber || '',
      order.offerId || '',
    ]);
    results.push({
      trackingNo: tn,
      found: !!order.found,
      suspected: !!order.suspected,
      productName: order.productName || '',
    });
  }
  await appendStaffReportRows(rows);
  return { created: rows.length, results, photoCount: photoUrls.length };
}

// --- 讀取 JSON body（相容 Vercel 已解析 / 原始串流）---
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!STAFF_REPORT_SPREADSHEET_ID) {
    res.status(503).json({ ok: false, error: '員工回報尚未啟用（缺 STAFF_REPORT_SPREADSHEET_ID）' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const type = String(body.type || '').trim();
    if (!VALID_TYPES.includes(type)) {
      res.status(400).json({ ok: false, error: '請選擇問題類型' });
      return;
    }
    const trackingNos = normalizeTrackingNos(body.trackingNos);
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 6) : [];
    if (type !== '未到貨' && trackingNos.length === 0 && photos.length === 0) {
      res.status(400).json({ ok: false, error: '請至少掃一個運單號或附一張照片' });
      return;
    }
    let qty = Number(body.qty);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;

    let employeeName = String(body.userName || '').trim();
    let userId = '';
    const verified = await verifyLiffIdToken(body.idToken);
    if (verified) {
      if (verified.name) employeeName = verified.name;
      userId = verified.sub || '';
    }
    const groupId = String(body.groupId || '').trim();
    const sourceKey = ['staff_report', 'liff', groupId, userId].filter(Boolean).join(':') || 'staff_report:liff';

    const result = await createStaffReports({
      type,
      qty,
      trackingNos,
      note: String(body.note || '').trim(),
      employeeName,
      sourceKey,
      photoBase64List: photos,
    });

    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('staff_report_submit_error', e);
    res.status(500).json({ ok: false, error: e?.message || '寫入失敗' });
  }
};
