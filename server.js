// 小瀾 Express 常駐入口（NAS 版）。
//
// 用途：把原本散裝在 Vercel serverless 的各 api/*.js handler，包進「一支常駐的 Express」，
//       方便放進 NAS（照喵秘書 linebot-order 同款）。**業務邏輯一行都不動**——
//       這支 server.js 只是「殼」：require 既有 handler，做 Vercel ↔ Express 的 req/res 相容轉接。
//
// Vercel 相容：api/*.js 維持 `module.exports = async (req, res) => {}` 原樣，main 分支仍可被 Vercel 使用，
//             也可作為 NAS 上線後的回滾後備。本檔不改寫它們。
//
// 路由（見下方 createApp）：
//   POST /webhook                     → api/webhook.js（LINE 入口；raw body 驗簽）
//   ALL  /api/maruten-expense-form     → api/maruten-expense-form.js（丸十支出 LIFF 表單）
//   ALL  /api/oauth                    → api/oauth.js（Google 重發 refresh token）
//   ALL  /api/staff-report             → api/staff-report.js（總倉回報 LIFF 表單）
//   ALL  /api/reminder                 → api/reminder.js（提醒；仍保留可手動觸發）
//   GET  /healthz                      → 健康檢查，回 200 "ok"
//   靜態：index.html / maruten-expense.html / staff.html（express.static 服務）
//
// 常駐排程（階段二）：原本 reminder 由 Vercel Cron「每小時整點」打 /api/reminder 一次
//   （見 AGENTS.md：`0 * * * *`）。搬 NAS 沒有 Vercel Cron，改用 node-cron 在本進程內
//   以同一頻率 `0 * * * *` 呼叫同一套 reminder 邏輯（reminder.js 一行不改）。
//   頻率必須維持「每小時一次」：reminder 內部用 currentHour===9/15/21 等整點判斷，
//   且早安／月底總結沒有當日去重，若改每分鐘會重複發 60 次——故沿用原契約。

'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const cron = require('node-cron');

// 既有 Vercel handler（原樣 require，不改寫）。
const webhookHandler = require('./api/webhook');
const marutenExpenseFormHandler = require('./api/maruten-expense-form');
const oauthHandler = require('./api/oauth');
const staffReportHandler = require('./api/staff-report');
const reminderHandler = require('./api/reminder');

// reminder 排程頻率：每小時第 0 分（與原 Vercel Cron `0 * * * *` 一致）。
const REMINDER_CRON_EXPR = '0 * * * *';

// LINE Channel Secret（與 webhook.js 一致，trim 避免環境變數夾帶空白）。
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || '').trim();

