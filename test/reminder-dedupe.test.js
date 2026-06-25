// api/reminder.js 去重測試（P1-3 早安摘要、P1-4 月底財務總結）。
//
// 背景：搬常駐（NAS）後，cron 重跑／手動打 /api/reminder／容器在整點重啟，
//   都可能讓「早安摘要（9 點）」與「月底財務總結（最後一天 21 點）」在同一期重複推送。
//   修正：比照既有「15 點待辦」那條用 xlan_kv 記旗標去重
//   （morning_summary_sent:YYYY-MM-DD / monthly_summary_sent:YYYY-MM）。
//
// 本測試驗證的核心契約：
//   1. 正常情況：第一次同期觸發會發（不可因去重而漏發）。
//   2. 去重情況：同一期第二次觸發「不再重發」（cron 重跑/重啟也只發一次）。
//
// 技術手法：
//   - 用 node:test 的 mock.timers 把系統時間鎖到「台北 09:30」與「台北 21:30 且為當月最後一天」，
//     讓 reminder.js 內部 getTaipeiNow() 命中 9 點 / 月底 21 點分支（不依賴跑測試的真實時刻）。
//   - 用 _stubs.setFakeSupabaseClient 注入「xlan_kv 具記憶體狀態」的假 supabase：
//     markSentDaily 的 upsert 真的寫入，hasSentDaily 的 single 真的讀得到 → 能驗證跨次去重。
//   - stub global.fetch 計數 LINE push 次數（pushMessage 內部用 fetch 打 LINE）。
//
// 跑法：node --test "test/*.test.js"，或單獨 node --test test/reminder-dedupe.test.js

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stubs = require('./_stubs');
stubs.install();

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'test-line-token';

// ---- 帶 xlan_kv 記憶體狀態的假 supabase ----
// 只實作 reminder.js 會用到的鏈式呼叫：from(table).select().eq().single()/then、upsert()。
//   - xlan_kv：用 Map 真實記憶（owner_line_id 固定回值；其餘 key 依 markSentDaily 寫入而變）。
//   - 其他表：select 結果一律空（build 函式拿到空資料仍能組出字串，不外連）。
function makeFakeSupabase(kv) {
  function makeQuery(table) {
    // 收集 eq 條件，single() 時據此回 xlan_kv 的值。
    const cond = {};
    const q = {
      select() { return this; },
      eq(col, val) { cond[col] = val; return this; },
      // reminder.js 會用到的其餘鏈式篩選/排序方法，一律回 this（資料層由 then() 統一回空）。
      neq() { return this; }, gt() { return this; }, gte() { return this; }, lt() { return this; }, lte() { return this; },
      or() { return this; }, filter() { return this; }, not() { return this; }, in() { return this; },
      is() { return this; }, match() { return this; }, contains() { return this; },
      order() { return this; },
      limit() { return this; },
      // upsert：只 xlan_kv 在意；寫進 Map。
      async upsert(row) {
        if (table === 'xlan_kv' && row && row.key !== undefined) {
          kv.set(row.key, row.value);
        }
        return { data: null, error: null };
      },
      insert() { return this; },
      update() { return this; },
      delete() { return this; },
      // single：xlan_kv 依 key 回記憶值；其它表回 null。
      async single() {
        if (table === 'xlan_kv' && cond.key !== undefined) {
          const v = kv.get(cond.key);
          return { data: v === undefined ? null : { value: v }, error: null };
        }
        return { data: null, error: null };
      },
      // 末端 await（list 查詢）：一律空陣列。
      then(resolve) { return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve); },
    };
    return q;
  }
  return { from: (table) => makeQuery(table) };
}

