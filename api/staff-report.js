// 員工回報 LIFF 表單的後端接收端點（POST /api/staff-report）
// 自成一檔、不 require webhook.js，避免 serverless 互相污染（見 NEXT_PHASE 規格）。
// 重用的寫入邏輯（找訂單、寫 Sheet、上傳 Drive）是從 webhook.js 複製過來的，
// 兩邊邏輯若要改請一起改。
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
// Sheet ID / 資料夾 ID 非機密（真正的鑰匙是 Google OAuth token，存在環境變數）。
// 環境變數有設就用它；沒設就用這裡的後備值，免得卡在 Vercel 的 Sensitive 變數問題。
const STAFF_REPORT_SPREADSHEET_ID = (process.env.STAFF_REPORT_SPREADSHEET_ID || '1_MWDukWyWTjVF_pVcW9ZBYeZFRKdMnf_dMVxxLMQ33A').trim();
const STAFF_REPORT_IMAGE_FOLDER_ID = (process.env.STAFF_REPORT_IMAGE_FOLDER_ID || '1u9MQJ2DnF6jKrfazDIJpYAKaEuM4Xr1B').trim();
const STAFF_REPORT_SHEET_NAME = process.env.STAFF_REPORT_SHEET_NAME || '員工問題回報';
const STAFF_REPORT_ORDER_SHEET_NAME = process.env.STAFF_REPORT_ORDER_SHEET_NAME || '所有訂單';
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const STAFF_LIFF_CHANNEL_ID = process.env.STAFF_LIFF_CHANNEL_ID; // 選填：有設就驗證 LIFF idToken
const STAFF_LIFF_ID = process.env.STAFF_LIFF_ID; // 給前端 staff.html 初始化用

const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY) ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const VALID_TYPES = ['少貨', '破損', '錯貨', '多貨', '未到貨', '其他'];

// Refresh token：優先讀 Supabase（xlan_kv 的 google_refresh_token），讀不到才用環境變數。
// 這樣 /api/oauth 重新授權後，不用改 Vercel、也不用重新部署就即時生效。
let RESOLVED_REFRESH_TOKEN = GOOGLE_REFRESH_TOKEN;
let REFRESH_TOKEN_SOURCE = 'env';
async function resolveRefreshToken() {
  if (!supabase) return;
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', 'google_refresh_token').single();
    if (data && data.value) {
      RESOLVED_REFRESH_TOKEN = String(data.value).trim();
      REFRESH_TOKEN_SOURCE = 'supabase';
    }
  } catch (e) {
    // 讀不到就維持環境變數值
  }
}

// --- Google clients ---
function getGoogleOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: RESOLVED_REFRESH_TOKEN });
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
function scoreTrackingCandidate(value) {
  let score = 0;
  if (/^[A-Z]{1,5}\d+$/.test(value)) score += 4;
  if (/^\d{10,16}$/.test(value)) score += 3;
  if (value.length >= 10 && value.length <= 18) score += 2;
  if (/^1\d{11,}$/.test(value)) score += 1;
  return score;
}
function extractTrackingNoFromOcr(text) {
  const compact = String(text || '').toUpperCase().replace(/[^\dA-Z]/g, ' ');
  const candidates = [];
  const re = /\b([A-Z]{1,5}\d{7,20}|\d{9,20})\b/g;
  let m;
  while ((m = re.exec(compact)) !== null) {
    const value = m[1];
    if (/^20\d{6,}$/.test(value)) continue;
    candidates.push(value);
  }
  if (!candidates.length) return '';
  candidates.sort((a, b) => scoreTrackingCandidate(b) - scoreTrackingCandidate(a));
  return candidates[0];
}
async function ocrStaffImage(base64Data) {
  if (!GOOGLE_VISION_API_KEY) return '';
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(GOOGLE_VISION_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content: base64Data }, features: [{ type: 'TEXT_DETECTION' }] }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Vision OCR failed: ${JSON.stringify(data)}`);
  return data.responses?.[0]?.textAnnotations?.[0]?.description || '';
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

// --- AI 判斷問題類型（員工自由填寫 → 少貨/破損/錯貨/多貨/未到貨/其他）---
async function classifyProblem(text) {
  const clean = String(text || '').trim();
  if (!clean) return { type: '其他', qty: 1, summary: '' };
  if (!anthropic) return { type: '其他', qty: 1, summary: clean.slice(0, 20) };
  try {
    const prompt = `你是倉庫到貨問題回報助手。員工會用很口語、有錯字的方式描述問題。
