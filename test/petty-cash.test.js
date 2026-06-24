// 丸十零用金管理 —— #補錢／#餘額 測試（解析／觸發／餘額計算／主體閘門）。
//
// 對應公文：
//   需求單_零用金.md ／ 實作計畫_零用金.md（任務 1–7）
//
// 設計重點（測試專門蓋這幾條）：
//   - 餘額 = 補入合計(type='deposit') − 支出合計(type='expense')，且**只算本 entity**
//     （不混私訊 entity=null、不混別主體；漏 entity 過濾會把別人的錢算進來）。
//   - 補入用 type='deposit' 區分（不開新表）；#餘額 的支出加總只算 type='expense'。
//   - #補錢／#餘額 命中、不搶 #支出、#補錢明細／#餘額多少 之類查詢句不誤記。
//   - 未設定主體 → 補錢／餘額都靜默（沿用 #支出 P0，不在別人群組冒泡）。
//
// 跑法：node --test "test/*.test.js"
// 純函數測試先塞假 env 讓 createClient 建物件即可；流程／餘額測試用可觀測假 supabase。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const stubs = require('./_stubs');

stubs.install();

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { __test__ } = require(path.join(__dirname, '..', 'api', 'webhook.js'));
const {
  parseMarutenTopupText,
  isMarutenTopupTrigger,
  isMarutenBalanceTrigger,
  getPettyCashBalance,
  handleMarutenTopup,
  handleMarutenBalance,
} = __test__;

// ====================== 任務2：解析 #補錢 文字 ======================
test('補錢解析：「#補錢 10000」→ 金額 10000', () => {
  const r = parseMarutenTopupText('補錢 10000');
  assert.ok(r, '應解析成功');
  assert.equal(r.amount, 10000);
});

test('補錢解析：黏著「#補錢10000」→ 金額 10000', () => {
  const r = parseMarutenTopupText('補錢10000');
  assert.ok(r);
  assert.equal(r.amount, 10000);
});

test('補錢解析：千分位「#補錢 5,000」→ 金額 5000', () => {
  const r = parseMarutenTopupText('補錢 5,000');
  assert.ok(r);
  assert.equal(r.amount, 5000);
});

test('補錢解析：「#補錢 NT$3000」→ 金額 3000', () => {
  const r = parseMarutenTopupText('補錢 NT$3000');
  assert.ok(r);
  assert.equal(r.amount, 3000);
});

test('補錢解析：「#補錢 3000元」→ 金額 3000、備註不殘留「元」', () => {
  const r = parseMarutenTopupText('補錢 3000元');
  assert.ok(r);
  assert.equal(r.amount, 3000);
  assert.equal(r.note, '');
});

test('補錢解析：可帶備註「#補錢 10000 六月零用金」→ 金額＋備註', () => {
  const r = parseMarutenTopupText('補錢 10000 六月零用金');
  assert.ok(r);
  assert.equal(r.amount, 10000);
  assert.equal(r.note, '六月零用金');
});

test('補錢解析：無金額「#補錢」→ null（交給用法提示）', () => {
  assert.equal(parseMarutenTopupText('補錢'), null);
});

test('補錢解析：金額為 0「#補錢 0」→ null', () => {
  assert.equal(parseMarutenTopupText('補錢 0'), null);
});

test('補錢解析：負數「#補錢 -100」→ null（不可把負數吃成正數補入）', () => {
  assert.equal(parseMarutenTopupText('補錢 -100'), null);
});

// 【P0 回歸】負號被空白／貨幣符號隔開時，先前正則漏抓負號 → -1000 被當 +1000 入帳（金錢算錯）。
// 這幾條釘死：凡解析出 ≤ 0 一律回 null。
test('補錢解析P0：「#補錢 現金 -1000」→ null（負號被空白隔開，不可當 +1000）', () => {
  assert.equal(parseMarutenTopupText('補錢 現金 -1000'), null);
});

test('補錢解析P0：「#補錢 NT$ -1000」→ null（負號被貨幣符號＋空白隔開）', () => {
  assert.equal(parseMarutenTopupText('補錢 NT$ -1000'), null);
});

test('補錢解析P0：「#補錢 -1000」→ null（負號緊貼數字）', () => {
  assert.equal(parseMarutenTopupText('補錢 -1000'), null);
});

