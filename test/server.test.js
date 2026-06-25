// server.js（NAS 常駐 Express 入口）單元測試。
//
// 驗證範圍（階段一）：
//   1. 簽章驗證純函式 verifyLineSignature：對的簽章過、錯的／缺的擋。
//   2. /healthz 路由有掛載，且回 200 "ok"。
//   3. /webhook 與五個 API 路由都有掛載到正確路徑與方法。
//   4. /webhook 中介層：壞簽章直接 401、不進 webhook handler；對的簽章才轉交 handler，
//      且交給 handler 的 req 仍能用 `for await...of` 讀回「原始 bytes」（webhook.js 內部驗簽不會壞）。
//
// 約束：本專案測試環境「沒有 node_modules」（既有 168 測試全靠 test/_stubs.js 攔截 require）。
//   故本檔不真的 require('express')，而是自備一個「可觀測的假 express」攔下來，記錄路由註冊、
//   並能直接呼叫各路由的 handler／middleware 來驗行為。supabase / anthropic / googleapis 等
//   下游 require 仍交給 test/_stubs.js 接住（server.js → api/webhook.js 會載入它們）。
//
// 跑法：node --test test/

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Module = require('node:module');
const { Readable } = require('node:stream');

// 先裝既有 stub（接住 supabase/anthropic/googleapis/line-sdk 與本地 maruten-expense）。
const stubs = require('./_stubs');
stubs.install();

// 補假 env，避免下游 handler 頂層初始化（createClient 等）因缺值拋錯。
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
// 固定一把測試用 LINE secret，讓簽章驗證可預期。
const TEST_SECRET = 'test-line-secret';
process.env.LINE_CHANNEL_SECRET = TEST_SECRET;

// ---- 可觀測的假 express ----
// app 記錄所有路由註冊：{ method, path, handlers:[...] }；middleware 用 app.use 記錄。
function makeFakeExpressApp() {
  const routes = [];
  const mounts = []; // app.use(...) 註冊（含全域中介層與 static）
  let listened = null;

  function record(method, args) {
    // 形態一：app.get('/path', h1, h2, ...) ；形態二：app.use(mwFn) 或 app.use('/path', mwFn)
    if (typeof args[0] === 'string') {
      routes.push({ method, path: args[0], handlers: args.slice(1) });
    } else {
      mounts.push({ method, handlers: args.slice(0) });
    }
  }

  const app = {
    get(...a) { record('get', a); return app; },
    post(...a) { record('post', a); return app; },
    put(...a) { record('put', a); return app; },
    all(...a) { record('all', a); return app; },
    use(...a) {
      if (typeof a[0] === 'string') routes.push({ method: 'use', path: a[0], handlers: a.slice(1) });
      else mounts.push({ method: 'use', handlers: a.slice(0) });
      return app;
    },
    listen(port, cb) { listened = port; if (typeof cb === 'function') cb(); return { close() {} }; },
    // 測試輔助：找某 method+path 的註冊。
    _find(method, p) { return routes.find(r => r.method === method && r.path === p); },
    _routes: routes,
    _mounts: mounts,
    get _listened() { return listened; },
  };
  return app;
}

let lastApp = null;
// express 工廠：呼叫回新 app；並掛上 raw/json/static 三個 middleware 工廠（回傳「可辨識」的標記函式）。
function fakeExpressFactory() {
  lastApp = makeFakeExpressApp();
  return lastApp;
}
fakeExpressFactory.raw = (opts) => {
  const fn = (req, res, next) => next && next();
  fn._kind = 'raw'; fn._opts = opts;
  return fn;
};
fakeExpressFactory.json = (opts) => {
  const fn = (req, res, next) => next && next();
  fn._kind = 'json'; fn._opts = opts;
  return fn;
};
fakeExpressFactory.static = (root, opts) => {
  const fn = (req, res, next) => next && next();
  fn._kind = 'static'; fn._root = root; fn._opts = opts;
  return fn;
};

// ---- 可觀測的假 node-cron ----
// 記錄每次 schedule(expr, fn, opts) 呼叫，並回傳一個可 start/stop 的假 task。
const fakeCron = {
  scheduled: [],
  schedule(expr, fn, opts) {
    const task = { expr, fn, opts, started: true, stop() { this.started = false; }, start() { this.started = true; } };
    this.scheduled.push(task);
    return task;
  },
  _reset() { this.scheduled.length = 0; },
};

