// 丸十支出 LIFF 表單版（切片二）—— maruten-expense-form.js 後端純函數測試。
//
// 對應實作計畫任務1 的驗證要求：
//   - 金額必須 > 0 的數字（後端自驗，不只信前端）
//   - 分類必須在 EXPENSE_CATEGORIES 清單內（餐飲/進貨食材/運費/雜支/水電/其他）
//   - 項目（note）必填
//   - 收據照超過上限要截斷（不報錯）
//   - 中／英文欄位名都接受（前端送中文 key：分類/項目/金額/備註/收據照）
//
// 跑法：node --test test/  （Node 內建 test runner，零外部依賴）
// 主體擋下（未設定群組不記＋不可 fallback 丸十）的 P0 行為，因牽涉 supabase/Google，
// 在 webhook-flow.test.js 以流程層驗證（handleMarutenExpense）；本檔聚焦可純測的欄位驗證。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const stubs = require('./_stubs');
stubs.install();

// 先塞假 env，避免 require 時 createClient 因缺 URL 拋錯（form.js 頂層會建 supabase）。
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const formPath = require.resolve(path.join(__dirname, '..', 'api', 'maruten-expense-form.js'));
delete require.cache[formPath];
const { __test__ } = require(formPath);
const { validateExpenseForm, EXPENSE_CATEGORIES, MAX_RECEIPT_PHOTOS } = __test__;

test('分類清單＝餐飲/進貨食材/運費/雜支/水電/其他（與需求單一致）', () => {
  assert.deepEqual(EXPENSE_CATEGORIES, ['餐飲', '進貨食材', '運費', '雜支', '水電', '其他']);
});

test('正常：中文 key 表單 → 通過，欄位正規化正確', () => {
  const r = validateExpenseForm({ 分類: '餐飲', 項目: '員工便當', 金額: 120, 備註: '付現', 收據照: ['data:image/jpeg;base64,AAA='] });
  assert.equal(r.ok, true);
  assert.equal(r.value.category, '餐飲');
  assert.equal(r.value.note, '員工便當');
  assert.equal(r.value.amount, 120);
  assert.equal(r.value.memo, '付現');
  assert.equal(r.value.photos.length, 1);
});

test('正常：金額帶逗號字串「1,234」→ 解析為 1234', () => {
  const r = validateExpenseForm({ 分類: '進貨食材', 項目: '青菜一批', 金額: '1,234' });
  assert.equal(r.ok, true);
  assert.equal(r.value.amount, 1234);
});

test('擋下：缺分類 → 不通過', () => {
  const r = validateExpenseForm({ 項目: '便當', 金額: 100 });
  assert.equal(r.ok, false);
  assert.match(r.error, /分類/);
});

test('擋下：分類不在清單（亂填）→ 不通過', () => {
  const r = validateExpenseForm({ 分類: '亂分類', 項目: '便當', 金額: 100 });
  assert.equal(r.ok, false);
  assert.match(r.error, /清單/);
});

test('擋下：缺項目 → 不通過', () => {
  const r = validateExpenseForm({ 分類: '餐飲', 金額: 100 });
  assert.equal(r.ok, false);
  assert.match(r.error, /項目/);
});

test('擋下：金額為 0 → 不通過（後端自驗，不只信前端）', () => {
  const r = validateExpenseForm({ 分類: '餐飲', 項目: '便當', 金額: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /金額/);
});

test('擋下：金額為負數 → 不通過', () => {
  const r = validateExpenseForm({ 分類: '餐飲', 項目: '便當', 金額: -50 });
  assert.equal(r.ok, false);
});

test('擋下：金額非數字「abc」→ 不通過', () => {
  const r = validateExpenseForm({ 分類: '餐飲', 項目: '便當', 金額: 'abc' });
  assert.equal(r.ok, false);
  assert.match(r.error, /金額/);
});

test('照片超過上限 → 截到 MAX_RECEIPT_PHOTOS 張（不報錯）', () => {
  const many = Array.from({ length: MAX_RECEIPT_PHOTOS + 3 }, (_, i) => `data:image/jpeg;base64,IMG${i}`);
  const r = validateExpenseForm({ 分類: '雜支', 項目: '雜物', 金額: 30, 收據照: many });
  assert.equal(r.ok, true);
  assert.equal(r.value.photos.length, MAX_RECEIPT_PHOTOS);
});

test('照片非陣列（誤傳字串）→ 視為無照片，不報錯', () => {
  const r = validateExpenseForm({ 分類: '雜支', 項目: '雜物', 金額: 30, 收據照: 'not-an-array' });
  assert.equal(r.ok, true);
  assert.equal(r.value.photos.length, 0);
});

test('相容：英文 key（category/note/amount/memo/receiptPhotos）也接受', () => {
  const r = validateExpenseForm({ category: '運費', note: '宅配', amount: 80, memo: 'x', receiptPhotos: [] });
  assert.equal(r.ok, true);
  assert.equal(r.value.category, '運費');
  assert.equal(r.value.note, '宅配');
  assert.equal(r.value.amount, 80);
});