test('補錢解析P0：「#補錢 -1,000」→ null（負數帶千分位）', () => {
  assert.equal(parseMarutenTopupText('補錢 -1,000'), null);
});

test('補錢解析P0：「#補錢 -0」「#補錢 0」→ null（0 與 -0 都無效）', () => {
  assert.equal(parseMarutenTopupText('補錢 -0'), null);
  assert.equal(parseMarutenTopupText('補錢 0'), null);
});

test('補錢解析：正常「#補錢 現金 1000」→ 1000、備註「現金」（確認排除負數沒誤傷正常前綴備註）', () => {
  const r = parseMarutenTopupText('補錢 現金 1000');
  assert.ok(r);
  assert.equal(r.amount, 1000);
  assert.equal(r.note, '現金');
});

// ====================== 任務2：觸發判定 ======================
test('觸發：「#補錢 10000」命中補錢', () => {
  assert.equal(isMarutenTopupTrigger('#補錢 10000'), true);
});

test('觸發：黏著「#補錢10000」命中補錢', () => {
  assert.equal(isMarutenTopupTrigger('#補錢10000'), true);
});

test('觸發：全形「＃補錢 5000」命中補錢', () => {
  assert.equal(isMarutenTopupTrigger('＃補錢 5000'), true);
});

test('觸發：只打「#補錢」也命中（走用法提示分支）', () => {
  assert.equal(isMarutenTopupTrigger('#補錢'), true);
});

test('觸發排除：「#補錢明細」不觸發補錢（查詢句，不誤記）', () => {
  assert.equal(isMarutenTopupTrigger('#補錢明細'), false);
});

test('觸發排除：「#補錢紀錄」「#補錢清單」不觸發補錢', () => {
  assert.equal(isMarutenTopupTrigger('#補錢紀錄'), false);
  assert.equal(isMarutenTopupTrigger('#補錢記錄'), false);
  assert.equal(isMarutenTopupTrigger('#補錢清單'), false);
});

test('觸發不搶：「#支出 便當 120」不被補錢觸發', () => {
  assert.equal(isMarutenTopupTrigger('#支出 便當 120'), false);
});

test('觸發不搶：「#餘額」不被補錢觸發', () => {
  assert.equal(isMarutenTopupTrigger('#餘額'), false);
});

// 【P1 回歸】負數／0 也要「命中」補錢（再由 handler 回用法提示），不可 fall through 靜默。
test('觸發P1：「#補錢 -1000」命中（交 handler 回提示，不漏接）', () => {
  assert.equal(isMarutenTopupTrigger('#補錢 -1000'), true);
});

test('觸發P1：「#補錢 現金 -1000」命中（負號在備註後也算補錢指令）', () => {
  assert.equal(isMarutenTopupTrigger('#補錢 現金 -1000'), true);
});

test('觸發P1：「#補錢 NT$ -1000」命中', () => {
  assert.equal(isMarutenTopupTrigger('#補錢 NT$ -1000'), true);
});

test('觸發P1：「#補錢 0」命中（交 handler 回提示）', () => {
  assert.equal(isMarutenTopupTrigger('#補錢 0'), true);
});

test('餘額觸發：「#餘額」命中', () => {
  assert.equal(isMarutenBalanceTrigger('#餘額'), true);
});

test('餘額觸發：全形「＃餘額」、含尾空白「#餘額 」命中', () => {
  assert.equal(isMarutenBalanceTrigger('＃餘額'), true);
  assert.equal(isMarutenBalanceTrigger('#餘額 '), true);
});

test('餘額觸發排除：「#餘額多少」不命中（後面黏字 → 非單獨指令）', () => {
  assert.equal(isMarutenBalanceTrigger('#餘額多少'), false);
});

test('餘額觸發排除：「#餘額明細」不命中', () => {
  assert.equal(isMarutenBalanceTrigger('#餘額明細'), false);
});

test('餘額不搶：「#補錢 10000」不被餘額觸發', () => {
  assert.equal(isMarutenBalanceTrigger('#補錢 10000'), false);
});

