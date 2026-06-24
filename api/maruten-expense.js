// 丸十支出記帳（#支出）的 Google Sheet 寫入與「群組 → 主體」對應。
//
// 設計目標（見 D:\丸十支出機器人\實作計畫_丸十支出機器人.md）：
//   1. 「丸十支出」是一份「程式化建立」的獨立 Google Sheet（不是掛在員工回報那份底下加分頁）。
//      它的 spreadsheetId 存進 Supabase xlan_kv（key: maruten_expense_sheet_id），
//      kv 沒有就自動建一張、有就用既有的——老闆零手動設定。
//   2. 每筆 #支出 都 append 一列（日期/分類/項目/金額/記錄人/原始訊息），並多存一欄記帳ID供日後同步。
//   3. 改分類 / 刪除最近一筆時，用記帳ID反查列號，更新或標記該列。
//
// 這個檔自成一塊、只被 webhook.js require，不反向 require webhook.js，避免 serverless 互相污染
// （與 staff-report.js 同樣的隔離原則）。Google client 的建法刻意比照 staff-report.js：
// refresh token「優先讀 xlan_kv.google_refresh_token、env 後備」，這樣老闆重新跑 /api/oauth 後不必改 env。

const { google } = require('googleapis');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// 丸十支出 Sheet 的設定（非機密，真正的鑰匙是 Google OAuth token）。
// kv 是唯一可信來源；下面這些 env / 常數只是後備或預設名稱。
const KV_SHEET_ID = 'maruten_expense_sheet_id';          // 存放已建立的 spreadsheetId
const KV_REFRESH_TOKEN = 'google_refresh_token';          // 與 staff-report.js 共用同一把 token
const MARUTEN_SHEET_TITLE = '支出明細';                    // 分頁名稱
const MARUTEN_SPREADSHEET_NAME = '丸十支出';               // 新建檔名
// 老闆若想用「既有的一份 Sheet」而非讓程式新建，可把 ID 設在這個 env（或直接寫進 kv）。env 優先於自動建立。
const MARUTEN_EXPENSE_SHEET_ID_ENV = (process.env.MARUTEN_EXPENSE_SHEET_ID || '').trim();

// 表頭（需求單欄位：日期 ｜ 分類 ｜ 項目 ｜ 金額 ｜ 記錄人 ｜ 備註 ｜ 收據照片 ｜ 原始訊息）。
// 末兩欄是同步用的隱藏欄位（記帳ID／狀態），方便日後改分類、刪除時定位該列。
// 切片二（LIFF 表單版）新增「備註」「收據照片」兩欄：表單可填備註、拍收據存證（連結寫進「收據照片」欄）。
// 打字版（#支出 便當 120）沒有備註／照片，這兩欄留空即可，兩版共用同一份表、同一套同步邏輯。
const MARUTEN_HEADER = ['日期', '分類', '項目', '金額', '記錄人', '備註', '收據照片', '原始訊息', '記帳ID', '狀態'];

// 欄位字母一律從表頭索引推導，避免「插欄後忘了同步改某個寫死的字母」的維護地雷（切片二就是這樣多插了兩欄）。
// colLetter(0)→'A'、colLetter(25)→'Z'、colLetter(26)→'AA'…（表頭目前只到第 10 欄 J，但仍支援雙字母以防再擴充）。
function colLetter(index) {
  let n = Number(index);
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
const HEADER_INDEX = MARUTEN_HEADER.reduce((m, name, i) => { m[name] = i; return m; }, {});
const COL_ID_INDEX = HEADER_INDEX['記帳ID'];                 // 「記帳ID」欄 0-based 索引（供測試與定位用）
const COL_CATEGORY = colLetter(HEADER_INDEX['分類']);        // 分類欄字母（改分類時更新此欄）
const COL_RECEIPT = colLetter(HEADER_INDEX['收據照片']);     // 收據照片欄字母（append 收據連結用）
const COL_ID = colLetter(COL_ID_INDEX);                       // 記帳ID 欄字母（findRowByExpenseId 掃此欄）
const COL_STATUS = colLetter(HEADER_INDEX['狀態']);          // 狀態欄字母（刪除標記寫此欄）
const SHEET_LAST_COL = colLetter(MARUTEN_HEADER.length - 1); // 表頭最後一欄字母（目前 10 欄 → J）

// --- refresh token：kv 優先、env 後備（每次寫入前解析，確保用到最新授權）---
let RESOLVED_REFRESH_TOKEN = GOOGLE_REFRESH_TOKEN;

async function resolveRefreshToken(supabase) {
  if (!supabase) return;
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', KV_REFRESH_TOKEN).single();
    if (data && data.value) RESOLVED_REFRESH_TOKEN = String(data.value).trim();
  } catch (e) {
    // 讀不到就維持 env 值
  }
}

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: RESOLVED_REFRESH_TOKEN });
  return oauth2Client;
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getOAuthClient() });
}

