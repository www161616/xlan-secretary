// 丸十支出 LIFF 表單版（#支出 切片二）的後端端點（GET / POST /api/maruten-expense-form）。
//
// 設計目標（見 D:\丸十支出機器人\實作計畫_丸十支出_LIFF表單.md 任務1）：
//   GET  → 回 { liffId, categories }，給前端 maruten-expense.html 初始化用
//          （照 staff-report.js：先 GET 拿 liffId 再 liff.init，避免 liff.state 包住網址參數讀不到）。
//   POST → 收 { 分類, 項目, 金額, 備註, 收據照[base64], groupId, userName, idToken }
//          1. 驗證（金額 > 0、分類在清單內、項目非空）
//          2. getEntityForGroup(groupId) 取主體——未設定就「擋下不記＋回提示」（沿用打字版 P0，嚴禁 fallback 丸十）
//          3. saveExpense 存 Supabase（帶 entity）
//          4. marutenExpense.appendExpenseToSheet 寫「丸十支出」Sheet
//          5. 收據照上傳 Google Drive，連結寫進 Sheet 的「收據照片」欄
//
// 隔離原則（與 staff-report.js / maruten-expense.js 一致）：本檔自成一塊、自帶 Google/Supabase client，
// 不 require webhook.js，避免 serverless 互相污染。getEntityForGroup / saveExpense 是 webhook.js 同邏輯的
// 等價實作（讀同一個 xlan_kv.group_entity_map、insert 同一張 xlan_expenses、entity 有值才寫）——
// 兩邊邏輯若要改請一起改。寫 Sheet 直接複用已寫好的 marutenExpense 模組（同一張表、同一套同步邏輯）。

const { google } = require('googleapis');
const marutenExpense = require('./maruten-expense');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// LIFF ID 非機密（本來就會出現在網址）。env 有設且非空白就用它，否則用寫死後備值——
// 後備值＝老闆已註冊的真 LIFF app（這樣不必去 Vercel 設 env，部署後即可用；env 若有設仍優先）。
const MARUTEN_EXPENSE_LIFF_ID = (process.env.MARUTEN_EXPENSE_LIFF_ID || '').trim() || '2009806013-sND5Erbq';

// 收據／發票照片上傳的 Drive 資料夾：優先用專屬的 MARUTEN_RECEIPT_FOLDER_ID，
// 沒設就沿用員工回報那顆 STAFF_REPORT_IMAGE_FOLDER_ID（同一個 Google 帳號、省設定）。
// 兩者都沒有 → 不上傳照片（收據連結留空），但記帳本身仍照常完成（照片是加值、不可擋住記帳）。
const MARUTEN_RECEIPT_FOLDER_ID = (
  process.env.MARUTEN_RECEIPT_FOLDER_ID
  || process.env.STAFF_REPORT_IMAGE_FOLDER_ID
  || '1u9MQJ2DnF6jKrfazDIJpYAKaEuM4Xr1B'
).trim();

// 選填：有設就驗證 LIFF idToken（沿用 staff 的可選驗證模式）。
const MARUTEN_EXPENSE_LIFF_CHANNEL_ID = process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID || process.env.STAFF_LIFF_CHANNEL_ID;

// LINE Messaging API push 用的 channel access token（與 webhook.js / reminder.js 同一把）。
// 表單送出成功後要 push 確認訊息回群組，沒設就只能略過 push（記帳仍完成，回應附 warning）。
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 分類清單（需求單 §6）：餐飲／進貨食材／運費／雜支／水電／其他。
// 寫死在程式（清單穩定、無需動態設定）；前端下拉與後端驗證共用同一份，避免兩邊不一致。
const EXPENSE_CATEGORIES = ['餐飲', '進貨食材', '運費', '雜支', '水電', '其他'];

const KV_GROUP_ENTITY_MAP = 'group_entity_map';   // 與 webhook.js 同一個 key
const KV_REFRESH_TOKEN = 'google_refresh_token';   // 與 webhook.js / staff-report.js 共用同一把 token