// ====================== 任務1：餘額計算（可觀測假 supabase）======================
// 簡化版 observable supabase：xlan_expenses 的 select（無 id 過濾）回傳全部列，
// 並**忠實套用 .eq('entity', x) 與 .eq('type', x) 過濾**，以便真的驗到「只算本 entity」。
function makeBalanceSupabase(rows) {
  let expenses = [...rows];
  function from(table) {
    const b = {
      _op: null, _f: {},
      select() { if (!this._op) this._op = 'select'; return this; },
      insert(r) { this._op = 'insert'; this._row = r; return this; },
      eq(c, v) { this._f[c] = v; return this; },
      order() { return this; }, limit() { return this; },
      not() { return this; },
      async single() { return this._run(true); },
      then(res, rej) { return this._run(false).then(res, rej); },
      async _run(single) {
        if (table === 'xlan_expenses' && this._op === 'select') {
          let out = expenses;
          if (this._f.entity !== undefined) out = out.filter((e) => e.entity === this._f.entity);
          if (this._f.type !== undefined) out = out.filter((e) => e.type === this._f.type);
          return single ? { data: out[0] || null, error: null } : { data: out, error: null };
        }
        if (table === 'xlan_expenses' && this._op === 'insert') {
          const row = { id: `exp-${expenses.length + 1}`, ...this._row };
          expenses.push(row);
          return { data: [row], error: null };
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return b;
  }
  return { client: { from }, _expenses: () => expenses };
}

function loadWebhook(supabaseClient) {
  stubs.install();
  stubs.setFakeSupabaseClient(supabaseClient);
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  const p = require.resolve(path.join(__dirname, '..', 'api', 'webhook.js'));
  delete require.cache[p];
  return require(p).__test__;
}

test('餘額：補入 10000 − 支出 120 = 9880（限丸十）', async () => {
  const sb = makeBalanceSupabase([
    { id: 'a', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: 'b', entity: '丸十', type: 'expense', amount: 120 },
  ]);
  const wh = loadWebhook(sb.client);
  const r = await wh.getPettyCashBalance('丸十');
  assert.equal(r.deposit, 10000);
  assert.equal(r.expense, 120);
  assert.equal(r.balance, 9880);
});

test('餘額：無資料 → 全部 0', async () => {
  const sb = makeBalanceSupabase([]);
  const wh = loadWebhook(sb.client);
  const r = await wh.getPettyCashBalance('丸十');
  assert.equal(r.deposit, 0);
  assert.equal(r.expense, 0);
  assert.equal(r.balance, 0);
});

test('餘額隔離：不混私訊 entity=null 的記帳', async () => {
  const sb = makeBalanceSupabase([
    { id: 'a', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: 'b', entity: null, type: 'expense', amount: 999 },     // 私訊記帳，不該算進丸十
    { id: 'c', entity: null, type: 'deposit', amount: 888 },     // 私訊記帳，不該算進丸十
  ]);
  const wh = loadWebhook(sb.client);
  const r = await wh.getPettyCashBalance('丸十');
  assert.equal(r.deposit, 10000, 'deposit 不可吃到 entity=null 的 888');
  assert.equal(r.expense, 0, 'expense 不可吃到 entity=null 的 999');
  assert.equal(r.balance, 10000);
});

test('餘額隔離：不混別主體（央廚）的記帳', async () => {
  const sb = makeBalanceSupabase([
    { id: 'a', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: 'b', entity: '央廚', type: 'deposit', amount: 50000 }, // 別主體，不該算進丸十
    { id: 'c', entity: '央廚', type: 'expense', amount: 300 },
  ]);
  const wh = loadWebhook(sb.client);
  const r = await wh.getPettyCashBalance('丸十');
  assert.equal(r.deposit, 10000);
  assert.equal(r.expense, 0);
  assert.equal(r.balance, 10000);
});

test('餘額：多筆補入與支出正確加總（千分位視為數值）', async () => {
  const sb = makeBalanceSupabase([
    { id: '1', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: '2', entity: '丸十', type: 'deposit', amount: 5000 },
    { id: '3', entity: '丸十', type: 'expense', amount: 120 },
    { id: '4', entity: '丸十', type: 'expense', amount: 80 },
    { id: '5', entity: '丸十', type: 'income', amount: 7777 },   // 其他 type，不該算進補入或支出
  ]);
  const wh = loadWebhook(sb.client);
  const r = await wh.getPettyCashBalance('丸十');
  assert.equal(r.deposit, 15000, 'deposit 只算 type=deposit');
  assert.equal(r.expense, 200, 'expense 只算 type=expense，不含 income');
  assert.equal(r.balance, 14800);
});

test('餘額防呆：已標 deleted=true 的列不算進加總（沿用 getExpenses 防禦慣例）', async () => {
  const sb = makeBalanceSupabase([
    { id: '1', entity: '丸十', type: 'deposit', amount: 10000 },
    { id: '2', entity: '丸十', type: 'expense', amount: 120 },
    { id: '3', entity: '丸十', type: 'expense', amount: 9999, deleted: true }, // 已刪，不算
  ]);
  const wh = loadWebhook(sb.client);
  const r = await wh.getPettyCashBalance('丸十');
  assert.equal(r.expense, 120, '已標 deleted 的 9999 不可算進支出');
  assert.equal(r.balance, 9880);
});

// ====================== 任務3／4：handler 主體閘門靜默 ======================
test('閘門：未設定主體群組打 #補錢 → 靜默 null、不寫 DB', async () => {
  const sb = makeBalanceSupabase([]); // 無 group_entity_map（select kv 回 null）
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-unknown', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenTopup(event, '補錢 10000', 'focus:G-unknown');
  assert.equal(reply, null, '未設定主體應回 null（靜默）');
  assert.equal(sb._expenses().length, 0, '不可寫入任何記帳');
});

test('閘門：未設定主體群組打 #餘額 → 靜默 null', async () => {
  const sb = makeBalanceSupabase([]);
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-unknown', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenBalance(event);
  assert.equal(reply, null, '未設定主體應回 null（靜默）');
});

// ====================== 已設定主體：handler 行為（recorder 入庫／餘額失敗誠實／負數提示）======================
// 較完整的可觀測假 supabase：支援 xlan_kv（entity 閘門）、記錄 inserts、可注入「餘額查詢拋錯」。
//   seed.kv             : { key: value }（放 group_entity_map 讓 getEntityForGroup 取到主體）
//   seed.expenses       : 既有列（getPettyCashBalance 的 select 會讀）
//   seed.failBalanceSelect: true → xlan_expenses 帶 entity 過濾的 select 一律拋錯（模擬餘額查詢失敗）
function makeTopupSupabase(seed = {}) {
  const kv = new Map(Object.entries(seed.kv || {}));
  let expenses = [...(seed.expenses || [])];
  const log = { inserts: [] };
  function from(table) {
    const b = {
      _op: null, _row: null, _f: {},
      insert(r) { this._op = 'insert'; this._row = r; return this; },
      upsert(r) { this._op = 'upsert'; this._row = r; return this; },
      update(r) { this._op = 'update'; this._row = r; return this; },
      delete() { this._op = 'delete'; return this; },
      select() { if (!this._op) this._op = 'select'; return this; },
      eq(c, v) { this._f[c] = v; return this; },
      order() { return this; }, limit() { return this; }, not() { return this; },
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
          if (this._op === 'select') {
            // getPettyCashBalance 走「.eq('entity', x)」的 select；要模擬餘額查詢失敗：
            // 比照 Supabase 真實行為「不 throw，回 { data:null, error }」，讓 getPettyCashBalance 的
            // `if (error) throw` 在自身 scope 拋出 → 確實傳到 handler 的 try/catch。
            if (seed.failBalanceSelect && this._f.entity !== undefined) {
              return single ? { data: null, error: { message: 'balance query boom' } } : { data: null, error: { message: 'balance query boom' } };
            }
            let out = expenses;
            if (this._f.entity !== undefined) out = out.filter((e) => e.entity === this._f.entity);
            if (this._f.type !== undefined) out = out.filter((e) => e.type === this._f.type);
            return single ? { data: out[0] || null, error: null } : { data: out, error: null };
          }
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return b;
  }
  return { client: { from }, log, _expenses: () => expenses };
}

// getLineDisplayName 會打 LINE API（global.fetch）。測試時暫時 stub 成回固定 displayName，跑完還原。
async function withFakeDisplayName(name, fn) {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ displayName: name }) });
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
}