// --- 取得（必要時建立）丸十支出 spreadsheetId ---
async function getStoredSheetId(supabase) {
  if (!supabase) return '';
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', KV_SHEET_ID).single();
    return (data && data.value) ? String(data.value).trim() : '';
  } catch {
    return '';
  }
}

// 把 spreadsheetId 寫進 KV——insert-only（compare-and-set），絕不覆蓋既有值（P1-A 治本）。
// 鐵律：第一個寫入者贏。靠 KV_SHEET_ID 主鍵唯一性，insert 成功＝自己是首個寫入者，採用自己的 id；
// 撞 key（PK 衝突，code 23505）＝已有人先寫 → 不覆蓋，讀回既有 id 採用之（自己那張交由呼叫端當孤兒處理）。
// 與 acquireSheetLock 的樂觀鎖同模式，消除「check-then-act（stillOwnLock 後再 upsert）」的覆蓋窗口（TOCTOU）。
// 回傳「最終 KV 裡生效的 id」：可能是自己的（首寫成功）或既有的（別人先寫）；無 supabase（測試）時直接回傳自己的。
// 注意：只有 23505（PK 衝突）才走「讀回既有 id」分支；其他 error（暫時性 DB 故障等）一律 throw，
// 交由上層 handleMarutenExpense 既有 catch 回「同步稍後補」——避免把錯誤誤判成衝突、回傳沒寫進 KV 的孤兒 id（P2）。
async function storeSheetId(supabase, spreadsheetId) {
  const wanted = String(spreadsheetId || '').trim();
  if (!supabase || !wanted) return wanted;
  const { error } = await supabase.from('xlan_kv').insert({ key: KV_SHEET_ID, value: wanted });
  if (!error) return wanted;                       // 首個寫入者：採用自己的 id
  if (error.code !== '23505') {
    // 非 PK 衝突（暫時性 DB 故障等）：不可當成「別人先寫」處理，否則 existing 讀不回時會回傳 wanted，
    // 害呼叫端 append 到沒寫進 KV 的孤兒 Sheet。直接 throw，由上層容錯（DB 已存，附「同步稍後補」）。
    console.error('maruten_store_sheet_id_failed', wanted, error.code, error.message);
    throw new Error(`maruten_store_sheet_id_failed: ${error.code || ''} ${error.message || ''}`.trim());
  }
  // 確是 PK 衝突（已有人先寫）：讀回既有 id 採用之，不覆蓋。
  const existing = await getStoredSheetId(supabase);
  if (!existing) {
    // 撞 key 卻讀不回既有 id（極端：剛被刪、或讀取暫時失敗）。盲目回傳 wanted 會造成孤兒，
    // 故 throw 讓上層重試——下次重跑會重新走 ensure 流程，poll 到正確 id 或自行接管（P2）。
    console.error('maruten_store_sheet_id_conflict_no_existing', wanted);
    throw new Error('maruten_store_sheet_id_conflict_no_existing: 撞 key 但讀不回既有 id，改由上層重試');
  }
  return existing;
}

// 清掉壞掉的 Sheet ID（被刪／無權限／非試算表），讓下一次 ensure 重建。
async function clearStoredSheetId(supabase) {
  if (!supabase) return;
  try {
    await supabase.from('xlan_kv').delete().eq('key', KV_SHEET_ID);
  } catch {
    // 清不掉就算了，下一輪仍會走驗證流程
  }
}

