// 丸十支出 LIFF 表單版 v0.2 修正驗證 —— maruten-expense-form.js 的 P1-1／P1-2／P1-3／P2-1。
//
// 對應審查報告（審查報告_丸十支出_LIFF表單-v0.1.md）：
//   P1-1 表單送出成功後要 push 確認訊息回群組（pushExpenseConfirm／buildExpenseConfirmText）
//   P1-2 照片 payload 大小／MIME／base64 驗證（validateReceiptPhotos：超限 413、壞格式 400）
//   P1-3 有 channel ID 且帶 idToken 時驗證失敗 → handler 回 401（不可 fallback userName）
//   P2-1 部分照片上傳失敗要可見（buildExpenseConfirmText 附「部分上傳失敗 N/M」、回應帶 receiptFailedCount）
//
// 跑法：node --test "test/*.test.js"
// 純函數直接測；P1-3 的 401 走 handler，注入假 supabase（_stubs）＋覆寫 global.fetch（攔 LINE verify／push）。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const stubs = require('./_stubs');
stubs.install();

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

// 取得 form.js 的純函數匯出（每次重載確保拿到最新模組常數）。
function loadForm() {
  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  return require(p);
}
const { __test__ } = loadForm();
const {
  validateReceiptPhotos, buildExpenseConfirmText, pushExpenseConfirm,
  uploadReceiptList, base64DecodedBytes,
  MAX_RECEIPT_DATAURL_CHARS, MAX_RECEIPT_DECODED_BYTES, MAX_RECEIPT_TOTAL_DECODED_BYTES,
} = __test__;

// 1px 合法 jpeg base64（夠短、格式正確），用來組各種 data URL。
const JPEG_1PX = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

// ========================== P1-2：照片大小／格式驗證 ==========================
test('P1-2：正常 jpeg data URL → 通過', () => {
  const r = validateReceiptPhotos([JPEG_1PX]);
  assert.equal(r.ok, true);
  assert.equal(r.photos.length, 1);
});

test('P1-2：png／webp 也放行', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const webp = 'data:image/webp;base64,UklGRiQAAABXRUJQ';
  const r = validateReceiptPhotos([png, webp]);
  assert.equal(r.ok, true);
  assert.equal(r.photos.length, 2);
});