const MAX_RECEIPT_PHOTOS = 4;                       // 收據照最多 4 張（與前端一致、防 Vercel 60s timeout）

// 照片 payload 上限（防 memory bomb：惡意請求塞超大字串會吃爆 Buffer.from 的記憶體）。
// 前端已壓到 1280px / q0.7（單張通常 <500KB），這裡留寬鬆餘裕擋住明顯異常即可。
// 三道防線（語意主限＝解碼後位元組；單張字串長度只是更外層、更便宜的粗估閘門）：
//   (1) 單張字串長度上限＝第一道便宜閘門：超大字串連 regex 都不跑就擋掉。
//       因 base64 解碼後 ≈ 字串長度 ×3/4，這道要設成「比解碼上限更寬」的粗估值（解碼上限 ×4/3 再加餘裕），
//       否則它會先於解碼檢查觸發、讓解碼上限變成永遠到不了的死碼。
//   (2) 單張解碼後位元組上限：在 Buffer.from 前用 base64 長度換算解碼後 bytes 再確認，避免先吃記憶體。
//   (3) 合計解碼後位元組上限：累加各張解碼後 bytes，封住「多張湊量」的記憶體上限（≤ MAX_RECEIPT_PHOTOS 張）。
// 註：合計「字串長度」上限刻意不設——因每張字串長度已被 (1) 綁住、張數被 MAX_RECEIPT_PHOTOS 綁住，
//     在這些限制下任何能通過單張閘門的輸入，其字串長度總和都到不了合計解碼上限會先觸發的水位，
//     另設一道合計字串閘門只會是永遠觸發不到的死碼，故以合計解碼位元組 (3) 作為唯一的合計主限。
const MAX_RECEIPT_DECODED_BYTES = 2 * 1024 * 1024;    // 單張解碼後上限 ~2MB（decode 前用長度換算確認）
const MAX_RECEIPT_TOTAL_DECODED_BYTES = 8 * 1024 * 1024; // 所有照片解碼後合計上限 ~8MB
// 單張字串長度粗估閘門＝解碼上限 ×4/3（base64 膨脹率）再加 64KB 餘裕（含 data URL prefix），確保合法的足量圖片不會被誤擋。
const MAX_RECEIPT_DATAURL_CHARS = Math.ceil(MAX_RECEIPT_DECODED_BYTES * 4 / 3) + 64 * 1024;        // 單張字串上限（粗估）
// 只接受這幾種影像 data URL（前端壓縮輸出 jpeg；png/webp 一併放行，其餘擋掉）。
// 拆兩段：prefix 驗 MIME 並擷出 base64 本體；本體再用嚴格 base64 文法驗（長度須 4 對齊，不接受 %4===1 的非法串）。
const RECEIPT_DATAURL_PREFIX_RE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
// 嚴格 base64：每 4 字元一組，結尾允許 2 字元+`==` 或 3 字元+`=`；長度 %4===1 的非法串會被擋下。
const BASE64_STRICT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// 用 base64 字串長度換算解碼後位元組數（不真的 decode，避免先吃記憶體）。
// 前提：b64 已過 BASE64_STRICT_RE（長度為 4 的倍數），故 decoded = len/4*3 - padding 數。
function base64DecodedBytes(b64) {
  const len = b64.length;
  if (len === 0) return 0;
  let pad = 0;
  if (b64.charCodeAt(len - 1) === 61) pad += 1;       // '='
  if (b64.charCodeAt(len - 2) === 61) pad += 1;
  return Math.floor(len / 4) * 3 - pad;
}