const KV_SHEET_LOCK = 'maruten_expense_sheet_lock';   // 首次建立 Sheet 的並發鎖
// 鎖 TTL 縮到 20s（< 等待者輪詢上限），讓「持鎖者 crash」時等待者能在自己逾時前接管建表（P2-2）。
// 原 60s 過長：等待者只等 8s 就 timeout，crash 後這筆會只寫 DB、Sheet 漏同步。
const SHEET_LOCK_TTL_MS = 20 * 1000;                  // 鎖逾時：避免某次建立中途崩潰把鎖卡死
const SHEET_LOCK_WAIT_MS = 25 * 1000;                 // 等鎖持有者建好的最長輪詢時間（> TTL，確保能等到接管時機）
const SHEET_LOCK_POLL_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 產生本次請求專屬的鎖擁有者 token（owner），用來辨識「鎖是不是自己持有的」。
// 沒有 crypto.randomUUID（舊 runtime）就退回時間＋亂數，碰撞機率極低且只用於鎖辨識。
function newOwnerToken() {
  try {
    if (typeof require('crypto').randomUUID === 'function') return require('crypto').randomUUID();
  } catch {
    // ignore，走後備
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 把鎖值序列化成 { owner, locked_at }（字串存進 xlan_kv.value）。
function makeLockValue(owner) {
  return JSON.stringify({ owner, locked_at: new Date().toISOString() });
}

// 解析鎖值；舊格式（純 ISO 時間字串、無 owner）也容忍，回傳 { owner:'', locked_at }。
function parseLockValue(value) {
  if (!value) return null;
  try {
    const obj = JSON.parse(value);
    if (obj && typeof obj === 'object') {
      return { owner: String(obj.owner || ''), locked_at: obj.locked_at || '' };
    }
  } catch {
    // 非 JSON：當成舊版純時間字串
  }
  return { owner: '', locked_at: String(value) };
}

// 嘗試取得「建立 Sheet」的鎖：靠 xlan_kv 主鍵唯一性，insert 成功者才是持鎖者。
// 鎖值存 { owner, locked_at }；回傳 owner token（取得成功）或 ''（沒搶到，走等待路徑）。
// 已有未逾時的鎖 → 取鎖失敗（''）；逾時的舊鎖 → 視為廢棄，用樂觀鎖接管（成功才回 owner）。
async function acquireSheetLock(supabase) {
  if (!supabase) return newOwnerToken(); // 無 DB（測試）時不鎖，直接讓呼叫端建立
  const owner = newOwnerToken();
  // insert 不帶 upsert：key 已存在會回 error（PK 衝突），代表別人持鎖。
  const { error } = await supabase.from('xlan_kv').insert({ key: KV_SHEET_LOCK, value: makeLockValue(owner) });
  if (!error) return owner;

  // 已有鎖：檢查是否逾時，逾時就接管（用樂觀鎖把整個 value 換成自己的，避免兩個接管者同時搶）。
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', KV_SHEET_LOCK).single();
    const parsed = parseLockValue(data?.value);
    const lockedAt = parsed?.locked_at ? Date.parse(parsed.locked_at) : 0;
    if (lockedAt && Date.now() - lockedAt > SHEET_LOCK_TTL_MS) {
      const { data: taken } = await supabase
        .from('xlan_kv')
        .update({ value: makeLockValue(owner) })
        .eq('key', KV_SHEET_LOCK)
        .eq('value', data.value)   // 樂觀鎖：value 沒被別人換過才更新成功（含 owner，確保唯一接管者）
        .select();
      if (taken && taken.length > 0) return owner;
    }
  } catch {
    // 讀不到鎖狀態就當作沒搶到，走等待路徑
  }
  return '';
}

// 釋放鎖：只有「鎖的 owner == 自己」才刪，避免逾時被別人接管後誤殺別人的鎖（P1-A）。
// 先讀現值比對 owner，再用「value 完全相等」的條件刪除（樂觀鎖，防 read→delete 之間被換走）。
async function releaseSheetLock(supabase, owner) {
  if (!supabase || !owner) return;
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', KV_SHEET_LOCK).single();
    if (!data?.value) return;                       // 鎖已不在
    const parsed = parseLockValue(data.value);
    if (parsed.owner !== owner) return;             // 不是自己的鎖（已被接管），不可刪
    await supabase.from('xlan_kv').delete().eq('key', KV_SHEET_LOCK).eq('value', data.value);
  } catch {
    // 釋放失敗就靠 TTL 逾時回收
  }
}