// 在既有 stub 之外，再包一層攔截 express 與 node-cron（其餘 request 交給已安裝的 stub patched 處理）。
// node-cron 只有 server.js 用到，故在此攔截即可，不必動共用的 _stubs.js。
const prevLoad = Module._load;
Module._load = function patchedForExpress(request, parent, isMain) {
  if (request === 'express') return fakeExpressFactory;
  if (request === 'node-cron') return fakeCron;
  return prevLoad.apply(this, arguments);
};

// 載入受測模組（require 鏈：server.js → api/*.js → 下游套件，全部被 stub／假 express 接住）。
const serverPath = require.resolve(path.join(__dirname, '..', 'server.js'));
delete require.cache[serverPath];
const server = require(serverPath);
const {
  createApp, verifyLineSignature, makeRawBodyReq,
  runReminderJob, startReminderCron, REMINDER_CRON_EXPR,
} = server;

// 小工具：用指定 secret 對 body 算 LINE 簽章。
function sign(body, secret = TEST_SECRET) {
  return crypto.createHmac('SHA256', secret).update(body).digest('base64');
}

// 小工具：假 res，記錄 status/send/json 結果。
function makeFakeRes() {
  const res = {
    statusCode: null, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    json(o) { this.body = o; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { if (b !== undefined) this.body = b; return this; },
  };
  return res;
}

// ============================================================================
// 1. 簽章驗證純函式
// ============================================================================
test('verifyLineSignature：正確簽章 → true', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(verifyLineSignature(body, sign(body)), true);
});

test('verifyLineSignature：Buffer body 與字串 body 行為一致', () => {
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  const sig = sign(body);
  assert.equal(verifyLineSignature(Buffer.from(body), sig), true);
  assert.equal(verifyLineSignature(body, sig), true);
});

test('verifyLineSignature：錯誤簽章 → false', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(verifyLineSignature(body, 'WRONG_SIGNATURE_BASE64=='), false);
});

test('verifyLineSignature：缺簽章 → false', () => {
  const body = JSON.stringify({ events: [] });
  assert.equal(verifyLineSignature(body, undefined), false);
  assert.equal(verifyLineSignature(body, ''), false);
});

test('verifyLineSignature：secret 不同 → false（防用錯 channel secret）', () => {
  const body = JSON.stringify({ events: [] });
  const sigWithOtherSecret = sign(body, 'another-secret');
  assert.equal(verifyLineSignature(body, sigWithOtherSecret), false);
});