const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY) ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// --- refresh token：kv 優先、env 後備（每次寫入前解析，確保用到最新授權）---
let RESOLVED_REFRESH_TOKEN = GOOGLE_REFRESH_TOKEN;
async function resolveRefreshToken() {
  if (!supabase) return;
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', KV_REFRESH_TOKEN).single();
    if (data && data.value) RESOLVED_REFRESH_TOKEN = String(data.value).trim();
  } catch (e) {
    // 讀不到就維持 env 值
  }
}

function getGoogleOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: RESOLVED_REFRESH_TOKEN });
  return oauth2Client;
}
function getDriveClient() {
  return google.drive({ version: 'v3', auth: getGoogleOAuthClient() });
}

// --- 群組 → 主體對應（與 webhook.js getEntityForGroup 同邏輯）---
// kv key「group_entity_map」存 JSON：{ "<groupId>": "丸十", ... }，未設定的群組回 null。
async function getEntityForGroup(groupId) {
  if (!groupId || !supabase) return null;
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', KV_GROUP_ENTITY_MAP).single();
    if (!data?.value) return null;
    const map = JSON.parse(data.value);
    const entity = map?.[groupId];
    return entity ? String(entity).trim() : null;
  } catch {
    return null;
  }
}

// --- 寫一筆支出進 Supabase（與 webhook.js saveExpense 同邏輯：entity 有值才寫）---
async function saveExpense({ amount, category, note, entity }) {
  const row = {
    amount,
    category,
    note: note || null,
    type: 'expense',
    account: 'business',
  };
  if (entity) row.entity = entity;
  const { data, error } = await supabase.from('xlan_expenses').insert(row).select();
  if (error) throw new Error(error.message);
  return data[0];
}

// --- 零用金餘額計算（與 webhook.js getPettyCashBalance 嚴格等價）---
// ⚠️ 兩處邏輯需一致：本檔是獨立 serverless function、拿不到 webhook.js 的 getPettyCashBalance，
//    故在此放一份等價實作（同 entity 過濾、同 type='deposit'/'expense' 加總、同 deleted 排除、
//    同 select 欄位 'amount, type, entity, deleted'）。webhook.js 那份若改算法／欄位，這份要一起改。
// 回傳 { deposit, expense, balance }；entity 為空回全 0。查詢有 error 時 throw（呼叫端負責 try/catch graceful）。
// entity 過濾在 DB（.eq）與 JS（row.entity!==entity）兩層都做，與 webhook.js 一致，確保不混 null／別主體。
async function getPettyCashBalance(entity) {
  const empty = { deposit: 0, expense: 0, balance: 0 };
  if (!entity || !supabase) return empty;
  const { data, error } = await supabase
    .from('xlan_expenses')
    .select('amount, type, entity, deleted')
    .eq('entity', entity);
  if (error) throw new Error(error.message);
  let deposit = 0;
  let expense = 0;
  for (const row of data || []) {
    if (!row) continue;
    if (row.entity !== entity) continue;        // 第二層 entity 防護：絕不混 null／別主體
    if (row.deleted === true) continue;          // 已刪不算（防禦；與 webhook.js 一致）
    const amt = Number(row.amount);
    if (!Number.isFinite(amt)) continue;
    if (row.type === 'deposit') deposit += amt;
    else if (row.type === 'expense') expense += amt;
    // 其他 type（income 等）不計入零用金池子
  }
  return { deposit, expense, balance: deposit - expense };
}

// 把記帳對應的 Sheet 列號寫回 xlan_expenses（供日後改分類／刪除同步該列）。
// 失敗只記 log、不拋錯（與 webhook.js setExpenseSheetRow 同；Sheet 同步是加值功能，不能影響主流程）。
async function setExpenseSheetRow(expenseId, sheetRow) {
  if (!expenseId || !Number.isFinite(Number(sheetRow)) || !supabase) return false;
  try {
    const { error } = await supabase.from('xlan_expenses').update({ sheet_row: Number(sheetRow) }).eq('id', expenseId);
    if (error) { console.error('maruten_form_set_sheet_row_error', error.message); return false; }
    return true;
  } catch (e) {
    console.error('maruten_form_set_sheet_row_error', e?.message);
    return false;
  }
}