// --- LINE 簽章驗證 ---
// 與 api/webhook.js 的 validateSignature 同演算法（HMAC-SHA256 + base64），
// 但這裡多一層在「進 handler 前」先擋掉壞簽章，避免無效請求白跑 handler。
// rawBody 必須是「LINE 送來的原始 bytes」（Buffer 或字串），不能是 JSON.parse 後再 stringify 的結果，
// 否則 byte 不一致會驗不過。
function verifyLineSignature(rawBody, signature, secret = LINE_CHANNEL_SECRET) {
  if (!signature || !secret) return false;
  const hash = crypto
    .createHmac('SHA256', secret)
    .update(rawBody)
    .digest('base64');
  // 用 timingSafeEqual 防時間側錄；長度不同直接判否（timingSafeEqual 要求等長 Buffer）。
  const a = Buffer.from(hash);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 把「Express 已用 express.raw() 收好的 Buffer」重新包成一個「可被 `for await...of` 消費的類 req」。
//
// 為什麼需要：api/webhook.js 內部是用 `for await (const chunk of req)` 自己讀原始串流來驗簽，
//   一旦 express.raw() 先把 body 讀走，原始 req 串流就空了，webhook.js 會讀到空字串而驗簽失敗。
//   解法：用原始 Buffer 造一個 Readable，並補上 webhook.js 會用到的 method / headers / url，
//   讓 webhook.js 完全照舊運作（它一行都不用改）。
function makeRawBodyReq(originalReq, rawBuffer) {
  // Readable.from 讓 `for await (const chunk of req)` 能再讀一次原始 bytes。
  const stream = Readable.from([rawBuffer]);
  // 補齊 webhook.js 會讀到的欄位（method / headers / url），其餘交給原型鏈上的 Readable。
  stream.method = originalReq.method;
  stream.headers = originalReq.headers;
  stream.url = originalReq.url;
  return stream;
}

// 把 Vercel 風格 handler 包成 Express middleware。
// Vercel 的 (req, res) 與 Express 幾乎相容；Express 的 res 已有 status()/json()/send()/end()/setHeader()/redirect()，
// 故大多數 handler 直接套用即可。錯誤統一交給 Express 錯誤處理（next(err)），避免未捕捉例外讓連線吊死。
function wrapVercelHandler(handler) {
  return (req, res, next) => {
    // return 該 promise：Express 忽略 route handler 回傳值（生產行為不變），
    // 但讓未捕捉的 rejection 確實走到 next(err)，也方便測試 await。
    return Promise.resolve(handler(req, res)).catch(next);
  };
}

function createApp() {
  const app = express();

  // 健康檢查：放最前面，最單純、不依賴任何外部服務，給 NAS / Cloudflare / 監控用。
  app.get('/healthz', (req, res) => {
    res.status(200).send('ok');
  });

  // --- LINE Webhook ---
  // 先用 express.raw 取得「原始 bytes」（type:'*/*' 比照喵秘書，確保任何 Content-Type 都收成 Buffer），
  // 在進 webhook.js 前先驗簽（壞簽章直接 401，不白跑 handler），
  // 再把原始 Buffer 包成可重新 for-await 的 req 交給 webhook.js（其內部仍自行讀串流＋驗簽，行為不變）。
  app.post('/webhook', express.raw({ type: '*/*', limit: '10mb' }), (req, res, next) => {
    const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const signature = req.headers['x-line-signature'];
    if (!verifyLineSignature(rawBuffer, signature)) {
      return res.status(401).send('Invalid signature');
    }
    const rawReq = makeRawBodyReq(req, rawBuffer);
    // return 該 promise：Express 會忽略 route handler 的回傳值（生產行為不變），
    // 但讓呼叫端（測試）能 await 到 handler 真正跑完。
    return Promise.resolve(webhookHandler(rawReq, res)).catch(next);
  });

  // --- 其餘 API：用 express.json 解析 JSON body ---
  // form / staff-report 的 readJsonBody 會優先吃 req.body（物件），命中此分支即可；
  // oauth / reminder 不依賴 body。limit 放寬到 10mb：表單會夾帶 base64 收據照片。
  app.use(express.json({ limit: '10mb' }));

  app.all('/api/maruten-expense-form', wrapVercelHandler(marutenExpenseFormHandler));
  app.all('/api/oauth', wrapVercelHandler(oauthHandler));
  app.all('/api/staff-report', wrapVercelHandler(staffReportHandler));
  app.all('/api/reminder', wrapVercelHandler(reminderHandler));

  // --- 靜態網頁 ---
  // 服務專案根目錄的三個前端頁（index.html / maruten-expense.html / staff.html）。
  // 放在 API 路由之後，避免靜態中介層攔截到 /api/* 或 /webhook。
  app.use(express.static(__dirname, { index: 'index.html', extensions: ['html'] }));

  return app;
}

// 跑一次 reminder 邏輯（cron 觸發用）。
// reminder.js 是 Vercel 形態 (req,res)=>{}，這裡用最小假 req/res 把它跑完——
// 它只會讀「沒讀 req」、並對 res 呼叫 status().json()/send()。回傳該 Promise 方便測試 await。
// 業務邏輯零改動：等同「外部排程打了一次 GET /api/reminder」。
function runReminderJob(handler = reminderHandler) {
  const req = { method: 'GET', url: '/api/reminder', headers: {} };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    send(body) { this.body = body; return this; },
    setHeader() {},
    end() { return this; },
  };
  // handler 內部已有 try/catch 並回 500；這裡再包一層，確保 cron 回呼不因未捕捉 rejection 而中斷排程。
  return Promise.resolve()
    .then(() => handler(req, res))
    .catch((err) => { console.error('reminder cron 執行失敗：', err); });
}

// 啟動 reminder 的 node-cron 排程（每小時整點）。回傳建立的 task 以利測試／關閉。
// 時區固定 Asia/Taipei：reminder 內部雖自行用 getTaipeiNow() 取台北時間，
// 但讓 cron 觸發點也對齊台北整點，語意更清楚、與原 Vercel Cron 行為一致。
function startReminderCron(scheduler = cron) {
  return scheduler.schedule(
    REMINDER_CRON_EXPR,
    () => { runReminderJob(); },
    { timezone: 'Asia/Taipei' },
  );
}

// 只有「直接執行」本檔時才真的 listen＋起排程；被 require（測試）時都不啟動。
if (require.main === module) {
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`小瀾常駐服務啟動，PORT=${PORT}`);
  });
  startReminderCron();
  console.log(`reminder 排程已啟動（${REMINDER_CRON_EXPR}，Asia/Taipei）`);
}

module.exports = {
  createApp, verifyLineSignature, makeRawBodyReq, wrapVercelHandler,
  runReminderJob, startReminderCron, REMINDER_CRON_EXPR,
};
