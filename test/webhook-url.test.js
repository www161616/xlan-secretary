// api/webhook.js 的 A4「對外網址可設定化」驗證（P2-3）。
//
// 重點：SYSTEM_PROMPT 內「後台網址／LINE Webhook」應讀 PUBLIC_BASE_URL；
//   未設時 fallback 回原 Vercel 值（https://xlan-secretary.vercel.app），確保 Vercel 行為不變。
//   香奈問「小瀾後台／webhook」時，香奈會從 SYSTEM_PROMPT 取得這兩個值，故必須隨環境正確。
//
// 手法：比照 oauth-url.test.js——在指定 PUBLIC_BASE_URL 下重載 webhook.js，
//   讀 module.exports.__test__ 暴露的 XLAN_CONSOLE_URL / XLAN_WEBHOOK_URL / SYSTEM_PROMPT 來斷言。
//
// 跑法：node --test "test/*.test.js"

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stubs = require('./_stubs');
stubs.install();

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const VERCEL_FALLBACK_CONSOLE = 'https://xlan-secretary.vercel.app';
const VERCEL_FALLBACK_WEBHOOK = 'https://xlan-secretary.vercel.app/webhook';

// 在指定 PUBLIC_BASE_URL 下重載 webhook.js，回傳其 __test__ 暴露的網址常數與 SYSTEM_PROMPT。
function loadWebhookWith(publicBaseUrl) {
  if (publicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = publicBaseUrl;

  const p = require.resolve(path.join(__dirname, '..', 'api', 'webhook.js'));
  delete require.cache[p];
  const mod = require(p);
  return mod.__test__;
}

test('未設 PUBLIC_BASE_URL → 後台/Webhook fallback 回原 Vercel 值（Vercel 行為不變）', () => {
  const t = loadWebhookWith(undefined);
  assert.equal(t.XLAN_CONSOLE_URL, VERCEL_FALLBACK_CONSOLE);
  assert.equal(t.XLAN_WEBHOOK_URL, VERCEL_FALLBACK_WEBHOOK);
  // SYSTEM_PROMPT 應實際帶入這兩個值。
  assert.ok(t.SYSTEM_PROMPT.includes(`後台網址：${VERCEL_FALLBACK_CONSOLE}`), 'SYSTEM_PROMPT 應含 fallback 後台網址');
  assert.ok(t.SYSTEM_PROMPT.includes(`LINE Webhook：${VERCEL_FALLBACK_WEBHOOK}`), 'SYSTEM_PROMPT 應含 fallback webhook');
});

test('PUBLIC_BASE_URL 為空字串 → 同樣 fallback 回 Vercel 值', () => {
  const t = loadWebhookWith('');
  assert.equal(t.XLAN_CONSOLE_URL, VERCEL_FALLBACK_CONSOLE);
  assert.equal(t.XLAN_WEBHOOK_URL, VERCEL_FALLBACK_WEBHOOK);
});

test('設了 PUBLIC_BASE_URL → 後台用它、Webhook 用它組 /webhook', () => {
  const t = loadWebhookWith('https://xlan.example.com');
  assert.equal(t.XLAN_CONSOLE_URL, 'https://xlan.example.com');
  assert.equal(t.XLAN_WEBHOOK_URL, 'https://xlan.example.com/webhook');
  assert.ok(t.SYSTEM_PROMPT.includes('後台網址：https://xlan.example.com'), 'SYSTEM_PROMPT 應帶入新後台網址');
  assert.ok(t.SYSTEM_PROMPT.includes('LINE Webhook：https://xlan.example.com/webhook'), 'SYSTEM_PROMPT 應帶入新 webhook');
  // 不應再殘留舊 Vercel 字串。
  assert.ok(!t.SYSTEM_PROMPT.includes('xlan-secretary.vercel.app'), '設了新網址後不應再出現舊 Vercel 網址');
});

test('PUBLIC_BASE_URL 結尾多餘斜線會被去掉，不組出雙斜線', () => {
  const t = loadWebhookWith('https://xlan.example.com/');
  assert.equal(t.XLAN_CONSOLE_URL, 'https://xlan.example.com');
  assert.equal(t.XLAN_WEBHOOK_URL, 'https://xlan.example.com/webhook');
});

// 收尾：清掉 PUBLIC_BASE_URL，避免污染其他測試。
test('收尾：清掉 PUBLIC_BASE_URL', () => {
  delete process.env.PUBLIC_BASE_URL;
  assert.equal(process.env.PUBLIC_BASE_URL, undefined);
});
