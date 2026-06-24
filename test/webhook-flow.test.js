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
  const kv = new Map(Object.entries(seed.kv || {}));
  let expenses = [...(seed.expenses || [])];
  const log = { inserts: [], deletes: [], updates: [] };

  function from(table) {
    const b = {
      _op: null, _row: null, _f: {},
      insert(r) { this._op = 'insert'; this._row = r; return this; },
      upsert(r) { this._op = 'upsert'; this._row = r; return this; },
      update(r) { this._op = 'update'; this._row = r; return this; },
      delete() { this._op = 'delete'; return this; },
      select() { if (!this._op) this._op = 'select'; return this; },
      eq(c, v) { this._f[c] = v; return this; },
      order() { return this; }, limit() { return this; },
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
            if (this._f.id !== undefined) {
              const hit = expenses.find((e) => e.id === this._f.id);
              if (single) return { data: hit || null, error: hit ? null : { code: 'PGRST116' } };
              return { data: hit ? [hit] : [], error: null };
            }
            return single ? { data: expenses[0] || null, error: null } : { data: expenses, error: null };
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
test('P0：未設定主體的群組打 #支出 → 回提示、不寫 DB', async () => {
  const sb = makeObservableSupabase({ kv: {} }); // 無 group_entity_map
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-unknown', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:G-unknown');

  assert.ok(Array.isArray(reply));
  assert.match(reply[0].text, /尚未設定支出主體/);
  assert.equal(sb.log.inserts.length, 0, '未設定主體不可寫 DB');
  assert.equal(fm.calls.append.length, 0, '未設定主體不可寫 Sheet');
});

test('P0：未設定主體提示要附上當前 groupId（方便管理員拿去設定）', async () => {
  const sb = makeObservableSupabase({ kv: {} }); // 無 group_entity_map
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  const event = { source: { type: 'group', groupId: 'G-need-setup', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:G-need-setup');

  assert.match(reply[0].text, /尚未設定支出主體/);
  assert.match(reply[0].text, /G-need-setup/, '提示應含當前 groupId 供複製設定');
  assert.equal(sb.log.inserts.length, 0, '仍維持 P0：未設定不寫 DB');
  assert.equal(fm.calls.append.length, 0, '仍維持 P0：未設定不寫 Sheet');
});

test('P0：未設定主體＋私訊（無 groupId）→ 顯示「無群組ID」且仍不記帳', async () => {
  const sb = makeObservableSupabase({ kv: {} });
  const fm = makeFakeMaruten();
  const wh = loadWebhook(sb.client, fm.mod);

  // 私訊來源沒有 groupId（event.source 只有 userId）。
  const event = { source: { type: 'user', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenExpense(event, '支出 便當 120', 'focus:U1');

  assert.match(reply[0].text, /尚未設定支出主體/);
  assert.match(reply[0].text, /無群組ID/, '無 groupId 時應妥善顯示「無群組ID」');
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
    assert.match(btn.action.uri, /2009806013-ON2KtCsF/, '卡片應指向真 LIFF 後備值');
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
