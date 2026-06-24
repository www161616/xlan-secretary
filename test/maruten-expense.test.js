// 丸十支出機器人 v0.2 修正驗證 —— maruten-expense.js 單元測試（mock Google／Supabase）。
//
// 對應審查報告（D:\丸十支出機器人\審查報告_丸十支出機器人-v0.1.md）：
//   P1-1 首次建 Sheet 競態 → 鎖確保只建一次
//   P1-4 KV 命中時驗證 Sheet 有效，壞掉清 KV 重建
//   報告第9行 表頭驗證 → 分頁存在但表頭錯/空也補表頭
//   P2-4 已刪除列同時標 H 欄狀態＋B 欄分類加註，避免被加總誤算
//
// 跑法：node --test test/  （Node 內建 test runner，零外部依賴）
// Google：用 require.cache 注入假的 googleapis，攔下所有 Sheets 呼叫並記錄。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const stubs = require('./_stubs');
stubs.install();

// 切片二（LIFF 表單版）後的正式表頭（10 欄）：日期/分類/項目/金額/記錄人/備註/收據照片/原始訊息/記帳ID/狀態。
// 記帳ID 由 G→I（0-based 8）、狀態由 H→J（0-based 9）。各 fixture 共用此常數，避免散落多份。
const HEADER = ['日期', '分類', '項目', '金額', '記錄人', '備註', '收據照片', '原始訊息', '記帳ID', '狀態'];
const IDX_STATUS = 9; // 狀態欄 0-based 索引（10 欄表頭）

// ---- 假 googleapis：可程式化控制行為、記錄所有呼叫 ----
function makeFakeGoogle(state) {
  const calls = state.calls;
  const sheetsApi = {
    spreadsheets: {
      // 建新試算表
      create: async () => {
        calls.push({ fn: 'create' });
        state.createdCount += 1;
        const id = `new-sheet-${state.createdCount}`;
        state.sheetsById[id] = { tabs: ['支出明細'], header: [], rows: [] };
        // 測試鉤子：模擬「建表期間鎖被 B 接管」等並發情境（P1-A）。
        if (typeof state.onCreate === 'function') await state.onCreate(state, id);
        return { data: { spreadsheetId: id } };
      },
      // 讀 metadata（分頁清單）；state 設 throwOnGet 可模擬 Sheet 失效
      get: async ({ spreadsheetId }) => {
        calls.push({ fn: 'get', spreadsheetId });
        if (state.throwOnGet) throw new Error('Requested entity was not found.');
        const s = state.sheetsById[spreadsheetId];
        if (!s) throw new Error('not found');
        return { data: { sheets: (s.tabs || []).map((t) => ({ properties: { title: t } })) } };
      },
      batchUpdate: async ({ spreadsheetId, requestBody }) => {
        calls.push({ fn: 'batchUpdate', spreadsheetId, requestBody });
        const s = state.sheetsById[spreadsheetId];
        const reqs = requestBody?.requests || [];
        for (const r of reqs) {
          if (r.addSheet) s.tabs.push(r.addSheet.properties.title);
        }
        return { data: {} };
      },
      values: {
        get: async ({ spreadsheetId, range }) => {
          calls.push({ fn: 'values.get', spreadsheetId, range });
          const s = state.sheetsById[spreadsheetId] || { header: [], rows: [] };
          if (/A1:.*1$/.test(range)) return { data: { values: s.header.length ? [s.header] : [] } };
          // 記帳ID 欄：切片二把表頭擴成 10 欄後，記帳ID 由 G 移到 I（0-based 8）。
          if (/!I:I$/.test(range)) {
            const col = [['記帳ID']].concat((s.rows || []).map((row) => [row[8] || '']));
            return { data: { values: col } };
          }
          // 分類欄（B）：讀單列分類值，第2列=rows[0]。
          if (/!B\d+$/.test(range)) {
            const m = range.match(/!B(\d+)$/);
            const idx = Number(m[1]) - 2;
            const val = (s.rows[idx] || [])[1] || '';
            return { data: { values: [[val]] } };
          }
          return { data: { values: [] } };
        },
        update: async ({ spreadsheetId, range, requestBody }) => {
          calls.push({ fn: 'values.update', spreadsheetId, range, values: requestBody?.values });
          const s = state.sheetsById[spreadsheetId];
          if (/A1:.*1$/.test(range)) s.header = requestBody.values[0];
          return { data: {} };
        },
        append: async ({ spreadsheetId, requestBody }) => {
          calls.push({ fn: 'values.append', spreadsheetId, values: requestBody?.values });
          const s = state.sheetsById[spreadsheetId];
          s.rows.push(requestBody.values[0]);
          const rowNum = s.rows.length + 1; // +1 表頭
          // 切片二表頭擴成 10 欄（A..J），updatedRange 末欄改 J。
          return { data: { updates: { updatedRange: `支出明細!A${rowNum}:J${rowNum}` } } };
        },
        batchUpdate: async ({ spreadsheetId, requestBody }) => {
          calls.push({ fn: 'values.batchUpdate', spreadsheetId, data: requestBody?.data });
          const s = state.sheetsById[spreadsheetId];
          for (const d of requestBody.data || []) {
            const mB = d.range.match(/!B(\d+)$/);   // 分類欄（0-based 1）
            const mJ = d.range.match(/!J(\d+)$/);   // 狀態欄（10 欄後由 H 移到 J，0-based 9）
            if (mB) { const i = Number(mB[1]) - 2; if (s.rows[i]) s.rows[i][1] = d.values[0][0]; }
            if (mJ) { const i = Number(mJ[1]) - 2; if (s.rows[i]) s.rows[i][9] = d.values[0][0]; }
          }
          return { data: {} };
        },
      },
    },
  };
  return {
    google: {
      auth: { OAuth2: class { setCredentials() {} } },
      sheets: () => sheetsApi,
    },
  };
}

