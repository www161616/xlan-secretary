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
  validateReceiptPhotos, buildExpenseConfirmText, buildFormExpenseFlex, pushExpenseConfirm,
  uploadReceiptList, base64DecodedBytes,
  MAX_RECEIPT_DATAURL_CHARS, MAX_RECEIPT_DECODED_BYTES, MAX_RECEIPT_TOTAL_DECODED_BYTES,
} = __test__;

// 1px 合法 jpeg base64（夠短、格式正確），用來組各種 data URL。
const JPEG_1PX = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

// --- flex 卡片測試輔助：把 bubble 裡所有 text node 的文字攤平成一個陣列，方便比對欄位／餘額是否在卡片上。---
function flexTexts(flexMessage) {
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
    if (node.contents) walk(node.contents);
    if (node.body) walk(node.body);
    if (node.footer) walk(node.footer);
  })(flexMessage.contents || flexMessage);
  return out;
}

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

// ========================== 群組確認改 flex 卡片（老闆指定：要卡片不要純文字）==========================
// 比照打字版 webhook.js buildMarutenExpenseFlex：群組確認＝flex 訊息，結構含
// 主體／分類／項目／金額／記錄人／日期／收據照片張數／目前餘額，altText 為既有摘要文字。
test('flex：群組確認＝flex 訊息（type:flex、bubble、altText 為摘要）', () => {
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '餐飲', note: '員工便當', amount: 1234,
    recorder: '小明', dateText: '2026/06/24 12:00', receiptCount: 2, receiptFailed: 0, balance: 9880,
  });
  assert.equal(card.type, 'flex', '群組確認應為 flex 訊息（非純文字）');
  assert.equal(card.contents.type, 'bubble', 'flex 內容應為 bubble');
  assert.match(card.altText, /員工便當/, 'altText 應為含項目的摘要文字（通知列／不支援 flex 時顯示）');
  assert.match(card.altText, /餐飲/, 'altText 摘要也應含分類');
});

// P1（審查報告 v0.1）：altText 不可無上限。長 note／sheetWarning 會讓 altText 超過 LINE 上限 → push 400 退件，
// 記帳成功但群組卡片送不出去。altText 必須是短摘要並截到安全長度（≤200），超長以「…」結尾，且不塞 sheetWarning。
const FLEX_ALTTEXT_LIMIT = 200;
test('P1：超長 note → altText 截到 ≤200 且以「…」結尾（不超 LINE 上限）', () => {
  const longNote = '超長備註'.repeat(125); // 4 字 ×125＝500 字，遠超上限
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '餐飲', note: longNote, amount: 1234,
    recorder: '小明', dateText: '2026/06/24 12:00', receiptCount: 0, receiptFailed: 0, balance: 9880,
  });
  assert.ok(card.altText.length <= FLEX_ALTTEXT_LIMIT, `altText 長度應 ≤ ${FLEX_ALTTEXT_LIMIT}，實際 ${card.altText.length}`);
  assert.ok(card.altText.endsWith('…'), 'altText 截斷後應以「…」結尾');
});

test('P1：超長 sheetWarning 不得撐爆 altText（altText 仍 ≤200，且不含警告全文）', () => {
  const longWarning = 'X'.repeat(800); // 模擬很長的同步錯誤訊息
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '餐飲', note: '便當', amount: 120,
    recorder: '小明', dateText: '2026/06/24 12:00', receiptCount: 0, receiptFailed: 0,
    sheetWarning: longWarning, balance: 9880,
  });
  assert.ok(card.altText.length <= FLEX_ALTTEXT_LIMIT, `altText 長度應 ≤ ${FLEX_ALTTEXT_LIMIT}，實際 ${card.altText.length}`);
  assert.ok(!card.altText.includes(longWarning), 'altText 不應夾帶可變長的 sheetWarning 全文');
});

test('P1：一般長度 note → altText 完整呈現、不被截（不加「…」）', () => {
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '餐飲', note: '員工便當', amount: 1234,
    recorder: '小明', dateText: '2026/06/24 12:00', receiptCount: 0, receiptFailed: 0, balance: 9880,
  });
  assert.ok(card.altText.length <= FLEX_ALTTEXT_LIMIT);
  assert.ok(!card.altText.endsWith('…'), '未超長時不應出現截斷符號');
  assert.match(card.altText, /員工便當/, '一般長度仍應含項目');
});

