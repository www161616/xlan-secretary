// 丸十支出機器人 v0.2 修正驗證 —— webhook.js 流程層測試（P0／P1-2／P1-3）。
//
// 對應審查報告：
//   P0   未設定主體的群組打 #支出 → 不記帳、回提示、不寫 DB
//   P1-2 刪除：丸十支出先標 Sheet 成功才刪 DB；標 Sheet 失敗則不刪 DB
//   P1-3 entity!=='丸十' → 改分類／刪除都不跑丸十 Sheet 同步（含舊私訊 entity=null）
//
// 跑法：node --test test/
// 透過 test/_stubs 注入「可觀測的假 supabase」與「可控的假 maruten-expense 模組」，再 require webhook.js。

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const stubs = require('./_stubs');

// ---- 可觀測假 supabase：用 table → rows 陣列；記錄 insert/delete 行為 ----
function makeObservableSupabase(seed = {}) {
  // seed.kv: { key: value }；seed.expenses: [ {id, ...} ]
  // seed.failBalanceSelect: true → getPettyCashBalance 的「帶 entity、無 id」select 一律回 error（模擬餘額查詢失敗，驗 graceful）。
  const kv = new Map(Object.entries(seed.kv || {}));
  let expenses = [...(seed.expenses || [])];
  const log = { inserts: [], deletes: [], updates: [] };

  function from(table) {
    const b = {
      _op: null, _row: null, _f: {}, _sel: '',
      insert(r) { this._op = 'insert'; this._row = r; return this; },
      upsert(r) { this._op = 'upsert'; this._row = r; return this; },
      update(r) { this._op = 'update'; this._row = r; return this; },
      delete() { this._op = 'delete'; return this; },
      select(cols) { if (!this._op) this._op = 'select'; this._sel = cols || ''; return this; },
      eq(c, v) { this._f[c] = v; return this; },
      order() { return this; }, limit() { return this; }, not() { return this; },
      async single() { return this._run(true); },
      then(res, rej) { return this._run(false).then(res, rej); },
      async _run(single) {
        if (table === 'xlan_kv') {
          const key = this._row?.key ?? this._f.key;
          if (this._op === 'select') {
            if (kv.has(key)) return { data: { value: kv.get(key) }, error: null };
            return single ? { data: null, error: { code: 'PGRST116' } } : { data: [], error: null };
          }
          if (this._op === 'upsert' || this._op === 'insert') { kv.set(this._row.key, this._row.value); return { data: [this._row], error: null }; }
          if (this._op === 'delete') { kv.delete(key); return { data: [], error: null }; }
        }
        if (table === 'xlan_expenses') {
          if (this._op === 'insert') {
            const row = { id: `exp-${log.inserts.length + 1}`, ...this._row };
            log.inserts.push(row); expenses.push(row);
            return { data: [row], error: null };
          }
          if (this._op === 'update') {
            log.updates.push({ filter: { ...this._f }, set: { ...this._row } });
            const hit = expenses.find((e) => e.id === this._f.id);
            if (hit) Object.assign(hit, this._row);
            return single ? { data: hit || null, error: null } : { data: hit ? [hit] : [], error: null };
          }
          if (this._op === 'delete') {
            log.deletes.push({ ...this._f });
            // seed.silentDeleteFail：模擬「DB delete 沒回 error，但其實沒刪掉」（P1-B 靜默未刪）。
            // 此時不從 expenses 移除（後置驗證 select 仍會查到），但仍回傳被刪列＋error:null。
            if (!seed.silentDeleteFail) {
              expenses = expenses.filter((e) => e.id !== this._f.id);
            }
            // 回傳被刪的列（webhook 會用 .select() 拿 deleted）
            const deletedRow = (seed.expenses || []).concat(log.inserts).find((e) => e.id === this._f.id);
            return { data: deletedRow ? [deletedRow] : [], error: null };
          }
          if (this._op === 'select') {
            // 欄位守門：select 到 xlan_expenses 已知欄位清單外的欄 → 比照真實 PostgREST 回 error
            // （與 petty-cash.test.js 同機制，防「select 不存在欄位」重演上次 deleted 欄事件）。
            const bad = stubs.unknownExpenseColumns(this._sel);
            if (bad.length) {
              const error = { message: `column xlan_expenses.${bad[0]} does not exist` };
              return single ? { data: null, error } : { data: null, error };
            }
            if (this._f.id !== undefined) {
              const hit = expenses.find((e) => e.id === this._f.id);
              if (single) return { data: hit || null, error: hit ? null : { code: 'PGRST116' } };
              return { data: hit ? [hit] : [], error: null };
            }
            // 餘額查詢（getPettyCashBalance）的特徵：帶 entity 過濾、無 id。可注入失敗驗 graceful。
            if (seed.failBalanceSelect && this._f.entity !== undefined) {
              const error = { message: 'balance query boom' };
              return single ? { data: null, error } : { data: null, error };
            }
            // 套用 entity 過濾（getPettyCashBalance 自身 JS 層也會再濾一次，這裡忠實模擬 DB .eq）。
            let out = expenses;
            if (this._f.entity !== undefined) out = out.filter((e) => e.entity === this._f.entity);
            return single ? { data: out[0] || null, error: null } : { data: out, error: null };
          }
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return b;
  }
  return { client: { from }, log, _expenses: () => expenses, _kv: kv };
}

// ---- 可控假 maruten-expense 模組 ----
function makeFakeMaruten(opts = {}) {
  const calls = { append: [], updateCategory: [], markDeleted: [], restoreDeleted: [] };
  return {
    calls,
    mod: {
      ensureSpreadsheetId: async () => 'sid',
      appendExpenseToSheet: async (sb, row) => { calls.append.push(row); return 2; },
      updateSheetCategory: async (sb, a) => { calls.updateCategory.push(a); return true; },
      markSheetDeleted: async (sb, a) => {
        calls.markDeleted.push(a);
        if (opts.markDeletedThrows) throw new Error('Google API 掛了');
        return opts.markDeletedReturns !== undefined ? opts.markDeletedReturns : true;
      },
      // 回滾用：webhook 的 rollbackMarutenSheetDelete 會呼叫這支把 Sheet 那列從「已刪除」還原。
      restoreSheetDeleted: async (sb, a) => {
        calls.restoreDeleted.push(a);
        if (opts.restoreThrows) throw new Error('還原 Sheet 也掛了');
        return opts.restoreReturns !== undefined ? opts.restoreReturns : true;
      },
    },
  };
}

// 每個 test 重新注入並重載 webhook.js，避免狀態互相污染。
function loadWebhook(supabaseClient, marutenMod) {
  stubs.install();
  stubs.setFakeSupabaseClient(supabaseClient);
  stubs.setFakeMarutenModule(marutenMod);
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  const p = require.resolve(path.join(__dirname, '..', 'api', 'webhook.js'));
  delete require.cache[p];
  return require(p).__test__;
}

// ========================== P0 ==========================
test('P0：未設定主體的群組打 #支出 → 完全靜默(null)、不寫 DB', async () => {
  const sb = makeObservableSupabase({ kv: {} }); // 無 group_entity_map
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-unknown', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:G-unknown');

  assert.equal(reply, null, '未設定主體 → 完全靜默 return null（呼叫端不回訊息、不 fall through 到閒聊）');
  assert.equal(sb.log.inserts.length, 0, '未設定主體不可寫 DB');
  assert.equal(fm.calls.append.length, 0, '未設定主體不可寫 Sheet');
});

test('P0（根因）：未設定主體 + 單獨 #支出（沒金額）→ 也完全靜默(null)、不冒開表單卡片', async () => {
  const sb = makeObservableSupabase({ kv: {} }); // 無 group_entity_map
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-need-setup', userId: 'U1' }, message: { type: 'text' } };
  // 單獨「支出」沒金額：未設定主體時也不可冒出開表單卡片連結（這正是上次在群組出包的根因）。
  const reply = await wh.handleMarutenExpense(event, '支出', 'focus:G-need-setup');

  assert.equal(reply, null, '未設定主體 → 靜默 null，絕不發開表單卡片');
  assert.equal(sb.log.inserts.length, 0, '仍維持 P0：未設定不寫 DB');
  assert.equal(fm.calls.append.length, 0, '仍維持 P0：未設定不寫 Sheet');
});

test('P0：未設定主體＋私訊（無 groupId）→ 也靜默(null)、不記帳', async () => {
  const sb = makeObservableSupabase({ kv: {} });
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  // 私訊來源沒有 groupId（event.source 只有 userId）→ getEntityForGroup 回 null → 靜默。
  const event = { source: { type: 'user', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:U1');

  assert.equal(reply, null, '無 groupId／未設定 → 靜默 null');
  assert.equal(sb.log.inserts.length, 0, '仍維持 P0：未設定不寫 DB');
});

test('P0：已設定主體（丸十）→ 正常記帳並寫 Sheet', async () => {
  const sb = makeObservableSupabase({ kv: { group_entity_map: JSON.stringify({ 'G-maruten': '丸十' }) } });
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:G-maruten');

  assert.equal(sb.log.inserts.length, 1, '應寫一筆 DB');
  assert.equal(sb.log.inserts[0].entity, '丸十');
  assert.equal(sb.log.inserts[0].amount, 120);
  assert.equal(fm.calls.append.length, 1, '應寫 Sheet');
  assert.match(reply[0].text, /已記帳：丸十/);
});

// ========================== P1-2 ==========================
test('P1-2：刪除丸十支出 → 先標 Sheet 成功才刪 DB（順序正確）', async () => {
  const seed = { expenses: [{ id: 'exp-x', entity: '丸十', category: '餐費', amount: 120, type: 'expense', account: 'business', sheet_row: 2 }] };
  const sb = makeObservableSupabase(seed);
  const fm = makeFakeMaruten({ markDeletedReturns: true });
  const wh = loadWebhook(sb.client, fm.mod);

  const msg = await wh.deleteExpense('exp-x');
  assert.equal(fm.calls.markDeleted.length, 1, '應先標 Sheet');
  assert.equal(sb.log.deletes.length, 1, '標 Sheet 成功後才刪 DB');
  assert.match(msg, /已刪除/);
});

test('P1-2：刪除丸十支出但標 Sheet 失敗 → 不刪 DB、回提示（避免月底多算）', async () => {
  const seed = { expenses: [{ id: 'exp-y', entity: '丸十', category: '餐費', amount: 120, type: 'expense', account: 'business', sheet_row: 2 }] };
  const sb = makeObservableSupabase(seed);
  const fm = makeFakeMaruten({ markDeletedReturns: false }); // 標記失敗
  const wh = loadWebhook(sb.client, fm.mod);

  const msg = await wh.deleteExpense('exp-y');
  assert.equal(fm.calls.markDeleted.length, 1);
  assert.equal(sb.log.deletes.length, 0, '標 Sheet 失敗就不可刪 DB');
  assert.match(msg, /暫不刪除|失敗/);
});

test('P1-2：標 Sheet 丟例外 → 視為失敗，不刪 DB', async () => {
  const seed = { expenses: [{ id: 'exp-z', entity: '丸十', category: '餐費', amount: 120, type: 'expense', account: 'business', sheet_row: 2 }] };
  const sb = makeObservableSupabase(seed);
  const fm = makeFakeMaruten({ markDeletedThrows: true });
  const wh = loadWebhook(sb.client, fm.mod);

  const msg = await wh.deleteExpense('exp-z');
  assert.equal(sb.log.deletes.length, 0, '例外也不可刪 DB');
  assert.match(msg, /暫不刪除|失敗/);
});

// ========================== P1-3 ==========================
test('P1-3：刪除非丸十（entity=null，舊私訊記帳）→ 不跑丸十 Sheet、照常刪 DB', async () => {
  const seed = { expenses: [{ id: 'exp-old', entity: null, category: '餐費', amount: 90, type: 'expense', account: 'personal' }] };
  const sb = makeObservableSupabase(seed);
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const msg = await wh.deleteExpense('exp-old');
  assert.equal(fm.calls.markDeleted.length, 0, '非丸十不可呼叫丸十 Sheet 標記');
  assert.equal(sb.log.deletes.length, 1, '非丸十照舊直接刪 DB（行為不變）');
  assert.match(msg, /已刪除/);
});

test('P1-3：改分類非丸十（entity=null）→ 不跑丸十 Sheet 同步', async () => {
  const sb = makeObservableSupabase();
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  await wh.syncMarutenSheetOnCategory({ id: 'e1', entity: null, category: '餐費', sheet_row: 2 });
  assert.equal(fm.calls.updateCategory.length, 0, 'entity=null 不可同步丸十 Sheet');
});

test('P1-3：改分類其他主體（央廚）→ 不跑丸十 Sheet 同步', async () => {
  const sb = makeObservableSupabase();
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  await wh.syncMarutenSheetOnCategory({ id: 'e2', entity: '央廚', category: '餐費', sheet_row: 2 });
  assert.equal(fm.calls.updateCategory.length, 0, '其他主體不可誤跑丸十 Sheet');
});

test('P1-3：改分類丸十 → 會同步丸十 Sheet', async () => {
  const sb = makeObservableSupabase();
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  await wh.syncMarutenSheetOnCategory({ id: 'e3', entity: '丸十', category: '運費', sheet_row: 5 });
  assert.equal(fm.calls.updateCategory.length, 1, '丸十應同步');
  assert.equal(fm.calls.updateCategory[0].category, '運費');
});

// ========================== P1-B ==========================
test('P1-B：丸十 DB 靜默未刪（delete 沒回 error 但資料還在）→ 觸發 Sheet 回滾', async () => {
  const seed = {
    expenses: [{ id: 'exp-s', entity: '丸十', category: '餐費', amount: 120, type: 'expense', account: 'business', sheet_row: 2 }],
    silentDeleteFail: true, // delete 回 error:null 但其實沒刪掉
  };
  const sb = makeObservableSupabase(seed);
  const fm = makeFakeMaruten({ markDeletedReturns: true, restoreReturns: true });
  const wh = loadWebhook(sb.client, fm.mod);

  const msg = await wh.deleteExpense('exp-s');
  assert.equal(fm.calls.markDeleted.length, 1, '先標 Sheet 已刪');
  assert.equal(sb.log.deletes.length, 1, '有嘗試刪 DB');
  assert.equal(fm.calls.restoreDeleted.length, 1, '靜默未刪也必須回滾 Sheet 標記（P1-B）');
  assert.match(msg, /還在/);
  assert.match(msg, /還原/, '應告知已把 Sheet 標記還原');
});

test('P1-B：丸十靜默未刪且 Sheet 回滾也失敗 → 明確要求人工處理', async () => {
  const seed = {
    expenses: [{ id: 'exp-s2', entity: '丸十', category: '餐費', amount: 120, type: 'expense', account: 'business', sheet_row: 2 }],
    silentDeleteFail: true,
  };
  const sb = makeObservableSupabase(seed);
  const fm = makeFakeMaruten({ markDeletedReturns: true, restoreReturns: false }); // 回滾失敗
  const wh = loadWebhook(sb.client, fm.mod);

  const msg = await wh.deleteExpense('exp-s2');
  assert.equal(fm.calls.restoreDeleted.length, 1, '有嘗試回滾');
  assert.match(msg, /無法自動還原|後台/, '回滾失敗應升為人工處理提示');
});

test('P1-B：非丸十靜默未刪 → 不跑 Sheet 回滾（行為不變）', async () => {
  const seed = {
    expenses: [{ id: 'exp-old', entity: null, category: '餐費', amount: 90, type: 'expense', account: 'personal' }],
    silentDeleteFail: true,
  };
  const sb = makeObservableSupabase(seed);
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const msg = await wh.deleteExpense('exp-old');
  assert.equal(fm.calls.restoreDeleted.length, 0, '非丸十不可呼叫 Sheet 回滾');
  assert.match(msg, /還在/);
});

// ========================== 切片二：#支出 卡片分流 ==========================
// getMarutenExpenseLiffId / buildMarutenExpenseLiffUrl 讀的是「模組載入時」抓的 MARUTEN_EXPENSE_LIFF_ID 常數，
// 故必須在 loadWebhook（delete cache + require）之前設好 env。每個案例自行設定，測後還原避免污染其他測試。
function withMarutenLiffEnv(value, fn) {
  const prev = process.env.MARUTEN_EXPENSE_LIFF_ID;
  if (value === undefined) delete process.env.MARUTEN_EXPENSE_LIFF_ID;
  else process.env.MARUTEN_EXPENSE_LIFF_ID = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MARUTEN_EXPENSE_LIFF_ID;
    else process.env.MARUTEN_EXPENSE_LIFF_ID = prev;
  }
}

test('切片二：單獨 #支出（無金額）＋ 有 LIFF ID → 回「開支出表單」卡片', async () => {
  await withMarutenLiffEnv('2009999999-RealLiff', async () => {
    const sb = makeObservableSupabase({ kv: { group_entity_map: JSON.stringify({ 'G-maruten': '丸十' }) } });
    const fm = makeFakeMaruten();
    const wh = loadWebhook(sb.client, fm.mod);

    const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
    const reply = await wh.handleMarutenExpense(event, '支出', 'focus:G-maruten');

    assert.ok(Array.isArray(reply));
    assert.equal(reply[0].type, 'flex', '應回 flex 卡片而非文字');
    // 卡片 footer 有「開支出表單」按鈕，uri 指向該 LIFF、帶 groupId。
    const btn = reply[0].contents.footer.contents[0];
    assert.equal(btn.action.type, 'uri');
    assert.match(btn.action.uri, /2009999999-RealLiff/);
    assert.match(btn.action.uri, /g=G-maruten/);
    assert.equal(sb.log.inserts.length, 0, '只開表單、尚未記帳，不可寫 DB');
    assert.equal(fm.calls.append.length, 0, '只開表單、不可寫 Sheet');
  });
});

test('切片二：單獨 #支出 ＋ 沒設 env（用寫死真 LIFF 後備）→ 發「開支出表單」卡片', async () => {
  // v0.2：MARUTEN_EXPENSE_LIFF_ID 已改為「真 LIFF 後備值」，故沒設 env 也算「有 LIFF」→ 發卡片（不必設 Vercel env）。
  // 「不發卡片」的保護改由下一條「env 仍是佔位值 → 回打字提示」驗證。
  await withMarutenLiffEnv(undefined, async () => {
    const sb = makeObservableSupabase({ kv: { group_entity_map: JSON.stringify({ 'G-maruten': '丸十' }) } });
    const fm = makeFakeMaruten();
    const wh = loadWebhook(sb.client, fm.mod);

    const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
    const reply = await wh.handleMarutenExpense(event, '支出', 'focus:G-maruten');

    assert.equal(reply[0].type, 'flex', '有真 LIFF 後備值 → 應發 flex 卡片');
    const btn = reply[0].contents.footer.contents[0];
    assert.equal(btn.action.type, 'uri');
    assert.match(btn.action.uri, /2009806013-sND5Erbq/, '卡片應指向真 LIFF 後備值');
    assert.equal(sb.log.inserts.length, 0, '只開表單、不可寫 DB');
  });
});

test('切片二：單獨 #支出 ＋ LIFF ID 還是佔位值 → 視同沒設，回打字提示', async () => {
  await withMarutenLiffEnv('0000000000-MarutenExp', async () => {
    const sb = makeObservableSupabase({ kv: { group_entity_map: JSON.stringify({ 'G-maruten': '丸十' }) } });
    const fm = makeFakeMaruten();
    const wh = loadWebhook(sb.client, fm.mod);

    const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
    const reply = await wh.handleMarutenExpense(event, '支出', 'focus:G-maruten');

    assert.notEqual(reply[0].type, 'flex', '佔位值不可發無效卡片');
    assert.match(reply[0].text, /記帳格式/);
  });
});

test('切片二：帶金額 #支出 便當 120 ＋ 有 LIFF ID → 仍走打字直接記（不發卡片）', async () => {
  await withMarutenLiffEnv('2009999999-RealLiff', async () => {
    const sb = makeObservableSupabase({ kv: { group_entity_map: JSON.stringify({ 'G-maruten': '丸十' }) } });
    const fm = makeFakeMaruten();
    const wh = loadWebhook(sb.client, fm.mod);

    const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
    const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:G-maruten');

    assert.equal(sb.log.inserts.length, 1, '帶金額應直接記帳（打字版並存）');
    assert.equal(fm.calls.append.length, 1, '帶金額應寫 Sheet');
    assert.match(reply[0].text, /已記帳：丸十/);
  });
});

test('切片二：isMarutenExpenseTrigger 對單獨「#支出」仍回 true（命中後才在 handler 分流）', () => {
  const sb = makeObservableSupabase();
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);
  assert.equal(wh.isMarutenExpenseTrigger('#支出'), true);
  assert.equal(wh.isMarutenExpenseTrigger('＃支出'), true);
  // 查詢句不被當記帳（回歸保護）。
  assert.equal(wh.isMarutenExpenseTrigger('#支出明細'), false);
});

// ========================== 支出顯示餘額（任務1／2／4）==========================
// 需求：每次花錢／開表單，當下就直接看到零用金還剩多少。
//   任務1 打字版記完卡片加「目前餘額」；任務2 開表單提醒卡片加「目前餘額」；
//   任務4 餘額查詢失敗 → 記帳／開表單照常成功，餘額顯示「－（暫無法顯示）」，絕不擋記帳（吸取上次 deleted 欄事件）。
const MARUTEN_KV = { group_entity_map: JSON.stringify({ 'G-maruten': '丸十' }) };

test('任務1：打字 #支出 便當 120 記完 → 確認卡片含「目前餘額」行且數字正確（補入10000−120=9880）', async () => {
  const sb = makeObservableSupabase({
    kv: MARUTEN_KV,
    expenses: [{ id: 'dep', entity: '丸十', type: 'deposit', amount: 10000 }], // 既有補入，餘額才可驗
  });
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:G-maruten');

  assert.equal(sb.log.inserts.length, 1, '應記一筆支出');
  // 文字訊息含目前餘額（含千分位）。
  assert.match(reply[0].text, /目前餘額 NT\$9,880/, '文字訊息應顯示本筆支出後的餘額 9,880');
  // 確認卡片含「目前餘額」行與正確金額。
  const flexStr = JSON.stringify(reply[1]);
  assert.match(flexStr, /目前餘額/, '卡片應有「目前餘額」行');
  assert.match(flexStr, /NT\$ 9,880/, '卡片餘額金額應為 9,880（千分位）');
  assert.doesNotMatch(flexStr, /暫無法顯示/, '查得到餘額時不應顯示 fallback');
});

test('任務2：單獨 #支出 開表單卡片 → 含「目前餘額」行（當前餘額 10000−120=9880）', async () => {
  await withMarutenLiffEnv('2009999999-RealLiff', async () => {
    const sb = makeObservableSupabase({
      kv: MARUTEN_KV,
      expenses: [
        { id: 'dep', entity: '丸十', type: 'deposit', amount: 10000 },
        { id: 'exp', entity: '丸十', type: 'expense', amount: 120 },
      ],
    });
    const fm = makeFakeMaruten();
    const wh = loadWebhook(sb.client, fm.mod);

    const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
    const reply = await wh.handleMarutenExpense(event, '支出', 'focus:G-maruten');

    assert.equal(reply[0].type, 'flex', '應回開表單 flex 卡片');
    const flexStr = JSON.stringify(reply[0]);
    assert.match(flexStr, /目前餘額/, '開表單卡片應有「目前餘額」行');
    assert.match(flexStr, /NT\$ 9,880/, '開表單卡片餘額應為當前 9,880');
    assert.equal(sb.log.inserts.length, 0, '只開表單、不可寫 DB');
  });
});

test('任務4 graceful：記帳後餘額查詢失敗 → 記帳照常成功、卡片顯示「－（暫無法顯示）」、文字不放假數字', async () => {
  const sb = makeObservableSupabase({
    kv: MARUTEN_KV,
    expenses: [{ id: 'dep', entity: '丸十', type: 'deposit', amount: 10000 }],
    failBalanceSelect: true, // 餘額查詢一律失敗
  });
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:G-maruten');

  // 記帳一定要成功（餘額查詢失敗不可擋記帳）。
  assert.equal(sb.log.inserts.length, 1, '餘額查詢失敗也必須記帳成功（graceful 最高原則）');
  assert.equal(fm.calls.append.length, 1, '仍寫 Sheet');
  assert.match(reply[0].text, /已記帳：丸十/, '仍回已記帳訊息');
  assert.doesNotMatch(reply[0].text, /目前餘額/, '餘額查不到時文字訊息不放餘額（不放假數字）');
  // 卡片餘額行退化成 fallback 文案，且不出現任何 NT$ 數字餘額。
  const flexStr = JSON.stringify(reply[1]);
  assert.match(flexStr, /－（暫無法顯示）/, '卡片餘額行應顯示 fallback「－（暫無法顯示）」');
});

test('任務4 graceful：開表單時餘額查詢失敗 → 仍發開表單卡片、餘額行顯示「－（暫無法顯示）」', async () => {
  await withMarutenLiffEnv('2009999999-RealLiff', async () => {
    const sb = makeObservableSupabase({
      kv: MARUTEN_KV,
      expenses: [{ id: 'dep', entity: '丸十', type: 'deposit', amount: 10000 }],
      failBalanceSelect: true,
    });
    const fm = makeFakeMaruten();
    const wh = loadWebhook(sb.client, fm.mod);

    const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
    const reply = await wh.handleMarutenExpense(event, '支出', 'focus:G-maruten');

    assert.equal(reply[0].type, 'flex', '餘額失敗也要照常發開表單卡片');
    const flexStr = JSON.stringify(reply[0]);
    assert.match(flexStr, /－（暫無法顯示）/, '開表單卡片餘額行應顯示 fallback');
    // 開表單按鈕仍在（功能不受影響）。
    assert.equal(reply[0].contents.footer.contents[0].action.type, 'uri');
  });
});

test('任務1：餘額為負（超支）→ 卡片標「⚠️ 已超支」、文字附「（⚠️ 已超支）」', async () => {
  // 既有補入 100、支出 50；本筆再記 #支出 200 → 餘額 100−50−200 = -150（超支）。
  const sb = makeObservableSupabase({
    kv: MARUTEN_KV,
    expenses: [
      { id: 'dep', entity: '丸十', type: 'deposit', amount: 100 },
      { id: 'e1', entity: '丸十', type: 'expense', amount: 50 },
    ],
  });
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 大採購 200', 'focus:G-maruten');

  assert.match(reply[0].text, /-150/, '文字餘額應為 -150');
  assert.match(reply[0].text, /已超支/, '負餘額文字應標已超支');
  const flexStr = JSON.stringify(reply[1]);
  assert.match(flexStr, /已超支/, '卡片應標已超支');
});