// 在「既有的整份試算表」裡確保有「支出明細」分頁＋正確表頭。
// 用於 env 指定既有檔、以及「KV 命中後驗證該檔仍有效」兩種情況。
// 每次都驗證：分頁不存在就建、表頭（A1:H1）與 MARUTEN_HEADER 不符就補寫。
// 若 spreadsheetId 失效（被刪／無權限／非試算表），spreadsheets.get 會丟錯，由呼叫端決定是否清壞 KV。
async function ensureSheetTabWithHeader(spreadsheetId) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === MARUTEN_SHEET_TITLE);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: MARUTEN_SHEET_TITLE } } }] },
    });
  }
  // 不論分頁原本在不在，都讀一次 A1:H1 驗證表頭；不符（含空白、欄位錯、缺欄）就補寫正確表頭。
  // 避免「分頁存在但表頭空白／錯誤」時，第一筆 append 直接落到第 1 列、驗收欄位列不存在。
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${MARUTEN_SHEET_TITLE}!A1:${SHEET_LAST_COL}1`,
  });
  const currentHeader = (headerRes.data.values || [])[0] || [];
  const headerOk = MARUTEN_HEADER.every((h, i) => String(currentHeader[i] || '').trim() === h);
  if (!headerOk) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${MARUTEN_SHEET_TITLE}!A1:${SHEET_LAST_COL}1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [MARUTEN_HEADER] },
    });
  }
}

// 程式化建立一份全新的「丸十支出」試算表，第一個分頁即為「支出明細」並寫好表頭。
async function createSpreadsheet() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: MARUTEN_SPREADSHEET_NAME },
      sheets: [{ properties: { title: MARUTEN_SHEET_TITLE } }],
    },
  });
  const spreadsheetId = res.data.spreadsheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${MARUTEN_SHEET_TITLE}!A1:${SHEET_LAST_COL}1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [MARUTEN_HEADER] },
  });
  return spreadsheetId;
}

// 取得可用的 spreadsheetId：kv 有就用（但會驗證該檔仍有效）；env 指定既有檔就確保分頁並回傳；都沒有就新建一張並存 kv。
// 任一情況都保證「支出明細」分頁與表頭存在。
// 並發保護：首次建立用 acquireSheetLock 確保只有一個請求真的去建，其他請求等鎖持有者建好後讀 KV，避免建出孤兒 Sheet。
async function ensureSpreadsheetId(supabase) {
  await resolveRefreshToken(supabase);

  // KV 命中：不可盲信，先驗證該 Sheet 仍存在、分頁與表頭有效；壞掉就清 KV 往下重建。
  let id = await getStoredSheetId(supabase);
  if (id) {
    try {
      await ensureSheetTabWithHeader(id);
      return id;
    } catch (e) {
      console.error('maruten_kv_sheet_invalid', id, e?.message);
      await clearStoredSheetId(supabase);
      id = '';
    }
  }

  // env 指定既有檔：同樣驗證後採用（此路徑由老闆明確指定，不走自動建立鎖）。
  // storeSheetId 為 insert-only：正常會寫入 env id；若此刻 KV 已被別的並發請求寫入，
  // 則不覆蓋、改採既有值（鐵律：第一個寫入者贏，任何路徑都不覆蓋既有 sheetId）。
  if (MARUTEN_EXPENSE_SHEET_ID_ENV) {
    await ensureSheetTabWithHeader(MARUTEN_EXPENSE_SHEET_ID_ENV);
    return await storeSheetId(supabase, MARUTEN_EXPENSE_SHEET_ID_ENV);
  }

  // 都沒有 → 需新建。先搶鎖，確保並發下只建一張。
  // acquireSheetLock 回傳 owner token（拿到鎖）或 ''（沒搶到，走等待路徑）。
  let owner = await acquireSheetLock(supabase);
  if (!owner) {
    // 沒搶到鎖：別人正在建，輪詢等 KV 出現 id。輪詢上限 > 鎖 TTL，
    // 這樣若持鎖者 crash，等到鎖 TTL 逾時後本請求可自己接管建表，不會直接 timeout 丟錯（P2-2）。
    const deadline = Date.now() + SHEET_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(SHEET_LOCK_POLL_MS);
      const polled = await getStoredSheetId(supabase);
      if (polled) return polled;
      // KV 還沒出現 id：嘗試接管（acquireSheetLock 內含 TTL 判斷，逾時才會接管成功）。
      owner = await acquireSheetLock(supabase);
      if (owner) break;   // 接管成功 → 跳出去走下面的建立流程
    }
    if (!owner) {
      // 等到上限仍沒接管成功也沒看到 id：最後再讀一次，真的沒有就拋錯，由呼叫端容錯（不貿然再建以免孤兒）。
      const finalId = await getStoredSheetId(supabase);
      if (finalId) return finalId;
      throw new Error('maruten_sheet_init_timeout: 等待其他請求建立丸十支出表逾時');
    }
  }

  // 拿到鎖：建表前再 double-check KV（鎖到手前可能已被別人建好並存 KV）。
  try {
    const existing = await getStoredSheetId(supabase);
    if (existing) return existing;

    const created = await createSpreadsheet();

    // 建表後、寫 KV 前再確認一次（P1-A）：若這期間 KV 已被別人寫入 id，或鎖已被別人逾時接管，
    // 代表自己不該再宣告所有權 → 絕不可把自己建的 sheetId 寫進 KV（不能覆蓋接管者 B 的正確狀態）。
    const winnerId = await getStoredSheetId(supabase);
    if (winnerId) return winnerId;                 // 別人已先寫入：採用既有，自己這張成孤兒
    if (!(await stillOwnLock(supabase, owner))) {
      // 鎖已不是自己的（被接管）：再讀一次 KV，有就用接管者寫入的 id。
      const afterId = await getStoredSheetId(supabase);
      if (afterId) return afterId;
      // 鎖被接管、但 B 還沒把 id 寫進 KV：此時若寫入自己的 created 會覆蓋 B 即將寫入的正確狀態。
      // 鐵律：A 永遠不能覆蓋 B 已/將寫入 KV 的 sheetId → 不寫 KV，記下孤兒供清理，丟可重試錯誤讓上層重跑。
      // 上層（appendExpenseToSheet 的呼叫端）已 try/catch 容錯：DB 已存，僅附「同步稍後補」提示；
      // 下次重跑會 poll 到 B 寫入的 id 或自行接管，不會雙主、不會誤殺。
      console.error('maruten_orphan_spreadsheet', created, 'lock taken over before storeSheetId; not overwriting KV');
      throw new Error('maruten_sheet_lock_lost: 建表後鎖已被接管，避免覆蓋正確狀態，改由上層重試');
    }
    // 仍持鎖 → 寫 KV。storeSheetId 為 insert-only：即使在「上面 stillOwnLock 檢查通過」到「此處寫入」
    // 的窗口期 B 搶先寫了 KV，insert 也不會覆蓋，會回傳 B 已寫入的既有 id（治本 TOCTOU：第一個寫入者贏）。
    const effectiveId = await storeSheetId(supabase, created);
    if (effectiveId !== created) {
      // 窗口期 B 搶先寫入：自己這張沒進 KV，是孤兒；採用 B 的 id，不覆蓋、不雙主。
      console.error('maruten_orphan_spreadsheet', created, 'KV already had id at insert; adopting existing', effectiveId);
    }
    return effectiveId;
  } finally {
    await releaseSheetLock(supabase, owner);
  }
}

// 確認鎖目前仍由 owner 持有（owner 相符且未被換走）。用於建表後寫 KV 前的最終確認（P1-A）。
async function stillOwnLock(supabase, owner) {
  if (!supabase) return true;
  if (!owner) return false;
  try {
    const { data } = await supabase.from('xlan_kv').select('value').eq('key', KV_SHEET_LOCK).single();
    if (!data?.value) return false;
    return parseLockValue(data.value).owner === owner;
  } catch {
    return false;
  }
}

// --- 任務2：把一筆支出 append 進 Sheet ---
// row: { date, category, note, amount, recorder, memo, receiptPhotos, rawText, expenseId }
//   - memo：備註（表單可填；打字版沒有，留空）
//   - receiptPhotos：收據／發票照片連結，字串或字串陣列（表單拍照存證；打字版沒有，留空）
// 回傳寫入後該列的列號（1-based，含表頭）；失敗回傳 null（呼叫端負責容錯、不可中斷主流程）。
async function appendExpenseToSheet(supabase, row) {
  const spreadsheetId = await ensureSpreadsheetId(supabase);
  const sheets = getSheetsClient();
  // 收據照片可能是陣列（多張）或單一字串；多張用換行串起來，方便在 Sheet 儲存格內逐連結點開。
  const receiptCell = Array.isArray(row.receiptPhotos)
    ? row.receiptPhotos.filter(Boolean).join('\n')
    : String(row.receiptPhotos || '');
  // 欄序須與 MARUTEN_HEADER 完全一致：日期/分類/項目/金額/記錄人/備註/收據照片/原始訊息/記帳ID/狀態。
  const values = [[
    row.date || '',
    row.category || '',
    row.note || '',
    Number(row.amount) || 0,        // 金額寫成數字，方便 Sheet 加總
    row.recorder || '',
    row.memo || '',                 // 備註（表單填；打字版空）
    receiptCell,                    // 收據照片連結（表單拍照；打字版空）
    row.rawText || '',
    row.expenseId || '',
    '正常',
  ]];
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${MARUTEN_SHEET_TITLE}!A:${SHEET_LAST_COL}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  // updatedRange 形如「支出明細!A12:H12」→ 解析出列號 12，回傳給呼叫端寫回 xlan_expenses.sheet_row
  const updatedRange = res.data?.updates?.updatedRange || '';
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  return m ? Number(m[1]) : null;
}

// 刪除標記用的 B 欄分類前綴（markSheetDeleted 加註、restoreSheetDeleted 剝除，需一致）。
const DELETED_PREFIX = '(已刪除) ';

// 依「記帳ID」在 Sheet 裡找出對應列號（找不到回 0）。用於 sheet_row 沒存到時的後備定位。
async function findRowByExpenseId(supabase, expenseId) {
  if (!expenseId) return 0;
  const spreadsheetId = await getStoredSheetId(supabase);
  if (!spreadsheetId) return 0;
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${MARUTEN_SHEET_TITLE}!${COL_ID}:${COL_ID}`,   // 記帳ID 欄（字母由表頭索引推導）
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (String((rows[i] || [])[0] || '').trim() === String(expenseId).trim()) return i + 1;
  }
  return 0;
}