test('flex：卡片結構含主體/分類/項目/金額/記錄人/日期/收據張數/目前餘額', () => {
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '餐飲', note: '員工便當', amount: 1234,
    recorder: '小明', dateText: '2026/06/24 12:00', receiptCount: 2, receiptFailed: 0, balance: 9880,
  });
  const texts = flexTexts(card);
  const joined = texts.join('｜');
  // 標題（主體・支出）＋大字金額
  assert.ok(texts.includes('丸十・支出'), '應有「<主體>・支出」標題');
  assert.ok(texts.includes('NT$ 1,234'), '應有大字金額（千分位）');
  // 欄位標籤齊全
  for (const label of ['主體', '分類', '項目', '金額', '記錄人', '日期', '收據照片', '目前餘額']) {
    assert.ok(texts.includes(label), `卡片應含欄位「${label}」，實際：${joined}`);
  }
  // 欄位值
  assert.ok(texts.includes('餐飲'), '分類值');
  assert.ok(texts.includes('員工便當'), '項目值');
  assert.ok(texts.includes('小明'), '記錄人值');
  assert.ok(texts.includes('2026/06/24 12:00'), '日期值');
  assert.ok(texts.some((t) => /2 張/.test(t)), '收據照片張數（2 張）');
  assert.ok(texts.includes('NT$ 9,880'), '目前餘額值（千分位）');
});

test('flex：收據部分上傳失敗 → 收據列附「部分上傳失敗 N/M」（P2-1 可見）', () => {
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '雜支', note: '雜物', amount: 50,
    recorder: '小華', dateText: '2026/06/24', receiptCount: 2, receiptFailed: 2, balance: 100,
  });
  const joined = flexTexts(card).join('｜');
  assert.match(joined, /部分上傳失敗 2\/4/, '失敗張數要在卡片上看得到（成功2+失敗2=4）');
});

test('flex graceful：餘額查詢失敗（balance=null）→ 餘額列顯示「－（暫無法顯示）」、不放假數字、卡片照樣產出', () => {
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '餐飲', note: '便當', amount: 120,
    recorder: '小明', dateText: '2026/06/24', receiptCount: 0, receiptFailed: 0, balance: null,
  });
  assert.equal(card.type, 'flex', '餘額查詢失敗也照樣產出卡片（graceful，不擋）');
  const texts = flexTexts(card);
  assert.ok(texts.includes('－（暫無法顯示）'), '餘額列退化成 fallback 文案');
  assert.ok(!texts.some((t) => /目前餘額/.test(t) && /NT\$/.test(t)), '不可在餘額處放任何 NT$ 假數字');
  assert.ok(!texts.includes('⚠️ 已超支'), '查詢失敗不可誤標已超支');
});

test('flex：餘額為負 → 顯示「⚠️ 已超支」', () => {
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '雜支', note: '大採購', amount: 500,
    recorder: '小明', dateText: '2026/06/24', receiptCount: 0, receiptFailed: 0, balance: -150,
  });
  const texts = flexTexts(card);
  assert.ok(texts.includes('NT$ -150'), '負餘額顯示負值');
  assert.ok(texts.includes('⚠️ 已超支'), '負餘額標已超支');
});

test('flex：配色比照 webhook CARD_THEME（淡黃主題：page #FFFBEB、primaryDark #92400E）', () => {
  const card = buildFormExpenseFlex({
    entity: '丸十', category: '餐飲', note: '便當', amount: 120,
    recorder: '小明', dateText: '2026/06/24', receiptCount: 0, receiptFailed: 0, balance: 9880,
  });
  assert.equal(card.contents.body.backgroundColor, '#FFFBEB', 'body 底色應與打字版卡片一致');
  // 大字金額用 primaryDark（與 buildMarutenExpenseFlex 同色），確保視覺一致。
  const amountNode = card.contents.body.contents.find((c) => c.type === 'text' && c.size === 'xxl');
  assert.ok(amountNode, '應有大字金額節點');
  assert.equal(amountNode.color, '#92400E', '大字金額色應與打字版一致（primaryDark）');
});

// ========================== 任務3：表單版顯示餘額 ==========================
const { formatPettyCashBalanceText, getPettyCashBalance } = __test__;

test('任務3：確認文字含「目前餘額 NT$X」（千分位）', () => {
  const txt = buildExpenseConfirmText({
    entity: '丸十', category: '餐飲', note: '便當', amount: 120,
    recorder: '小明', dateText: '2026/06/24', receiptCount: 0, receiptFailed: 0, balance: 9880,
  });
  assert.match(txt, /目前餘額：NT\$ 9,880/, '確認文字應含目前餘額（千分位）');
});

