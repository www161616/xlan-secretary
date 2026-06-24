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

module.exports = { install, setFakeGoogle, setFakeSupabaseClient, setFakeMarutenModule };