// 解析出要操作的列號：優先用 xlan_expenses 存的 sheet_row，沒有才掃 Sheet 找 ID。
async function resolveSheetRow(supabase, { sheetRow, expenseId }) {
  if (Number.isFinite(Number(sheetRow)) && Number(sheetRow) > 1) return Number(sheetRow);
  return findRowByExpenseId(supabase, expenseId);
}

// --- 任務6：改分類 → 更新該列的「分類」欄（B 欄）---
async function updateSheetCategory(supabase, { sheetRow, expenseId, category }) {
  await resolveRefreshToken(supabase);
  const spreadsheetId = await getStoredSheetId(supabase);
  if (!spreadsheetId) return false;
  const targetRow = await resolveSheetRow(supabase, { sheetRow, expenseId });
  if (!targetRow) return false;
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${MARUTEN_SHEET_TITLE}!${COL_CATEGORY}${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[category || '']] },
  });
  return true;
}

// --- 任務6：刪除 → 把該列標記為「已刪除」，保留原始資料供查核 ---
// 不真的移除整列（整列移除 vs 標記，產品取捨老闆未拍板；刪列要算 sheetId 做 batchUpdate.deleteDimension 也較易誤刪）。
// 為確保「已刪除列不被 Sheet 加總誤算」，採雙保險：
//   1) H 欄狀態寫「已刪除」（程式／公式可用 H 欄過濾）。
//   2) B 欄分類前加註「(已刪除) 」前綴（人工 SUMIF(分類) 或目視篩選也不會把它算進原分類）。
//   另外，月底彙總本來就以 Supabase 為準（deleteExpense 已先確認可標記再刪 DB），Sheet 僅作流水備查。
// 回傳 true=已標記成功；false=找不到列或缺 Sheet（呼叫端據此決定是否續刪 DB）。
async function markSheetDeleted(supabase, { sheetRow, expenseId }) {
  await resolveRefreshToken(supabase);
  const spreadsheetId = await getStoredSheetId(supabase);
  if (!spreadsheetId) return false;
  const targetRow = await resolveSheetRow(supabase, { sheetRow, expenseId });
  if (!targetRow) return false;
  const sheets = getSheetsClient();

  // 讀現有分類欄，加上「(已刪除) 」前綴（避免重複加註）。
  let category = '';
  try {
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${MARUTEN_SHEET_TITLE}!${COL_CATEGORY}${targetRow}`,
    });
    category = String(((cur.data.values || [])[0] || [])[0] || '');
  } catch {
    // 讀不到分類就只更新狀態欄，仍能達到「狀態=已刪除」的過濾效果
  }
  const markedCategory = category.startsWith(DELETED_PREFIX) ? category : `${DELETED_PREFIX}${category}`;

  // 一次更新「分類」（加註）與「狀態」欄。batchUpdate values 用 data 陣列分別指定兩個 range。
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${MARUTEN_SHEET_TITLE}!${COL_CATEGORY}${targetRow}`, values: [[markedCategory]] },
        { range: `${MARUTEN_SHEET_TITLE}!${COL_STATUS}${targetRow}`, values: [['已刪除']] },
      ],
    },
  });
  return true;
}