test('任務3：餘額查詢失敗（balance=null）→ 確認文字顯示「－（暫無法顯示）」（不放假數字）', () => {
  const txt = buildExpenseConfirmText({
    entity: '丸十', category: '餐飲', note: '便當', amount: 120,
    recorder: '小明', dateText: '2026/06/24', receiptCount: 0, receiptFailed: 0, balance: null,
  });
  assert.match(txt, /目前餘額：－（暫無法顯示）/, '查不到餘額時用 fallback 文案');
  assert.doesNotMatch(txt, /目前餘額：NT\$/, '查不到時不可出現任何 NT$ 餘額數字');
});

test('任務3：餘額為負 → 確認文字標「（⚠️ 已超支）」', () => {
  const txt = buildExpenseConfirmText({
    entity: '丸十', category: '雜支', note: '大採購', amount: 500,
    recorder: '小明', dateText: '2026/06/24', receiptCount: 0, receiptFailed: 0, balance: -150,
  });
  assert.match(txt, /目前餘額：NT\$ -150/, '負餘額顯示負值');
  assert.match(txt, /已超支/, '負餘額標已超支');
});

test('任務3：formatPettyCashBalanceText 與 webhook 同口徑（數字千分位／null fallback）', () => {
  assert.equal(formatPettyCashBalanceText(9880), 'NT$ 9,880');
  assert.equal(formatPettyCashBalanceText(0), 'NT$ 0', '0 是有效餘額（不可當查詢失敗）');
  assert.equal(formatPettyCashBalanceText(null), '－（暫無法顯示）');
  assert.equal(formatPettyCashBalanceText(undefined), '－（暫無法顯示）');
  assert.equal(formatPettyCashBalanceText(NaN), '－（暫無法顯示）', '非有限數字視為查詢失敗');
});