// 在指定鎖定時間下，跑 reminder handler N 次，回傳每次的 res.body 與「總推送次數」。
async function runReminderTimes({ fixedUtcMs, times }) {
  // 鎖時間（Date 全域）→ getTaipeiNow() 會回對應台北時刻。
  mock.timers.enable({ apis: ['Date'], now: fixedUtcMs });

  // KV：預置 owner_line_id，讓 handler 不會在「no owner」早退。
  const kv = new Map([['owner_line_id', 'U_OWNER_TEST']]);
  stubs.setFakeSupabaseClient(makeFakeSupabase(kv));

  // 計數 LINE push；回 ok 避免 pushMessage 走錯誤分支。
  let pushCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { pushCount += 1; return { ok: true, async text() { return ''; } }; };

  // 重新載入 reminder.js（讓它用上面注入的假 supabase）。
  const reminderPath = require.resolve(path.join(__dirname, '..', 'api', 'reminder.js'));
  delete require.cache[reminderPath];
  const handler = require(reminderPath);

  const bodies = [];
  try {
    for (let i = 0; i < times; i++) {
      const req = { method: 'GET', url: '/api/reminder', headers: {} };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
        send(b) { this.body = b; return this; },
        setHeader() {}, end() { return this; },
      };
      await handler(req, res);
      bodies.push(res.body);
    }
  } finally {
    global.fetch = originalFetch;
    mock.timers.reset();
    stubs.setFakeSupabaseClient(null);
  }
  return { bodies, pushCount, kv };
}

// 台北 09:30（UTC+8）→ UTC 01:30。2025-06-30 為當月最後一天（順便給月底測試用 21:30）。
const MORNING_UTC = Date.UTC(2025, 5, 30, 1, 30, 0);   // 台北 2025-06-30 09:30
const MONTHLY_UTC = Date.UTC(2025, 5, 30, 13, 30, 0);  // 台北 2025-06-30 21:30（最後一天）

// ============================================================================
// P1-3 早安摘要去重
// ============================================================================
test('早安：9 點第一次觸發會發早安（sent 含 morning）', async () => {
  const { bodies, pushCount } = await runReminderTimes({ fixedUtcMs: MORNING_UTC, times: 1 });
  assert.ok(bodies[0] && Array.isArray(bodies[0].sent), 'handler 應回 { sent:[...] }');
  assert.ok(bodies[0].sent.includes('morning'), '第一次 9 點應發早安');
  assert.ok(pushCount >= 1, '應至少推送一次');
});

test('早安：同一天 9 點第二次觸發「不再重發」早安（cron 重跑/重啟去重）', async () => {
  const { bodies } = await runReminderTimes({ fixedUtcMs: MORNING_UTC, times: 2 });
  assert.ok(bodies[0].sent.includes('morning'), '第一次應發早安');
  assert.ok(!bodies[1].sent.includes('morning'), '第二次同一天不應再發早安');
});

test('早安：去重旗標 morning_summary_sent:YYYY-MM-DD 會在發送後寫入 xlan_kv', async () => {
  const { kv } = await runReminderTimes({ fixedUtcMs: MORNING_UTC, times: 1 });
  assert.ok(kv.has('morning_summary_sent:2025-06-30'), '發送後應寫入當日早安去重旗標');
});

// ============================================================================
// P1-4 月底財務總結去重
// ============================================================================
test('月底：最後一天 21 點第一次觸發會發月底總結（sent 含 monthly_summary）', async () => {
  const { bodies } = await runReminderTimes({ fixedUtcMs: MONTHLY_UTC, times: 1 });
  assert.ok(bodies[0].sent.includes('monthly_summary'), '最後一天 21 點應發月底總結');
});

test('月底：同一個月最後一天 21 點第二次觸發「不再重發」月底總結', async () => {
  const { bodies } = await runReminderTimes({ fixedUtcMs: MONTHLY_UTC, times: 2 });
  assert.ok(bodies[0].sent.includes('monthly_summary'), '第一次應發月底總結');
  assert.ok(!bodies[1].sent.includes('monthly_summary'), '第二次同月不應再發月底總結');
});

test('月底：去重旗標 monthly_summary_sent:YYYY-MM 會在發送後寫入 xlan_kv', async () => {
  const { kv } = await runReminderTimes({ fixedUtcMs: MONTHLY_UTC, times: 1 });
  assert.ok(kv.has('monthly_summary_sent:2025-06'), '發送後應寫入當月月底去重旗標');
});