test('P1-2：非影像 MIME（gif）→ 擋下回 400', () => {
  const r = validateReceiptPhotos(['data:image/gif;base64,R0lGODlh']);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('P1-2：偽裝成 data URL 但非 base64 內容 → 擋下回 400', () => {
  const r = validateReceiptPhotos(['data:image/jpeg;base64,@@@not-base64@@@']);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('P1-2：完全不是 data URL（純字串）→ 擋下回 400', () => {
  const r = validateReceiptPhotos(['hello world']);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('P1-2：base64 長度 %4===1（合法字元但長度非法）→ 擋下回 400（v0.3 嚴格對齊）', () => {
  // 'AAAAA' 全是合法 base64 字元，但長度 5（%4===1）解不出完整位元組，舊的寬鬆 regex 會誤放行。
  const bad = 'data:image/jpeg;base64,AAAAA';
  const r = validateReceiptPhotos([bad]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('P1-2：合法 base64（含 = 與 == 兩種 padding）→ 通過', () => {
  const pad1 = 'data:image/jpeg;base64,AAA=';   // 4 字元、單 padding（%4===3 + =）
  const pad2 = 'data:image/png;base64,AA==';    // 4 字元、雙 padding（%4===2 + ==）
  const noPad = 'data:image/webp;base64,AAAA';  // 4 字元、無 padding
  const r = validateReceiptPhotos([pad1, pad2, noPad]);
  assert.equal(r.ok, true);
  assert.equal(r.photos.length, 3);
});

test('P1-2：用長度換算擋超限解碼後 bytes（不需真的 decode）→ 回 413', () => {
  // 造一張「字串長度在上限內、但解碼後位元組數超過 MAX_RECEIPT_DECODED_BYTES」的合法 base64。
  // base64 解碼後約為長度的 3/4，故取「解碼上限 / 3 * 4 多一點」的 4 對齊長度即可超過解碼上限。
  let bodyLen = Math.ceil((MAX_RECEIPT_DECODED_BYTES + 16) * 4 / 3);
  bodyLen += (4 - (bodyLen % 4)) % 4;   // 補到 4 的倍數，符合嚴格 base64 文法
  const body = 'A'.repeat(bodyLen);
  // 確認此測試確實走「解碼後位元組」這條路，而非被字串長度上限先擋（兩者語意不同）。
  assert.ok(`data:image/jpeg;base64,${body}`.length <= MAX_RECEIPT_DATAURL_CHARS, '字串長度應在上限內，才驗得到解碼後上限');
  assert.ok(base64DecodedBytes(body) > MAX_RECEIPT_DECODED_BYTES, '解碼後位元組數應超過上限');
  const r = validateReceiptPhotos([`data:image/jpeg;base64,${body}`]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('P1-2：base64DecodedBytes 長度換算正確（對照 Buffer 實際解碼長度）', () => {
  // 純函數換算結果應與真的 Buffer.from(...).length 一致（驗「不需 decode 即可算出 bytes」的正確性）。
  for (const b64 of ['AAAA', 'AAA=', 'AA==', '/9j/4AAQSkZJRg==', 'iVBORw0KGgo=']) {
    assert.equal(base64DecodedBytes(b64), Buffer.from(b64, 'base64').length, `換算長度應等於實際解碼長度：${b64}`);
  }
  assert.equal(base64DecodedBytes(''), 0);
});

test('P1-2：單張超過上限 → 擋下回 413（memory bomb 防護）', () => {
  // 造一張「格式正確但超大」的 data URL：base64 內容用合法字元灌到超過單張上限。
  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_RECEIPT_DATAURL_CHARS + 10);
  const r = validateReceiptPhotos([huge]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('P1-2：多張大圖（合計超量）→ 擋下回 413（memory bomb 防護）', () => {
  // 4 張接近單張上限的合法圖，合計遠超記憶體安全水位，必須擋下回 413。
  // （單張上限與總上限相近，實務上哪個先觸發不重要，重點是大 payload 一律 413、不餵 Buffer.from。）
  const near = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_RECEIPT_DATAURL_CHARS);
  const r = validateReceiptPhotos([near, near, near, near]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('P1-2：合計解碼後位元組是受 MAX_RECEIPT_TOTAL_DECODED_BYTES 約束的（合計上限以解碼位元組為準，非字串長度）', () => {
  // 收尾說明：合計上限的語意主限＝「解碼後位元組」(MAX_RECEIPT_TOTAL_DECODED_BYTES)，
  // 不另設合計「字串長度」上限（在單張字串上限＋張數上限下，合計字串閘門永遠觸發不到、會是死碼，故移除）。
  // 此測試把「合計上限以解碼位元組計」這個設計約束釘住：常數存在且 = 單張解碼上限 × MAX_RECEIPT_PHOTOS。
  assert.equal(typeof MAX_RECEIPT_TOTAL_DECODED_BYTES, 'number');
  assert.equal(MAX_RECEIPT_TOTAL_DECODED_BYTES, MAX_RECEIPT_DECODED_BYTES * 4, '合計解碼上限＝單張解碼上限 ×4 張（與 MAX_RECEIPT_PHOTOS 一致）');
  // 連帶確認：已移除的合計字串常數不再對外匯出（避免死碼復活）。
  assert.equal(__test__.MAX_RECEIPT_TOTAL_CHARS, undefined, '合計字串上限常數應已移除、不再匯出');
});

test('P1-2：非陣列（誤傳字串）→ 視為無照片，不報錯', () => {
  const r = validateReceiptPhotos('not-an-array');
  assert.equal(r.ok, true);
  assert.equal(r.photos.length, 0);
});

test('P1-2：超過張數上限 → 先截到 4 張再驗（多的不報錯）', () => {
  const many = Array.from({ length: 7 }, () => JPEG_1PX);
  const r = validateReceiptPhotos(many);
  assert.equal(r.ok, true);
  assert.equal(r.photos.length, 4);
});

// ========================== P1-1：群組確認訊息文字 ==========================
test('P1-1：確認文字含主體／分類／項目／金額／記錄人／日期／照片張數', () => {
  const txt = buildExpenseConfirmText({
    entity: '丸十', category: '餐飲', note: '員工便當', amount: 1234,
    recorder: '小明', dateText: '2026/06/24 12:00', receiptCount: 2, receiptFailed: 0, sheetWarning: '',
  });
  assert.match(txt, /丸十/);
  assert.match(txt, /餐飲/);
  assert.match(txt, /員工便當/);
  assert.match(txt, /NT\$ 1,234/);   // 金額千分位
  assert.match(txt, /小明/);
  assert.match(txt, /2026\/06\/24 12:00/);
  assert.match(txt, /2 張/);
});

test('P2-1：有照片上傳失敗 → 確認文字附「部分上傳失敗 N/M」', () => {
  const txt = buildExpenseConfirmText({
    entity: '丸十', category: '雜支', note: '雜物', amount: 50,
    recorder: '小華', dateText: '2026/06/24', receiptCount: 2, receiptFailed: 2, sheetWarning: '',
  });
  assert.match(txt, /部分上傳失敗 2\/4/);   // 成功2 + 失敗2 = 共4
});

test('P1-1：sheetWarning 有值 → 帶進確認文字（不靜默）', () => {
  const txt = buildExpenseConfirmText({
    entity: '丸十', category: '運費', note: '宅配', amount: 80,
    recorder: '小明', dateText: '2026/06/24', receiptCount: 0, receiptFailed: 0,
    sheetWarning: '已記到資料庫，但同步支出表失敗（稍後可補）。',
  });
  assert.match(txt, /同步支出表失敗/);
});

// ========================== P1-1：push 行為 ==========================
test('P1-1：pushExpenseConfirm 會 push 到 groupId（fetch 帶正確 to／messages）', async () => {
  const prevToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const prevFetch = global.fetch;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
  // token 在 form.js 載入時就讀進常數，故覆寫 env 後要重載模組再取函數。
  const { __test__: t } = loadForm();
  const calls = [];
  global.fetch = async (url, opt) => {
    calls.push({ url, opt });
    return { ok: true, status: 200, async text() { return ''; } };
  };
  try {
    const ok = await t.pushExpenseConfirm('G-123', '確認訊息內容');
    assert.equal(ok, true);
    assert.equal(calls.length, 1, '應呼叫一次 LINE push API');
    assert.match(calls[0].url, /api\.line\.me\/v2\/bot\/message\/push/);
    const body = JSON.parse(calls[0].opt.body);
    assert.equal(body.to, 'G-123', 'push 目標應為 groupId');
    assert.equal(body.messages[0].text, '確認訊息內容');
    assert.match(calls[0].opt.headers.Authorization, /Bearer test-token/);
  } finally {
    global.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = prevToken;
  }
});

test('P1-1：缺 groupId → 不 push（回 false，不呼叫 fetch）', async () => {
  const prevFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, status: 200, async text() { return ''; } }; };
  try {
    const ok = await pushExpenseConfirm('', '內容');
    assert.equal(ok, false);
    assert.equal(called, false, '缺 groupId 不應呼叫 fetch');
  } finally {
    global.fetch = prevFetch;
  }
});

test('P1-1：push 失敗（LINE 回非 2xx）→ 回 false（讓 handler 附 warning）', async () => {
  const prevToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const prevFetch = global.fetch;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
  const { __test__: t } = loadForm();
  global.fetch = async () => ({ ok: false, status: 400, async text() { return 'bad'; } });
  try {
    const ok = await t.pushExpenseConfirm('G-123', '內容');
    assert.equal(ok, false);
  } finally {
    global.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = prevToken;
  }
});

// ========================== P2-1：uploadReceiptList 回 failed 計數 ==========================
test('P2-1：未設 Drive 資料夾 → 不上傳、failed=0（不算失敗）', async () => {
  const prev = process.env.MARUTEN_RECEIPT_FOLDER_ID;
  const prevStaff = process.env.STAFF_REPORT_IMAGE_FOLDER_ID;
  // form.js 對資料夾有寫死後備值，無法用 env 清成空字串；改驗「未設時 failed 維持 0」的回傳結構即可。
  // 這裡用既有匯出函數驗回傳形狀（urls/failed 兩欄都在），實際上傳路徑在真機測。
  const r = await uploadReceiptList([], 'k');
  assert.ok(Array.isArray(r.urls));
  assert.equal(typeof r.failed, 'number');
  assert.equal(r.failed, 0, '空清單不應有失敗');
  if (prev === undefined) delete process.env.MARUTEN_RECEIPT_FOLDER_ID; else process.env.MARUTEN_RECEIPT_FOLDER_ID = prev;
  if (prevStaff === undefined) delete process.env.STAFF_REPORT_IMAGE_FOLDER_ID; else process.env.STAFF_REPORT_IMAGE_FOLDER_ID = prevStaff;
});

// ========================== P1-3：idToken 驗證失敗 → handler 回 401 ==========================
// 極簡假 supabase：只支援 group_entity_map 的 select（回丸十）＋ xlan_expenses 的 insert。
function makeFakeSupabaseForHandler() {
  const inserts = [];
  return {
    inserts,
    client: {
      from(table) {
        return {
          _op: null, _f: {},
          select() { if (!this._op) this._op = 'select'; return this; },
          insert(r) { this._op = 'insert'; this._row = r; return this; },
          update() { this._op = 'update'; return this; },
          eq(c, v) { this._f[c] = v; return this; },
          async single() {
            if (table === 'xlan_kv' && this._f.key === 'group_entity_map') {
              return { data: { value: JSON.stringify({ 'G-1': '丸十' }) }, error: null };
            }
            return { data: null, error: null };
          },
          then(res) {
            if (table === 'xlan_expenses' && this._op === 'insert') {
              const row = { id: 'exp-1', ...this._row };
              inserts.push(row);
              return Promise.resolve({ data: [row], error: null }).then(res);
            }
            return Promise.resolve({ data: [], error: null }).then(res);
          },
        };
      },
    },
  };
}

// 假 maruten-expense 模組（_stubs 會把 form.js 的 require('./maruten-expense') 換成這個），避免真連 Google Sheets。
function makeFakeMarutenMod() {
  const calls = { append: [] };
  return {
    calls,
    mod: {
      ensureSpreadsheetId: async () => 'sid',
      appendExpenseToSheet: async (sb, row) => { calls.append.push(row); return 2; },
      updateSheetCategory: async () => true,
      markSheetDeleted: async () => true,
      restoreSheetDeleted: async () => true,
    },
  };
}

function makeRes() {
  return {
    statusCode: 0, body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

test('P1-3：有 channel ID 且帶 idToken，驗證失敗 → 回 401、不寫 DB', async () => {
  const prevChannel = process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID;
  const prevFetch = global.fetch;
  process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID = 'test-channel-id';

  const fakeSb = makeFakeSupabaseForHandler();
  stubs.setFakeSupabaseClient(fakeSb.client);
  const fakeMaruten = makeFakeMarutenMod();
  stubs.setFakeMarutenModule(fakeMaruten.mod);

  // verify 端點回非 ok（驗證失敗）；push 端點理論上不會被呼叫到。
  global.fetch = async (url) => {
    if (String(url).includes('/oauth2/v2.1/verify')) return { ok: false, status: 400, async json() { return {}; }, async text() { return ''; } };
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
  };

  // 重載 handler，讓它讀到剛設的 channel id 與 stub 的 supabase。
  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  const handler = require(p);

  const req = {
    method: 'POST',
    body: { 分類: '餐飲', 項目: '便當', 金額: 100, groupId: 'G-1', userName: '偽造者', idToken: 'bad-token' },
  };
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 401, 'idToken 驗證失敗應回 401');
    assert.equal(fakeSb.inserts.length, 0, '驗證失敗不可寫 DB（防偽造記錄人）');
  } finally {
    global.fetch = prevFetch;
    if (prevChannel === undefined) delete process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID;
    else process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID = prevChannel;
  }
});

test('P1-3：未帶 idToken（即使有 channel ID）→ 走 optional skip，不擋（用前端 userName）', async () => {
  const prevChannel = process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID;
  const prevFetch = global.fetch;
  process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID = 'test-channel-id';

  const fakeSb = makeFakeSupabaseForHandler();
  stubs.setFakeSupabaseClient(fakeSb.client);
  const fakeMaruten = makeFakeMarutenMod();
  stubs.setFakeMarutenModule(fakeMaruten.mod);

  // 沒帶 token → verify 不該被呼叫；push 會被呼叫（但無 token env → pushExpenseConfirm 自行 skip）。
  let verifyCalled = false;
  global.fetch = async (url) => {
    if (String(url).includes('/oauth2/v2.1/verify')) { verifyCalled = true; }
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
  };

  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  const handler = require(p);

  const req = {
    method: 'POST',
    body: { 分類: '餐飲', 項目: '便當', 金額: 100, groupId: 'G-1', userName: '阿明' }, // 無 idToken
  };
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200, '未帶 token 應照常記帳（optional skip）');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.recorder, '阿明', '未帶 token 時用前端 userName');
    assert.equal(verifyCalled, false, '沒帶 token 不應呼叫 verify');
    assert.equal(fakeSb.inserts.length, 1, '應寫一筆 DB');
  } finally {
    global.fetch = prevFetch;
    if (prevChannel === undefined) delete process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID;
    else process.env.MARUTEN_EXPENSE_LIFF_CHANNEL_ID = prevChannel;
  }
});

// ========================== 上線收尾：未設定主體提示附 groupId（表單版）==========================
// 維持 P0（未設定仍不記帳），但 400 回應要帶 groupId，方便管理員拿去設定 group_entity_map。
test('收尾：未設定主體的群組 → 回 400、錯誤含 groupId、回應帶 groupId 欄、不寫 DB', async () => {
  const prevFetch = global.fetch;
  const fakeSb = makeFakeSupabaseForHandler();   // 只認得 G-1=丸十，其餘群組查不到主體
  stubs.setFakeSupabaseClient(fakeSb.client);
  const fakeMaruten = makeFakeMarutenMod();
  stubs.setFakeMarutenModule(fakeMaruten.mod);
  global.fetch = async () => ({ ok: true, status: 200, async json() { return {}; }, async text() { return ''; } });

  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  const handler = require(p);

  const req = {
    method: 'POST',
    body: { 分類: '餐飲', 項目: '便當', 金額: 100, groupId: 'G-need-setup', userName: '阿明' },
  };
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 400, '未設定主體應回 400');
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /尚未設定支出主體/);
    assert.match(res.body.error, /G-need-setup/, '錯誤訊息應含 groupId 供複製設定');
    assert.equal(res.body.groupId, 'G-need-setup', '回應應帶 groupId 欄（前端可渲染／複製）');
    assert.equal(fakeSb.inserts.length, 0, '仍維持 P0：未設定不寫 DB');
    assert.equal(fakeMaruten.calls.append.length, 0, '仍維持 P0：未設定不寫 Sheet');
  } finally {
    global.fetch = prevFetch;
  }
});

test('收尾：未設定主體＋無 groupId（私訊／非群組）→ 回 400、錯誤顯示「無群組ID」、不寫 DB', async () => {
  const prevFetch = global.fetch;
  const fakeSb = makeFakeSupabaseForHandler();
  stubs.setFakeSupabaseClient(fakeSb.client);
  const fakeMaruten = makeFakeMarutenMod();
  stubs.setFakeMarutenModule(fakeMaruten.mod);
  global.fetch = async () => ({ ok: true, status: 200, async json() { return {}; }, async text() { return ''; } });

  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  const handler = require(p);

  const req = {
    method: 'POST',
    body: { 分類: '餐飲', 項目: '便當', 金額: 100, userName: '阿明' },   // 無 groupId
  };
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 400, '未設定主體應回 400');
    assert.match(res.body.error, /無群組ID/, '無 groupId 時錯誤應妥善顯示「無群組ID」');
    assert.equal(res.body.groupId, '', '無 groupId 時回應 groupId 欄為空字串');
    assert.equal(fakeSb.inserts.length, 0, '仍維持 P0：未設定不寫 DB');
  } finally {
    global.fetch = prevFetch;
  }
});