請判斷員工這句話是在回報哪一種到貨問題，只回 JSON：
{"type":"少貨|破損|錯貨|多貨|未到貨|其他","qty":數字或null,"summary":"10字內摘要"}
判斷規則：
- 沒到、沒收到、沒來、整箱沒、都沒到、沒有到、未到、位到 = 未到貨
- 少、短少、缺、不夠 = 少貨
- 破、壞、損、爛、裂 = 破損
- 錯、發錯、拿錯、不是我要的 = 錯貨
- 多、多出、多給 = 多貨
- 看不出明確類型就填「其他」，把原話濃縮放 summary
- qty 是有問題的件數，看不出來填 null
員工的話：${clean}`;
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = (response.content[0]?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { type: '其他', qty: 1, summary: '' };
    const parsed = JSON.parse(m[0]);
    const type = VALID_TYPES.includes(parsed.type) ? parsed.type : '其他';
    const qty = Number(parsed.qty) > 0 ? Number(parsed.qty) : 1;
    return { type, qty, summary: parsed.summary || '' };
  } catch (e) {
    console.error('classifyProblem_error', e?.message);
    return { type: '其他', qty: 1, summary: '' };
  }
}

async function uploadPhotoList(list, sourceKey, tag) {
  const urls = [];
  for (const b64 of (list || [])) {
    const clean = String(b64 || '').replace(/^data:image\/\w+;base64,/, '');
    if (!clean) continue;
    try {
      const buffer = Buffer.from(clean, 'base64');
      const url = await uploadStaffImageBufferToDrive(buffer, `${Date.now()}_${sanitizeKey(sourceKey)}_${tag}${urls.length + 1}.jpg`);
      if (url) urls.push(url);
    } catch (e) {
      console.error('staff_photo_upload_error', e?.message);
    }
  }
  return urls;
}

// --- 核心：建立回報（每個運單號各一列，共用同一問題與照片）---
async function createStaffReports({ type, qty, description, summary, trackingNos, employeeName, sourceKey, waybillPhotoList, problemPhotoList }) {
  const waybillUrls = await uploadPhotoList(waybillPhotoList, sourceKey, 'wb');
  const problemUrls = await uploadPhotoList(problemPhotoList, sourceKey, 'pp');
  const waybillPhotoCell = waybillUrls.join('\n');
  const problemPhotoCell = problemUrls.join('\n');
  const empTextCell = description ? description : (type === '未到貨' ? '未到貨' : '（表單回報）'); // 員工原話
  const aiNote = `小瀾判斷：${type}${qty ? ' ' + qty : ''}${summary ? `（${summary}）` : ''}`;
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
      empTextCell,
      waybillPhotoCell,
      problemPhotoCell,
      tn ? (order.found ? (order.suspected ? '疑似運單' : '未處理') : '找不到運單') : '未填運單',
      [
        aiNote,
        tn
          ? (order.found ? (order.suspected ? `系統疑似比對到 ${order.trackingNo}` : '') : '所有訂單找不到這個運單號')
          : '員工未填運單號',
      ].filter(Boolean).join('｜'),
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
  return { created: rows.length, results, photoCount: waybillUrls.length + problemUrls.length, problemType: type, problemQty: qty };
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
  // 前端開啟表單時先 GET 拿 LIFF ID（避免 liff.state 包住網址參數讀不到）
  if (req.method === 'GET') {
    let googleAuth = 'untested';
    let supa = 'untested';
    if (req.url && req.url.includes('diag')) {
      if (!supabase) {
        supa = 'no-config';
      } else {
        try {
          const { error } = await supabase.from('xlan_kv').upsert({ key: 'staff_diag', value: 'ping' });
          supa = error ? ('fail:' + error.message) : 'ok';
        } catch (e) {
          supa = 'fail:' + (e?.message || 'err');
        }
      }
      await resolveRefreshToken();
      try {
        const c = getGoogleOAuthClient();
        const t = await c.getAccessToken();
        googleAuth = (t && t.token) ? 'ok' : 'no-token';
      } catch (e) {
        googleAuth = 'fail:' + (e?.response?.data?.error || e?.message || 'err');
      }
    }
    res.status(200).json({
      ok: true,
      liffId: (STAFF_LIFF_ID || '').trim(),
      googleAuth,
      tokenSource: REFRESH_TOKEN_SOURCE,
      supabase: supa,
      spreadsheetIdTail: STAFF_REPORT_SPREADSHEET_ID.slice(-6),
      // 診斷用：只回報變數有沒有設（true/false），不洩漏值
      env: {
        spreadsheet: !!process.env.STAFF_REPORT_SPREADSHEET_ID,
        vision: !!process.env.GOOGLE_VISION_API_KEY,
        folder: !!process.env.STAFF_REPORT_IMAGE_FOLDER_ID,
        sheetName: !!process.env.STAFF_REPORT_SHEET_NAME,
        refresh: !!process.env.GOOGLE_REFRESH_TOKEN,
        clientId: !!process.env.GOOGLE_CLIENT_ID,
        clientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
        orderSheet: !!process.env.STAFF_REPORT_ORDER_SHEET_NAME,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        liff: !!process.env.STAFF_LIFF_ID,
      },
    });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!STAFF_REPORT_SPREADSHEET_ID) {
    res.status(503).json({ ok: false, error: '員工回報尚未啟用（缺 STAFF_REPORT_SPREADSHEET_ID）' });
    return;
  }
  try {
    await resolveRefreshToken();
    const body = await readJsonBody(req);
    if (body.arrived === undefined || body.arrived === null) {
      res.status(400).json({ ok: false, error: '請先選「貨到了嗎」' });
      return;
    }
    const arrived = body.arrived === true || body.arrived === 'true' || body.arrived === 1;
    let trackingNos = normalizeTrackingNos(body.trackingNos);
    const waybillPhotos = Array.isArray(body.waybillPhotos) ? body.waybillPhotos.slice(0, 2) : [];
    const problemPhotos = Array.isArray(body.problemPhotos) ? body.problemPhotos.slice(0, 4) : [];
    const description = String(body.description || '').trim();

    let type, qty, summary = '';
    if (!arrived) {
      // 未到貨：只要運單號
      if (trackingNos.length === 0) {
        res.status(400).json({ ok: false, error: '請填沒到的運單號' });
        return;
      }
      type = '未到貨';
      qty = trackingNos.length || 1;
    } else {
      // 有到貨：運單（打字/掃／運單照片 OCR）＋ 問題描述
      if (trackingNos.length === 0 && waybillPhotos.length === 0) {
        res.status(400).json({ ok: false, error: '請掃／拍／打運單號' });
        return;
      }
      if (!description) {
        res.status(400).json({ ok: false, error: '請描述問題（例：粉色少3）' });
        return;
      }
      // 沒打運單號但有拍運單照片 → OCR 讀運單號
      if (trackingNos.length === 0 && waybillPhotos.length) {
        for (const b64 of waybillPhotos) {
          try {
            const txt = await ocrStaffImage(String(b64).replace(/^data:image\/\w+;base64,/, ''));
            const no = extractTrackingNoFromOcr(txt);
            if (no) trackingNos.push(no);
          } catch (e) {
            console.error('staff_wb_ocr_error', e?.message);
          }
        }
        trackingNos = normalizeTrackingNos(trackingNos);
      }
      const cls = await classifyProblem(description);
      type = cls.type; qty = cls.qty; summary = cls.summary;
    }

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
      description: arrived ? description : '',
      summary,
      trackingNos,
      employeeName,
      sourceKey,
      waybillPhotoList: arrived ? waybillPhotos : [],
      problemPhotoList: arrived ? problemPhotos : [],
    });

    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('staff_report_submit_error', e);
    const detail = e?.response?.data?.error_description
      || e?.response?.data?.error
      || e?.errors?.[0]?.message
      || e?.message
      || '寫入失敗';
    res.status(500).json({ ok: false, error: String(detail), code: e?.response?.data?.error || e?.code || '' });
  }
};