// --- 收據照上傳 Drive（比照 staff-report.js uploadStaffImageBufferToDrive）---
async function uploadReceiptBufferToDrive(buffer, filename) {
  if (!MARUTEN_RECEIPT_FOLDER_ID) return '';
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [MARUTEN_RECEIPT_FOLDER_ID] },
    media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(buffer) },
    fields: 'id,webViewLink',
  });
  return res.data.webViewLink || (res.data.id ? `https://drive.google.com/file/d/${res.data.id}/view` : '');
}

function sanitizeKey(s) {
  return String(s || '').replace(/[^\w-]/g, '_');
}

// 依序把多張收據照（base64）上傳 Drive，回傳 { urls, failed }（單張失敗只略過該張、不中斷其餘）。
// failed＝「有內容卻沒成功上傳」的張數（P2-1：要讓使用者／群組看得出「傳了 4 張只成功 2 張」）。
// 序列上傳（非並行）：照片不多（≤4）、序列較不易撞 Drive 配額／Vercel 記憶體，也方便錯誤定位。
// 注意：傳進來的 list 應已過 validateReceiptPhotos（MIME／大小已驗），故 strip prefix 後一定有內容。
async function uploadReceiptList(list, sourceKey) {
  const urls = [];
  let failed = 0;
  // 未設 Drive 資料夾＝「不上傳照片」（設計上記帳仍完成、連結留空），這不算「失敗」，故 failed 維持 0。
  if (!MARUTEN_RECEIPT_FOLDER_ID) return { urls, failed };
  for (const b64 of (list || [])) {
    const clean = String(b64 || '').replace(/^data:image\/\w+;base64,/, '');
    if (!clean) continue;
    try {
      const buffer = Buffer.from(clean, 'base64');
      const url = await uploadReceiptBufferToDrive(buffer, `${Date.now()}_${sanitizeKey(sourceKey)}_receipt${urls.length + 1}.jpg`);
      if (url) urls.push(url);
      else failed += 1;   // 有設資料夾卻沒回連結 → 視為這張上傳失敗
    } catch (e) {
      failed += 1;
      console.error('maruten_receipt_upload_error', e?.message);
    }
  }
  return { urls, failed };
}

// --- LIFF idToken 驗證（選填，沿用 staff-report.js verifyLiffIdToken）---
async function verifyLiffIdToken(idToken) {
  if (!idToken || !MARUTEN_EXPENSE_LIFF_CHANNEL_ID) return null;
  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: MARUTEN_EXPENSE_LIFF_CHANNEL_ID }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { sub: data.sub || '', name: data.name || '' };
  } catch {
    return null;
  }
}

