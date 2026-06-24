// 共用：攔截外部 npm 套件的 require，讓測試不需安裝 node_modules、不連任何外部服務。
// 被攔截的套件（googleapis / @supabase/supabase-js / @line/bot-sdk / @anthropic-ai/sdk）
// 在單元測試裡都不該真的被呼叫；webhook.js 頂層 createClient 只會建出假物件。
//
// googleapis 例外：maruten-expense 測試需要可控的假 Sheets，故提供 setFakeGoogle() 注入。

'use strict';

// P2：webhook.js 的 __test__ 匯出只在 NODE_ENV==='test' 時掛上。本檔在所有測試檔頂端、
// 且早於任何 webhook.js / maruten-expense.js 的 require 被載入，於此設定可確保 node --test
// 不依賴外部環境變數也能取得 __test__（不要只靠外部 env）。
process.env.NODE_ENV = 'test';

const Module = require('node:module');

// ============================================================================
// xlan_expenses 已知欄位清單（防「測試綠但真實 DB 爆」的單一事實來源）。
//
// 背景／教訓：本 bot 曾因 getPettyCashBalance 的 select 引用真實 DB 不存在的 `deleted` 欄
//   而上線爆掉——當時測試的假 supabase 對 select 字串照單全收（不檢查欄位），於是
//   測試全綠、真實 PostgREST 卻回「column xlan_expenses.deleted does not exist」。
//
// 對策：把「DB 實際有哪些欄」列成這份清單（須與 setup-db.sql 的 xlan_expenses 定義＋
//   後續 ALTER ADD COLUMN 補丁一致），並提供 parseSelectColumns／unknownExpenseColumns
//   讓假 supabase 在 select 到清單外的欄位時「比照真實 PostgREST 回 error」，
//   使「未來有人又 select 不存在欄位」這件事在測試就會變紅（見 petty-cash.test.js 守門測試）。
//
// 維護準則：setup-db.sql 對 xlan_expenses 新增欄位時，這份清單要同步加上對應欄名。
const XLAN_EXPENSES_COLUMNS = [
  'id', 'amount', 'category', 'note', 'type', 'account',
  'created_at', 'entity', 'sheet_row', 'recorder', 'deleted',
];

// 把 Supabase 的 .select('a, b, c') 字串切成欄位陣列。
// 只處理本案會用到的簡單情境：逗號分隔的欄名；'*' 代表全部欄位（回空陣列＝不檢查個別欄）。
// 不支援 PostgREST 的關聯展開語法（本專案 xlan_expenses 查詢都沒用到，毋須過度設計）。
function parseSelectColumns(selectStr) {
  const s = String(selectStr || '').trim();
  if (s === '' || s === '*') return [];
  return s.split(',').map((c) => c.trim()).filter(Boolean);
}

// 回傳 select 字串中「不在 xlan_expenses 已知欄位清單」的欄位（真實 DB 會對這些欄報錯）。
// 假 supabase 可據此模擬真實 PostgREST：有未知欄 → 回 { data:null, error:{ message } }。
function unknownExpenseColumns(selectStr) {
  return parseSelectColumns(selectStr).filter((c) => !XLAN_EXPENSES_COLUMNS.includes(c));
}

let fakeGoogle = null;
// maruten-expense 測試用：注入這次案例專屬的假 googleapis（含 state 記錄）。
function setFakeGoogle(g) { fakeGoogle = g; }

// webhook.js 流程測試用：注入可觀測的假 supabase client 與假 maruten-expense 模組。
let fakeSupabaseClient = null;
function setFakeSupabaseClient(c) { fakeSupabaseClient = c; }
let fakeMarutenModule = null;
function setFakeMarutenModule(m) { fakeMarutenModule = m; }

// 預設假 supabase client（webhook.js 頂層 createClient 用；純函數測試不會碰它）。
function defaultFakeSupabaseModule() {
  return {
    createClient: () => ({
      from: () => ({
        select() { return this; }, insert() { return this; }, upsert() { return this; },
        update() { return this; }, delete() { return this; }, eq() { return this; },
        async single() { return { data: null, error: null }; },
        then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
      }),
    }),
  };
}

const original = Module._load;
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'googleapis') {
      if (fakeGoogle) return fakeGoogle;
      // 未注入時給一個不會被呼叫到的占位（避免 require 失敗）。
      return { google: { auth: { OAuth2: class {} }, sheets: () => ({}), calendar: () => ({}), drive: () => ({}) } };
    }
    if (request === '@supabase/supabase-js') {
      if (fakeSupabaseClient) return { createClient: () => fakeSupabaseClient };
      return defaultFakeSupabaseModule();
    }
    if (request === '@line/bot-sdk') return { Client: class { constructor() {} }, middleware: () => () => {}, validateSignature: () => true };
    if (request === '@anthropic-ai/sdk') return class Anthropic { constructor() {} };
    // 攔截 webhook.js 對本地 maruten-expense 的 require，換成可觀測的假模組。
    if (fakeMarutenModule && /(^|[\\/])maruten-expense(\.js)?$/.test(request)) return fakeMarutenModule;
    return original.apply(this, arguments);
  };
}

module.exports = {
  install, setFakeGoogle, setFakeSupabaseClient, setFakeMarutenModule,
  // schema 守門：xlan_expenses 已知欄位清單＋select 欄位解析（防「select 不存在欄位」重演上次 deleted 事件）。
  XLAN_EXPENSES_COLUMNS, parseSelectColumns, unknownExpenseColumns,
};