const MARUTEN_KV = { group_entity_map: JSON.stringify({ 'G-maruten': '丸十' }) };

test('P1 recorder：補錢成功 → insert 的 row 帶 recorder（記錄人持久化）', async () => {
  const sb = makeTopupSupabase({ kv: MARUTEN_KV, expenses: [] });
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U-zhang' }, message: { type: 'text' } };
  const reply = await withFakeDisplayName('小張', () => wh.handleMarutenTopup(event, '補錢 10000', 'focus:G-maruten'));

  assert.equal(sb.log.inserts.length, 1, '應寫一筆補入');
  const row = sb.log.inserts[0];
  assert.equal(row.type, 'deposit');
  assert.equal(row.entity, '丸十');
  assert.equal(row.amount, 10000);
  assert.equal(row.recorder, '小張', 'recorder 必須入庫（事後查得到是誰補的）');
  assert.ok(Array.isArray(reply) && reply.length >= 1);
  assert.match(reply[0].text, /已補入/);
  assert.match(reply[0].text, /小張/);
});

test('P1 餘額失敗不捏造：補錢成功但 getPettyCashBalance 拋錯 → 回誠實訊息、卡片無假數字', async () => {
  // 既有已有 50000 補入；本次再補 1000。若餘額查詢失敗，舊版會謊報「餘額 1000」。
  const sb = makeTopupSupabase({
    kv: MARUTEN_KV,
    expenses: [{ id: 'old', entity: '丸十', type: 'deposit', amount: 50000 }],
    failBalanceSelect: true,
  });
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await withFakeDisplayName('阿明', () => wh.handleMarutenTopup(event, '補錢 1000', 'focus:G-maruten'));

  assert.equal(sb.log.inserts.length, 1, '補入仍要成功寫入');
  assert.equal(sb.log.inserts[0].recorder, '阿明');
  const text = reply[0].text;
  assert.match(text, /已補入 NT\$1,000/, '應誠實說已補入本次金額');
  assert.match(text, /餘額暫時查詢失敗/, '餘額查不到要明說，不能給數字');
  assert.doesNotMatch(text, /目前餘額 NT\$1,000/, '絕不可把本次補入額當成總餘額謊報');
  // 卡片餘額欄不放假數字
  const flex = reply[1];
  const flexStr = JSON.stringify(flex);
  assert.match(flexStr, /暫時查詢失敗/, '卡片餘額欄應標示查詢失敗');
  assert.doesNotMatch(flexStr, /目前餘額[^]*NT\$ 1,000/, '卡片不可顯示假餘額');
});