// --- 純函數：收據照（base64 data URL）大小／格式驗證（P1-2：防 memory bomb）---
// 回傳 { ok:true, photos:[...] } 或 { ok:false, error, status }（status 給 handler 決定 413/400）。
// 規則：先截到 MAX_RECEIPT_PHOTOS 張（多的不報錯）；每張須符合 image/jpeg|png|webp 的 base64 data URL、
//      base64 嚴格合法（長度 4 對齊，%4===1 的非法串擋掉）；
//      單張字串／單張解碼後／合計解碼後皆有上限（超限回 413）。
// 後端自驗、不只信前端：壞 MIME／非 base64 一律擋（400），避免把垃圾餵給 Buffer.from。
// 兩段式驗證：字串長度上限是便宜的第一道閘門，超大字串連 regex 都不跑就擋；
//            解碼後位元組數在 Buffer.from 前用長度換算確認（不真的 decode，避免先吃記憶體）。
function validateReceiptPhotos(raw) {
  if (!Array.isArray(raw)) return { ok: true, photos: [] };   // 非陣列（誤傳）視為無照片，不報錯（與既有行為一致）
  const list = raw.filter((x) => typeof x === 'string' && x).slice(0, MAX_RECEIPT_PHOTOS);
  let totalDecoded = 0;
  for (const dataUrl of list) {
    // (1) 第一道便宜閘門：單張字串長度上限（超大字串直接擋，不進 regex）。
    if (dataUrl.length > MAX_RECEIPT_DATAURL_CHARS) {
      return { ok: false, status: 413, error: '收據照片過大，請重拍或減少張數後再送。' };
    }
    // (2) MIME 白名單＋擷出 base64 本體。
    const m = RECEIPT_DATAURL_PREFIX_RE.exec(dataUrl);
    if (!m) {
      return { ok: false, status: 400, error: '收據照片格式不支援（僅接受 JPG／PNG／WebP）。' };
    }
    // (3) 嚴格 base64 文法：長度須 4 對齊（擋 %4===1 等非法串），避免把垃圾餵給 Buffer.from。
    const b64 = m[2];
    if (!BASE64_STRICT_RE.test(b64)) {
      return { ok: false, status: 400, error: '收據照片內容不是有效的圖片資料，請重拍後再送。' };
    }
    // (4) decode 前先用長度換算解碼後位元組數，做單張／合計上限確認（避免先吃記憶體）。
    const decoded = base64DecodedBytes(b64);
    if (decoded > MAX_RECEIPT_DECODED_BYTES) {
      return { ok: false, status: 413, error: '收據照片過大，請重拍或減少張數後再送。' };
    }
    totalDecoded += decoded;
    if (totalDecoded > MAX_RECEIPT_TOTAL_DECODED_BYTES) {
      return { ok: false, status: 413, error: '收據照片總量過大，請減少張數或重拍後再送。' };
    }
  }
  return { ok: true, photos: list };
}

// 「目前餘額」顯示文字（與 webhook.js formatPettyCashBalanceText 同口徑與 fallback 文案）。
//   balance 為有限數字 → 「NT$X」（千分位、zh-TW）；null/undefined/非有限數字（查詢失敗）→ 「－（暫無法顯示）」。
// ⚠️ 文案需與 webhook.js／maruten-expense.html 三處一致（「目前餘額」「－（暫無法顯示）」）。
// 注意：Number(null)===0 且 Number.isFinite(0)===true，故先排除 null/undefined，否則查詢失敗會被誤顯示成 NT$ 0。
function formatPettyCashBalanceText(balance) {
  const available = balance !== null && balance !== undefined && Number.isFinite(Number(balance));
  return available ? `NT$ ${Number(balance).toLocaleString('zh-TW')}` : '－（暫無法顯示）';
}

// --- 純函數：組群組確認訊息文字（P1-1）---
// 比照打字版確認風格（webhook.js handleMarutenExpense 的「已記帳：…」），含主體／分類／項目／金額／記錄人／日期／照片張數／目前餘額。
// receiptFailed > 0 時附「部分照片上傳失敗 (N/M)」（P2-1）；sheetWarning 有值也帶進訊息，不靜默。
// balance：記帳後該主體零用金餘額（查詢失敗傳 null → 顯示「－（暫無法顯示）」，記帳已完成，不受影響）。
function buildExpenseConfirmText({ entity, category, note, amount, recorder, dateText, receiptCount, receiptFailed, sheetWarning, balance }) {
  const amountText = Number.isFinite(Number(amount)) ? Number(amount).toLocaleString() : String(amount);
  const total = (Number(receiptCount) || 0) + (Number(receiptFailed) || 0);
  let photoLine = `📎 收據照片：${Number(receiptCount) || 0} 張`;
  if (Number(receiptFailed) > 0) photoLine += `（部分上傳失敗 ${receiptFailed}/${total}，稍後可補）`;
  const balanceAvailable = balance !== null && balance !== undefined && Number.isFinite(Number(balance));
  let balanceLine = `💰 目前餘額：${formatPettyCashBalanceText(balance)}`;
  if (balanceAvailable && Number(balance) < 0) balanceLine += '（⚠️ 已超支）';
  const lines = [
    `✅ 已記帳（表單）：${entity}`,
    `・分類：${category}`,
    `・項目：${note}`,
    `・金額：NT$ ${amountText}`,
    `・記錄人：${recorder || '-'}`,
    `・日期：${dateText || ''}`,
    photoLine,
    balanceLine,
  ];
  if (sheetWarning) lines.push(`⚠️ ${sheetWarning}`);
  return lines.join('\n');
}