// 還原 markSheetDeleted 造成的標記：拿掉 B 欄「(已刪除) 」前綴、H 欄狀態改回「正常」。
// 用於「先標 Sheet 再刪 DB」流程中 DB 刪除失敗時的回滾（P1-B），確保兩邊一致、不留半標記。
// 回傳 true=還原成功；false=找不到列或缺 Sheet（呼叫端據此提示需人工確認）。
async function restoreSheetDeleted(supabase, { sheetRow, expenseId }) {
  await resolveRefreshToken(supabase);
  const spreadsheetId = await getStoredSheetId(supabase);
  if (!spreadsheetId) return false;
  const targetRow = await resolveSheetRow(supabase, { sheetRow, expenseId });
  if (!targetRow) return false;
  const sheets = getSheetsClient();

  // 讀現有分類欄，去掉前綴（可能多次標記殘留，迴圈剝乾淨）。
  let category = '';
  try {
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${MARUTEN_SHEET_TITLE}!${COL_CATEGORY}${targetRow}`,
    });
    category = String(((cur.data.values || [])[0] || [])[0] || '');
  } catch {
    // 讀不到分類就只還原狀態欄
  }
  while (category.startsWith(DELETED_PREFIX)) category = category.slice(DELETED_PREFIX.length);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${MARUTEN_SHEET_TITLE}!${COL_CATEGORY}${targetRow}`, values: [[category]] },
        { range: `${MARUTEN_SHEET_TITLE}!${COL_STATUS}${targetRow}`, values: [['正常']] },
      ],
    },
  });
  return true;
}

module.exports = {
  ensureSpreadsheetId,
  appendExpenseToSheet,
  updateSheetCategory,
  markSheetDeleted,
  restoreSheetDeleted,
  // 匯出供測試
  _internal: { MARUTEN_HEADER, MARUTEN_SHEET_TITLE, COL_ID_INDEX, SHEET_LAST_COL, COL_CATEGORY, COL_RECEIPT, COL_ID, COL_STATUS, colLetter },
};
