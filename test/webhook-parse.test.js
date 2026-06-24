// 丸十支出機器人 v0.2 修正驗證 —— webhook.js 純文字解析函數測試。
//
// 對應審查報告：
//   P2-1 「#支出明細 100」「#支出表在哪 120」不應被當記帳
//   P2-2 「元氣早餐 120」不應被截成「氣早餐」
//   並回歸：正常 #支出 仍能解析、向後相容（不誤吃 #回報／#待辦）
//
// 跑法：node --test test/
// require webhook.js 會在頂層 createClient(SUPABASE_URL,...)；測試只用純函數、不呼叫 handler，
// 故先塞假 env 讓 createClient 建物件即可（不會真連線）。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const stubs = require('./_stubs');

// 攔截外部套件 require（不需安裝 node_modules、不連外部服務）。
stubs.install();

// 先設假環境變數，避免 require 時 createClient 因缺 URL 拋錯。
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { __test__ } = require(path.join(__dirname, '..', 'api', 'webhook.js'));
const { parseMarutenExpenseText, isMarutenExpenseTrigger } = __test__;

// ---------- P2-2：項目含「元」字不被截斷 ----------
test('P2-2：「元氣早餐 120」項目應完整保留為「元氣早餐」', () => {
  const r = parseMarutenExpenseText('支出 元氣早餐 120');
  assert.ok(r, '應解析成功');
  assert.equal(r.amount, 120);
  assert.equal(r.note, '元氣早餐', '不可被截成「氣早餐」');
});

test('P2-2：金額尾綴「元」仍正確移除，項目不殘留「元」', () => {
  const r = parseMarutenExpenseText('支出 便當 120元');
  assert.ok(r);
  assert.equal(r.amount, 120);
  assert.equal(r.note, '便當', '金額後的「元」應隨金額 token 一起去掉');
});

test('P2-2：項目本身含「元」的多字詞（一元復始 50）保留', () => {
  const r = parseMarutenExpenseText('支出 一元復始 50');
  assert.ok(r);
  assert.equal(r.amount, 50);
  assert.equal(r.note, '一元復始');
});

// ---------- P2-1：查詢句不被當記帳 ----------
test('P2-1：「#支出明細 100」不應觸發記帳', () => {
  assert.equal(isMarutenExpenseTrigger('#支出明細 100'), false);
});

test('P2-1：「#支出表在哪 120」不應觸發記帳', () => {
  assert.equal(isMarutenExpenseTrigger('#支出表在哪 120'), false);
});

test('P2-1：「#支出清單」「#支出統計」不應觸發記帳', () => {
  assert.equal(isMarutenExpenseTrigger('#支出清單'), false);
  assert.equal(isMarutenExpenseTrigger('#支出統計'), false);
});

// ---------- 正常記帳仍要能觸發 ----------
test('正常：「#支出 便當 120」應觸發記帳', () => {
  assert.equal(isMarutenExpenseTrigger('#支出 便當 120'), true);
});

test('正常：無空白黏著「#支出便當120」應觸發記帳', () => {
  assert.equal(isMarutenExpenseTrigger('#支出便當120'), true);
});

test('正常：只打「#支出」應觸發（走用法提示分支）', () => {
  assert.equal(isMarutenExpenseTrigger('#支出'), true);
});

// ---------- 向後相容：不誤吃其他指令 ----------
test('相容：「#回報 少3」不應被當丸十支出', () => {
  assert.equal(isMarutenExpenseTrigger('#回報 少3'), false);
});

test('相容：「#待辦 買貨」不應被當丸十支出', () => {
  assert.equal(isMarutenExpenseTrigger('#待辦 買貨'), false);
});

test('相容：非 # 開頭（私訊隱式記帳那套）不應被丸十觸發', () => {
  assert.equal(isMarutenExpenseTrigger('便當 120'), false);
});