// --- 表單送出成功後 push 確認訊息回群組（P1-1）---
// 用 LINE Messaging API push 到 groupId（沿用 reminder.js pushMessage 模式；本端點無 replyToken，只能 push）。
// 缺 token／缺 groupId／push 失敗都不擋記帳（記帳已完成），回傳 false 讓 handler 附 warning，但不靜默。
async function pushExpenseConfirm(groupId, text) {
  if (!groupId || !LINE_CHANNEL_ACCESS_TOKEN) return false;
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('maruten_form_push_error', res.status, err);
      return false;
    }
    return true;
  } catch (e) {
    console.error('maruten_form_push_error', e?.message);
    return false;
  }
}

// --- 純函數：把表單欄位正規化＋驗證（抽出來方便單元測試，不碰 Google/Supabase）---
// 回傳 { ok:true, value:{ category, note, amount, memo, photos } } 或 { ok:false, error, status }。
// 規則：金額必須 > 0 的數字；分類必須在 EXPENSE_CATEGORIES 內；項目（note）必填；備註選填；
//      照片限 MAX_RECEIPT_PHOTOS 張（多的截掉），並做大小／格式驗證（P1-2）。後端自驗，不只信前端。
function validateExpenseForm(body) {
  const b = body || {};
  const category = String(b.分類 || b.category || '').trim();
  const note = String(b.項目 || b.note || '').trim();
  const memo = String(b.備註 || b.memo || '').trim();
  const amountRaw = b.金額 !== undefined ? b.金額 : b.amount;
  const amount = Number(String(amountRaw == null ? '' : amountRaw).replace(/[,，\s]/g, ''));

  if (!category) return { ok: false, error: '請選擇分類' };
  if (!EXPENSE_CATEGORIES.includes(category)) return { ok: false, error: `分類不在清單內：${EXPENSE_CATEGORIES.join('／')}` };
  if (!note) return { ok: false, error: '請填項目（買了什麼）' };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: '金額需為大於 0 的數字' };

  const photosRaw = b.收據照 || b.收據照片 || b.receiptPhotos || b.photos;
  const photoCheck = validateReceiptPhotos(photosRaw);
  if (!photoCheck.ok) return { ok: false, error: photoCheck.error, status: photoCheck.status };

  return { ok: true, value: { category, note, amount, memo, photos: photoCheck.photos } };
}