test('P1 handler 負數：「#補錢 NT$ -1000」已設定主體 → 回用法提示、不寫 DB', async () => {
  const sb = makeTopupSupabase({ kv: MARUTEN_KV, expenses: [] });
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await withFakeDisplayName('小張', () => wh.handleMarutenTopup(event, '補錢 NT$ -1000', 'focus:G-maruten'));
  assert.equal(sb.log.inserts.length, 0, '負數不可入帳');
  assert.equal(reply[0].text, '補錢格式：#補錢 <金額>，例如 #補錢 10000');
});

test('P1 handler 負數2：「#補錢 現金 -1000」→ 回用法提示、不寫 DB', async () => {
  const sb = makeTopupSupabase({ kv: MARUTEN_KV, expenses: [] });
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await withFakeDisplayName('小張', () => wh.handleMarutenTopup(event, '補錢 現金 -1000', 'focus:G-maruten'));
  assert.equal(sb.log.inserts.length, 0);
  assert.equal(reply[0].text, '補錢格式：#補錢 <金額>，例如 #補錢 10000');
});

test('P1 handler 0：「#補錢 0」→ 回用法提示、不寫 DB', async () => {
  const sb = makeTopupSupabase({ kv: MARUTEN_KV, expenses: [] });
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await withFakeDisplayName('小張', () => wh.handleMarutenTopup(event, '補錢 0', 'focus:G-maruten'));
  assert.equal(sb.log.inserts.length, 0);
  assert.equal(reply[0].text, '補錢格式：#補錢 <金額>，例如 #補錢 10000');
});

test('P2 千分位＋超支：餘額為負時純文字含千分位與「已超支」提示', async () => {
  // 既有支出 12,000、補入 10,000 → 餘額 -2,000（超支）。本次再補 5,000 → 餘額 3,000（轉正）。
  // 改測「查餘額」直接看負餘額格式：先補一筆很小、讓餘額為負。
  const sb = makeTopupSupabase({
    kv: MARUTEN_KV,
    expenses: [
      { id: 'd', entity: '丸十', type: 'deposit', amount: 10000 },
      { id: 'e', entity: '丸十', type: 'expense', amount: 12000 },
    ],
  });
  const wh = loadWebhook(sb.client);
  const event = { source: { type: 'group', groupId: 'G-maruten', userId: 'U1' }, message: { type: 'text' } };
  const reply = await wh.handleMarutenBalance(event);
  const text = reply[0].text;
  assert.match(text, /-2,000/, '負餘額要有千分位');
  assert.match(text, /已超支/, '負餘額要標已超支');
});

