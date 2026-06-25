// api/oauth.js 的 A4「對外網址可設定化」驗證。
//
// 重點：REDIRECT_URI 應讀 PUBLIC_BASE_URL；沒設時 fallback 回原 Vercel 網址（確保 Vercel 行為不變）。
// REDIRECT_URI 是模組私有常數，故用 _stubs.setFakeGoogle 注入假 googleapis，
// 攔 OAuth2 建構子拿到第 3 個參數（redirect_uri）來觀測；oauth.js 一行不用改。
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
// oauth.js 頂層需要 CLIENT_ID/SECRET 非空，否則 handler 早退回 500（拿不到 redirect_uri）。
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';

// 注入假 googleapis：OAuth2 建構子記下收到的 redirect_uri；generateAuthUrl 回固定字串讓無 code 分支跑完。
let capturedRedirectUri = null;
stubs.setFakeGoogle({
  google: {
    auth: {
      OAuth2: class {
        constructor(clientId, clientSecret, redirectUri) {
          capturedRedirectUri = redirectUri;
        }
        generateAuthUrl() { return 'https://accounts.google.com/o/oauth2/auth?fake=1'; }
      },
    },
  },
});

// 在指定 PUBLIC_BASE_URL 下重載 oauth.js 並跑一次 handler（無 code → 走 generateAuthUrl 分支），
// 回傳建構子捕捉到的 REDIRECT_URI。
async function loadRedirectUriWith(publicBaseUrl) {
  if (publicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = publicBaseUrl;

  const p = require.resolve(path.join(__dirname, '..', 'api', 'oauth.js'));
  delete require.cache[p];
  const handler = require(p);

  capturedRedirectUri = null;
  const req = { method: 'GET', url: '/api/oauth', headers: {} };
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    send() { return this; },
    setHeader() {},
    end() { return this; },
  };
  await handler(req, res);
  return capturedRedirectUri;
}

const VERCEL_FALLBACK = 'https://xlan-secretary-rqhb.vercel.app/api/oauth';

test('未設 PUBLIC_BASE_URL → REDIRECT_URI fallback 回原 Vercel 網址（Vercel 行為不變）', async () => {
  const uri = await loadRedirectUriWith(undefined);
  assert.equal(uri, VERCEL_FALLBACK);
});

test('PUBLIC_BASE_URL 為空字串 → 同樣 fallback 回 Vercel 網址', async () => {
  const uri = await loadRedirectUriWith('');
  assert.equal(uri, VERCEL_FALLBACK);
});

test('設了 PUBLIC_BASE_URL → REDIRECT_URI 用它組 /api/oauth', async () => {
  const uri = await loadRedirectUriWith('https://xlan.example.com');
  assert.equal(uri, 'https://xlan.example.com/api/oauth');
});

test('PUBLIC_BASE_URL 結尾多餘斜線會被去掉，不組出雙斜線', async () => {
  const uri = await loadRedirectUriWith('https://xlan.example.com/');
  assert.equal(uri, 'https://xlan.example.com/api/oauth');
});

// 收尾：還原 env，避免污染其他測試（PUBLIC_BASE_URL 預設應為未設）。
test('收尾：清掉 PUBLIC_BASE_URL', () => {
  delete process.env.PUBLIC_BASE_URL;
  assert.equal(process.env.PUBLIC_BASE_URL, undefined);
});
