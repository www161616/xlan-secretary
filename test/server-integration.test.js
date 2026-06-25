// server.js 整合測試（用「真 Express」+ 真 HTTP，補足 server.test.js 用假 express 的覆蓋缺口）。
//
// 背景：server.test.js 為了「無 node_modules 也能跑」而用假 express 觀測路由註冊，
//   沒有真的跑過 express.raw()／express.json()／真 HTTP 401/200 路徑。Codex 審查（P2-4）要求補一個
//   用真 Express app + node:http 的整合測試，實打實驗證 raw-body 驗簽與路由行為。
//
// 為什麼能跑：本檔「不」攔截 express/node-cron（讓它們用真的 node_modules），
//   只沿用 _stubs.js 攔住 webhook.js 的下游套件（supabase/anthropic/line-sdk/googleapis），
//   使 webhook.js 能載入、且不連任何外部服務。
//
// 容錯：若執行環境真的沒有安裝 express（純 CI 無 node_modules），則整批 skip，
//   並印出原因——符合「裝不了就說明、不要讓測試硬紅」的精神（unit 測試 server.test.js 仍覆蓋路由註冊）。
//
// 跑法：node --test "test/*.test.js"（會被一起帶到）；或單獨 node --test test/server-integration.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

// 先裝下游 stub（supabase/anthropic/line/googleapis），但「不」攔 express → 用真 express。
const stubs = require('./_stubs');
stubs.install();

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
const TEST_SECRET = 'test-line-secret-integration';
process.env.LINE_CHANNEL_SECRET = TEST_SECRET;

// 偵測真 express 是否可用；不可用就整批 skip（不讓環境差異變成假紅）。
let expressAvailable = true;
try {
  require.resolve('express');
} catch {
  expressAvailable = false;
}

// 載入受測 server.js（真 express 會被真的 require）。
let createApp = null;
if (expressAvailable) {
  const serverPath = require.resolve(path.join(__dirname, '..', 'server.js'));
  delete require.cache[serverPath];
  ({ createApp } = require(serverPath));
}

// 用指定 secret 對 body 算 LINE 簽章（與 server.js verifyLineSignature 同演算法）。
function sign(body, secret = TEST_SECRET) {
  return crypto.createHmac('SHA256', secret).update(body).digest('base64');
}

// 起一個真 http server 跑 app，回傳 { server, port }，並提供 close()。
function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// 發一個真實 HTTP 請求，回傳 { status, body }。
function request(port, { method = 'GET', pathName = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathName, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const opts = { skip: expressAvailable ? false : '此環境未安裝 express（node_modules 不存在），整合測試 skip' };

// ---------------------------------------------------------------------------
// /healthz 真實回應
// ---------------------------------------------------------------------------
test('整合：GET /healthz → 200 ok', opts, async () => {
  const { server, port } = await listen(createApp());
  try {
    const r = await request(port, { method: 'GET', pathName: '/healthz' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'ok');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// webhook 壞簽：/webhook 與 /api/webhook 都該 401（真 express.raw + 真 HMAC 驗簽）
// ---------------------------------------------------------------------------
for (const p of ['/webhook', '/api/webhook']) {
  test(`整合：POST ${p} 壞簽章 → 401（兩路由一致）`, opts, async () => {
    const { server, port } = await listen(createApp());
    try {
      const body = JSON.stringify({ events: [] });
      const r = await request(port, {
        method: 'POST',
        pathName: p,
        headers: { 'content-type': 'application/json', 'x-line-signature': 'BAD_SIGNATURE==' },
        body,
      });
      assert.equal(r.status, 401, `${p} 壞簽應 401`);
      assert.equal(r.body, 'Invalid signature');
    } finally {
      server.close();
    }
  });

  test(`整合：POST ${p} 缺簽章 → 401`, opts, async () => {
    const { server, port } = await listen(createApp());
    try {
      const body = JSON.stringify({ events: [] });
      const r = await request(port, {
        method: 'POST',
        pathName: p,
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(r.status, 401, `${p} 缺簽應 401`);
    } finally {
      server.close();
    }
  });

  test(`整合：POST ${p} 對的簽章 → 進 handler 回 200（raw body 未被 json 破壞）`, opts, async () => {
    const { server, port } = await listen(createApp());
    try {
      // events 為空：webhook.js 驗簽過後不做任何外部呼叫，回 200 json。
      const body = JSON.stringify({ events: [] });
      const r = await request(port, {
        method: 'POST',
        pathName: p,
        headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) },
        body,
      });
      assert.equal(r.status, 200, `${p} 對簽應進 handler 並 200（raw body 完整才驗得過）`);
    } finally {
      server.close();
    }
  });

  test(`整合：GET ${p} → 200（對齊 Vercel webhook.js 的 GET 健康字串）`, opts, async () => {
    const { server, port } = await listen(createApp());
    try {
      const r = await request(port, { method: 'GET', pathName: p });
      assert.equal(r.status, 200, `${p} GET 應由 webhook.js 處理並回 200`);
      assert.match(r.body, /xlan-secretary is running/, 'GET 應回 webhook.js 的健康字串');
    } finally {
      server.close();
    }
  });
}

// ---------------------------------------------------------------------------
// P1-1 安全：白名單外的敏感檔不可得（應 404），白名單頁可服務
// ---------------------------------------------------------------------------
test('整合：敏感路徑 /api/webhook.js、/setup-db.sql、/.env、/server.js 不可得（404）', opts, async () => {
  const { server, port } = await listen(createApp());
  try {
    for (const p of ['/api/webhook.js', '/setup-db.sql', '/.env', '/.env.example', '/server.js', '/package.json', '/test/_stubs.js']) {
      const r = await request(port, { method: 'GET', pathName: p });
      assert.equal(r.status, 404, `${p} 應為 404（不得對外服務專案內部檔）`);
    }
  } finally {
    server.close();
  }
});

test('整合：白名單頁 / 與 /maruten-expense.html 可服務（200，且確實是 HTML）', opts, async () => {
  const { server, port } = await listen(createApp());
  try {
    for (const p of ['/', '/index.html', '/maruten-expense.html', '/staff.html']) {
      const r = await request(port, { method: 'GET', pathName: p });
      assert.equal(r.status, 200, `${p} 白名單頁應 200`);
      assert.match(r.body, /<!DOCTYPE html|<html|<meta/i, `${p} 應回傳 HTML 內容`);
    }
  } finally {
    server.close();
  }
});

// 防穿越：嘗試用編碼後的 ../ 取根目錄外/內部檔，應不可得（白名單路由根本不吃外部路徑）。
test('整合：路徑穿越嘗試（%2e%2e、..）取不到 server.js（非 200 内容洩漏）', opts, async () => {
  const { server, port } = await listen(createApp());
  try {
    for (const p of ['/..%2fserver.js', '/%2e%2e/server.js', '/static/../server.js']) {
      const r = await request(port, { method: 'GET', pathName: p });
      assert.notEqual(r.status, 200, `${p} 不應回 200`);
      assert.doesNotMatch(r.body, /verifyLineSignature|createApp/, `${p} 不應洩漏 server.js 原始碼`);
    }
  } finally {
    server.close();
  }
});