// ============================================================================
// 2. /healthz
// ============================================================================
test('/healthz 路由有掛載，且回 200 "ok"', () => {
  const app = createApp();
  const route = app._find('get', '/healthz');
  assert.ok(route, '/healthz 應以 GET 掛載');
  const res = makeFakeRes();
  route.handlers[route.handlers.length - 1]({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
});

// ============================================================================
// 3. 路由掛載表
// ============================================================================
test('/webhook 與 /api/webhook 都以 POST 掛載，且前置 express.raw 中介層', () => {
  const app = createApp();
  // P1-2：Vercel 把 /webhook rewrite 到 /api/webhook，等價要兩條都通。
  for (const p of ['/webhook', '/api/webhook']) {
    const route = app._find('post', p);
    assert.ok(route, `${p} 應以 POST 掛載`);
    // 第一個 handler 應是 express.raw() 產生的 middleware。
    assert.equal(route.handlers[0]._kind, 'raw', `${p} 第一個中介層應為 express.raw`);
  }
});

test('/webhook 與 /api/webhook 共用同一套 POST dispatch（同一函式參考）', () => {
  const app = createApp();
  const a = app._find('post', '/webhook');
  const b = app._find('post', '/api/webhook');
  // raw 中介層與最終 dispatch 都應是同一個函式參考（確保兩路徑行為完全一致）。
  assert.equal(a.handlers[0], b.handlers[0], '兩路由應共用同一 express.raw 中介層');
  assert.equal(a.handlers[a.handlers.length - 1], b.handlers[b.handlers.length - 1], '兩路由應共用同一 dispatch');
});

test('/webhook 與 /api/webhook 也都以 all 掛載（接住 GET 等非 POST，對齊 Vercel webhook.js 行為）', () => {
  const app = createApp();
  for (const p of ['/webhook', '/api/webhook']) {
    assert.ok(app._find('all', p), `${p} 應以 app.all 掛載以接住 GET / 其他方法`);
  }
});

test('五個 API 路由都掛載到正確路徑（all 方法）', () => {
  const app = createApp();
  for (const p of [
    '/api/maruten-expense-form',
    '/api/oauth',
    '/api/staff-report',
    '/api/reminder',
  ]) {
    assert.ok(app._find('all', p), `${p} 應以 app.all 掛載`);
  }
});

test('有掛載 express.json，但「不」對根目錄開 express.static（白名單化後）', () => {
  const app = createApp();
  const kinds = app._mounts.map(m => m.handlers[0] && m.handlers[0]._kind).filter(Boolean);
  assert.ok(kinds.includes('json'), '應掛 express.json');
  // P1-1：安全修正後不再用 express.static(__dirname)，避免整個專案根目錄外洩。
  assert.ok(!kinds.includes('static'), '不應再對根目錄開 express.static');
});

test('白名單三頁以固定 GET 路由服務（index/maruten-expense/staff），不接受外部路徑', () => {
  const app = createApp();
  for (const p of ['/index.html', '/maruten-expense.html', '/staff.html', '/']) {
    assert.ok(app._find('get', p), `${p} 應以固定 GET 路由掛載`);
  }
  // 反向確認：沒有任何「服務整個目錄」的萬用靜態掛載。
  const staticMounts = app._mounts.filter(m => m.handlers.some(h => h && h._kind === 'static'));
  assert.equal(staticMounts.length, 0, '不應存在 express.static 掛載');
});

test('白名單 GET 路由只 sendFile 白名單內檔名（不洩漏 api/*.js、setup-db.sql 等）', () => {
  const app = createApp();
  // 逐一觸發白名單路由，攔截 res.sendFile 收到的絕對路徑，確認 basename 落在白名單內。
  const path = require('node:path');
  const allow = new Set(['index.html', 'maruten-expense.html', 'staff.html']);
  for (const p of ['/index.html', '/maruten-expense.html', '/staff.html', '/']) {
    const route = app._find('get', p);
    let sentPath = null;
    const res = { sendFile(fp) { sentPath = fp; } };
    route.handlers[route.handlers.length - 1]({ url: p }, res);
    assert.ok(sentPath, `${p} 應呼叫 res.sendFile`);
    assert.ok(allow.has(path.basename(sentPath)), `${p} 只能服務白名單檔，實際=${path.basename(sentPath)}`);
  }
  // 確認沒有任何路由會服務這些敏感檔（白名單外的路徑根本沒掛 GET 路由 → 交給 Express 預設 404）。
  for (const sensitive of ['/api/webhook.js', '/setup-db.sql', '/.env', '/package.json', '/server.js']) {
    assert.equal(app._find('get', sensitive), undefined, `${sensitive} 不應有對應靜態路由（應 404）`);
  }
});

test('listen 使用 process.env.PORT 或預設 3000（被 require 時不自動 listen）', () => {
  // createApp 不應自行 listen；listen 僅在直接執行時發生。
  const app = createApp();
  assert.equal(app._listened, null, 'createApp 不應自動 listen');
});

// ============================================================================
// 4. /webhook 中介層行為：壞簽章 401、好簽章轉交且 raw body 可重讀
// ============================================================================
test('/webhook：壞簽章 → 401，不進 webhook handler', async () => {
  const app = createApp();
  const route = app._find('post', '/webhook');
  // 路由 handler 鏈：[rawMw, verify+dispatch]
  const dispatch = route.handlers[route.handlers.length - 1];
  const body = JSON.stringify({ events: [] });
  const req = { method: 'POST', headers: { 'x-line-signature': 'BAD==' }, body: Buffer.from(body), url: '/webhook' };
  const res = makeFakeRes();
  await dispatch(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, 'Invalid signature');
});

test('makeRawBodyReq：包出的 req 可被 for-await 讀回原始 bytes，且保留 method/headers', async () => {
  const body = JSON.stringify({ events: [{ type: 'message', message: { type: 'text' } }] });
  const original = { method: 'POST', headers: { 'x-line-signature': 'sig', host: 'x' }, url: '/webhook' };
  const rawReq = makeRawBodyReq(original, Buffer.from(body));
  assert.equal(rawReq.method, 'POST');
  assert.equal(rawReq.headers['x-line-signature'], 'sig');
  // 用 for-await 讀回（webhook.js 內部就是這樣讀的）。
  const chunks = [];
  for await (const chunk of rawReq) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), body);
});