// ---- 等價餘額查詢：與 webhook.js getPettyCashBalance 嚴格對齊（entity 過濾／type 加總／deleted 排除）----
// 可觀測假 supabase：忠實套用 .eq('entity')，並做欄位守門（與其他測試一致，防 select 不存在欄位）。
function makeFormBalanceSupabase(rows, opts = {}) {
  const expenses = [...rows];
  const knownColumns = opts.knownColumns || stubs.XLAN_EXPENSES_COLUMNS;
  function from(table) {
    const b = {
      _op: null, _f: {}, _sel: '',
      select(cols) { if (!this._op) this._op = 'select'; this._sel = cols || ''; return this; },
      eq(c, v) { this._f[c] = v; return this; },
      order() { return this; }, limit() { return this; }, not() { return this; },
      async single() { return this._run(true); },
      then(res, rej) { return this._run(false).then(res, rej); },
      async _run(single) {
        if (table === 'xlan_expenses' && this._op === 'select') {
          const bad = stubs.parseSelectColumns(this._sel).filter((c) => !knownColumns.includes(c));
          if (bad.length) {
            const error = { message: `column xlan_expenses.${bad[0]} does not exist` };
            return single ? { data: null, error } : { data: null, error };
          }
          let out = expenses;
          if (this._f.entity !== undefined) out = out.filter((e) => e.entity === this._f.entity);
          return single ? { data: out[0] || null, error: null } : { data: out, error: null };
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return b;
  }
  return { client: { from } };
}

// 用注入的假 supabase 重載 form.js，取其 __test__（form.js 頂層 createClient 會吃 stub）。
function loadFormWithSupabase(supabaseClient) {
  stubs.install();
  stubs.setFakeSupabaseClient(supabaseClient);
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  return require(p).__test__;
}

test('任務3 等價：form 的 getPettyCashBalance 補入10000−支出120=9880（限丸十）', async () => {
  const sb = makeFormBalanceSupabase([
    { id: 'a', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: 'b', entity: '丸十', type: 'expense', amount: 120 },
  ]);
  const t = loadFormWithSupabase(sb.client);
  const r = await t.getPettyCashBalance('丸十');
  assert.equal(r.deposit, 10000);
  assert.equal(r.expense, 120);
  assert.equal(r.balance, 9880);
});

test('任務3 等價：不混 entity=null／別主體（與 webhook 同隔離）', async () => {
  const sb = makeFormBalanceSupabase([
    { id: 'a', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: 'b', entity: null, type: 'expense', amount: 999 },   // 私訊，不算
    { id: 'c', entity: '央廚', type: 'deposit', amount: 50000 }, // 別主體，不算
  ]);
  const t = loadFormWithSupabase(sb.client);
  const r = await t.getPettyCashBalance('丸十');
  assert.equal(r.deposit, 10000, '不可吃到別 entity 的 deposit');
  assert.equal(r.expense, 0, '不可吃到 entity=null 的 expense');
  assert.equal(r.balance, 10000);
});

test('任務3 等價：deleted=true 不算、income 不算（與 webhook 同口徑）', async () => {
  const sb = makeFormBalanceSupabase([
    { id: '1', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: '2', entity: '丸十', type: 'expense', amount: 120 },
    { id: '3', entity: '丸十', type: 'expense', amount: 9999, deleted: true }, // 已刪，不算
    { id: '4', entity: '丸十', type: 'income', amount: 7777 },                  // 非池子，不算
  ]);
  const t = loadFormWithSupabase(sb.client);
  const r = await t.getPettyCashBalance('丸十');
  assert.equal(r.expense, 120, '已刪 9999 不算');
  assert.equal(r.balance, 9880);
});

test('任務3 守門：form 的 getPettyCashBalance 也用真實欄位（DB 缺 deleted → 拋錯，與 webhook 同防護）', async () => {
  const columnsWithoutDeleted = stubs.XLAN_EXPENSES_COLUMNS.filter((c) => c !== 'deleted');
  const sb = makeFormBalanceSupabase(
    [{ id: '1', entity: '丸十', type: 'deposit', amount: 10000 }],
    { knownColumns: columnsWithoutDeleted },
  );
  const t = loadFormWithSupabase(sb.client);
  await assert.rejects(
    () => t.getPettyCashBalance('丸十'),
    /column xlan_expenses\.deleted does not exist/,
    'form 端 select 不存在欄位時也要拋錯（守住兩處邏輯一致）',
  );
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
  // 現在 push 的是完整 flex 訊息物件（非純文字），驗證它被原封不動放進 messages[0]。
  const flexMsg = { type: 'flex', altText: '確認摘要', contents: { type: 'bubble' } };
  try {
    const ok = await t.pushExpenseConfirm('G-123', flexMsg);
    assert.equal(ok, true);
    assert.equal(calls.length, 1, '應呼叫一次 LINE push API');
    assert.match(calls[0].url, /api\.line\.me\/v2\/bot\/message\/push/);
    const body = JSON.parse(calls[0].opt.body);
    assert.equal(body.to, 'G-123', 'push 目標應為 groupId');
    assert.equal(body.messages[0].type, 'flex', 'push 的應是 flex 訊息（非純文字）');
    assert.equal(body.messages[0].altText, '確認摘要', 'altText 應原樣帶上');
    assert.deepEqual(body.messages[0], flexMsg, '應把完整 flex 訊息物件放進 messages[0]');
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
    const ok = await pushExpenseConfirm('', { type: 'flex', altText: '內容', contents: { type: 'bubble' } });
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
    const ok = await t.pushExpenseConfirm('G-123', { type: 'flex', altText: '內容', contents: { type: 'bubble' } });
    assert.equal(ok, false);
  } finally {
    global.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = prevToken;
  }
});

// 覆蓋缺口（審查報告 F-WARN）：先前只測 fetch 回非 2xx，未測 fetch 直接 throw（網路層拋例外）。
// pushExpenseConfirm 的 try/catch 必須吞掉例外回 false（不可讓例外往上炸，否則會把已完成的記帳搞成 500）。
test('P1-1：push 時 fetch 拋例外 → 吞掉回 false（不外拋）', async () => {
  const prevToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const prevFetch = global.fetch;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
  const { __test__: t } = loadForm();
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const ok = await t.pushExpenseConfirm('G-123', { type: 'flex', altText: '內容', contents: { type: 'bubble' } });
    assert.equal(ok, false, 'fetch throw 應被吞掉並回 false');
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

// ========================== 任務3：handler 串接餘額（回應帶 balance／群組文字含餘額／graceful）==========================
// handler 用的假 supabase：支援 kv（G-1=丸十）、xlan_expenses insert、xlan_expenses 餘額 select（帶 entity）。
// seed.expenses 放既有列讓餘額可驗；seed.failBalanceSelect 讓餘額 select 失敗以驗 graceful（記帳仍成功）。
function makeHandlerBalanceSupabase(seed = {}) {
  const inserts = [];
  const expenses = [...(seed.expenses || [])];
  function from(table) {
    return {
      _op: null, _f: {}, _sel: '',
      select(cols) { if (!this._op) this._op = 'select'; this._sel = cols || ''; return this; },
      insert(r) { this._op = 'insert'; this._row = r; return this; },
      update() { this._op = 'update'; return this; },
      eq(c, v) { this._f[c] = v; return this; },
      not() { return this; }, order() { return this; }, limit() { return this; },
      async single() {
        if (table === 'xlan_kv' && this._f.key === 'group_entity_map') {
          return { data: { value: JSON.stringify({ 'G-1': '丸十' }) }, error: null };
        }
        return { data: null, error: null };
      },
      then(res) {
        if (table === 'xlan_expenses' && this._op === 'insert') {
          const row = { id: `exp-${inserts.length + 1}`, ...this._row };
          inserts.push(row); expenses.push(row);
          return Promise.resolve({ data: [row], error: null }).then(res);
        }
        if (table === 'xlan_expenses' && this._op === 'select') {
          // 欄位守門（同其他測試）：select 不存在欄位 → 回 error。
          const bad = stubs.unknownExpenseColumns(this._sel);
          if (bad.length) return Promise.resolve({ data: null, error: { message: `column xlan_expenses.${bad[0]} does not exist` } }).then(res);
          // 餘額查詢（帶 entity）：可注入失敗驗 graceful。
          if (seed.failBalanceSelect && this._f.entity !== undefined) {
            return Promise.resolve({ data: null, error: { message: 'balance query boom' } }).then(res);
          }
          let out = expenses;
          if (this._f.entity !== undefined) out = out.filter((e) => e.entity === this._f.entity);
          return Promise.resolve({ data: out, error: null }).then(res);
        }
        return Promise.resolve({ data: [], error: null }).then(res);
      },
    };
  }
  return { inserts, client: { from } };
}

test('任務3 handler：POST 成功 → 回應帶 balance、群組確認＝flex 卡片且含主體/項目/金額/目前餘額', async () => {
  const prevToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const prevFetch = global.fetch;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';   // 設了 token 才會 push（才驗得到群組卡片）

  const sb = makeHandlerBalanceSupabase({
    expenses: [{ id: 'dep', entity: '丸十', type: 'deposit', amount: 10000 }], // 既有補入，記帳後餘額=10000-120=9880
  });
  stubs.setFakeSupabaseClient(sb.client);
  const fakeMaruten = makeFakeMarutenMod();
  stubs.setFakeMarutenModule(fakeMaruten.mod);

  // 攔 push：抓送到群組的整則訊息（現為 flex 卡片），驗它是 flex 且卡片上有餘額等欄位。
  let pushedMsg = null;
  global.fetch = async (url, init) => {
    if (String(url).includes('/v2/bot/message/push')) {
      try { pushedMsg = JSON.parse(init.body).messages[0]; } catch {}
      return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
    }
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
  };

  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  const handler = require(p);

  const req = { method: 'POST', body: { 分類: '餐飲', 項目: '便當', 金額: 120, groupId: 'G-1', userName: '阿明' } };
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(sb.inserts.length, 1, '應記一筆支出');
    assert.equal(res.body.balance, 9880, '回應 balance 應為記帳後餘額 9,880（前端完成頁用）');
    // 群組確認改推 flex 卡片（老闆指定）：驗 type=flex、卡片含主體/項目/金額/目前餘額。
    assert.ok(pushedMsg, '應有 push 訊息');
    assert.equal(pushedMsg.type, 'flex', '群組確認應推 flex 卡片（非純文字）');
    const texts = flexTexts(pushedMsg);
    assert.ok(texts.includes('丸十・支出'), '卡片應有「丸十・支出」標題');
    assert.ok(texts.includes('便當'), '卡片應含項目');
    assert.ok(texts.includes('NT$ 120'), '卡片應含金額');
    assert.ok(texts.includes('目前餘額') && texts.includes('NT$ 9,880'), '卡片應含目前餘額（千分位）');
  } finally {
    global.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN; else process.env.LINE_CHANNEL_ACCESS_TOKEN = prevToken;
  }
});

test('任務3 handler graceful：餘額查詢失敗 → 仍記帳成功、回應 balance=null、群組仍推 flex 卡片（餘額 fallback）、不擋（200）', async () => {
  const prevToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const prevFetch = global.fetch;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';

  const sb = makeHandlerBalanceSupabase({
    expenses: [{ id: 'dep', entity: '丸十', type: 'deposit', amount: 10000 }],
    failBalanceSelect: true, // 餘額查詢一律失敗
  });
  stubs.setFakeSupabaseClient(sb.client);
  const fakeMaruten = makeFakeMarutenMod();
  stubs.setFakeMarutenModule(fakeMaruten.mod);

  let pushedMsg = null;
  global.fetch = async (url, init) => {
    if (String(url).includes('/v2/bot/message/push')) {
      try { pushedMsg = JSON.parse(init.body).messages[0]; } catch {}
      return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
    }
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
  };

  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  const handler = require(p);

  const req = { method: 'POST', body: { 分類: '餐飲', 項目: '便當', 金額: 120, groupId: 'G-1', userName: '阿明' } };
  const res = makeRes();
  try {
    await handler(req, res);
    // 記帳一定要成功，餘額查詢失敗絕不可擋（graceful 最高原則）。
    assert.equal(res.statusCode, 200, '餘額查詢失敗也必須回 200（記帳已成功）');
    assert.equal(res.body.ok, true);
    assert.equal(sb.inserts.length, 1, '記帳必須成功寫入');
    assert.equal(res.body.balance, null, '查不到餘額 → 回應 balance=null（前端顯示 fallback，不放假數字）');
    // graceful：餘額失敗也照樣推 flex 卡片，餘額列退化成 fallback、不放假數字。
    assert.ok(pushedMsg, '餘額查詢失敗也必須照樣 push（不可因此不送）');
    assert.equal(pushedMsg.type, 'flex', '仍推 flex 卡片');
    const texts = flexTexts(pushedMsg);
    assert.ok(texts.includes('－（暫無法顯示）'), '卡片餘額列應退化成 fallback');
    assert.ok(!texts.some((t) => /目前餘額/.test(t) && /NT\$/.test(t)), '查詢失敗時卡片不可出現 NT$ 假餘額');
  } finally {
    global.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN; else process.env.LINE_CHANNEL_ACCESS_TOKEN = prevToken;
  }
});

// 覆蓋缺口（審查報告 F-WARN）：push 的 fetch 直接拋例外（網路層 throw，非單純非 2xx）時，
// handler 必須 graceful：記帳已完成 → 仍回 200、ok=true、pushed=false，並在 sheetWarning 附「發送失敗」提示，不靜默也不擋。
test('handler graceful：push 時 fetch 拋例外 → 仍記帳成功、回 200、pushed=false＋warning（不擋）', async () => {
  const prevToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const prevFetch = global.fetch;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';

  const sb = makeHandlerBalanceSupabase({
    expenses: [{ id: 'dep', entity: '丸十', type: 'deposit', amount: 10000 }],
  });
  stubs.setFakeSupabaseClient(sb.client);
  const fakeMaruten = makeFakeMarutenMod();
  stubs.setFakeMarutenModule(fakeMaruten.mod);

  // push 分支直接 throw（模擬網路層例外）；其餘 fetch（如有）正常回 200。
  let pushAttempted = false;
  global.fetch = async (url) => {
    if (String(url).includes('/v2/bot/message/push')) {
      pushAttempted = true;
      throw new Error('network down');
    }
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
  };

  const p = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
  delete require.cache[p];
  const handler = require(p);

  const req = { method: 'POST', body: { 分類: '餐飲', 項目: '便當', 金額: 120, groupId: 'G-1', userName: '阿明' } };
  const res = makeRes();
  try {
    await handler(req, res);
    // push 例外絕不可炸掉已完成的記帳：必須回 200、ok=true、照樣寫入。
    assert.equal(res.statusCode, 200, 'push fetch throw 也必須回 200（記帳已成功）');
    assert.equal(res.body.ok, true);
    assert.equal(sb.inserts.length, 1, '記帳必須成功寫入（push 失敗不擋）');
    assert.equal(pushAttempted, true, '應有嘗試 push');
    assert.equal(res.body.pushed, false, 'push 拋例外 → pushed=false');
    assert.match(res.body.sheetWarning, /發送失敗/, 'sheetWarning 應附群組確認發送失敗提示（不靜默）');
  } finally {
    global.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN; else process.env.LINE_CHANNEL_ACCESS_TOKEN = prevToken;
  }
});