// --- 讀取 JSON body（相容 Vercel 已解析 / 原始串流，與 staff-report.js 同）---
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

  // 前端開啟表單時先 GET 拿 LIFF ID 與分類清單（避免 liff.state 包住網址參數讀不到）。
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, liffId: MARUTEN_EXPENSE_LIFF_ID, categories: EXPENSE_CATEGORIES });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!supabase) {
    res.status(503).json({ ok: false, error: '記帳服務尚未啟用（缺 Supabase 設定）' });
    return;
  }

  try {
    const body = await readJsonBody(req);

    // 1. 驗證欄位（金額 > 0、分類在清單、項目必填）＋照片大小／格式（P1-2，超限回 413／壞格式回 400）。
    const v = validateExpenseForm(body);
    if (!v.ok) { res.status(v.status || 400).json({ ok: false, error: v.error }); return; }
    const { category, note, amount, memo, photos } = v.value;

    // 2. 取主體：未設定群組 → 擋下不記＋回提示（沿用打字版 P0，嚴禁 fallback 丸十）。
    const groupId = String(body.groupId || '').trim();
    const entity = await getEntityForGroup(groupId);
    if (!entity) {
      // 附上當前 groupId，方便管理員拿去設定 group_entity_map（私訊／非群組來源無 groupId 時顯示「無群組ID」）。
      // 維持 P0：未設定仍不記帳，只是回應多帶 groupId（前端完成頁／錯誤可顯示出來）。
      const groupIdText = groupId || '無群組ID';
      res.status(400).json({
        ok: false,
        groupId,   // 原始值（無則空字串），前端可據此渲染／複製
        error: `⚠️ 本群組尚未設定支出主體，先不記帳。群組ID：${groupIdText}，請管理員設定後再試。`,
      });
      return;
    }

    // 記錄人：優先用 idToken 驗證出的名字（可信），否則用前端帶來的 userName。
    // P1-3：有設 channel ID 且 request 確實帶了 idToken 時，「驗證失敗」必須擋下（回 401），
    //       不可 fallback 用前端 userName（否則記錄人可偽造）。只有「未帶 token」才走規格允許的 optional skip。
    let recorder = String(body.userName || '').trim();
    let userId = '';
    const idToken = String(body.idToken || '').trim();
    if (idToken && MARUTEN_EXPENSE_LIFF_CHANNEL_ID) {
      const verified = await verifyLiffIdToken(idToken);
      if (!verified) {
        res.status(401).json({ ok: false, error: '身分驗證失敗，請重新從 LINE 開啟表單後再送出。' });
        return;
      }
      if (verified.name) recorder = verified.name;
      userId = verified.sub || '';
    }

    await resolveRefreshToken();

    // 3. 先存 Supabase（主體＝entity、強制 expense、帳別 business）。這步失敗才真的算記帳失敗。
    let savedExpense;
    try {
      savedExpense = await saveExpense({ amount, category, note, entity });
    } catch (e) {
      console.error('maruten_form_save_error', e?.message);
      res.status(500).json({ ok: false, error: `記帳失敗（${e?.message || '資料庫錯誤'}），請稍後再試。` });
      return;
    }

    // 4. 收據照上傳 Drive（失敗不擋記帳，連結留空即可）。回 { urls, failed }（P2-1：失敗張數要可見）。
    const sourceKey = ['maruten_expense', 'liff', groupId, userId].filter(Boolean).join(':') || 'maruten_expense:liff';
    let receiptUrls = [];
    let receiptFailed = 0;
    try {
      const up = await uploadReceiptList(photos, sourceKey);
      receiptUrls = up.urls;
      receiptFailed = up.failed;
    } catch (e) {
      console.error('maruten_form_receipt_error', e?.message);
    }

    const dateText = new Date().toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    // P2-1：有照片上傳失敗時，在 Sheet 備註欄附記「部分照片上傳失敗 (N/M)」，方便事後對帳補件。
    const receiptTotal = receiptUrls.length + receiptFailed;
    const memoForSheet = receiptFailed > 0
      ? `${memo ? memo + '｜' : ''}部分照片上傳失敗 (${receiptFailed}/${receiptTotal})`
      : memo;

    // 5. 寫進「丸十支出」Google Sheet（含收據照片連結）。失敗不影響已存的 Supabase，只在回應附 warning。
    let sheetWarning = '';
    try {
      const sheetRow = await marutenExpense.appendExpenseToSheet(supabase, {
        date: dateText,
        category,
        note,
        amount,
        recorder,
        memo: memoForSheet,           // 備註（表單填）＋部分照片失敗附記（P2-1）
        receiptPhotos: receiptUrls,   // 收據照片連結（多張，appendExpenseToSheet 會用換行串起）
        rawText: `#支出（表單）${note} ${amount}${memo ? '｜' + memo : ''}`,
        expenseId: savedExpense.id,
      });
      if (!sheetRow) {
        sheetWarning = '已記到資料庫，但無法確認支出表的列號（之後改分類／刪除會以記帳ID比對）。';
      } else {
        const rowSaved = await setExpenseSheetRow(savedExpense.id, sheetRow);
        if (!rowSaved) sheetWarning = '已記到資料庫並寫入支出表，但列號回寫失敗（之後改分類／刪除會以記帳ID比對）。';
      }
    } catch (e) {
      console.error('maruten_form_sheet_error', e?.message);
      sheetWarning = '已記到資料庫，但同步支出表失敗（稍後可補）。';
    }

    // 5.5 算記帳後該主體零用金餘額（顯示在群組確認卡片與完成頁）。
    //     graceful（最高原則，吸取上次 deleted 欄事件）：餘額查詢失敗 → balance=null，
    //     記帳已完成、完全不受影響，卡片／完成頁餘額顯示「－（暫無法顯示）」，絕不讓「算餘額」變成記帳失敗的新原因。
    let balance = null;
    try {
      const info = await getPettyCashBalance(entity);
      balance = info ? info.balance : null;
    } catch (e) {
      console.error('maruten_form_balance_error', e?.message);
      balance = null;
    }

    // 6. push 確認訊息回群組（P1-1：驗收要「送出 → 群組回確認」）。
    //    push 失敗不影響已完成的記帳，但要在回應附 warning（不靜默）。
    const confirmText = buildExpenseConfirmText({
      entity, category, note, amount, recorder, dateText,
      receiptCount: receiptUrls.length, receiptFailed, sheetWarning, balance,
    });
    const pushed = await pushExpenseConfirm(groupId, confirmText);
    let pushWarning = '';
    if (!pushed) {
      pushWarning = !LINE_CHANNEL_ACCESS_TOKEN
        ? '已完成記帳，但群組確認訊息未發送（未設定推播權杖）。'
        : '已完成記帳，但群組確認訊息發送失敗（稍後可於群組查詢）。';
    }

    res.status(200).json({
      ok: true,
      entity,
      category,
      note,
      amount,
      memo,
      recorder,
      dateText,
      receiptCount: receiptUrls.length,
      receiptFailedCount: receiptFailed,   // P2-1：部分照片上傳失敗張數（完成頁據此顯示）
      balance,                              // 記帳後零用金餘額（完成頁顯示；查詢失敗為 null → 顯示「－（暫無法顯示）」）
      pushed,                               // 群組確認是否已送達（debug／前端可選用）
      sheetWarning: [sheetWarning, pushWarning].filter(Boolean).join(' '),
    });
  } catch (e) {
    console.error('maruten_form_submit_error', e);
    const detail = e?.response?.data?.error_description
      || e?.response?.data?.error
      || e?.errors?.[0]?.message
      || e?.message
      || '寫入失敗';
    res.status(500).json({ ok: false, error: String(detail), code: e?.response?.data?.error || e?.code || '' });
  }
};

// 測試專用匯出：只暴露純函數供本地單元測試（不影響 handler 行為）。
// 比照 webhook.js / maruten-expense.js 的慣例；只在 NODE_ENV==='test' 時掛上，避免污染 production surface。
if (process.env.NODE_ENV === 'test') {
  module.exports.__test__ = {
    validateExpenseForm,
    validateReceiptPhotos,
    buildExpenseConfirmText,
    formatPettyCashBalanceText,
    getPettyCashBalance,
    pushExpenseConfirm,
    uploadReceiptList,
    base64DecodedBytes,
    EXPENSE_CATEGORIES,
    MAX_RECEIPT_PHOTOS,
    MAX_RECEIPT_DATAURL_CHARS,
    MAX_RECEIPT_DECODED_BYTES,
    MAX_RECEIPT_TOTAL_DECODED_BYTES,
    MARUTEN_EXPENSE_LIFF_ID,
  };
}