// ====================== P1 回歸：deposit 不污染既有帳務查詢（getExpenses）======================
// getExpenses 是「本月記帳」明細／摘要／清空待刪／盤點帳務區的共同來源。
// 排除 deposit 後：(a) deposit 不出現在結果；(b) 沒有 deposit 資料時，結果與排除前一模一樣（expense/income 行為不變）。
function makeGetExpensesSupabase(rows) {
  const data = [...rows];
  function from(table) {
    const b = {
      _op: null, _f: {}, _notDeleted: false, _neqType: null,
      select() { if (!this._op) this._op = 'select'; return this; },
      eq(c, v) { this._f[c] = v; return this; },
      gte() { return this; },
      order() { return this; },
      not(col, op, val) { if (col === 'deleted') this._notDeleted = true; void op; void val; return this; },
      neq(col, val) { if (col === 'type') this._neqType = val; return this; },
      then(res, rej) { return this._run().then(res, rej); },
      async _run() {
        if (table === 'xlan_expenses' && this._op === 'select') {
          let out = data;
          if (this._notDeleted) out = out.filter((e) => e.deleted !== true);
          if (this._neqType !== null) out = out.filter((e) => e.type !== this._neqType);
          return { data: out, error: null };
        }
        return { data: [], error: null };
      },
    };
    return b;
  }
  return { client: { from }, _appliedNeqType: () => true };
}

test('P1 deposit 不污染：getExpenses 結果排除 type=deposit（不被當支出列出）', async () => {
  const sb = makeGetExpensesSupabase([
    { id: '1', type: 'expense', amount: 120, account: 'business', created_at: new Date().toISOString() },
    { id: '2', type: 'income', amount: 500, account: 'personal', created_at: new Date().toISOString() },
    { id: '3', type: 'deposit', amount: 10000, account: 'business', entity: '丸十', created_at: new Date().toISOString() },
  ]);
  const wh = loadWebhook(sb.client);
  const out = await wh.getExpenses('this_month');
  assert.ok(out.every((e) => e.type !== 'deposit'), 'deposit 不可出現在既有帳務查詢結果');
  assert.equal(out.length, 2, '只剩 expense 與 income');
});

test('P1 回歸：沒有 deposit 資料時，getExpenses 結果與排除前一模一樣（不誤傷 expense/income）', async () => {
  const rows = [
    { id: '1', type: 'expense', amount: 120, account: 'business', created_at: '2026-06-20T00:00:00.000Z' },
    { id: '2', type: 'income', amount: 500, account: 'personal', created_at: '2026-06-21T00:00:00.000Z' },
    { id: '3', type: 'expense', amount: 80, account: 'personal', created_at: '2026-06-22T00:00:00.000Z' },
  ];
  const sb = makeGetExpensesSupabase(rows);
  const wh = loadWebhook(sb.client);
  const out = await wh.getExpenses('this_month');
  assert.deepEqual(out, rows, '無 deposit 時結果應與原始列完全一致');
});

// ====================== P1 回歸：saveExpense 不帶 recorder 時不寫該欄（既有呼叫不受影響）======================
test('P1 回歸：saveExpense 未帶 recorder → row 不含 recorder 鍵（比照 entity 有值才寫）', async () => {
  const sb = makeTopupSupabase({ kv: {}, expenses: [] });
  const wh = loadWebhook(sb.client);
  await wh.saveExpense({ amount: 120, category: '餐費', type: 'expense', account: 'business' });
  assert.equal(sb.log.inserts.length, 1);
  assert.equal('recorder' in sb.log.inserts[0], false, '不帶 recorder 就不該寫該欄（既有 #支出／私訊記帳不受影響）');
});

test('P1：saveExpense 帶 recorder → row 含 recorder', async () => {
  const sb = makeTopupSupabase({ kv: {}, expenses: [] });
  const wh = loadWebhook(sb.client);
  await wh.saveExpense({ amount: 10000, category: '零用金補入', type: 'deposit', account: 'business', entity: '丸十', recorder: '小張' });
  assert.equal(sb.log.inserts[0].recorder, '小張');
});
