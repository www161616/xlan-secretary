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

test('補錢解析：負數「#補錢 -100」→ null（正則只抓正數，負號被當雜符）', () => {
  // 需求：金額沒填／填 0 或負 → 不亂記。負號不在金額 token 內，故 -100 會被抓成 100？
  // 防呆：解析層對「-」開頭的金額視為無效（見實作），確保不會把負數記成正數補入。
  assert.equal(parseMarutenTopupText('補錢 -100'), null);
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