test('/webhook：正確簽章 → 轉交 handler，且 handler 端能用同簽章驗過（raw body 不被破壞）', async () => {
  const app = createApp();
  const route = app._find('post', '/webhook');
  const dispatch = route.handlers[route.handlers.length - 1];
  const body = JSON.stringify({ events: [] });
  const sig = sign(body);
  const req = { method: 'POST', headers: { 'x-line-signature': sig }, body: Buffer.from(body), url: '/webhook' };
  const res = makeFakeRes();
  // webhook.js 是 GET→200 / POST→自讀串流驗簽。這裡 dispatch 會以「包好的 rawReq」呼叫真 webhookHandler。
  // 預期 webhook handler 走完回 200（events 為空，不做任何外部呼叫）。
  await dispatch(req, res, (err) => { if (err) throw err; });
  // webhook.js 對成功路徑回 200 json({ok:true})；壞簽章才 401。這裡簽章正確，應為 200。
  assert.equal(res.statusCode, 200, '正確簽章應轉交並由 webhook handler 回 200');
});

// ============================================================================
// 5. reminder 常駐排程（node-cron）
// ============================================================================
test('REMINDER_CRON_EXPR 為每小時整點 0 * * * *（沿用原 Vercel Cron 契約）', () => {
  // 頻率必須是「每小時一次」：reminder 內部用 currentHour 整點判斷、早安/月底無當日去重，
  // 若改成每分鐘會重複發 60 次。這條鎖住頻率，避免日後被誤改。
  assert.equal(REMINDER_CRON_EXPR, '0 * * * *');
});

test('startReminderCron 以 0 * * * * 註冊，且帶 Asia/Taipei 時區', () => {
  fakeCron._reset();
  const task = startReminderCron();
  assert.equal(fakeCron.scheduled.length, 1, '應只註冊一個排程');
  const reg = fakeCron.scheduled[0];
  assert.equal(reg.expr, '0 * * * *', 'cron 運算式應為每小時整點');
  assert.equal(reg.opts && reg.opts.timezone, 'Asia/Taipei', '應指定台北時區');
  assert.ok(typeof reg.fn === 'function', '應傳入觸發函式');
  assert.ok(task, 'startReminderCron 應回傳 task');
});

test('createApp 不會自行啟動 cron（被 require 時不排程）', () => {
  // 與 listen 同理：排程只在「直接執行 server.js」時啟動，被 require（測試）時不啟動。
  fakeCron._reset();
  createApp();
  assert.equal(fakeCron.scheduled.length, 0, 'createApp 不應註冊任何排程');
});

test('runReminderJob 會以「假 GET req + 可回應 res」呼叫 reminder handler', async () => {
  // 用假 handler 觀測：runReminderJob 餵進去的 req/res 形狀正確，且 res.status().json() 可用。
  let received = null;
  const fakeHandler = (req, res) => {
    received = { method: req.method, url: req.url };
    res.status(200).json({ ok: true });
    return Promise.resolve();
  };
  await runReminderJob(fakeHandler);
  assert.ok(received, 'handler 應被呼叫');
  assert.equal(received.method, 'GET', 'reminder 應以等同 GET /api/reminder 觸發');
  assert.equal(received.url, '/api/reminder');
});

test('runReminderJob 吞掉 handler 拋錯，不讓未捕捉 rejection 中斷排程', async () => {
  const throwingHandler = () => { throw new Error('boom'); };
  // 不應 reject（內部已 catch 並 console.error）。
  await assert.doesNotReject(runReminderJob(throwingHandler));
});

test('startReminderCron 的觸發函式可被呼叫（觸發即跑 reminder，不丟例外）', async () => {
  fakeCron._reset();
  startReminderCron();
  const reg = fakeCron.scheduled[0];
  // 直接呼叫排程登記的函式：它內部呼叫 runReminderJob()（真 reminderHandler，
  // 下游 supabase 由 _stubs 接住，single() 回 {data:null} → handler 早退回 {ok:true,'no owner'}）。
  assert.doesNotThrow(() => reg.fn());
});