// 注入這次案例專屬的假 googleapis，再全新載入 maruten-expense（清掉它的快取以套用 mock）。
function loadModuleWithFakeGoogle(state) {
  stubs.setFakeGoogle(makeFakeGoogle(state));
  const modPath = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense.js'));
  delete require.cache[modPath];
  return require(modPath);
}

// ---- 極簡假 supabase：以一個 Map 當 xlan_kv，支援 insert(衝突)/upsert/select/update/delete ----
// opts.beforeInsert(key, kv)：在每次 insert「實際寫入前」呼叫，用來模擬「窗口期被別人搶先寫入」的競態（P1-A）。
function makeFakeSupabase(initialKv = {}, opts = {}) {
  const kv = new Map(Object.entries(initialKv));
  function from(tableName) {
    const builder = {
      _op: null, _row: null, _filters: {},
      insert(row) { this._op = 'insert'; this._row = row; return this; },
      upsert(row) { this._op = 'upsert'; this._row = row; return this; },
      update(row) { this._op = 'update'; this._row = row; return this; },
      delete() { this._op = 'delete'; return this; },
      select() { if (!this._op) this._op = 'select'; return this; },
      eq(col, val) { this._filters[col] = val; return this; },
      async single() { return this._run(true); },
      then(resolve, reject) { return this._run(false).then(resolve, reject); },
      async _run(single) {
        if (tableName !== 'xlan_kv') return single ? { data: null, error: null } : { data: [], error: null };
        const key = this._row?.key ?? this._filters.key;
        if (this._op === 'insert') {
          // 競態鉤子：模擬「A 即將 insert 的瞬間，B 先一步寫入」（P1-A 窗口期）。
          if (typeof opts.beforeInsert === 'function') await opts.beforeInsert(this._row.key, kv);
          // 故障鉤子：模擬「非 23505 的暫時性 DB 錯誤」（P2）。回傳一次後即清空，不影響後續 insert。
          if (typeof opts.insertError === 'function') {
            const injected = opts.insertError(this._row.key, kv);
            if (injected) return { data: null, error: injected };
          }
          if (kv.has(this._row.key)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          kv.set(this._row.key, this._row.value);
          return { data: [this._row], error: null };
        }
        if (this._op === 'upsert') { kv.set(this._row.key, this._row.value); return { data: [this._row], error: null }; }
        if (this._op === 'update') {
          if (this._filters.value !== undefined && kv.get(key) !== this._filters.value) {
            return single ? { data: null, error: null } : { data: [], error: null };
          }
          if (kv.has(key)) { kv.set(key, this._row.value); return { data: [{ key, value: this._row.value }], error: null }; }
          return single ? { data: null, error: null } : { data: [], error: null };
        }
        if (this._op === 'delete') { kv.delete(key); return { data: [], error: null }; }
        // select
        if (key !== undefined) {
          if (kv.has(key)) return { data: { value: kv.get(key) }, error: null };
          return single ? { data: null, error: { code: 'PGRST116' } } : { data: [], error: null };
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return builder;
  }
  return { from, _kv: kv };
}

// ========================== 測試 ==========================

test('P1-4：KV 命中且 Sheet 有效 → 直接沿用，不重建', async () => {
  const state = { calls: [], createdCount: 0, sheetsById: { 'good-id': { tabs: ['支出明細'], header: HEADER, rows: [] } } };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({ maruten_expense_sheet_id: 'good-id' });
  const id = await mod.ensureSpreadsheetId(supabase);
  assert.equal(id, 'good-id');
  assert.equal(state.createdCount, 0, '不應重建');
  // 應有讀 metadata + 讀表頭做驗證
  assert.ok(state.calls.some((c) => c.fn === 'get'), '應驗證 Sheet 存在');
  assert.ok(state.calls.some((c) => c.fn === 'values.get'), '應驗證表頭');
});

test('P1-4：KV 指到的 Sheet 已失效 → 清掉壞 KV 並重建一張', async () => {
  const state = { calls: [], createdCount: 0, throwOnGet: true, sheetsById: {} };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({ maruten_expense_sheet_id: 'dead-id' });
  // 第一次：get 丟錯 → 清 KV → 重建
  state.throwOnGet = true;
  const id = await mod.ensureSpreadsheetId(supabase);
  // 重建走 create（create 後 throwOnGet 仍 true，但建立路徑不再 get，所以能成功）
  assert.equal(state.createdCount, 1, '壞 KV 應觸發重建一次');
  assert.match(id, /^new-sheet-/);
  assert.equal(supabase._kv.get('maruten_expense_sheet_id'), id, '新 id 應寫回 KV');
});

test('報告第9行：分頁存在但表頭空白 → 補寫正確表頭', async () => {
  const state = { calls: [], createdCount: 0, sheetsById: { 'blank-head': { tabs: ['支出明細'], header: [], rows: [] } } };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({ maruten_expense_sheet_id: 'blank-head' });
  await mod.ensureSpreadsheetId(supabase);
  const headerWrite = state.calls.find((c) => c.fn === 'values.update' && /A1:J1$/.test(c.range));
  assert.ok(headerWrite, '表頭空白時應補寫表頭');
  assert.deepEqual(headerWrite.values[0], HEADER);
});

test('P1-1：並發兩筆首次 #支出 → 只建立一張 Sheet（鎖生效）', async () => {
  const state = { calls: [], createdCount: 0, sheetsById: {} };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({}); // 全空：無 sheet id、無鎖
  // 同時兩個請求（共用同一個 supabase / kv），模擬並發
  const [a, b] = await Promise.all([
    mod.ensureSpreadsheetId(supabase),
    mod.ensureSpreadsheetId(supabase),
  ]);
  assert.equal(a, b, '兩個請求應拿到同一張 Sheet');
  assert.equal(state.createdCount, 1, '只能建立一張（不可有孤兒）');
});

test('P1-A：A 建表後鎖已被 B 接管且 B 尚未寫 KV → A 不覆蓋 KV、丟可重試錯誤', async () => {
  // 起手：KV 全空 → A acquireSheetLock 成功（鎖 owner=A）。
  // 在 createSpreadsheet 期間用 onCreate 模擬 B 逾時接管：把鎖值換成別的 owner，且「不」寫入 sheet id。
  const supabase = makeFakeSupabase({});
  const state = {
    calls: [], createdCount: 0, sheetsById: {},
    onCreate: (st, createdId) => {
      // B 接管：覆寫鎖 owner（≠ A），並故意不寫 maruten_expense_sheet_id（模擬 B 還沒寫完）。
      supabase._kv.set('maruten_expense_sheet_lock', JSON.stringify({ owner: 'B-other', locked_at: new Date().toISOString() }));
      st._orphanId = createdId; // 記住 A 建的孤兒，稍後驗證它沒被寫進 KV
    },
  };
  const mod = loadModuleWithFakeGoogle(state);

  await assert.rejects(
    () => mod.ensureSpreadsheetId(supabase),
    /maruten_sheet_lock_lost/,
    '鎖被接管且 KV 無 id 時，應丟可重試錯誤讓上層重跑',
  );
  assert.equal(state.createdCount, 1, 'A 確實建了一張（成孤兒）');
  // 鐵律：A 絕不能把自己的 sheetId 寫進 KV 覆蓋 B 的正確狀態。
  assert.equal(supabase._kv.has('maruten_expense_sheet_id'), false, 'A 不可寫入 KV sheet id');
  assert.notEqual(supabase._kv.get('maruten_expense_sheet_id'), state._orphanId, '孤兒 id 不可出現在 KV');
});

test('P1-A：A 建表後發現 B 已把正確 id 寫進 KV → A 採用 B 的 id、不覆蓋', async () => {
  // 安全分支：建表期間 B 已寫入 KV sheet id，A 應直接回傳 B 的 id，不寫自己的。
  const supabase = makeFakeSupabase({});
  const state = {
    calls: [], createdCount: 0, sheetsById: {},
    onCreate: (st) => {
      supabase._kv.set('maruten_expense_sheet_id', 'B-correct-id'); // B 先寫好
    },
  };
  const mod = loadModuleWithFakeGoogle(state);
  const id = await mod.ensureSpreadsheetId(supabase);
  assert.equal(id, 'B-correct-id', '應採用 B 已寫入 KV 的正確 id');
  assert.equal(supabase._kv.get('maruten_expense_sheet_id'), 'B-correct-id', 'KV 仍是 B 的 id，未被 A 覆蓋');
});

test('P1-A（治本）：A 在 stillOwnLock 通過後、寫 KV 前，B 搶先寫入 id → A 不覆蓋、採用 B 的 id、只一張有效', async () => {
  // 這是 P1-A 殘留窗口的精確情境：A 全程持鎖（stillOwnLock=true），但在 storeSheetId 的 insert
  // 「實際寫入前」的瞬間，B 搶先把正確 id 寫進 KV。insert-only 必須擋下 A 的覆蓋。
  let injected = false;
  const supabase = makeFakeSupabase({}, {
    beforeInsert: (key, kv) => {
      // 只在 A 要寫 sheet id 的那一刻、且僅一次，模擬 B 搶先寫入。
      if (key === 'maruten_expense_sheet_id' && !injected) {
        injected = true;
        kv.set('maruten_expense_sheet_id', 'B-correct-id');
      }
    },
  });
  // 鎖全程維持 A：onCreate 不動鎖、不寫 KV，確保流程走到 storeSheetId（而非 maruten_sheet_lock_lost 分支）。
  const state = { calls: [], createdCount: 0, sheetsById: {} };
  const mod = loadModuleWithFakeGoogle(state);

  const id = await mod.ensureSpreadsheetId(supabase);
  assert.equal(id, 'B-correct-id', 'A 應採用 B 在窗口期搶先寫入的 id，而非自己的 created');
  assert.equal(supabase._kv.get('maruten_expense_sheet_id'), 'B-correct-id', 'KV 仍是 B 的 id，A 的 insert-only 未覆蓋');
  assert.equal(state.createdCount, 1, 'A 確實建了一張（成孤兒，只 log，不寫 KV、不雙主）');
  assert.ok(injected, '測試確有命中「寫 KV 前」窗口的注入點');
});

test('P2：storeSheetId 遇非 23505 錯誤 → throw、不回傳 wanted（不產生孤兒）', async () => {
  // 模擬「寫 sheet id 時遇暫時性 DB 故障（非 PK 衝突）」：storeSheetId 不可當成衝突處理回傳 created，
  // 否則上層會 append 到沒寫進 KV 的孤兒 Sheet。應 throw，交由上層既有 catch 回「同步稍後補」。
  let hit = false;
  const supabase = makeFakeSupabase({}, {
    insertError: (key) => {
      // 只攔截「寫 sheet id」這一次（不影響 acquireSheetLock 等其他 insert）。
      if (key === 'maruten_expense_sheet_id' && !hit) {
        hit = true;
        return { code: '08006', message: 'connection failure' }; // 非 23505 的暫時性錯誤
      }
      return null;
    },
  });
  const state = { calls: [], createdCount: 0, sheetsById: {} };
  const mod = loadModuleWithFakeGoogle(state);

  await assert.rejects(
    () => mod.ensureSpreadsheetId(supabase),
    /maruten_store_sheet_id_failed/,
    '非 23505 錯誤應 throw，讓上層容錯而非回傳孤兒 id',
  );
  assert.ok(hit, '測試確有命中非 23505 錯誤的注入點');
  // 關鍵：KV 不可被寫入任何 sheet id（沒有孤兒被「採用」）。
  assert.equal(supabase._kv.has('maruten_expense_sheet_id'), false, '故障時不可把 created 寫/採用為 KV id');
});

test('P2-4：刪除標記 → 同時寫 H 欄「已刪除」與 B 欄「(已刪除)」前綴', async () => {
  // 預先放一張有一列資料的 Sheet（第2列）；10 欄：日期/分類/項目/金額/記錄人/備註/收據照片/原始訊息/記帳ID/狀態。
  const row = ['2026-06-24', '餐費', '便當', 120, '阿明', '', '', '#支出 便當 120', 'exp-1', '正常'];
  const state = { calls: [], createdCount: 0, sheetsById: { 'sid': { tabs: ['支出明細'], header: HEADER, rows: [row] } } };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({ maruten_expense_sheet_id: 'sid' });
  const ok = await mod.markSheetDeleted(supabase, { sheetRow: 2, expenseId: 'exp-1' });
  assert.equal(ok, true);
  const updated = state.sheetsById['sid'].rows[0];
  assert.equal(updated[IDX_STATUS], '已刪除', '狀態欄（J）應為已刪除');
  assert.equal(updated[1], '(已刪除) 餐費', 'B 欄分類應加註前綴，避免被 SUMIF 加總');
});

test('P2-4：重複刪除不會疊加前綴', async () => {
  const row = ['2026-06-24', '(已刪除) 餐費', '便當', 120, '阿明', '', '', 'x', 'exp-1', '已刪除'];
  const state = { calls: [], createdCount: 0, sheetsById: { 'sid': { tabs: ['支出明細'], header: HEADER, rows: [row] } } };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({ maruten_expense_sheet_id: 'sid' });
  await mod.markSheetDeleted(supabase, { sheetRow: 2, expenseId: 'exp-1' });
  assert.equal(state.sheetsById['sid'].rows[0][1], '(已刪除) 餐費', '不應變成「(已刪除) (已刪除) 餐費」');
});

test('append：寫一列並回傳正確列號', async () => {
  const state = { calls: [], createdCount: 0, sheetsById: { 'sid': { tabs: ['支出明細'], header: HEADER, rows: [] } } };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({ maruten_expense_sheet_id: 'sid' });
  const rowNum = await mod.appendExpenseToSheet(supabase, { date: 'd', category: '餐費', note: '便當', amount: 120, recorder: '阿明', rawText: 'x', expenseId: 'exp-1' });
  assert.equal(rowNum, 2, '第一筆資料應在第 2 列');
  assert.equal(state.sheetsById['sid'].rows.length, 1);
});

test('append：表單版帶備註＋多張收據連結 → 寫進備註欄(F)與收據照片欄(G)', async () => {
  const state = { calls: [], createdCount: 0, sheetsById: { 'sid': { tabs: ['支出明細'], header: HEADER, rows: [] } } };
  const mod = loadModuleWithFakeGoogle(state);
  const supabase = makeFakeSupabase({ maruten_expense_sheet_id: 'sid' });
  await mod.appendExpenseToSheet(supabase, {
    date: 'd', category: '進貨食材', note: '青菜', amount: 300, recorder: '阿明',
    memo: '臨時補貨', receiptPhotos: ['http://drive/a', 'http://drive/b'], rawText: '', expenseId: 'exp-2',
  });
  const wrote = state.sheetsById['sid'].rows[0];
  assert.equal(wrote[5], '臨時補貨', '備註寫進第 6 欄（F）');
  assert.equal(wrote[6], 'http://drive/a\nhttp://drive/b', '多張收據連結以換行串進第 7 欄（G）');
  assert.equal(wrote[3], 300, '金額仍為數字');
  assert.equal(wrote[IDX_STATUS], '正常', '狀態欄（J）預設正常');
});
