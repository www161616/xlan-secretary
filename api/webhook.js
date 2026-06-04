const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// --- 環境變數 ---
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const STAFF_REPORT_SPREADSHEET_ID = process.env.STAFF_REPORT_SPREADSHEET_ID;
const STAFF_REPORT_IMAGE_FOLDER_ID = process.env.STAFF_REPORT_IMAGE_FOLDER_ID;
const STAFF_REPORT_SHEET_NAME = process.env.STAFF_REPORT_SHEET_NAME || '員工問題回報';
const STAFF_REPORT_ORDER_SHEET_NAME = process.env.STAFF_REPORT_ORDER_SHEET_NAME || '所有訂單';
const STAFF_REPORT_GROUP_ID = process.env.STAFF_REPORT_GROUP_ID;
const STAFF_LIFF_ID = process.env.STAFF_LIFF_ID; // 員工回報 LIFF 表單的 LIFF ID（選填，有設卡片就會出現「開表單」按鈕）

const CARD_THEME = {
  page: '#FFFBEB',
  panel: '#FFFFFF',
  soft: '#FEF3C7',
  line: '#FCD34D',
  primary: '#F59E0B',
  primaryDark: '#92400E',
  text: '#1F2937',
  muted: '#6B7280',
  success: '#16A34A',
  danger: '#DC2626',
  info: '#2563EB',
};

// --- 初始化 ---
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Google Calendar ---
function getCalendarClient() {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

function getGoogleOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getGoogleOAuthClient() });
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getGoogleOAuthClient() });
}

async function createCalendarEvent({ title, date, time, duration_minutes, location, description }) {
  const calendar = getCalendarClient();
  const duration = duration_minutes || 60;

  let event;
  if (time) {
    const startDateTime = `${date}T${time}:00+08:00`;
    const endMs = new Date(`${date}T${time}:00+08:00`).getTime() + duration * 60 * 1000;
    const endDateTime = new Date(endMs).toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
    event = {
      summary: title,
      start: { dateTime: startDateTime, timeZone: 'Asia/Taipei' },
      end: { dateTime: endDateTime, timeZone: 'Asia/Taipei' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    };
  } else {
    event = {
      summary: title,
      start: { date },
      end: { date },
    };
  }

  if (location) event.location = location;
  if (description) event.description = description;

  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });

  // 同步寫入 xlan_events
  await supabase.from('xlan_events').insert({
    title,
    date,
    time: time || null,
    location: location || null,
    description: description || null,
  });

  return res.data;
}

// --- 記帳功能 ---
async function saveExpense({ amount, category, note, type, account }) {
  const { data, error } = await supabase.from('xlan_expenses').insert({
    amount,
    category,
    note: note || null,
    type: type || 'expense',
    account: account || 'personal',
  }).select();
  if (error) throw new Error(error.message);
  return data[0];
}

const EXPENSE_FOCUS_TTL_MS = 2 * 60 * 60 * 1000;

function expenseFocusKey(sourceKey) {
  return `expense_focus:${sourceKey}`;
}

async function saveExpenseFocus(sourceKey, expense) {
  if (!sourceKey || !expense?.id) return;
  await supabase.from('xlan_kv').upsert({
    key: expenseFocusKey(sourceKey),
    value: JSON.stringify({ id: expense.id, updated_at: new Date().toISOString() }),
  });
}

async function clearExpenseFocus(sourceKey) {
  if (!sourceKey) return;
  await supabase.from('xlan_kv').delete().eq('key', expenseFocusKey(sourceKey));
}

async function loadExpenseFocus(sourceKey) {
  if (!sourceKey) return null;
  const { data } = await supabase.from('xlan_kv').select('value').eq('key', expenseFocusKey(sourceKey)).single();
  if (!data?.value) return null;

  let focus;
  try {
    focus = JSON.parse(data.value);
  } catch {
    return null;
  }

  const updatedAt = new Date(focus.updated_at || 0).getTime();
  if (!focus.id || !Number.isFinite(updatedAt) || Date.now() - updatedAt > EXPENSE_FOCUS_TTL_MS) return null;

  const { data: expense, error } = await supabase
    .from('xlan_expenses')
    .select('*')
    .eq('id', focus.id)
    .single();
  if (error || !expense) return null;
  return expense;
}

const EXPENSE_DUP_FOCUS_TTL_MS = 10 * 60 * 1000;

function expenseDupFocusKey(sourceKey) {
  return `expense_dup_focus:${sourceKey}`;
}

async function saveExpenseDupFocus(sourceKey, ids, sample) {
  if (!sourceKey || !Array.isArray(ids) || ids.length === 0) return;
  await supabase.from('xlan_kv').upsert({
    key: expenseDupFocusKey(sourceKey),
    value: JSON.stringify({
      ids,
      category: sample?.category || '',
      amount: sample?.amount ?? '',
      updated_at: new Date().toISOString(),
    }),
  });
}

async function clearExpenseDupFocus(sourceKey) {
  if (!sourceKey) return;
  await supabase.from('xlan_kv').delete().eq('key', expenseDupFocusKey(sourceKey));
}

async function loadExpenseDupFocus(sourceKey) {
  if (!sourceKey) return null;
  const { data } = await supabase.from('xlan_kv').select('value').eq('key', expenseDupFocusKey(sourceKey)).single();
  if (!data?.value) return null;
  let focus;
  try {
    focus = JSON.parse(data.value);
  } catch {
    return null;
  }
  const updatedAt = new Date(focus.updated_at || 0).getTime();
  if (!Array.isArray(focus.ids) || focus.ids.length === 0 || !Number.isFinite(updatedAt) || Date.now() - updatedAt > EXPENSE_DUP_FOCUS_TTL_MS) {
    return null;
  }
  return focus;
}

// 把上一筆刪除後偵測到的「重複同項」一次清掉
async function deleteDuplicateExpenses(sourceKey) {
  const focus = await loadExpenseDupFocus(sourceKey);
  if (!focus) return '沒有待清理的重複記帳（可能超過 10 分鐘了）。你可以先「今天帳務」看清單再處理。';
  const { data, error } = await supabase
    .from('xlan_expenses')
    .delete()
    .in('id', focus.ids)
    .select();
  await clearExpenseDupFocus(sourceKey);
  if (error) throw new Error(error.message);
  const count = Array.isArray(data) ? data.length : 0;
  if (count === 0) return '那些重複記帳已經不在了，不用再清。';
  return `已清掉 ${count} 筆重複的${focus.category ? `「${focus.category} NT$${focus.amount}」` : '記帳'}。`;
}

// --- 批次清空某期間的記帳（兩段式確認，避免誤刪）---
const EXPENSE_BULK_FOCUS_TTL_MS = 5 * 60 * 1000;
const EXPENSE_PERIOD_LABELS = { today: '今天', this_week: '本週', this_month: '本月' };

function expenseBulkFocusKey(sourceKey) {
  return `expense_bulk_focus:${sourceKey}`;
}

async function saveBulkExpenseFocus(sourceKey, ids, label) {
  if (!sourceKey || !Array.isArray(ids) || ids.length === 0) return;
  await supabase.from('xlan_kv').upsert({
    key: expenseBulkFocusKey(sourceKey),
    value: JSON.stringify({ ids, label: label || '', updated_at: new Date().toISOString() }),
  });
}

async function clearBulkExpenseFocus(sourceKey) {
  if (!sourceKey) return;
  await supabase.from('xlan_kv').delete().eq('key', expenseBulkFocusKey(sourceKey));
}

async function loadBulkExpenseFocus(sourceKey) {
  if (!sourceKey) return null;
  const { data } = await supabase.from('xlan_kv').select('value').eq('key', expenseBulkFocusKey(sourceKey)).single();
  if (!data?.value) return null;
  let focus;
  try {
    focus = JSON.parse(data.value);
  } catch {
    return null;
  }
  const updatedAt = new Date(focus.updated_at || 0).getTime();
  if (!Array.isArray(focus.ids) || focus.ids.length === 0 || !Number.isFinite(updatedAt) || Date.now() - updatedAt > EXPENSE_BULK_FOCUS_TTL_MS) {
    return null;
  }
  return focus;
}

// 第一段：告知數量與合計，存待刪清單，等使用者回「確定清空」
async function requestClearExpenses(sourceKey, period = 'today') {
  const label = EXPENSE_PERIOD_LABELS[period] || '今天';
  const expenses = await getExpenses(period);
  if (expenses.length === 0) {
    await clearBulkExpenseFocus(sourceKey);
    return `${label}沒有記帳，不用清。`;
  }
  const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  await saveBulkExpenseFocus(sourceKey, expenses.map((e) => e.id), label);
  return `${label}有 ${expenses.length} 筆記帳（合計 NT$${total}）。確定要全部清掉嗎？\n回「確定清空」就刪，回別的就當取消。`;
}

// 第二段：真正刪除
async function confirmClearExpenses(sourceKey) {
  const focus = await loadBulkExpenseFocus(sourceKey);
  if (!focus) return '沒有待清空的記帳（可能超過 5 分鐘了）。要清的話先說「清空今天記帳」。';
  const { data, error } = await supabase.from('xlan_expenses').delete().in('id', focus.ids).select();
  await clearBulkExpenseFocus(sourceKey);
  if (error) throw new Error(error.message);
  const count = Array.isArray(data) ? data.length : 0;
  if (count === 0) return '那些記帳已經不在了，不用再清。';
  return `已清空${focus.label || ''} ${count} 筆記帳。`;
}

async function getExpenses(period) {
  const now = new Date();
  let startDate;

  if (period === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'this_week') {
    const day = now.getDay() || 7;
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const { data } = await supabase
    .from('xlan_expenses')
    .select('*')
    .gte('created_at', startDate.toISOString())
    .order('created_at', { ascending: false });

  return data || [];
}

async function updateExpenseAccount(expenseId, account) {
  const { data, error } = await supabase
    .from('xlan_expenses')
    .update({ account })
    .eq('id', expenseId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  const label = account === 'business' ? '公司' : '私人';
  return `已改成${label}帳：${data.category} NT$${data.amount}`;
}

async function deleteExpense(expenseId, sourceKey = '') {
  const { data, error } = await supabase
    .from('xlan_expenses')
    .delete()
    .eq('id', expenseId)
    .select();
  if (error) throw new Error(error.message);
  const deleted = Array.isArray(data) ? data[0] : data;
  if (!deleted) return '找不到那筆記帳，可能已經刪掉了。';

  // 驗證：刪完再查一次，確認那筆真的不見了（香奈遇過「說刪了卻還在」）
  const { data: stillThere } = await supabase
    .from('xlan_expenses')
    .select('id')
    .eq('id', expenseId);
  if (stillThere && stillThere.length > 0) {
    return `⚠️ 嘗試刪除「${deleted.category} NT$${deleted.amount}」但它還在，可能有權限或同步問題，請再試一次或到後台確認。`;
  }

  // 偵測重複同項（同類別/金額/收支/帳戶/備註），主動提醒可一起清掉
  let dupNote = '';
  const { data: candidates } = await supabase
    .from('xlan_expenses')
    .select('id, note')
    .eq('category', deleted.category)
    .eq('amount', deleted.amount)
    .eq('type', deleted.type)
    .eq('account', deleted.account);
  const normNote = (n) => String(n ?? '').trim();
  const dupIds = (candidates || [])
    .filter((row) => normNote(row.note) === normNote(deleted.note))
    .map((row) => row.id);
  if (dupIds.length > 0) {
    if (sourceKey) {
      await saveExpenseDupFocus(sourceKey, dupIds, deleted);
      dupNote = `\n⚠️ 另外還有 ${dupIds.length} 筆一模一樣的（${deleted.category} NT$${deleted.amount}）。如果是重複記的，回「刪掉重複」可一起清掉。`;
    } else {
      dupNote = `\n⚠️ 另外還有 ${dupIds.length} 筆一模一樣的（${deleted.category} NT$${deleted.amount}），可到清單逐筆處理。`;
    }
  } else if (sourceKey) {
    await clearExpenseDupFocus(sourceKey);
  }

  return `已刪除記帳：${deleted.category} NT$${deleted.amount}${dupNote}`;
}

async function getLatestExpense() {
  const { data, error } = await supabase
    .from('xlan_expenses')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error || !data) return null;
  return data;
}

async function updateLatestExpenseAccount(account) {
  const latest = await getLatestExpense();
  if (!latest) return '找不到最近一筆記帳。';
  return updateExpenseAccount(latest.id, account);
}

async function deleteLatestExpense(sourceKey = '') {
  const latest = await getLatestExpense();
  if (!latest) return '找不到最近一筆記帳。';
  return deleteExpense(latest.id, sourceKey);
}

async function updateLatestExpenseCategory(category) {
  const latest = await getLatestExpense();
  if (!latest) return '找不到最近一筆記帳。';
  const { data, error } = await supabase
    .from('xlan_expenses')
    .update({ category })
    .eq('id', latest.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return `已改分類：${data.category} NT$${data.amount}`;
}

async function updateExpenseCategory(expenseId, category) {
  const { data, error } = await supabase
    .from('xlan_expenses')
    .update({ category })
    .eq('id', expenseId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return `已改分類：${data.category} NT$${data.amount}`;
}

async function buildExpenseSummary(period = 'this_month') {
  const expenses = await getExpenses(period);
  const label = { today: '今天', this_week: '本週', this_month: '本月' }[period] || '本月';
  if (expenses.length === 0) return `${label}沒有記帳資料。`;
  const sum = (items, type, account) => items
    .filter((e) => e.type === type && (!account || e.account === account))
    .reduce((total, e) => total + Number(e.amount || 0), 0);
  const personalExpense = sum(expenses, 'expense', 'personal');
  const businessExpense = sum(expenses, 'expense', 'business');
  const income = sum(expenses, 'income');
  const expense = sum(expenses, 'expense');
  const top = expenses.slice(0, 5).map((e, i) => {
    const account = e.account === 'business' ? '公司' : '私人';
    const type = e.type === 'income' ? '收入' : '支出';
    return `${i + 1}. ${account}${type} ${e.category} NT$${e.amount}${e.note ? `（${e.note}`.slice(0, 28) + '）' : ''}`;
  }).join('\n');
  return `${label}記帳摘要\n收入：NT$${income}\n支出：NT$${expense}\n私人支出：NT$${personalExpense}\n公司支出：NT$${businessExpense}\n\n最近5筆：\n${top}`;
}

function buildExpenseQuickActionFlex(latestExpense, periodLabel = '今天') {
  const latestText = latestExpense
    ? `最近一筆：${latestExpense.category} NT$${latestExpense.amount}`
    : '目前沒有最近一筆可修正。';
  const latestId = latestExpense?.id || null;
  return {
    type: 'flex',
    altText: `${periodLabel}帳務快捷卡片`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: CARD_THEME.page,
        spacing: 'md',
        contents: [
          { type: 'text', text: `${periodLabel}帳務處理`, weight: 'bold', size: 'lg', color: CARD_THEME.primaryDark },
          { type: 'text', text: latestText, size: 'sm', color: CARD_THEME.text, wrap: true },
          { type: 'text', text: '如果最近一筆分類或公司/私人錯了，可以直接點。', size: 'xs', color: CARD_THEME.muted, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                height: 'sm',
                style: 'primary',
                color: CARD_THEME.primary,
                action: { type: 'message', label: '算公司', text: latestId ? `記帳:${latestId}:公司` : '最近一筆算公司' },
              },
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '算私人', text: latestId ? `記帳:${latestId}:私人` : '最近一筆算私人' },
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '改分類', text: latestId ? `記帳:${latestId}:分類` : '最近一筆分類' },
              },
              {
                type: 'button',
                height: 'sm',
                color: CARD_THEME.danger,
                action: { type: 'message', label: '刪除', text: latestId ? `記帳:${latestId}:刪除` : '刪除最近一筆記帳' },
              },
            ],
          },
        ],
      },
    },
  };
}

async function buildExpenseSummaryReplyMessages(period = 'this_month', focusKey = '') {
  const text = await buildExpenseSummary(period);
  const expenses = await getExpenses(period);
  const label = { today: '今天', this_week: '本週', this_month: '本月' }[period] || '本月';
  const messages = [{ type: 'text', text }];
  if (expenses.length > 0) {
    await saveExpenseFocus(focusKey, expenses[0]);
    messages.push(buildExpenseQuickActionFlex(expenses[0], label));
  }
  return messages;
}

async function resolveFocusedExpenseReply(text, sourceKey) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const expense = await loadExpenseFocus(sourceKey);
  if (!expense) return null;

  if (/^(算公司|公司|公司帳|改公司|改成公司|這筆算公司|這個算公司|這筆要算公司|這個要算公司|這筆改公司|這個改公司)$/.test(raw)) {
    await saveExpenseFocus(sourceKey, expense);
    return [{ type: 'text', text: await updateExpenseAccount(expense.id, 'business') }];
  }
  if (/^(算私人|私人|私人帳|個人|個人帳|改私人|改成私人|這筆算私人|這個算私人|這筆要算私人|這個要算私人|這筆改私人|這個改私人)$/.test(raw)) {
    await saveExpenseFocus(sourceKey, expense);
    return [{ type: 'text', text: await updateExpenseAccount(expense.id, 'personal') }];
  }
  if (/^(分類|改分類)$/.test(raw)) {
    await saveExpenseFocus(sourceKey, expense);
    return [buildExpenseCategoryFlex(expense.id)];
  }
  if (/^(分類|改分類)(.+)$/.test(raw)) {
    const match = raw.match(/^(分類|改分類)(.+)$/);
    await saveExpenseFocus(sourceKey, expense);
    return [{ type: 'text', text: await updateExpenseCategory(expense.id, match[2].trim()) }];
  }
  if (/^(刪掉|刪除|刪除這筆|取消這筆|記錯了|不要記)$/.test(raw)) {
    const result = await deleteExpense(expense.id, sourceKey);
    await clearExpenseFocus(sourceKey);
    return [{ type: 'text', text: result }];
  }

  return null;
}

function inferExpenseCategory(text, type = 'expense') {
  const raw = String(text || '');
  if (type === 'income') {
    if (/貨款|營收|收入|收款/.test(raw)) return '業務收入';
    if (/退款|退費/.test(raw)) return '其他';
    return '業務收入';
  }
  if (/早餐|午餐|晚餐|飲料|餐|便當|咖啡/.test(raw)) return '餐飲';
  if (/車資|油|加油|停車|高鐵|火車|計程車|uber|運費/.test(raw)) return '交通';
  if (/進貨|採購|貨款|廠商/.test(raw)) return '進貨';
  if (/門市|店租|店/.test(raw)) return '門市';
  if (/薪資|薪水|工資/.test(raw)) return '薪資';
  if (/水電|電費|水費|瓦斯|網路|電話/.test(raw)) return '水電';
  if (/醫療|看醫生|藥/.test(raw)) return '醫療';
  if (/娛樂|電影|遊戲/.test(raw)) return '娛樂';
  if (/買|購物/.test(raw)) return '購物';
  return '其他';
}

function parseSimpleExpenseText(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 48 || /https?:\/\//i.test(raw)) return null;
  if (/(多少|幾筆|摘要|帳務|收支|查詢|清單|網址|系統|運單|單號)/.test(raw)) return null;
  if (/(月薪|薪資承諾|薪水承諾)/.test(raw)) return null;
  // 含刪除/移除/清掉等字眼是「要刪帳」不是「要記帳」，絕不可再記一筆
  if (/(刪|移除|清空|清掉|取消這筆|不要記|不用記|記錯)/.test(raw)) return null;
  // 小瀾自己的摘要行（「私人支出 餐飲 NT$210（買飲料）」）被貼回來時，不可當成新記帳
  if (/^(私人支出|公司支出|私人收入|公司收入)/.test(raw)) return null;

  const amountMatch = raw.match(/(?:NT\$?|[$＄])?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\s*元)?/i);
  if (!amountMatch) return null;
  const amount = Number(String(amountMatch[1]).replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const hasIncomeSignal = /(收入|收款|收到|入帳|營收|貨款|退款|退費)/.test(raw);
  const hasExpenseSignal = /(花|買|付款|付|支出|消費|刷卡|匯款|繳|進貨|採購|早餐|午餐|晚餐|飲料|餐|停車|加油|車資|運費|包材|水電|房租|店租|付薪資|發薪資|薪資支出)/.test(raw);
  if (!hasIncomeSignal && !hasExpenseSignal) return null;

  const type = hasIncomeSignal && !/(付款|付|支出|花|買|進貨|採購)/.test(raw) ? 'income' : 'expense';
  const category = inferExpenseCategory(raw, type);
  const account = /(進貨|廠商|貨款|門市|包材|薪資|水電|房租|店租|運費|業務|公司)/.test(raw)
    ? 'business'
    : 'personal';
  const note = raw.replace(amountMatch[0], '').replace(/元/g, '').trim() || raw;
  return { amount, category, note, type, account };
}

async function handleSimpleExpenseText(text, focusKey = '') {
  const parsed = parseSimpleExpenseText(text);
  if (!parsed) return null;
  const savedExpense = await saveExpense(parsed);
  await saveExpenseFocus(focusKey, savedExpense);
  const flex = buildExpenseFlexMessage({
    id: savedExpense.id,
    amount: parsed.amount,
    category: parsed.category,
    note: parsed.note,
    type: parsed.type,
    account: parsed.account,
    label: '快速記帳',
  });
  const accountLabel = parsed.account === 'business' ? '公司' : '私人';
  return [
    { type: 'text', text: `已記帳：${parsed.type === 'income' ? '收入' : '支出'} ${parsed.category} NT$${parsed.amount}（${accountLabel}）` },
    flex,
  ];
}

function isBriefingCommand(text) {
  return /^(盤點|任務盤點|幫我整理一下|幫我排一下|幫我排順序|排優先順序|今天要做什麼|今天先做什麼|先做什麼|先做哪個|哪個先做|我現在該做什麼|有什麼事|現在要做什麼|下一步|下一步做什麼|優先順序|今天重點)$/.test(String(text || '').trim());
}

function classifyTextIntent(text, context = {}) {
  const raw = String(text || '').trim();
  const mode = context.mode || 'direct';
  if (!raw) return { intent: 'empty', confidence: 1, route: 'ignore', reason: 'empty_text' };

  if (mode === 'group' && !/^[#＃]/.test(raw) && !context.cleaned) {
    return { intent: 'group_noise', confidence: 1, route: 'ignore', reason: 'group_without_hash' };
  }

  if (isStaffReportTrigger(raw)) return { intent: 'staff_report', confidence: 1, route: 'staff_report', reason: 'staff_report_trigger' };
  if (/^待辦:[0-9a-f-]{32,36}:/i.test(raw)) return { intent: 'todo_action', confidence: 1, route: 'fast', reason: 'todo_callback' };
  if (/^記帳:[0-9a-f-]+:/i.test(raw)) return { intent: 'expense_action', confidence: 1, route: 'fast', reason: 'expense_callback' };
  if (/^(待辦|清單|檢查待辦|任務清單)$/.test(raw)) return { intent: 'todo_list', confidence: 1, route: 'fast', reason: 'todo_list_command' };
  if (parseTodoPlanningScope(raw)) return { intent: 'todo_planning', confidence: 1, route: 'fast', reason: 'todo_planning_question' };
  if (isBriefingCommand(raw)) {
    return { intent: 'briefing', confidence: 1, route: 'fast', reason: 'briefing_command' };
  }
  if (/^(工作報告|今天報告|今日報告|本週報告|這週報告|週報)$/.test(raw)) return { intent: 'work_report', confidence: 1, route: 'fast', reason: 'work_report_command' };
  if (parseNaturalTodoAction(raw)) return { intent: 'todo_update', confidence: 0.95, route: 'fast', reason: 'natural_todo_action' };
  if (parseSimpleExpenseText(raw)) return { intent: 'expense_save', confidence: 0.9, route: 'fast', reason: 'simple_expense' };
  if (/^(本月記帳摘要|本月帳務|本月記帳|本月帳目|本月收支|本月開銷|本月花費|本月支出|這個月帳務|這個月記帳|這個月花多少|今天記帳摘要|今天帳務|今天記帳|今天帳目|今天收支|今天開銷|今天花費|今天花多少|今天花了多少|今日帳務|今日記帳|本週記帳摘要|本週帳務|本週記帳|本週帳目|本週收支|本週開銷|本週花費|這週帳務|這週記帳|這週花多少)$/.test(raw)) {
    return { intent: 'expense_query', confidence: 1, route: 'fast', reason: 'expense_query_command' };
  }
  if (/(改成|改為|更新成|更新為|換成|換為).*(https?:\/\/)|https?:\/\/.*(改成|改為|更新成|更新為|換成|換為)/i.test(raw)) {
    return { intent: 'memory_update', confidence: 0.9, route: 'memory', reason: 'url_update' };
  }
  if (/(不用記了|不用記|不要記了|不要記|刪掉|刪除|忘掉|忘記)/.test(raw) && /(網址|網站|筆記|資料|電話|系統|承諾|規格|帳號|密碼)/.test(raw)) {
    return { intent: 'memory_delete', confidence: 0.85, route: 'memory', reason: 'memory_delete' };
  }
  if (/^(我的連結|常用連結|所有連結|所有網址|我的網址|連結清單|網址清單|連結列表|網址列表)$/.test(raw)) {
    return { intent: 'url_list', confidence: 1, route: 'memory', reason: 'url_list_command' };
  }
  // 部署清單：列全部、記錄、查詢
  if (/^(我的部署|所有部署|部署清單|部署列表|所有機器人|我的機器人|機器人清單|機器人列表)$/.test(raw)) {
    return { intent: 'deploy_list', confidence: 1, route: 'memory', reason: 'deploy_list_command' };
  }
  if (/^(記部署|記錄部署|新增部署|加部署|登記部署|部署記錄)/.test(raw) ||
      (/(部署|部屬)/.test(raw) && /^(記|記一下|幫我記|新增|加|登記)/.test(raw))) {
    return { intent: 'todo_or_tool', confidence: 0.9, route: 'claude_tool', reason: 'deploy_save' };
  }
  if (/(部署|部屬)/.test(raw)) {
    return { intent: 'deploy_query', confidence: 0.78, route: 'memory', reason: 'deploy_query' };
  }
  if (/https?:\/\//i.test(raw)) return { intent: 'memory_save', confidence: 0.85, route: 'memory', reason: 'url_save' };
  // 明確的儲存意圖（記錄/記住/下次回傳）要先攔，否則含「帳號/密碼」會被下面的查詢規則搶走，變成吐舊筆記
  if (/(記錄|記住|記下|記一下|幫我記|先記|存起來|存一下)/.test(raw) ||
      (/(下次|以後|之後|每次)/.test(raw) && /(回傳|回覆|回我|告訴|給我|提供)/.test(raw))) {
    return { intent: 'todo_or_tool', confidence: 0.85, route: 'claude_tool', reason: 'explicit_memory_save' };
  }
  if (/網址|網站|連結|link|url|資料|在哪|哪裡|電話|帳號|密碼|有沒有記|規格|承諾/i.test(raw)) {
    return { intent: 'memory_query', confidence: 0.78, route: 'memory', reason: 'business_memory_query' };
  }
  if (/(以後|下次|之後|不要|別再|不能|不是|不對|錯了|應該|要改成|要當|不要當)/.test(raw)) {
    return { intent: 'correction', confidence: 0.72, route: 'memory', reason: 'correction_language' };
  }
  if (/(提醒|每天\d{1,2}點|[0-9一二三四五六七八九十]+點叫我)/.test(raw)) return { intent: 'reminder', confidence: 0.75, route: 'claude_tool', reason: 'reminder_language' };
  if (/(幫我|記得|提醒我|確認|處理|安排|通知|打電話|問|追|做|買|付款|上架|拍照)/.test(raw)) {
    return { intent: 'todo_or_tool', confidence: 0.65, route: 'claude_tool', reason: 'action_language' };
  }
  if (/[?？]|怎麼|為什麼|可以嗎|是多少|查一下|分析|建議/.test(raw)) return { intent: 'question', confidence: 0.65, route: 'claude', reason: 'question_language' };
  return { intent: 'chat', confidence: 0.45, route: 'claude', reason: 'fallback' };
}

// --- LINE 下載圖片 ---
async function downloadLineImage(messageId) {
  const buffer = await downloadLineImageBuffer(messageId);
  return buffer.toString('base64');
}

async function downloadLineImageBuffer(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --- Flex Message：記帳卡片 ---
function buildExpenseFlexMessage({ id, amount, category, note, type, account, label }) {
  const isIncome = type === 'income';
  const accentColor = isIncome ? CARD_THEME.success : CARD_THEME.primary;
  const typeText = isIncome ? '收入' : '支出';
  const accountText = account === 'business' ? '公司' : '私人';
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return {
    type: 'flex',
    altText: `${typeText} NT$${amount} - ${category}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: CARD_THEME.page,
        paddingAll: '20px',
        spacing: 'sm',
        contents: [
          ...(label ? [{
            type: 'box',
            layout: 'horizontal',
            backgroundColor: CARD_THEME.soft,
            paddingAll: '8px',
            contents: [{
              type: 'text',
              text: label,
              size: 'xxs',
              color: CARD_THEME.primaryDark,
              weight: 'bold',
            }],
            justifyContent: 'flex-end',
          }] : []),
          {
            type: 'text',
            text: `${typeText}・${accountText}`,
            size: 'sm',
            color: accentColor,
            weight: 'bold',
          },
          {
            type: 'text',
            text: `NT$ ${amount.toLocaleString()}`,
            size: 'xxl',
            weight: 'bold',
            color: CARD_THEME.primaryDark,
            margin: 'sm',
          },
          {
            type: 'separator',
            margin: 'lg',
            color: CARD_THEME.line,
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '類別', size: 'sm', color: CARD_THEME.muted, flex: 2 },
                  { type: 'text', text: category, size: 'sm', color: CARD_THEME.text, flex: 5, weight: 'bold' },
                ],
              },
              ...(note ? [{
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '備註', size: 'sm', color: CARD_THEME.muted, flex: 2 },
                  { type: 'text', text: note, size: 'sm', color: CARD_THEME.text, flex: 5, wrap: true },
                ],
              }] : []),
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '時間', size: 'sm', color: CARD_THEME.muted, flex: 2 },
                  { type: 'text', text: now, size: 'sm', color: CARD_THEME.text, flex: 5 },
                ],
              },
            ],
          },
          {
            type: 'text',
            text: '✓ 已記錄',
            size: 'xs',
            color: accentColor,
            align: 'end',
            margin: 'lg',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: account === 'business' ? 'primary' : 'secondary',
                height: 'sm',
                color: account === 'business' ? CARD_THEME.primary : undefined,
                action: { type: 'message', label: '公司', text: id ? `記帳:${id}:公司` : '最近一筆算公司' },
              },
              {
                type: 'button',
                style: account === 'personal' ? 'primary' : 'secondary',
                height: 'sm',
                color: account === 'personal' ? CARD_THEME.primary : undefined,
                action: { type: 'message', label: '私人', text: id ? `記帳:${id}:私人` : '最近一筆算私人' },
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '分類', text: id ? `記帳:${id}:分類` : '最近一筆分類' },
              },
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '本月摘要', text: '本月記帳摘要' },
              },
            ],
          },
          {
            type: 'button',
            height: 'sm',
            color: CARD_THEME.danger,
            action: { type: 'message', label: '刪除這筆', text: id ? `記帳:${id}:刪除` : '刪除最近一筆記帳' },
          },
        ],
      },
    },
  };
}

function buildExpenseCategoryFlex(expenseId) {
  const categories = ['餐飲', '交通', '購物', '進貨', '門市', '薪資', '水電', '醫療', '娛樂', '其他'];
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: categories.slice(i, i + 2).map((category) => ({
        type: 'button',
        height: 'sm',
        style: 'secondary',
        action: { type: 'message', label: category, text: expenseId ? `記帳:${expenseId}:分類:${category}` : `最近一筆分類${category}` },
      })),
    });
  }

  return {
    type: 'flex',
    altText: '選擇記帳分類',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: CARD_THEME.page,
        spacing: 'md',
        contents: [
          { type: 'text', text: '選擇分類', weight: 'bold', size: 'lg', color: CARD_THEME.primaryDark },
          { type: 'text', text: '這會更新剛剛那筆記帳。', size: 'sm', color: CARD_THEME.muted, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: rows,
      },
    },
  };
}

// --- System Prompt ---
const SYSTEM_PROMPT = `【回覆規則】
1. 絕對不可以主動說明如何把Bot加進群組
2. 絕對不可以說「直接把我加進LINE群組就可以了」
3. 絕對不可以用「沒錯」「對」「好的」「當然可以」「你說得沒錯」這種寒暄或認同句作為開頭；第一句直接回答問題或給結論
4. 收到「完成」「已完成」「做好了」「處理好了」這類訊息，如果能從訊息判斷是哪一件待辦，就一定要呼叫 complete_todo 標記完成；不能判斷是哪一件時也要呼叫 complete_todo 並讓系統產生候選卡片
5. 回覆要簡短直接，不要超過3行，除非用戶需要詳細資訊
6. LINE 不支援 Markdown，不要使用 **粗體**、反引號、標題符號或 Markdown 連結；網址直接貼純文字。
7. 香奈問「明天有什麼要做」「今天要做什麼」時，只回答待辦/建議；不要補充 LINE 群組、Webhook、如何使用小瀾等設定說明。

【對話環境規則，最重要】
- 私訊一對一：香奈是在直接跟你說話，可以自然對話、記錄、查詢、分析、看圖、記帳，不需要 # 關鍵字。
- 群組：只有訊息以 # 或 ＃ 開頭時才代表叫你做事；沒有 # 的群組訊息一律不要回覆、不要記錄、不要判斷待辦。
- 群組中 #回報 是員工缺貨/破損回報；#待辦 或 #其他內容 才進一般秘書功能。
- 回答時要符合目前環境：私訊可以像秘書主動整理；群組只處理該則 # 指令，不延伸處理其他聊天內容。

你是「小瀾」，香奈的專屬 AI 秘書。
香奈是包子媽生鮮小舖的負責人，旗下有 16 個門市（中和、文山、龍潭、林口、永和、平鎮、經國、古華、南平等），
同時負責管理 LT-ERP 系統、樂樂團購平台、各門市帳務與薪資。

【小瀾系統資訊】
- 後台網址：https://xlan-secretary.vercel.app
- LINE Webhook：https://xlan-secretary.vercel.app/webhook
- GitHub 專案：www161616/xlan-secretary
- 員工回報 Google Sheet 分頁：員工問題回報
只有當香奈明確詢問「小瀾後台」「小瀾 webhook」「LINE webhook」「小瀾網址」時，才回答上述小瀾系統資訊。
如果香奈問「新系統網址」「薪資系統網址」「ERP網址」「包子媽系統網址」這類業務系統網址，不可以回答小瀾 webhook，必須呼叫 get_notes 查筆記。

你的工作原則：
- 繁體中文回答，親切簡潔
- 幫香奈記錄、整理、分析任何事情
- 回答問題、草擬文字、計算數字都可以
- 重要資訊用條列式整理，不廢話
- 香奈喜歡黃色系、精緻、乾淨、有質感的 UI；卡片或視覺回覆優先用暖黃色、琥珀色、奶油白、深棕灰文字。

【最重要的規則 — 待辦 vs 記事 判斷】
待辦（save_todo）= 需要執行的動作，有動詞：去、打、買、確認、回覆、處理、安排、記得、幫、叫、通知。
例如：「去銀行」「打電話給廠商」「幫各店送菜單」「確認龍潭付款」
priority 判斷：
- urgent：老闆交辦、bug、付款到期、有「馬上」「緊急」「立刻」
- important：有截止日期、陸貨相關、到期3天內
- normal：其他
source_person：誰交辦的（從訊息判斷，沒有就填 null）

記事（save_note）= 需要記住的資訊，不是動作：薪資承諾、聯絡資料、密碼帳號、重要數字、規格。
例如：「盈君月薪5000」「林口電話0912xxx」
承諾記事一律存 save_note，tags 加 ["承諾"]。

不確定時：有動詞選待辦，是資訊選記事。
存完待辦回覆「✅ 已記錄：{待辦內容}」，存完記事回覆「📝 已記錄筆記」。
如果一則訊息包含多個待辦，每個都要存，每個都要確認。
如果訊息只是聊天、問問題、打招呼，就正常回覆，不要存待辦。

【Google 行事曆自動記錄】
當用戶提到任何有時間或日期的行程、會議、約定、提醒，自動呼叫 create_calendar_event 建到 Google Calendar。
建完回覆「📅 已加入行事曆：{行程名稱} / {日期時間}」。
沒有明確日期時，詢問用戶是哪一天。
今天是 ${new Date().toISOString().split('T')[0]}（用來推算「明天」「下週一」等相對日期）。

【記帳功能】
當用戶提到花費、消費、付款、收入、匯款等金錢相關訊息，自動呼叫 save_expense 記錄。
類別從以下選一個最接近的：餐飲、交通、購物、娛樂、醫療、水電、薪資、業務收入、其他。
note 填用戶的原始說法摘要。
type 判斷：花錢/付款/買東西 = expense，收到錢/營收/薪資入帳 = income。
account 判斷：提到廠商名稱、進貨、業務往來、門市費用 = business；日常餐飲、交通、個人購物 = personal。不確定時預設 personal，但告知用戶可以說「這筆算公司的」修改。
存完回覆格式：「💰 已記帳：{類別} NT$\{金額\}（{私人/公司}）」。

當用戶問「今天花了多少」「這週收支」「這個月帳目」等，呼叫 get_expenses 查詢。
查詢結果用條列式回覆，包含總收入、總支出、淨額、各筆明細。

【筆記功能】
當用戶說「記一下」「備忘」「筆記」「記住」等，或提到重要資訊但不是待辦也不是帳務，呼叫 save_note 儲存。
如果內容包含網址，呼叫 save_note 儲存，content 必須包含「名稱 + 網址 + 用途」。存完只回覆「📝 已記錄：{名稱}」，不要補充任何建議。
其他筆記存完回覆「📝 已記錄筆記」。
tags 根據內容自動分類，例如 ["業務","門市"]、["個人"]、["ERP"] 等。
當用戶說「查筆記」「看筆記」「之前記了什麼」，呼叫 get_notes 列出筆記，不要問用戶問題。
當用戶問「某某網址是多少」「之前給你的網址」「某某資料在哪」「你有沒有記某某」時，先呼叫 get_notes，用最明確的關鍵字查詢；例如「新系統網址」查「新系統」，「薪資系統網址」查「薪資系統」。
當用戶說「某某不用記了」「某某刪掉」「不要記某某」，呼叫 delete_note。
當用戶說「某某改成...」「某某更新成...」「某某網址換成...」，呼叫 update_note。
如果查到筆記，直接回答筆記內容；不要說「我沒有記到」。
不要在已完成記錄或查詢後補充不相關提醒、加入群組說明或操作建議。

【部署清單】
香奈有很多機器人/系統，分散在 NAS、Vercel、GitHub、Cloudflare 等不同地方，部署方式也不一樣。
當香奈說「記部署」「登記部署」或描述某台機器人部署在哪、程式碼在哪、怎麼改怎麼部署時，呼叫 save_deployment 記下來。
盡量把 platform（平台）、code_location（程式碼位置）、deploy_method（部署/修改方式）、url（網址）都填齊；香奈沒講的欄位就留空，不要亂編。
同一台機器人名稱再記一次會自動更新覆蓋，不會重複。
當香奈問「X 部署在哪」「X 怎麼改」「列出所有機器人/部署」時呼叫 get_deployment（要列全部就 keyword 留空）。
存完只回覆「📝 已記錄部署：{名稱}」或「✅ 已更新部署：{名稱}」，不要補充建議。

【定期付款】
當用戶提到「每個月」「每年」「固定」「定期」付款或費用，呼叫 save_recurring 儲存。
存完回覆「🔁 已設定定期提醒：{名稱} 每月{N}號 NT$\{金額\}」。
account 判斷同記帳規則。

【自訂提醒】
你就是小瀾 Bot，你有 set_reminder tool 可以設定提醒。
當用戶說任何「提醒」「X點叫我」「每天X點」相關的話，
立刻呼叫 set_reminder tool，hour 填對應的小時（24小時制），
絕對不可以叫用戶去手機設鬧鐘或找工程師，
你自己就能做到。

【完成與延後】
當用戶說「完成」「辦完了」「OK了」「處理好了」，如果有提到待辦關鍵字，例如「龍潭付款完成」「菜單好了」「廠商回覆了」，呼叫 complete_todo。
如果只說「完成」但沒有目標，不要假裝完成，要呼叫 complete_todo，讓系統列出候選待辦卡片給用戶點選。
當用戶說「延後」「明天再做」「下週再處理」，如果有提到待辦關鍵字，呼叫 postpone_todo。
當用戶說「不用做」「取消」「刪掉」「不用管了」，如果有提到待辦關鍵字，呼叫 delete_todo。

【待辦狀態更新】
當用戶自然描述待辦狀態時，要呼叫 mark_todo_status，不要新增一筆待辦。
- 「先等」「等老闆」「等廠商」「等回覆」「對方還沒回」→ status 填「等待回覆」
- 「做到一半」「先做一半」「還沒完全好」「半完成」→ status 填「半完成」
- 「正在做」「處理中」「已經開始」→ status 填「進行中」
- 「還沒做」「沒完成」「今天沒做完」→ status 填「未完成」
keyword 填事情本身的關鍵字，例如「舒肥雞文案先等老闆」填「舒肥雞文案」，「招牌圖做到一半」填「招牌圖」。

【Bug 追蹤】
群組或私訊中出現「壞了」「不能用」「出錯」「bug」「error」「異常」，
自動呼叫 save_bug 記錄，回覆「🐛 已記錄 bug：{描述}，我會追蹤這個問題」。
當用戶說「XXX修好了」「XXX好了」「fix了」，呼叫 fix_bug 標記修復。

【優先待辦】
當用戶問「今天先做什麼」「優先順序」「今天重點」，呼叫 get_priority_todos。

【陸貨追蹤】
當用戶提到「陸貨」「預計到貨」「幾號到」，呼叫 save_shipment 記錄。
存完回覆「📦 已記錄到貨追蹤：{title} 預計 {date}」。
當用戶說「陸貨到了」「XXX到了」，呼叫 arrive_shipment 標記已到。
當用戶問「陸貨到了沒」「貨況」，呼叫 get_shipments 查詢。

【應付款】
當用戶說「要付XXX多少錢」「撥款給XXX」「付給龍潭XXX元」，
呼叫 save_payable 記錄，回覆「💸 已記錄應付款：付給{to_whom} NT$\{amount\}」。

【廠商管理】
當用戶提到廠商聯絡資訊、付款條件，呼叫 save_vendor 儲存。
當用戶問「XXX廠商電話是多少」「XXX付款條件」，呼叫 get_vendor 查詢。

【專案管理】
當用戶說「XXX專案」並列出多件要做的事，
必須呼叫 create_project tool，不可以用 save_todo 逐一存入。
create_project 會自動把工作項目存為待辦並關聯到專案。
判斷標準：訊息裡有「專案」兩個字，或是列出多件相關工作。
例如：「舒肥雞上架專案，要拍照、做圖文、上架」→ 呼叫 create_project
tasks 陣列由 AI 根據用戶說的事情拆分，可以補充合理的子項目。

當用戶問「XXX做到哪了」「XXX進度」「XXX專案狀況」，
呼叫 get_project_status 查詢進度條。

【Bug 與付款查詢】
當用戶說「待修bug清單」「有哪些bug」，呼叫 get_pending_bugs。
當用戶說「有哪些待付款」「付款清單」，呼叫 get_pending_payables。`;

// --- Tool 定義 ---
const SAVE_TODO_TOOL = {
  name: 'save_todo',
  description: '將待辦事項存入清單。當用戶提到任何需要執行的動作時使用。',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '待辦事項摘要，繁體中文，20字以內' },
      priority: { type: 'string', enum: ['urgent', 'important', 'normal'], description: 'urgent=緊急, important=重要, normal=一般' },
      source_person: { type: ['string', 'null'], description: '誰交辦的，沒有就 null' },
    },
    required: ['task'],
  },
};

const COMPLETE_TODO_TOOL = {
  name: 'complete_todo',
  description: '標記待辦事項完成。當用戶說某件事完成、處理好了、OK了、已辦完時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '用來搜尋待辦的關鍵字，例如「龍潭付款」「菜單」「廠商」；如果完全沒有目標就填空字串' },
    },
    required: ['keyword'],
  },
};

const DELETE_TODO_TOOL = {
  name: 'delete_todo',
  description: '刪除或取消待辦事項。當用戶說某件事不用做了、取消、刪掉、不用管了時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '用來搜尋待辦的關鍵字，例如「龍潭付款」「菜單」「廠商」；如果完全沒有目標就填空字串' },
    },
    required: ['keyword'],
  },
};

const POSTPONE_TODO_TOOL = {
  name: 'postpone_todo',
  description: '延後待辦事項。當用戶說某件事明天做、下週做、延後到某日期時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '用來搜尋待辦的關鍵字，例如「龍潭付款」「菜單」「廠商」；如果完全沒有目標就填空字串' },
      due_text: { type: 'string', description: '用戶說的延後時間，例如「明天」「下週一」「6/5」「2026-06-05」' },
    },
    required: ['keyword', 'due_text'],
  },
};

const MARK_TODO_STATUS_TOOL = {
  name: 'mark_todo_status',
  description: '用關鍵字更新待辦狀態。當用戶說某件事正在做、做到一半、等待回覆、未完成時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '用來搜尋待辦的關鍵字，例如「舒肥雞文案」「招牌圖」「薪資系統」；如果完全沒有目標就填空字串' },
      status: { type: 'string', enum: ['進行中', '半完成', '等待回覆', '未完成'], description: '要更新的待辦狀態' },
    },
    required: ['keyword', 'status'],
  },
};

const CREATE_CALENDAR_EVENT_TOOL = {
  name: 'create_calendar_event',
  description: '建立 Google Calendar 行程。當用戶提到有日期或時間的行程、會議、約定時使用。',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '行程名稱' },
      date: { type: 'string', description: '日期，格式 YYYY-MM-DD' },
      time: { type: ['string', 'null'], description: '時間，格式 HH:MM。沒有明確時間填 null' },
      duration_minutes: { type: 'number', description: '持續時間（分鐘），預設 60' },
      location: { type: 'string', description: '地點（可選）' },
      description: { type: 'string', description: '備註（可選）' },
    },
    required: ['title', 'date'],
  },
};

const SAVE_EXPENSE_TOOL = {
  name: 'save_expense',
  description: '記錄一筆收入或支出。當用戶提到花費、消費、付款、收入等金錢相關訊息時使用。',
  input_schema: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: '金額，正整數' },
      category: { type: 'string', description: '類別：餐飲、交通、購物、娛樂、醫療、水電、薪資、業務收入、其他' },
      note: { type: 'string', description: '備註，用戶的原始說法摘要' },
      type: { type: 'string', enum: ['expense', 'income'], description: 'expense=支出, income=收入' },
      account: { type: 'string', enum: ['personal', 'business'], description: 'personal=私人, business=公司' },
    },
    required: ['amount', 'category', 'type'],
  },
};

const GET_EXPENSES_TOOL = {
  name: 'get_expenses',
  description: '查詢收支記錄。當用戶問「今天花了多少」「這週收支」「這個月帳目」等問題時使用。',
  input_schema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'this_week', 'this_month'], description: '查詢期間' },
    },
    required: ['period'],
  },
};

const GET_NOTES_TOOL = {
  name: 'get_notes',
  description: '查詢筆記記錄。當用戶說「查筆記」「看筆記」「之前記了什麼」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '關鍵字搜尋，沒有就留空字串' },
    },
    required: [],
  },
};

const SAVE_NOTE_TOOL = {
  name: 'save_note',
  description: '記錄一則筆記、備忘或重要資訊。當用戶說「記一下」「備忘」「筆記」「記住」等時使用。',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '筆記內容' },
      tags: { type: 'array', items: { type: 'string' }, description: '標籤，例如 ["業務","門市"]' },
    },
    required: ['content'],
  },
};

const UPDATE_NOTE_TOOL = {
  name: 'update_note',
  description: '更新既有筆記。當用戶說某個網址、資料、規則、承諾「改成」「更新成」「換成」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '要搜尋舊筆記的關鍵字，例如「新系統」「薪資系統」「林口電話」' },
      content: { type: 'string', description: '更新後完整筆記內容，繁體中文；如果是網址，必須包含名稱與網址' },
      tags: { type: 'array', items: { type: 'string' }, description: '標籤，例如 ["網址","ERP"]' },
    },
    required: ['keyword', 'content'],
  },
};

const DELETE_NOTE_TOOL = {
  name: 'delete_note',
  description: '刪除既有筆記。當用戶說某個資料不用記、刪掉、不要記了時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '要刪除的筆記關鍵字，例如「新系統」「薪資系統」「林口電話」' },
    },
    required: ['keyword'],
  },
};

const SAVE_DEPLOYMENT_TOOL = {
  name: 'save_deployment',
  description: '記錄或更新一台機器人/系統的部署資訊。當香奈說「記部署」「這個機器人部署在...」「登記部署」並提供平台、程式碼位置、部署方式、網址等資訊時使用。同名會自動更新覆蓋。',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '機器人或系統名稱，例如「小瀾」「匯洲機器人」「集運系統」' },
      platform: { type: 'string', description: '部署平台，例如 Vercel、NAS、Cloudflare、GitHub Pages、Render' },
      code_location: { type: 'string', description: '程式碼位置，例如 GitHub repo 網址、NAS 路徑、本機資料夾' },
      deploy_method: { type: 'string', description: '部署或修改方式，例如「push 到 main 自動部署」「NAS 手動重啟容器」「跑 deploy.sh」' },
      url: { type: 'string', description: '線上網址或 Webhook，沒有可留空' },
      note: { type: 'string', description: '其他備註，例如環境變數位置、注意事項' },
    },
    required: ['name'],
  },
};

const GET_DEPLOYMENT_TOOL = {
  name: 'get_deployment',
  description: '查詢機器人/系統的部署資訊。香奈問「X 部署在哪」「X 怎麼改」「列出所有部署/機器人」時使用。keyword 留空代表列出全部。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '機器人名稱關鍵字，例如「小瀾」「匯洲」；要列全部就留空' },
    },
    required: [],
  },
};

const SAVE_RECURRING_TOOL = {
  name: 'save_recurring',
  description: '儲存定期付款或固定費用提醒。當用戶提到「每個月」「每年」「固定」「定期」付款時使用。',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '名稱，例如「房租」「信用卡」' },
      amount: { type: ['number', 'null'], description: '金額，不確定可為 null' },
      account: { type: 'string', enum: ['personal', 'business'], description: 'personal=私人, business=公司' },
      frequency: { type: 'string', enum: ['monthly', 'yearly'], description: '頻率' },
      day_of_month: { type: 'number', description: '幾號，1-31' },
      month_of_year: { type: ['number', 'null'], description: '幾月，yearly 才需要，1-12' },
      note: { type: 'string', description: '備註' },
    },
    required: ['title', 'frequency', 'day_of_month'],
  },
};

const SET_REMINDER_TOOL = {
  name: 'set_reminder',
  description: '設定自訂每日提醒時間。當用戶說「每天X點提醒我」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      hour: { type: 'number', description: '幾點（0-23）' },
      label: { type: 'string', description: '提醒標籤，例如「下午提醒」「晚間總結」' },
    },
    required: ['hour', 'label'],
  },
};

const SAVE_BUG_TOOL = {
  name: 'save_bug',
  description: '記錄 ERP 或系統 bug。當有人回報功能壞掉、不能用、出錯時使用。',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'bug 描述' },
      reporter: { type: ['string', 'null'], description: '回報人' },
      source_group: { type: ['string', 'null'], description: '來源群組' },
    },
    required: ['description'],
  },
};

const FIX_BUG_TOOL = {
  name: 'fix_bug',
  description: '標記 bug 已修復。當用戶說「XXX修好了」「fix了」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'bug 關鍵字，用來搜尋對應的 bug' },
    },
    required: ['keyword'],
  },
};

const GET_PRIORITY_TODOS_TOOL = {
  name: 'get_priority_todos',
  description: '取得今日優先待辦清單，依緊急程度排序。當用戶問「今天先做什麼」「優先順序」時使用。',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const SAVE_SHIPMENT_TOOL = {
  name: 'save_shipment',
  description: '記錄陸貨或貨物到貨追蹤。當用戶提到「陸貨」「到貨」「預計幾號到」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '貨物名稱或描述' },
      expected_date: { type: 'string', description: '預計到貨日，格式 YYYY-MM-DD' },
      note: { type: 'string', description: '備註' },
    },
    required: ['title', 'expected_date'],
  },
};

const ARRIVE_SHIPMENT_TOOL = {
  name: 'arrive_shipment',
  description: '標記貨物已到貨。當用戶說「陸貨到了」「XXX到了」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '貨物關鍵字' },
    },
    required: ['keyword'],
  },
};

const GET_SHIPMENTS_TOOL = {
  name: 'get_shipments',
  description: '查詢陸貨追蹤狀態。當用戶問「陸貨到了沒」「貨況」時使用。',
  input_schema: { type: 'object', properties: {} },
};

const SAVE_PAYABLE_TOOL = {
  name: 'save_payable',
  description: '記錄應付款項。當用戶說「要付XXX多少錢」「撥款給XXX」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '付款說明' },
      amount: { type: ['number', 'null'], description: '金額' },
      to_whom: { type: 'string', description: '付給誰' },
      due_date: { type: ['string', 'null'], description: '到期日 YYYY-MM-DD' },
      note: { type: 'string', description: '備註' },
    },
    required: ['title', 'to_whom'],
  },
};

const SAVE_VENDOR_TOOL = {
  name: 'save_vendor',
  description: '儲存廠商資料。當用戶提到「廠商」「供應商」並說明聯絡資訊時使用。',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '廠商名稱' },
      contact_person: { type: 'string', description: '聯絡人' },
      phone: { type: 'string', description: '電話' },
      payment_terms: { type: 'string', description: '付款條件，例如「月結30天」' },
      note: { type: 'string', description: '備註' },
    },
    required: ['name'],
  },
};

const GET_VENDOR_TOOL = {
  name: 'get_vendor',
  description: '查詢廠商資料。當用戶問「XXX廠商的電話」「XXX付款條件」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '廠商名稱關鍵字' },
    },
    required: ['keyword'],
  },
};

const CREATE_PROJECT_TOOL = {
  name: 'create_project',
  description: '建立新專案並自動拆分工作項目。當用戶提到「XXX專案」並列出要做的事情時使用。',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '專案名稱' },
      description: { type: 'string', description: '專案說明' },
      tasks: { type: 'array', items: { type: 'string' }, description: '工作項目清單' },
    },
    required: ['name', 'tasks'],
  },
};

const GET_PROJECT_STATUS_TOOL = {
  name: 'get_project_status',
  description: '查詢專案進度。當用戶問「XXX做到哪了」「XXX專案進度」時使用。',
  input_schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '專案名稱關鍵字' },
    },
    required: ['keyword'],
  },
};

const GET_PENDING_BUGS_TOOL = {
  name: 'get_pending_bugs',
  description: '查詢待修 bug 清單。當用戶說「待修bug清單」「有哪些bug」時使用。',
  input_schema: { type: 'object', properties: {} },
};

const GET_PENDING_PAYABLES_TOOL = {
  name: 'get_pending_payables',
  description: '查詢待付款清單。當用戶說「有哪些待付款」「付款清單」時使用。',
  input_schema: { type: 'object', properties: {} },
};

const ALL_TOOLS = [SAVE_TODO_TOOL, COMPLETE_TODO_TOOL, DELETE_TODO_TOOL, POSTPONE_TODO_TOOL, MARK_TODO_STATUS_TOOL, CREATE_CALENDAR_EVENT_TOOL, SAVE_EXPENSE_TOOL, GET_EXPENSES_TOOL, SAVE_NOTE_TOOL, GET_NOTES_TOOL, UPDATE_NOTE_TOOL, DELETE_NOTE_TOOL, SAVE_DEPLOYMENT_TOOL, GET_DEPLOYMENT_TOOL, SAVE_RECURRING_TOOL, SET_REMINDER_TOOL, SAVE_BUG_TOOL, FIX_BUG_TOOL, GET_PRIORITY_TODOS_TOOL, SAVE_SHIPMENT_TOOL, ARRIVE_SHIPMENT_TOOL, GET_SHIPMENTS_TOOL, SAVE_PAYABLE_TOOL, SAVE_VENDOR_TOOL, GET_VENDOR_TOOL, CREATE_PROJECT_TOOL, GET_PROJECT_STATUS_TOOL, GET_PENDING_BUGS_TOOL, GET_PENDING_PAYABLES_TOOL];

// --- LINE 簽名驗證 ---
function validateSignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// --- LINE 回覆訊息（支援 text 或 flex message 陣列）---
function sanitizeLineText(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 $2');
}

function stripOpeningFiller(text) {
  let cleaned = String(text || '').trim();
  for (let i = 0; i < 3; i += 1) {
    cleaned = cleaned.replace(/^(沒錯|對|對啊|是的|好的|好喔|可以|當然可以|了解|明白)[！!，,。.\s]+/u, '').trim();
    cleaned = cleaned.replace(/^你說得沒錯[！!，,。.\s]+/u, '').trim();
  }
  return cleaned;
}

function userAskedBotSetup(text) {
  return /(加進|加入|邀請|群組|LINE\s*群|webhook|Webhook|後台|設定|機器人網址|小瀾網址)/i.test(String(text || ''));
}

function stripUnaskedGroupSetupAdvice(replyText, userText) {
  if (userAskedBotSetup(userText)) return replyText;
  const paragraphs = String(replyText || '').split(/\n{2,}/);
  const isSetupAdvice = (paragraph) => (
    /(加進|加入|邀請).*(LINE\s*)?群組/i.test(paragraph)
    || /(LINE\s*)?群組.*(開頭|記錄|使用|設定)/i.test(paragraph)
    || /建立好我|已經建立好/i.test(paragraph)
    || /[#＃]\s*開頭/i.test(paragraph)
    || /webhook|Webhook/i.test(paragraph)
    || /直接把我加/i.test(paragraph)
  );
  const kept = paragraphs.filter((paragraph) => !isSetupAdvice(paragraph));
  const cleaned = kept.join('\n\n').trim();
  if (cleaned) return cleaned;
  // 整則都是「沒問就不該講」的群組設定廢話 → 不要回吐原文，給中性簡短回覆
  return '好，我在。你可以直接跟我說要記什麼，或查待辦、帳務。';
}

function normalizeClaudeReply(replyText, userText) {
  return stripOpeningFiller(stripUnaskedGroupSetupAdvice(replyText, userText));
}

async function replyMessage(replyToken, messages) {
  if (typeof messages === 'string') {
    messages = [{ type: 'text', text: messages }];
  }
  if (!Array.isArray(messages)) {
    messages = [messages];
  }
  messages = messages.map((message) => (
    message && message.type === 'text'
      ? { ...message, text: sanitizeLineText(message.text) }
      : message
  ));

  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('LINE reply error:', err);
  }
}

async function startLoadingAnimation(chatId, loadingSeconds = 20) {
  if (!chatId) return;
  try {
    const res = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        chatId,
        loadingSeconds,
      }),
    });
    if (!res.ok) {
      console.error('LINE loading error:', await res.text());
    }
  } catch (err) {
    console.error('LINE loading failed:', err.message);
  }
}

function logEventTiming(label, startedAt, extra = {}) {
  console.log('event_timing', {
    label,
    elapsed_ms: Date.now() - startedAt,
    ...extra,
  });
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s，。！？、)）]+/i);
  return match ? match[0] : '';
}

function cleanMemoryKeyword(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s，。！？、)）]+/ig, '')
    .replace(/(這是|這個是|幫我看|幫我找|幫我|幫|給我看|給我|丟給我|傳給我|傳給|我要|我想|記一下|記起來|記錄|網址|網站|是多少|是什麼|請問|以後|下次|要回覆我|跟我說|告訴我|的)/g, ' ')
    .replace(/[，。！？、,.!?;；:：\s"'「」『』（）()【】\[\]#]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length >= 2)
    .slice(0, 4)
    .join(' ');
}

function cleanNoteMutationKeyword(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s，。！？、)）]+/ig, '')
    .replace(/(這是|這個是|幫我|幫|記一下|記起來|記錄|網址|網站|資料|筆記|不用記了|不用記|不要記了|不要記|刪掉|刪除|忘掉|忘記|改成|改為|更新成|更新為|換成|換為|新的|請問|的)/g, ' ')
    .replace(/[，。！？、,.!?;；:：\s"'「」『』（）()【】\[\]#]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length >= 2)
    .slice(0, 4)
    .join(' ');
}

function extractMemoryKeywords(text) {
  const raw = String(text || '');
  const protectedPhrases = [
    '薪資系統', '新系統', 'ERP', 'LT-ERP', '包子媽系統', '樂樂團購',
    '1688', '集運', '員工回報', '小瀾後台', '小瀾 webhook', 'LINE webhook',
  ];
  const keywords = [];
  for (const phrase of protectedPhrases) {
    if (raw.toLowerCase().includes(phrase.toLowerCase())) keywords.push(phrase);
  }

  const cleaned = raw
    .replace(/https?:\/\/[^\s，。！？、)）]+/ig, ' ')
    .replace(/(這是|這個是|幫我看|幫我找|幫我|幫|給我看|給我|丟給我|傳給我|傳給|我要|我想|找一下|查一下|看一下|記一下|記起來|記錄|網址|網站|連結|link|url|資料|筆記|是多少|是什麼|在哪|哪裡|請問|以後|下次|要回覆我|跟我說|告訴我|有沒有記|不用記了|不用記|不要記了|不要記|刪掉|刪除|忘掉|忘記|改成|改為|更新成|更新為|換成|換為|新的|的)/ig, ' ')
    .replace(/[，。！？、,.!?;；:：\s"'「」『』（）()【】\[\]#]/g, ' ')
    .trim();

  for (const part of cleaned.split(/\s+/)) {
    if (/^[A-Za-z0-9-]{2,}$/.test(part) || /[\u4e00-\u9fa5]{2,}/.test(part)) {
      keywords.push(part);
      // \u9577\u4e2d\u6587\u7247\u8a9e\uff08\u5982\u300c\u4ec1\u5728\u5ee0\u5546\u767b\u5165\u5e33\u865f\u300d\uff09\u984d\u5916\u62bd\u524d 2~3 \u5b57\u7576\u4e3b\u9ad4\u95dc\u9375\u5b57\uff0c
      // \u901a\u5e38\u662f\u5ee0\u5546/\u4e3b\u984c\u540d\uff0c\u907f\u514d\u6574\u4e32\u9023\u5728\u4e00\u8d77\u8ddf\u542b\u7a7a\u683c\u7684\u7b46\u8a18\u6bd4\u5c0d\u4e0d\u5230
      if (/[\u4e00-\u9fa5]{4,}/.test(part)) {
        keywords.push(part.slice(0, 2));
        keywords.push(part.slice(0, 3));
      }
    }
  }

  const expanded = [];
  for (const keyword of keywords) {
    expanded.push(keyword);
    if (/erp/i.test(keyword)) expanded.push('ERP', 'LT-ERP');
    if (/薪資/.test(keyword)) expanded.push('薪資系統', '薪資');
    if (/新系統/.test(keyword)) expanded.push('新系統');
    if (/包子媽/.test(keyword)) expanded.push('包子媽系統', '包子媽');
  }

  return [...new Set(expanded.map((k) => String(k || '').trim()).filter((k) => k.length >= 2))].slice(0, 8);
}

function scoreMemoryNote(note, keywords) {
  const content = String(note?.content || '');
  const contentNoSpace = content.replace(/\s+/g, '');
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    const kwNoSpace = String(keyword).replace(/\s+/g, '');
    // 忽略空白比對：存的筆記常有「仁在 廠商…」的空格，不該因此漏配
    if (content.includes(keyword) || contentNoSpace.includes(kwNoSpace)) score += keyword.length + 8;
    const compactContent = contentNoSpace.toLowerCase();
    const compactKeyword = kwNoSpace.toLowerCase();
    if (compactContent.includes(compactKeyword)) score += keyword.length + 4;
  }
  if (extractFirstUrl(content)) score += 3;
  if ((note.tags || []).includes('網址')) score += 2;
  return score;
}

async function findNotesByKeywords(keywords, limit = 5) {
  const noteMap = new Map();
  const results = await Promise.all((keywords || []).map((keyword) => supabase
      .from('xlan_notes')
      .select('*')
      .ilike('content', `%${keyword}%`)
      .order('created_at', { ascending: false })
      .limit(limit)));
  for (const { data } of results) {
    for (const note of data || []) {
      noteMap.set(note.id, note);
    }
  }

  return Array.from(noteMap.values())
    .map((note) => ({ note, score: scoreMemoryNote(note, keywords) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.note.created_at || 0) - new Date(a.note.created_at || 0))
    .map((item) => item.note)
    .slice(0, limit);
}

async function rememberUrlFromText(text) {
  const url = extractFirstUrl(text);
  if (!url) return null;
  const keyword = cleanMemoryKeyword(text) || '網址';
  const content = `${keyword}：${url}`;
  await supabase.from('xlan_notes').insert({
    content,
    tags: ['網址'],
  });
  return `📝 已記錄：${keyword}`;
}

function parseCorrectionMemory(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 4) return null;
  if (!/(以後|下次|之後|不要|別再|不能|不是|不對|錯了|應該|要改成|改成|算公司|算私人|要當|不要當)/.test(raw)) return null;
  if (/^記帳:[0-9a-f-]+:/i.test(raw) || /^待辦:[0-9a-f-]{32,36}:/i.test(raw)) return null;
  if (/^(刪掉|刪除|取消|不用了|不用做了|明天|後天|下週|算公司|算私人|分類.+)$/.test(raw)) return null;

  const compact = raw
    .replace(/^小瀾[，,：:\s]*/i, '')
    .replace(/^(你|妳)(又)?/g, '')
    .trim();
  if (compact.length < 4) return null;

  const keywords = extractMemoryKeywords(compact).filter((keyword) => !['不要', '不是', '以後', '下次'].includes(keyword));
  const keywordText = keywords.length > 0 ? ` 關鍵字：${keywords.join('、')}` : '';
  return {
    content: `修正規則：${compact}${keywordText}`,
    keywords,
  };
}

async function rememberCorrectionFromText(text) {
  const correction = parseCorrectionMemory(text);
  if (!correction) return null;
  await supabase.from('xlan_notes').insert({
    content: correction.content,
    tags: ['修正規則'],
  });
  return '我記住這個修正了，下次遇到類似情況會照這個規則判斷。';
}

async function answerUrlFromMemory(text) {
  if (!/網址|網站|連結|link|url/i.test(text)) return null;
  const keywords = extractMemoryKeywords(text);
  if (keywords.length === 0) return null;

  const notes = await findNotesByKeywords(keywords, 8);
  const withUrls = notes
    .map((note) => ({ note, url: extractFirstUrl(note.content) }))
    .filter((item) => item.url);
  if (withUrls.length === 0) return null;

  // 同網址去重，全部回傳（香奈要的是「所有匯洲的網址」，不是只挑一個）
  const seen = new Set();
  const unique = [];
  for (const item of withUrls) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item.note);
  }
  if (unique.length === 1) return unique[0].content;
  return unique.map((note, i) => `${i + 1}. ${note.content}`).join('\n');
}

async function listAllUrlNotes() {
  const { data } = await supabase
    .from('xlan_notes')
    .select('content, created_at')
    .contains('tags', ['網址'])
    .order('created_at', { ascending: false })
    .limit(30);
  const withUrls = (data || []).filter((note) => extractFirstUrl(note.content));
  if (withUrls.length === 0) return '目前沒有記錄任何網址，把連結丟給我就會幫你記起來。';
  return `🔗 你的常用連結（${withUrls.length}）：\n${withUrls.map((note, i) => `${i + 1}. ${note.content}`).join('\n')}`;
}

// --- 部署清單（記每台機器人的部署位置與方式）---
function formatDeploymentContent({ name, platform, code_location, deploy_method, url, note }) {
  const lines = [`🤖 ${String(name).trim()}`];
  if (platform) lines.push(`平台：${platform}`);
  if (code_location) lines.push(`程式碼：${code_location}`);
  if (deploy_method) lines.push(`部署方式：${deploy_method}`);
  if (url) lines.push(`網址：${url}`);
  if (note) lines.push(`備註：${note}`);
  return lines.join('\n');
}

async function getAllDeploymentNotes() {
  const { data } = await supabase
    .from('xlan_notes')
    .select('id, content, created_at')
    .contains('tags', ['部署'])
    .order('created_at', { ascending: false })
    .limit(30);
  return data || [];
}

function formatDeploymentList(notes) {
  return notes.map((n, i) => `【${i + 1}】\n${n.content}`).join('\n\n');
}

const DEPLOYMENT_FIELD_LABELS = {
  平台: 'platform',
  程式碼: 'code_location',
  部署方式: 'deploy_method',
  網址: 'url',
  備註: 'note',
};

function parseDeploymentContent(content) {
  const fields = {};
  for (const line of String(content || '').split('\n')) {
    const idx = line.indexOf('：');
    if (idx === -1) continue;
    const key = DEPLOYMENT_FIELD_LABELS[line.slice(0, idx).trim()];
    if (key) fields[key] = line.slice(idx + 1).trim();
  }
  return fields;
}

async function saveDeployment(input) {
  const name = String(input.name || '').trim();
  if (!name) return '要記哪一台機器人的部署？請給我名稱。';
  const nameKey = name.replace(/\s+/g, '');
  const all = await getAllDeploymentNotes();
  const existing = all.find((n) => String(n.content || '').split('\n')[0].replace(/[🤖\s]/g, '') === nameKey);

  // 累加合併：只覆蓋這次有提到的欄位，其餘沿用舊資料，香奈才不用每次重打全部
  const prev = existing ? parseDeploymentContent(existing.content) : {};
  const merged = { name };
  for (const key of ['platform', 'code_location', 'deploy_method', 'url', 'note']) {
    const next = String(input[key] || '').trim();
    merged[key] = next || prev[key] || '';
  }
  const content = formatDeploymentContent(merged);

  if (existing) {
    await supabase.from('xlan_notes').update({ content, tags: ['部署', name] }).eq('id', existing.id);
    return `✅ 已更新部署：${name}`;
  }
  await supabase.from('xlan_notes').insert({ content, tags: ['部署', name] });
  return `📝 已記錄部署：${name}`;
}

async function answerDeploymentFromMemory(text) {
  const all = await getAllDeploymentNotes();
  if (all.length === 0) return null;
  const stop = ['部署', '部屬', '機器人', '在哪', '哪裡', '哪台', '怎麼', '如何', '資訊', '詳細', '詳情', '是什麼'];
  const keywords = extractMemoryKeywords(text).filter((k) => !stop.includes(k));
  if (keywords.length === 0) return formatDeploymentList(all);
  const matched = all.filter((n) => {
    const c = String(n.content || '').replace(/\s+/g, '');
    return keywords.some((k) => c.includes(String(k).replace(/\s+/g, '')));
  });
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0].content;
  return formatDeploymentList(matched);
}

async function listAllDeployments() {
  const all = await getAllDeploymentNotes();
  if (all.length === 0) {
    return '目前還沒記任何機器人的部署。跟我說「記部署 小瀾，平台 Vercel，程式碼 github www161616/xlan-secretary，部署方式 push 到 main 自動部署，網址 https://...」就會幫你記起來。';
  }
  return `🤖 你的機器人部署（${all.length}）：\n\n${formatDeploymentList(all)}`;
}

async function answerBusinessMemoryFromText(text) {
  if (!/(網址|網站|連結|link|url|資料|在哪|哪裡|是多少|是什麼|電話|帳號|密碼|有沒有記|誰|規格|承諾|系統)/i.test(text)) {
    return null;
  }
  const keywords = extractMemoryKeywords(text);
  if (keywords.length === 0) return null;
  const notes = await findNotesByKeywords(keywords, 5);
  if (notes.length === 0) return null;
  if (notes.length === 1) return notes[0].content;

  const top = notes.slice(0, 3).map((note, i) => `${i + 1}. ${note.content}`).join('\n');
  return `我找到幾筆可能相關的記憶：\n${top}`;
}

async function findNotesByKeyword(keyword, limit = 5) {
  const keywords = extractMemoryKeywords(keyword);
  return findNotesByKeywords(keywords, limit);
}

async function updateNoteByKeyword(keyword, content, tags = []) {
  const notes = await findNotesByKeyword(keyword, 5);
  if (notes.length === 0) {
    await supabase.from('xlan_notes').insert({ content, tags });
    return `找不到舊筆記，已新增：${content.substring(0, 40)}`;
  }
  const note = notes[0];
  const nextTags = tags.length > 0 ? tags : (note.tags || []);
  const { error } = await supabase
    .from('xlan_notes')
    .update({ content, tags: nextTags })
    .eq('id', note.id);
  if (error) throw error;
  return `已更新筆記：${content.substring(0, 40)}`;
}

async function deleteNoteByKeyword(keyword) {
  const notes = await findNotesByKeyword(keyword, 5);
  if (notes.length === 0) {
    return `找不到包含「${keyword}」的筆記。`;
  }
  if (notes.length > 1) {
    const exact = notes.find((note) => String(note.content || '').includes(keyword));
    if (!exact) {
      const options = notes.map((note, i) => `${i + 1}. ${String(note.content || '').slice(0, 40)}`).join('\n');
      return `找到幾筆可能的筆記，請說清楚一點：\n${options}`;
    }
    notes.splice(0, notes.length, exact);
  }
  const note = notes[0];
  const { error } = await supabase.from('xlan_notes').delete().eq('id', note.id);
  if (error) throw error;
  return `已刪除筆記：${String(note.content || '').substring(0, 40)}`;
}

async function updateUrlMemoryFromText(text) {
  if (!/(改成|改為|更新成|更新為|換成|換為)/.test(text)) return null;
  const url = extractFirstUrl(text);
  if (!url) return null;
  const keyword = cleanNoteMutationKeyword(text) || cleanMemoryKeyword(text);
  if (!keyword) return null;
  const content = `${keyword}：${url}`;
  return updateNoteByKeyword(keyword, content, ['網址']);
}

async function deleteNoteFromText(text) {
  if (!/(不用記了|不用記|不要記了|不要記|刪掉|刪除|忘掉|忘記)/.test(text)) return null;
  if (!/(網址|網站|筆記|資料|電話|系統|承諾|規格|帳號|密碼)/.test(text)) return null;
  const keyword = cleanNoteMutationKeyword(text);
  if (!keyword) return null;
  return deleteNoteByKeyword(keyword);
}

function keywordPartsFromText(text) {
  return extractMemoryKeywords(text).slice(0, 6);
}

async function getRelevantNotesForContext(text) {
  const keywords = keywordPartsFromText(text);
  return findNotesByKeywords(keywords, 5);
}

async function getRecentCorrectionRules(text, limit = 5) {
  const keywords = extractMemoryKeywords(text);
  let query = supabase
    .from('xlan_notes')
    .select('content, tags, created_at')
    .ilike('content', '%修正規則%')
    .order('created_at', { ascending: false })
    .limit(12);
  const { data } = await query;
  const notes = data || [];
  if (keywords.length === 0) return notes.slice(0, limit);
  return notes
    .map((note) => ({ note, score: scoreMemoryNote(note, keywords) }))
    .sort((a, b) => b.score - a.score || new Date(b.note.created_at || 0) - new Date(a.note.created_at || 0))
    .map((item) => item.note)
    .slice(0, limit);
}

async function buildAgentKnowledgeContext(userContent) {
  const userText = typeof userContent === 'string' ? userContent : '';
  const sections = [];

  const correctionRulesPromise = getRecentCorrectionRules(userText, 5);
  const notesPromise = getRelevantNotesForContext(userText);
  const todosPromise = supabase
    .from('xlan_todos')
    .select('id, text, priority, source_person, project_name, created_at')
    .eq('done', false)
    .order('created_at', { ascending: true })
    .limit(8);
  const payablesPromise = supabase
    .from('xlan_payables')
    .select('title, amount, to_whom, due_date, note')
    .eq('status', 'pending')
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(5);
  const shipmentsPromise = supabase
    .from('xlan_shipments')
    .select('title, expected_date, note')
    .eq('status', 'pending')
    .order('expected_date', { ascending: true })
    .limit(5);

  const [
    correctionRules,
    notes,
    { data: todos },
    { data: payables },
    { data: shipments },
  ] = await Promise.all([
    correctionRulesPromise,
    notesPromise,
    todosPromise,
    payablesPromise,
    shipmentsPromise,
  ]);

  if (correctionRules.length > 0) {
    sections.push(`香奈修正過的規則：\n${correctionRules.map((n, i) => `${i + 1}. ${n.content}`).join('\n')}`);
  }

  if (notes.length > 0) {
    sections.push(`相關記憶：\n${notes.map((n, i) => `${i + 1}. ${n.content}`).join('\n')}`);
  }

  if (todos && todos.length > 0) {
    const stateMap = await getTodoStateMap(todos);
    sections.push(`目前待辦：\n${todos.map((t, i) => {
      const state = stateMap.get(t.id) || {};
      const pri = t.priority && t.priority !== 'normal' ? `/${t.priority}` : '';
      const owner = t.source_person ? `/${t.source_person}` : '';
      const proj = t.project_name ? `/${t.project_name}` : '';
      const due = state.due_date ? `/延後到:${state.due_date}` : '';
      return `${i + 1}. ${cleanTodoDisplayText(t.text)}/狀態:${state.status || '待處理'}${due}${pri}${owner}${proj}`;
    }).join('\n')}`);
  }

  if (payables && payables.length > 0) {
    sections.push(`待付款：\n${payables.map((p, i) => {
      const amount = p.amount ? ` NT$${p.amount}` : '';
      const due = p.due_date ? ` 到期:${p.due_date}` : '';
      return `${i + 1}. ${p.title || p.to_whom}${amount}${due}`;
    }).join('\n')}`);
  }

  if (shipments && shipments.length > 0) {
    sections.push(`待到貨/陸貨：\n${shipments.map((s, i) => `${i + 1}. ${s.title} 預計:${s.expected_date}`).join('\n')}`);
  }

  if (sections.length === 0) return '';
  return `【小瀾可用工作資料】\n${sections.join('\n\n')}`;
}

// --- Claude API：判斷是否為待辦 ---
async function judgeTask(messageText) {
  const prompt = `以下是 LINE 群組裡的一則訊息。請判斷這則訊息是否包含交辦給香奈或負責人的待辦事項或需要處理的事情。
只回答 JSON：{"is_task": true/false, "task": "待辦事項摘要（繁體中文，20字以內）"}
如果不是待辦事項，task 填 null。
訊息內容：${messageText}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { is_task: false, task: null };
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { is_task: false, task: null };
  }
}

// --- 員工 LINE 回報：運單照片 + 問題照片 + 少3/破2 ---
function staffReportEnabled() {
  return Boolean(GOOGLE_VISION_API_KEY && STAFF_REPORT_SPREADSHEET_ID);
}

const STAFF_REPORT_RECENT_IMAGE_MS = 10 * 60 * 1000;
const STAFF_REPORT_ACTIVE_MS = 30 * 60 * 1000;

function staffReportSourceAllowed(source) {
  if (!STAFF_REPORT_GROUP_ID) return true;
  return source && source.groupId === STAFF_REPORT_GROUP_ID;
}

function isStaffReportCancelText(text) {
  return /^(取消|取消回報|不用回報|結束回報|算了)$/i.test(String(text || '').trim());
}

function shouldKeepStaffReportSession(text, session) {
  if (isStaffReportTrigger(text)) return true;
  if (parseStaffProblemText(text)) return true;
  if (extractTrackingNoFromText(text)) return true;
  return Boolean(session.problem || staffTrackingList(session).length);
}

function staffReportSessionActive(session) {
  if (!session || session.active !== true) return false;
  const ts = new Date(session.updated_at || session.activated_at || 0).getTime();
  return Boolean(ts && Date.now() - ts <= STAFF_REPORT_ACTIVE_MS);
}

function deactivateStaffReportSession(session) {
  return {
    images: pruneStaffReportImages(session?.images || []),
  };
}

function getStaffSourceKey(source) {
  if (!source) return 'unknown';
  return ['staff_report', source.type || 'unknown', source.groupId || source.roomId || '', source.userId || ''].join(':');
}

function pruneStaffReportImages(images) {
  const now = Date.now();
  return (images || [])
    .filter((image) => {
      const createdAt = new Date(image.createdAt || 0).getTime();
      return createdAt && now - createdAt <= STAFF_REPORT_RECENT_IMAGE_MS;
    })
    .slice(-4);
}

// 未到貨用比較明確的詞，避免一般聊天「他沒來」誤判；qty 可省略（整筆沒到預設 1）
// 「位到貨」是員工常見的「未到貨」錯字，特別收進來
const STAFF_NOT_ARRIVED_RE = /(未到貨|未到货|沒到貨|没到货|沒有到貨|沒有收到貨|貨沒到|貨還沒到|整箱沒到|整批沒到|整箱都沒|整批都沒|全部沒到|都沒到貨|位到貨)/;

function parseStaffProblemText(text) {
  const s = String(text || '')
    .replace(/#\s*回報|回報/g, '')
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
  const found = [];
  if (STAFF_NOT_ARRIVED_RE.test(s)) {
    const m = s.match(/(?:未到貨|沒到貨|貨沒到|位到貨)(\d+)/);
    found.push({ type: '未到貨', qty: m ? Number(m[1]) : 1 });
  }
  const patterns = [
    { type: '少貨', re: /(少貨|少來|短少|少)(\d+)/ },
    { type: '破損', re: /(破損|破掉|破)(\d+)/ },
    { type: '錯貨', re: /(錯貨|錯)(\d+)/ },
    { type: '多貨', re: /(多貨|多)(\d+)/ },
  ];
  for (const p of patterns) {
    const matches = [...s.matchAll(new RegExp(p.re.source, 'g'))];
    const qty = matches.reduce((sum, m) => sum + (Number(m[2]) || 1), 0);
    if (qty > 0) found.push({ type: p.type, qty });
  }
  if (found.length === 1) return { type: found[0].type, qty: found[0].qty, raw: text };
  if (found.length > 1) {
    return {
      type: found.map((item) => item.type).join('+'),
      qty: found.reduce((sum, item) => sum + item.qty, 0),
      raw: text,
    };
  }
  return null;
}

function looksLikeStaffReportText(text) {
  return Boolean(parseStaffProblemText(text)) || isStaffReportTrigger(text);
}

// AI 補刀：regex 看不懂員工口語/錯字時，丟 Haiku 判斷問題類型。
// 只在「已確認的回報流程中」呼叫（見 handleStaffReportEvent），避免亂花 token 或誤判一般聊天。
async function classifyStaffProblemWithAI(text) {
  const clean = String(text || '').replace(/#\s*回報|回報/g, '').trim();
  if (!clean) return null;
  // 把運單號去掉後若沒剩下描述，代表只貼了單號、還沒講問題 → 不亂猜
  const textForAI = clean.replace(/[A-Z]{0,5}\d{7,}/gi, '').replace(/[\s,，、;；]+/g, '').trim();
  if (textForAI.length < 2) return null;
  try {
    const prompt = `你是倉庫到貨問題回報助手。員工會用很口語、有錯字的方式描述問題。
請判斷員工這句話是在回報哪一種到貨問題，只回 JSON：
{"type":"少貨|破損|錯貨|多貨|未到貨|其他","qty":數字或null,"summary":"10字內摘要"}
判斷規則：
- 沒到、沒收到、沒來、整箱沒、都沒到、沒有到、未到、位到 = 未到貨
- 少、短少、缺、不夠 = 少貨
- 破、壞、損、爛、裂 = 破損
- 錯、發錯、拿錯、不是我要的 = 錯貨
- 多、多出、多給 = 多貨
- 看不出明確類型就填「其他」，把原話濃縮放 summary
- qty 是有問題的件數，看不出來填 null
員工的話：${clean}`;
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = (response.content[0]?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const validTypes = ['少貨', '破損', '錯貨', '多貨', '未到貨', '其他'];
    if (!validTypes.includes(parsed.type)) return null;
    return {
      type: parsed.type,
      qty: Number(parsed.qty) > 0 ? Number(parsed.qty) : 1,
      raw: text,
      ai: true,
      summary: parsed.summary || '',
    };
  } catch (e) {
    console.log('classifyStaffProblemWithAI_error', e?.message);
    return null;
  }
}

// 從文字抓出「所有」運單號（員工常一次貼多筆）；去重後回陣列
function extractAllTrackingNosFromText(text) {
  const compact = String(text || '').toUpperCase().replace(/[^\dA-Z]/g, ' ');
  const re = /\b([A-Z]{1,5}\d{7,20}|\d{9,20})\b/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(compact)) !== null) {
    const value = m[1];
    if (/^20\d{6,}$/.test(value)) continue; // 像日期，略過
    const key = cleanStaffKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// 取出本次 session 已掌握的運單號清單（相容舊的單筆欄位）
function staffTrackingList(session) {
  if (!session) return [];
  if (Array.isArray(session.manualTrackingNos) && session.manualTrackingNos.length) return session.manualTrackingNos;
  if (session.manualTrackingNo) return [session.manualTrackingNo];
  return [];
}

function extractTrackingNoFromText(text) {
  return extractTrackingNoFromOcr(text);
}

function isStaffReportTrigger(text) {
  return /[#＃]\s*回報/.test(String(text || '').trim());
}

function buildStaffReportLiffUrl(source) {
  // 環境變數有設且非空白就用它；否則用已知的員工回報 LIFF ID 當後備（LIFF ID 非機密）
  const liffId = (STAFF_LIFF_ID || '').trim() || '2009806013-E5IVkIFT';
  if (!liffId) return '';
  const groupId = (source && (source.groupId || source.roomId)) || '';
  const params = new URLSearchParams({ liff: liffId });
  if (groupId) params.set('g', groupId);
  return `https://liff.line.me/${liffId}?${params.toString()}`;
}

function buildStaffReportGuideFlex(source) {
  const liffUrl = buildStaffReportLiffUrl(source);
  const steps = liffUrl
    ? [
        { type: 'text', text: '1. 點下面「開回報表單」', size: 'sm', color: CARD_THEME.text, wrap: true },
        { type: 'text', text: '2. 選問題、調數量、掃運單條碼、拍照', size: 'sm', color: CARD_THEME.text, wrap: true },
        { type: 'text', text: '3. 按送出就好，小瀾會自動寫進表單', size: 'sm', color: CARD_THEME.text, wrap: true },
      ]
    : [
        { type: 'text', text: '1. 打 #回報 + 問題：少3 / 破2 / 錯1 / 未到貨', size: 'sm', color: CARD_THEME.text, wrap: true },
        { type: 'text', text: '2. 不會打也沒關係，直接用自己的話講（例：整箱都沒到）', size: 'sm', color: CARD_THEME.text, wrap: true },
        { type: 'text', text: '3. 拍運單照片＋問題照片；沒到貨的直接打運單號就好', size: 'sm', color: CARD_THEME.text, wrap: true },
      ];
  const footerButtons = [];
  if (liffUrl) {
    footerButtons.push({ type: 'button', style: 'primary', color: CARD_THEME.primary, height: 'sm', action: { type: 'uri', label: '📋 開回報表單', uri: liffUrl } });
  }
  footerButtons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '未到貨', text: '#回報 未到貨' } });
  footerButtons.push({ type: 'button', height: 'sm', color: CARD_THEME.danger, action: { type: 'message', label: '取消', text: '取消回報' } });

  const bodyContents = [
    { type: 'text', text: '員工回報', weight: 'bold', size: 'lg', color: CARD_THEME.primaryDark },
    { type: 'text', text: liffUrl ? '選一選、掃一掃就好，小瀾會寫進表單。' : '照順序補資料，小瀾會寫進 Google Sheet。', size: 'sm', color: CARD_THEME.muted, wrap: true },
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: CARD_THEME.soft,
      paddingAll: '12px',
      spacing: 'xs',
      contents: steps,
    },
  ];
  if (liffUrl) {
    bodyContents.push({ type: 'text', text: '懶得開表單？直接打「#回報 少6」這種也可以。', size: 'xs', color: CARD_THEME.muted, wrap: true });
  }

  return {
    type: 'flex',
    altText: '員工回報',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: CARD_THEME.page,
        spacing: 'md',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerButtons,
      },
    },
  };
}

async function loadStaffReportSession(sourceKey) {
  const { data } = await supabase.from('xlan_kv').select('value').eq('key', sourceKey).single();
  if (!data || !data.value) return { images: [] };
  try {
    return JSON.parse(data.value);
  } catch {
    return { images: [] };
  }
}

async function saveStaffReportSession(sourceKey, session) {
  await supabase.from('xlan_kv').upsert({
    key: sourceKey,
    value: JSON.stringify({ ...session, updated_at: new Date().toISOString() }),
  });
}

async function clearStaffReportSession(sourceKey) {
  await supabase.from('xlan_kv').delete().eq('key', sourceKey);
}

async function getLineDisplayName(source) {
  if (!source || !source.userId) return '';
  try {
    const url = source.type === 'group' && source.groupId
      ? `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(source.userId)}`
      : `https://api.line.me/v2/bot/profile/${encodeURIComponent(source.userId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) return source.userId;
    const data = await res.json();
    return data.displayName || source.userId;
  } catch {
    return source.userId;
  }
}

async function uploadStaffImageToDrive(buffer, filename) {
  if (!STAFF_REPORT_IMAGE_FOLDER_ID) return '';
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [STAFF_REPORT_IMAGE_FOLDER_ID],
    },
    media: {
      mimeType: 'image/jpeg',
      body: require('stream').Readable.from(buffer),
    },
    fields: 'id,webViewLink',
  });
  return res.data.webViewLink || (res.data.id ? `https://drive.google.com/file/d/${res.data.id}/view` : '');
}

async function ocrStaffImage(base64Data) {
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(GOOGLE_VISION_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        image: { content: base64Data },
        features: [{ type: 'TEXT_DETECTION' }],
      }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Vision OCR failed: ${JSON.stringify(data)}`);
  return data.responses?.[0]?.textAnnotations?.[0]?.description || '';
}

function cleanStaffKey(value) {
  return String(value || '').trim().replace(/^="?/, '').replace(/"$/, '').replace(/^["']|["']$/g, '').toUpperCase();
}

function splitStaffKeys(value) {
  return String(value || '')
    .split(/[;；,，、\s]+/)
    .map(cleanStaffKey)
    .filter(Boolean);
}

function extractTrackingNoFromOcr(text) {
  const compact = String(text || '').toUpperCase().replace(/[^\dA-Z]/g, ' ');
  const candidates = [];
  const re = /\b([A-Z]{1,5}\d{7,20}|\d{9,20})\b/g;
  let m;
  while ((m = re.exec(compact)) !== null) {
    const value = m[1];
    if (/^20\d{6,}$/.test(value)) continue;
    candidates.push(value);
  }
  if (!candidates.length) return '';
  candidates.sort((a, b) => scoreTrackingCandidate(b) - scoreTrackingCandidate(a));
  return candidates[0];
}

function scoreTrackingCandidate(value) {
  let score = 0;
  if (/^[A-Z]{1,5}\d+$/.test(value)) score += 4;
  if (/^\d{10,16}$/.test(value)) score += 3;
  if (value.length >= 10 && value.length <= 18) score += 2;
  if (/^1\d{11,}$/.test(value)) score += 1;
  return score;
}

function staffTrackingDistance(a, b) {
  const left = cleanStaffKey(a);
  const right = cleanStaffKey(b);
  if (!left || !right) return Infinity;
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return Infinity;

  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i++) dp[i][0] = i;
  for (let j = 0; j <= right.length; j++) dp[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[left.length][right.length];
}

function isLikelyStaffTrackingMatch(target, candidate) {
  const left = cleanStaffKey(target);
  const right = cleanStaffKey(candidate);
  if (!left || !right) return false;
  if (left.length < 9 || right.length < 9) return false;
  return staffTrackingDistance(left, right) <= 1;
}

function staffOrderFromRow(row, rowNumber, trackingNo, rawTrackingNo, suspected = false) {
  return {
    found: true,
    suspected,
    rowNumber,
    orderNo: row[2] || '',
    trackingNo,
    rawTrackingNo: rawTrackingNo || '',
    productId: row[14] || '',
    productName: row[15] || row[4] || '',
    qty: row[6] || '',
    usage: row[13] || '',
    destination: row[12] || '',
    offerId: row[19] || '',
  };
}

async function findOrderByTrackingNo(trackingNo) {
  const sheets = getSheetsClient();
  const range = `${STAFF_REPORT_ORDER_SHEET_NAME}!A:T`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
    range,
  });
  const rows = res.data.values || [];
  const target = cleanStaffKey(trackingNo);
  let nearest = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const tracks = splitStaffKeys(row[3] || ''); // D 運單號碼
    if (tracks.includes(target)) {
      return staffOrderFromRow(row, i + 1, target, row[3] || '');
    }
    for (const track of tracks) {
      if (!isLikelyStaffTrackingMatch(target, track)) continue;
      const distance = staffTrackingDistance(target, track);
      if (!nearest || distance < nearest.distance) {
        nearest = { row, rowNumber: i + 1, track, distance };
      }
    }
  }
  if (nearest) {
    return staffOrderFromRow(nearest.row, nearest.rowNumber, nearest.track, nearest.row[3] || '', true);
  }
  return { found: false };
}

async function ensureStaffReportSheet() {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: STAFF_REPORT_SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === STAFF_REPORT_SHEET_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: STAFF_REPORT_SHEET_NAME } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
      range: `${STAFF_REPORT_SHEET_NAME}!A1:R1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          '回報時間', '員工', 'LINE來源', '運單號', '1688訂單號', '商品編號',
          '商品名稱', '原訂數量', '用途', '問題類型', '問題數量', '員工文字',
          '運單照片', '問題照片', '狀態', '備註', '所有訂單列號', 'Offer ID',
        ]],
      },
    });
  }
}

async function appendStaffReport(row) {
  await ensureStaffReportSheet();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: STAFF_REPORT_SPREADSHEET_ID,
    range: `${STAFF_REPORT_SHEET_NAME}!A:R`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

async function maybeProcessStaffReport(event, session, sourceKey) {
  const problem = session.problem;
  const images = session.images || [];
  if (!problem) return false;

  const isNotArrived = /未到貨/.test(problem.type || '');
  const manualTrackingNos = staffTrackingList(session);
  // 未到貨通常沒東西可拍：只要已經有運單號，就不強制拍照（這是員工最常卡住的地方）
  const photoOptional = isNotArrived && manualTrackingNos.length > 0;

  if (images.length < 1 && !photoOptional) {
    const ask = manualTrackingNos.length > 0
      ? '收到，請附問題照片（破損或少貨要看得到）。'
      : '收到。請附運單照片，或直接把運單號打給我。';
    await replyMessage(event.replyToken, [
      { type: 'text', text: ask },
      buildStaffReportGuideFlex(event.source),
    ]);
    return true;
  }

  const downloaded = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const buffer = await downloadLineImageBuffer(img.messageId);
    const base64 = buffer.toString('base64');
    const url = await uploadStaffImageToDrive(buffer, `${Date.now()}_${sourceKey.replace(/[^\w-]/g, '_')}_${i + 1}.jpg`);
    downloaded.push({ ...img, buffer, base64, url });
  }

  // 運單號來源：員工打的（可多筆）優先；沒有才用照片 OCR（照片通常一張一單，取最佳一筆）
  let trackingNos = manualTrackingNos.slice();
  if (!trackingNos.length && downloaded.length) {
    const ocrTexts = [];
    for (const img of downloaded) {
      ocrTexts.push(await ocrStaffImage(img.base64));
    }
    const best = extractTrackingNoFromOcr(ocrTexts.join('\n'));
    if (best) trackingNos = [best];
  }
  const displayName = await getLineDisplayName(event.source);

  if (!trackingNos.length) {
    await saveStaffReportSession(sourceKey, {
      ...session,
      problem,
      images,
      waitingForTrackingNo: true,
    });
    await replyMessage(event.replyToken, '看不清楚運單號，請補打運單號。小瀾會用剛剛的照片和問題繼續建立回報。');
    return true;
  }

  const noteRaw = problem.summary ? `${problem.raw || ''}（小瀾理解：${problem.summary}）` : (problem.raw || '');
  const lines = [];
  for (const tn of trackingNos) {
    const order = await findOrderByTrackingNo(tn);
    await appendStaffReport([
      new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      displayName,
      sourceKey,
      tn,
      order.orderNo || '',
      order.productId || '',
      order.productName || '',
      order.qty || '',
      order.usage || '',
      problem.type,
      problem.qty,
      noteRaw,
      downloaded[0]?.url || '',
      downloaded.slice(1).map((i) => i.url).filter(Boolean).join('\n'),
      order.found ? (order.suspected ? '疑似運單' : '未處理') : '找不到運單',
      order.found
        ? (order.suspected ? `OCR辨識為 ${tn}，系統疑似比對到 ${order.trackingNo}` : '')
        : '所有訂單找不到這個運單號',
      order.rowNumber || '',
      order.offerId || '',
    ]);
    if (order.found) {
      lines.push(`• ${order.trackingNo || tn}　${order.productName || '(未帶出商品)'}${order.suspected ? '（疑似比對）' : ''}`);
    } else {
      lines.push(`• ${tn}　找不到運單，小瀾稍後確認`);
    }
  }

  const header = trackingNos.length > 1
    ? `已建立回報 ${trackingNos.length} 筆（${problem.type} ${problem.qty}）`
    : `已建立回報（${problem.type} ${problem.qty}）`;
  await replyMessage(event.replyToken, `${header}\n${lines.join('\n')}`);
  await clearStaffReportSession(sourceKey);
  return true;
}

async function handleStaffReportEvent(event) {
  const incomingText = event.message.type === 'text' ? (event.message.text || '').trim() : '';
  const isStaffTrigger = isStaffReportTrigger(incomingText);
  if (isStaffTrigger || event.message.type === 'image') {
    console.log('staff_report_event', {
      sourceType: event.source.type,
      messageType: event.message.type,
      text: incomingText,
      enabled: staffReportEnabled(),
    });
  }
  if (!staffReportEnabled()) {
    if (isStaffTrigger) {
      await replyMessage(event.replyToken, '員工回報功能還沒啟用：請檢查 GOOGLE_VISION_API_KEY 和 STAFF_REPORT_SPREADSHEET_ID。');
      return true;
    }
    return false;
  }
  if (!staffReportSourceAllowed(event.source)) return false;

  const sourceKey = getStaffSourceKey(event.source);
  const session = await loadStaffReportSession(sourceKey);
  session.images = pruneStaffReportImages(session.images || []);
  const isGroup = event.source.type === 'group' || event.source.type === 'room';

  if (event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    if (isStaffReportCancelText(text)) {
      await clearStaffReportSession(sourceKey);
      await replyMessage(event.replyToken, '已取消回報。');
      return true;
    }
    if (isStaffTrigger) {
      session.active = true;
      session.activated_at = new Date().toISOString();
    }
    const possibleManualTrackingNos = extractAllTrackingNosFromText(text);
    const possibleManualTrackingNo = possibleManualTrackingNos[0] || extractTrackingNoFromText(text);
    const canContinueWaitingReport = Boolean(session.waitingForTrackingNo && possibleManualTrackingNo && (!isGroup || staffReportSessionActive(session)));
    const groupTextWithoutKeyword = isGroup && !isStaffReportTrigger(text) && !canContinueWaitingReport;
    if (groupTextWithoutKeyword) return false;
    if (!isGroup && session.images.length > 0 && !shouldKeepStaffReportSession(text, session)) {
      await clearStaffReportSession(sourceKey);
      return false;
    }
    if (!looksLikeStaffReportText(text) && session.images.length === 0 && !session.problem && !staffTrackingList(session).length) return false;

    const manualTrackingNo = possibleManualTrackingNo;
    if (possibleManualTrackingNos.length) {
      // 累積運單號（員工可能一次或分次貼多筆），去重保留多筆
      const merged = [...staffTrackingList(session), ...possibleManualTrackingNos];
      const seen = new Set();
      session.manualTrackingNos = merged.filter((t) => {
        const k = cleanStaffKey(t);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      session.manualTrackingNo = session.manualTrackingNos[0];
    }

    let problem = parseStaffProblemText(text) || session.problem;
    // AI 補刀：已在回報流程中、regex 看不懂員工口語/錯字時，丟 Haiku 理解
    if (!problem) {
      const inReportFlow = isStaffTrigger || session.active === true || staffTrackingList(session).length > 0 || session.images.length > 0;
      if (inReportFlow) {
        const aiProblem = await classifyStaffProblemWithAI(text);
        if (aiProblem) problem = aiProblem;
      }
    }
    if (!problem) {
      await saveStaffReportSession(sourceKey, session);
      if (manualTrackingNo) {
        await replyMessage(event.replyToken, [
          { type: 'text', text: '收到運單號，請再輸入問題和數量，例如：少3、破2、錯1。' },
          buildStaffReportGuideFlex(event.source),
        ]);
      } else if (isStaffTrigger && session.images.length > 0) {
        await replyMessage(event.replyToken, [
          { type: 'text', text: '收到照片，請再輸入問題和數量，例如：少3、破2、錯1。' },
          buildStaffReportGuideFlex(event.source),
        ]);
      } else {
        await replyMessage(event.replyToken, [
          { type: 'text', text: '請輸入問題和數量，並附運單照片。例如：#回報 少3。' },
          buildStaffReportGuideFlex(event.source),
        ]);
      }
      return true;
    }
    session.problem = problem;
    session.text = text;
    await saveStaffReportSession(sourceKey, session);
    return maybeProcessStaffReport(event, session, sourceKey);
  }

  if (event.message.type === 'image') {
    if (isGroup && !staffReportSessionActive(session)) {
      const safeSession = deactivateStaffReportSession(session);
      safeSession.images.push({ messageId: event.message.id, createdAt: new Date().toISOString(), recentOnly: true });
      safeSession.images = pruneStaffReportImages(safeSession.images);
      await saveStaffReportSession(sourceKey, safeSession);
      return false;
    }

    if (!session.problem && !staffTrackingList(session).length) {
      if (isGroup) {
        session.images.push({ messageId: event.message.id, createdAt: new Date().toISOString(), recentOnly: true });
        session.images = pruneStaffReportImages(session.images);
        await saveStaffReportSession(sourceKey, session);
      }
      return false;
    }

    session.images.push({ messageId: event.message.id, createdAt: new Date().toISOString() });
    session.images = pruneStaffReportImages(session.images);
    await saveStaffReportSession(sourceKey, session);

    if (!session.problem) {
      await replyMessage(event.replyToken, [
        { type: 'text', text: '收到照片，請再輸入問題和數量，例如：少3、破2、錯1。' },
        buildStaffReportGuideFlex(event.source),
      ]);
      return true;
    }
    return maybeProcessStaffReport(event, session, sourceKey);
  }

  return false;
}

function normalizeTodoText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：\s"'「」『』（）()【】\[\]#]/g, '')
    .replace(/完成|已完成|做好了|好了|ok|OK|處理好了|辦完了|結束了|刪除/g, '')
    .replace(/先等|等老闆|等廠商|等回覆|等待回覆|對方還沒回|做到一半|先做一半|還沒完全好|半完成|正在做|處理中|已經開始|還沒做|沒完成|今天沒做完|延後|明天再做|下週再處理/g, '');
}

function scoreTodoMatch(keyword, text) {
  if (!keyword || !text) return 0;
  if (text.includes(keyword)) return keyword.length + 10;
  let score = 0;
  const parts = keyword.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [];
  for (const part of parts) {
    if (text.includes(part)) score += part.length;
  }
  return score;
}

function getTaipeiDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

function formatDateYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function parseTodoDueDate(text) {
  const raw = String(text || '').trim();
  const now = getTaipeiDate();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!raw) return '';

  const iso = raw.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;

  const md = raw.match(/(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?/);
  if (md) {
    let y = now.getFullYear();
    const m = Number(md[1]);
    const d = Number(md[2]);
    const candidate = new Date(y, m - 1, d);
    if (candidate < date) y += 1;
    return formatDateYmd(new Date(y, m - 1, d));
  }

  if (/今天/.test(raw)) return formatDateYmd(date);
  if (/明天/.test(raw)) {
    date.setDate(date.getDate() + 1);
    return formatDateYmd(date);
  }
  if (/後天/.test(raw)) {
    date.setDate(date.getDate() + 2);
    return formatDateYmd(date);
  }

  const weekMatch = raw.match(/下?週([一二三四五六日天])/);
  if (weekMatch) {
    const targetMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const target = targetMap[weekMatch[1]];
    let diff = target - date.getDay();
    if (diff <= 0 || raw.includes('下週')) diff += 7;
    date.setDate(date.getDate() + diff);
    return formatDateYmd(date);
  }

  return raw;
}

function stripTodoSchedulePrefix(text) {
  return String(text || '').replace(/^\[延後到 [^\]]+\]\s*/, '');
}

function withTodoSchedulePrefix(text, dueDate) {
  return `[延後到 ${dueDate}] ${stripTodoSchedulePrefix(text)}`;
}

function todoStateKey(todoId) {
  return `todo_state:${todoId}`;
}

const TODO_FOCUS_TTL_MS = 2 * 60 * 60 * 1000;

function todoFocusKey(sourceKey) {
  return `todo_focus:${sourceKey}`;
}

function getTodoFocusSourceKey(event) {
  if (event?.source?.type === 'group') return `group:${event.source.groupId}`;
  if (event?.source?.type === 'room') return `room:${event.source.roomId}`;
  if (event?.source?.type === 'user') return `direct:${event.source.userId}`;
  return '';
}

function parseTodoState(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function inferTodoStateFromText(text) {
  const raw = String(text || '');
  const statusMatch = raw.match(/^\[(進行中|半完成|未完成|等待回覆|待處理)\]\s*/);
  const dueMatch = raw.match(/^\[延後到 ([^\]]+)\]\s*/);
  return {
    status: statusMatch ? statusMatch[1] : '待處理',
    due_date: dueMatch ? dueMatch[1] : null,
  };
}

async function getTodoStateMap(todos) {
  const keys = (todos || []).map((todo) => todoStateKey(todo.id));
  if (keys.length === 0) return new Map();
  const { data } = await supabase.from('xlan_kv').select('key, value').in('key', keys);
  const kvMap = new Map((data || []).map((row) => [row.key, parseTodoState(row.value)]));
  return new Map((todos || []).map((todo) => {
    const stored = kvMap.get(todoStateKey(todo.id)) || {};
    return [todo.id, { ...inferTodoStateFromText(todo.text), ...stored }];
  }));
}

async function saveTodoState(todoId, patch) {
  const key = todoStateKey(todoId);
  const { data } = await supabase.from('xlan_kv').select('value').eq('key', key).single();
  const existing = parseTodoState(data?.value);
  const next = {
    ...existing,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await supabase.from('xlan_kv').upsert({ key, value: JSON.stringify(next) });
  return next;
}

async function clearTodoState(todoId) {
  await supabase.from('xlan_kv').delete().eq('key', todoStateKey(todoId));
}

async function saveTodoFocus(sourceKey, todos, reason = '') {
  const ids = (todos || []).map((todo) => todo?.id).filter(Boolean).slice(0, 10);
  if (!sourceKey || ids.length === 0) return;
  await supabase.from('xlan_kv').upsert({
    key: todoFocusKey(sourceKey),
    value: JSON.stringify({ ids, reason, updated_at: new Date().toISOString() }),
  });
}

async function loadTodoFocus(sourceKey) {
  if (!sourceKey) return [];
  const { data } = await supabase.from('xlan_kv').select('value').eq('key', todoFocusKey(sourceKey)).single();
  if (!data?.value) return [];

  let focus;
  try {
    focus = JSON.parse(data.value);
  } catch {
    return [];
  }

  const updatedAt = new Date(focus.updated_at || 0).getTime();
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > TODO_FOCUS_TTL_MS) return [];
  const ids = Array.isArray(focus.ids) ? focus.ids.filter(Boolean).slice(0, 10) : [];
  if (ids.length === 0) return [];

  const { data: todos } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .in('id', ids);
  const todoMap = new Map((todos || []).map((todo) => [todo.id, todo]));
  return ids.map((id) => todoMap.get(id)).filter(Boolean);
}

function cleanTodoDisplayText(text) {
  return stripTodoSchedulePrefix(stripTodoStatusPrefix(text));
}

function todoStatusIcon(status) {
  return {
    待處理: '⚪',
    進行中: '🟡',
    半完成: '🟠',
    等待回覆: '🔵',
    未完成: '⚫',
  }[status || '待處理'] || '⚪';
}

function formatTodoLine(todo, state = {}) {
  const due = state?.due_date ? `（延後到${state.due_date}）` : '';
  const pri = todo.priority === 'urgent' ? '🔴 ' : todo.priority === 'important' ? '🟡 ' : '';
  return `${todoStatusIcon(state?.status)} ${pri}${cleanTodoDisplayText(todo.text)}${due}`;
}

async function getPendingTodos(limit = 100) {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true })
    .limit(limit);
  return data || [];
}

function rankTodoCandidates(todos, keyword) {
  const normalizedKeyword = normalizeTodoText(keyword);
  return (todos || [])
    .map((todo) => ({
      todo,
      score: scoreTodoMatch(normalizedKeyword, normalizeTodoText(`${todo.text || ''} ${todo.source_message || ''} ${todo.project_name || ''}`)),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function ambiguousTodoReply(candidates, actionLabel) {
  const options = candidates.slice(0, 5).map((item, i) => `${i + 1}. ${item.todo.text}`).join('\n');
  return `找到幾個可能的待辦，請回「${actionLabel}第N項」：\n${options}`;
}

async function completeTodoByKeyword(keyword) {
  const todos = await getPendingTodos();
  const candidates = rankTodoCandidates(todos, keyword);
  if (candidates.length === 0) {
    return `找不到包含「${keyword}」的未完成待辦。你可以回「待辦」看清單。`;
  }
  const best = candidates[0];
  if (candidates.length > 1 && best.score === candidates[1].score && best.score < 8) {
    return ambiguousTodoReply(candidates, '完成');
  }
  await supabase
    .from('xlan_todos')
    .update({ done: true, done_at: new Date().toISOString() })
    .eq('id', best.todo.id);
  await clearTodoState(best.todo.id);
  return `✅ 已完成：「${cleanTodoDisplayText(best.todo.text)}」`;
}

async function deleteTodoByKeyword(keyword) {
  const todos = await getPendingTodos();
  const candidates = rankTodoCandidates(todos, keyword);
  if (candidates.length === 0) {
    return `找不到包含「${keyword}」的未完成待辦。你可以回「待辦」看清單。`;
  }
  const best = candidates[0];
  if (candidates.length > 1 && best.score === candidates[1].score && best.score < 8) {
    return ambiguousTodoReply(candidates, '刪除');
  }
  await supabase.from('xlan_todos').delete().eq('id', best.todo.id);
  await clearTodoState(best.todo.id);
  return `🗑️ 已刪除：「${cleanTodoDisplayText(best.todo.text)}」`;
}

async function postponeTodoByKeyword(keyword, dueText) {
  const dueDate = parseTodoDueDate(dueText);
  if (!dueDate) return '要延後到什麼時候？例如：延後到明天、延後到6/5。';
  const todos = await getPendingTodos();
  const candidates = rankTodoCandidates(todos, keyword);
  if (candidates.length === 0) {
    return `找不到包含「${keyword}」的未完成待辦。你可以回「待辦」看清單。`;
  }
  const best = candidates[0];
  if (candidates.length > 1 && best.score === candidates[1].score && best.score < 8) {
    return ambiguousTodoReply(candidates, '延後');
  }
  await saveTodoState(best.todo.id, { status: '待處理', due_date: dueDate });
  return `⏳ 已延後到 ${dueDate}：「${cleanTodoDisplayText(best.todo.text)}」`;
}

async function markTodoStatusByKeyword(keyword, status) {
  const allowed = ['進行中', '半完成', '等待回覆', '未完成'];
  if (!allowed.includes(status)) return '狀態只能是：進行中、半完成、等待回覆、未完成。';

  const todos = await getPendingTodos();
  const candidates = rankTodoCandidates(todos, keyword);
  if (candidates.length === 0) {
    return `找不到包含「${keyword}」的未完成待辦。你可以回「待辦」看清單。`;
  }

  const best = candidates[0];
  if (candidates.length > 1 && best.score === candidates[1].score && best.score < 8) {
    return ambiguousTodoReply(candidates, status);
  }

  await saveTodoState(best.todo.id, { status });
  return `${todoStatusIcon(status)} 已標記${status}：「${cleanTodoDisplayText(best.todo.text)}」`;
}

async function getPendingTodoById(todoId) {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('id', todoId)
    .eq('done', false)
    .single();
  return data || null;
}

async function completeTodoById(todoId) {
  const todo = await getPendingTodoById(todoId);
  if (!todo) return '找不到這件未完成待辦，可能已經完成或刪除了。';
  await supabase
    .from('xlan_todos')
    .update({ done: true, done_at: new Date().toISOString() })
    .eq('id', todo.id);
  await clearTodoState(todo.id);
  return `✅ 已完成：「${cleanTodoDisplayText(todo.text)}」`;
}

async function deleteTodoById(todoId) {
  const todo = await getPendingTodoById(todoId);
  if (!todo) return '找不到這件未完成待辦，可能已經完成或刪除了。';
  await supabase.from('xlan_todos').delete().eq('id', todo.id);
  await clearTodoState(todo.id);
  return `🗑️ 已刪除：「${cleanTodoDisplayText(todo.text)}」`;
}

async function markTodoStatusById(todoId, status) {
  const allowed = ['進行中', '半完成', '等待回覆', '未完成'];
  if (!allowed.includes(status)) return '狀態只能是：進行中、半完成、等待回覆、未完成。';
  const todo = await getPendingTodoById(todoId);
  if (!todo) return '找不到這件未完成待辦，可能已經完成或刪除了。';
  await saveTodoState(todo.id, { status });
  return `${todoStatusIcon(status)} 已標記${status}：「${cleanTodoDisplayText(todo.text)}」`;
}

async function postponeTodoById(todoId, dueText) {
  const dueDate = parseTodoDueDate(dueText);
  if (!dueDate) return '要延後到什麼時候？例如：延後到明天、延後到6/5。';
  const todo = await getPendingTodoById(todoId);
  if (!todo) return '找不到這件未完成待辦，可能已經完成或刪除了。';
  await saveTodoState(todo.id, { status: '待處理', due_date: dueDate });
  return `⏳ 已延後到 ${dueDate}：「${cleanTodoDisplayText(todo.text)}」`;
}

async function handleTodoActionCommand(text) {
  const match = String(text || '').match(/^待辦:([0-9a-f-]{32,36}):(完成|進行中|半完成|等待回覆|未完成|刪除|延後)(?::(.+))?$/i);
  if (!match) return null;
  const todoId = match[1];
  const action = match[2];
  const arg = match[3] || '';
  if (action === '完成') return completeTodoById(todoId);
  if (action === '刪除') return deleteTodoById(todoId);
  if (action === '延後') return postponeTodoById(todoId, arg || '明天');
  return markTodoStatusById(todoId, action);
}

function buildTodoCandidateActionFlex(todos, action, stateMap = new Map(), dueText = '') {
  const actionConfig = {
    完成: { label: '完成這件', color: CARD_THEME.primary, command: '完成' },
    刪除: { label: '刪除這件', color: CARD_THEME.danger, command: '刪除' },
    延後: { label: `延後到${dueText || '明天'}`, color: CARD_THEME.primary, command: `延後:${dueText || '明天'}` },
    進行中: { label: '標進行中', color: CARD_THEME.primary, command: '進行中' },
    半完成: { label: '標半完成', color: '#F97316', command: '半完成' },
    等待回覆: { label: '標等回覆', color: CARD_THEME.info, command: '等待回覆' },
    未完成: { label: '標未完成', color: CARD_THEME.muted, command: '未完成' },
  }[action] || { label: '處理這件', color: CARD_THEME.muted, command: action };

  const bubbles = (todos || []).slice(0, 5).map((todo) => {
    const state = stateMap.get(todo.id) || {};
    const displayText = cleanTodoDisplayText(todo.text);
    const title = displayText.length > 58 ? `${displayText.slice(0, 58)}...` : displayText;
    const due = state.due_date ? `｜延後到 ${state.due_date}` : '';
    const status = `${todoStatusIcon(state.status)} ${state.status || '待處理'}${due}`;
    return {
      type: 'bubble',
      size: 'micro',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: CARD_THEME.page,
        spacing: 'sm',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'sm', color: CARD_THEME.text, wrap: true },
          { type: 'text', text: status, size: 'xxs', color: CARD_THEME.primaryDark, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: actionConfig.color,
            action: { type: 'message', label: actionConfig.label, text: `待辦:${todo.id}:${actionConfig.command}` },
          },
          {
            type: 'button',
            height: 'sm',
            style: 'secondary',
            action: { type: 'message', label: '看待辦', text: '待辦' },
          },
        ],
      },
    };
  });

  if (bubbles.length === 0) return null;
  return {
    type: 'flex',
    altText: '請選擇待辦',
    contents: { type: 'carousel', contents: bubbles },
  };
}

async function resolveTodoActionByKeyword(keyword, action, actionLabel, options = {}) {
  const todos = await getPendingTodos();
  const topTodos = todos.slice(0, 5);
  const needsChoice = async (message, choiceTodos) => {
    if (!choiceTodos || choiceTodos.length === 0) {
      return { result: '目前沒有未完成待辦。', flexMessage: null };
    }
    const stateMap = await getTodoStateMap(choiceTodos);
    return {
      result: message,
      flexMessage: buildTodoCandidateActionFlex(choiceTodos, action, stateMap, options.dueText || ''),
    };
  };

  if (!keyword) {
    return needsChoice(
      `是哪一件要${actionLabel}？我先列出幾件未完成待辦，你可以直接點。`,
      topTodos,
    );
  }

  const candidates = rankTodoCandidates(todos, keyword);
  if (candidates.length === 0) {
    return needsChoice(
      `找不到包含「${keyword}」的未完成待辦。我先列出幾件可能要處理的，你可以直接點。`,
      topTodos,
    );
  }

  const best = candidates[0];
  if (candidates.length > 1 && best.score === candidates[1].score && best.score < 8) {
    return needsChoice(
      `找到幾個可能的待辦，請直接點你要${actionLabel}的那件。`,
      candidates.map((item) => item.todo).slice(0, 5),
    );
  }

  if (action === '完成') return { result: await completeTodoById(best.todo.id), flexMessage: null };
  if (action === '刪除') return { result: await deleteTodoById(best.todo.id), flexMessage: null };
  if (action === '延後') return { result: await postponeTodoById(best.todo.id, options.dueText), flexMessage: null };
  return { result: await markTodoStatusById(best.todo.id, action), flexMessage: null };
}

async function resolveTodoActionFromFocus(sourceKey, action, actionLabel, options = {}) {
  const focusedTodos = await loadTodoFocus(sourceKey);
  if (focusedTodos.length === 0) return null;
  if (focusedTodos.length === 1) {
    const todoId = focusedTodos[0].id;
    if (action === '完成') return { result: await completeTodoById(todoId), flexMessage: null };
    if (action === '刪除') return { result: await deleteTodoById(todoId), flexMessage: null };
    if (action === '延後') return { result: await postponeTodoById(todoId, options.dueText), flexMessage: null };
    return { result: await markTodoStatusById(todoId, action), flexMessage: null };
  }

  const stateMap = await getTodoStateMap(focusedTodos);
  return {
    result: `你剛剛看的有幾件待辦，請直接點要${actionLabel}的那一件。`,
    flexMessage: buildTodoCandidateActionFlex(focusedTodos, action, stateMap, options.dueText || ''),
  };
}

async function resolveNaturalTodoAction(naturalTodoAction, sourceKey) {
  if (!naturalTodoAction) return null;
  const options = { dueText: naturalTodoAction.dueText || '' };
  if (!naturalTodoAction.keyword) {
    const focused = await resolveTodoActionFromFocus(
      sourceKey,
      naturalTodoAction.action,
      naturalTodoAction.label,
      options,
    );
    if (focused) return focused;
  }
  return resolveTodoActionByKeyword(
    naturalTodoAction.keyword,
    naturalTodoAction.action,
    naturalTodoAction.label,
    options,
  );
}

async function resolveFocusedShortTodoReply(text, sourceKey) {
  const raw = String(text || '').trim();
  if (!raw || !sourceKey) return null;

  let action = null;
  let label = '';
  let dueText = '';

  if (/^(明天|明天做|明天再做|明天處理|明天再處理)$/.test(raw)) {
    action = '延後';
    label = '延後';
    dueText = '明天';
  } else if (/^(後天|後天做|後天再做|後天處理)$/.test(raw)) {
    action = '延後';
    label = '延後';
    dueText = '後天';
  } else if (/^(下週|下周|下禮拜|下星期|下週再處理|下周再處理)$/.test(raw)) {
    action = '延後';
    label = '延後';
    dueText = '下週一';
  } else if (/^(\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日?)$/.test(raw)) {
    action = '延後';
    label = '延後';
    dueText = raw;
  } else if (/^(取消|刪掉|刪除|不用了|不用做了|不用管了)$/.test(raw)) {
    action = '刪除';
    label = '刪除';
  }

  if (!action) return null;
  return resolveTodoActionFromFocus(sourceKey, action, label, { dueText });
}

function todoToolResultToMessages(result) {
  const messages = [];
  if (result?.flexMessage) messages.push(result.flexMessage);
  if (result?.result) messages.push({ type: 'text', text: result.result });
  return messages.length > 0 ? messages : null;
}

function parseNaturalTodoAction(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^(完成|好了|處理好了|辦完了|ok|OK|已完成)$/.test(raw)) {
    return { action: '完成', label: '完成', keyword: '' };
  }
  if (/^(等回覆|等待回覆|先等|等老闆|等廠商)$/.test(raw)) {
    return { action: '等待回覆', label: '標記等待回覆', keyword: '' };
  }
  if (/^(做到一半|半完成|先做一半)$/.test(raw)) {
    return { action: '半完成', label: '標記半完成', keyword: '' };
  }
  if (/^(進行中|正在做|處理中|已經開始)$/.test(raw)) {
    return { action: '進行中', label: '標記進行中', keyword: '' };
  }
  if (/^(未完成|還沒做|沒完成|今天沒做完)$/.test(raw)) {
    return { action: '未完成', label: '標記未完成', keyword: '' };
  }
  if (/^(明天再做|下週再處理)$/.test(raw)) {
    return { action: '延後', label: '延後', keyword: '', dueText: raw.includes('下週') ? '下週一' : '明天' };
  }
  if (/^延後到(.+)$/.test(raw)) {
    const match = raw.match(/^延後到(.+)$/);
    return { action: '延後', label: '延後', keyword: '', dueText: match[1].trim() };
  }

  const postponeMatch = raw.match(/^(.+?)(?:延後到|改到|挪到|明天再做|下週再處理)(.+)?$/);
  if (postponeMatch) {
    const dueText = postponeMatch[2] || (raw.includes('明天') ? '明天' : raw.includes('下週') ? '下週一' : '');
    return { action: '延後', label: '延後', keyword: postponeMatch[1].trim(), dueText };
  }

  const rules = [
    { action: '完成', label: '完成', re: /^(.+?)(?:完成了|已完成|做好了|好了|處理好了|辦完了|ok了|OK了)$/ },
    { action: '刪除', label: '刪除', re: /^(.+?)(?:不用做了|不用管了|取消|刪掉|刪除)$/ },
    { action: '等待回覆', label: '標記等待回覆', re: /^(.+?)(?:先等|等老闆|等廠商|等回覆|等待回覆|對方還沒回)$/ },
    { action: '半完成', label: '標記半完成', re: /^(.+?)(?:做到一半|先做一半|還沒完全好|半完成)$/ },
    { action: '進行中', label: '標記進行中', re: /^(.+?)(?:正在做|處理中|已經開始|進行中)$/ },
    { action: '未完成', label: '標記未完成', re: /^(.+?)(?:還沒做|沒完成|今天沒做完|未完成)$/ },
  ];
  for (const rule of rules) {
    const match = raw.match(rule.re);
    if (match) return { action: rule.action, label: rule.label, keyword: match[1].trim() };
  }
  return null;
}

// --- 處理 tool use 結果 ---
async function handleToolUse(block, userMessage, context = {}) {
  const focusKey = context.focusKey || '';

  if (block.name === 'save_todo' && block.input.task) {
    const { data: savedTodo, error } = await supabase.from('xlan_todos').insert({
      text: block.input.task,
      source_message: userMessage,
      priority: block.input.priority || 'normal',
      source_person: block.input.source_person || null,
    }).select('*').single();
    if (error) {
      console.error('Save todo error:', error.message);
      return { result: `待辦儲存失敗：${error.message}`, isError: true, flexMessage: null };
    }
    const pLabel = { urgent: '🔴', important: '🟡', normal: '' }[block.input.priority || 'normal'];
    const stateMap = savedTodo ? new Map([[savedTodo.id, { status: '待處理' }]]) : new Map();
    if (savedTodo) await saveTodoFocus(focusKey, [savedTodo], 'saved_todo');
    return {
      result: `已存入待辦${pLabel}：${block.input.task}`,
      flexMessage: savedTodo ? buildTodoActionFlex([savedTodo], stateMap) : null,
    };
  }

  if (block.name === 'complete_todo') {
    try {
      const keyword = String(block.input.keyword || '').trim();
      if (!keyword) {
        const focused = await resolveTodoActionFromFocus(focusKey, '完成', '完成');
        if (focused) return focused;
      }
      return resolveTodoActionByKeyword(keyword, '完成', '完成');
    } catch (err) {
      console.error('Complete todo error:', err.message);
      return { result: `標記完成失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'delete_todo') {
    try {
      const keyword = String(block.input.keyword || '').trim();
      if (!keyword) {
        const focused = await resolveTodoActionFromFocus(focusKey, '刪除', '刪除');
        if (focused) return focused;
      }
      return resolveTodoActionByKeyword(keyword, '刪除', '刪除');
    } catch (err) {
      console.error('Delete todo error:', err.message);
      return { result: `刪除失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'postpone_todo') {
    try {
      const keyword = String(block.input.keyword || '').trim();
      const dueText = String(block.input.due_text || '').trim();
      if (!dueText) return { result: '要延後到什麼時候？例如：明天、下週一、6/5。', flexMessage: null };
      if (!keyword) {
        const focused = await resolveTodoActionFromFocus(focusKey, '延後', '延後', { dueText });
        if (focused) return focused;
      }
      return resolveTodoActionByKeyword(keyword, '延後', '延後', { dueText });
    } catch (err) {
      console.error('Postpone todo error:', err.message);
      return { result: `延後失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'mark_todo_status') {
    try {
      const keyword = String(block.input.keyword || '').trim();
      const status = String(block.input.status || '').trim();
      if (!keyword) {
        const focused = await resolveTodoActionFromFocus(focusKey, status, `標記${status}`);
        if (focused) return focused;
      }
      return resolveTodoActionByKeyword(keyword, status, `標記${status}`);
    } catch (err) {
      console.error('Mark todo status error:', err.message);
      return { result: `更新狀態失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'create_calendar_event' && block.input.title) {
    try {
      await createCalendarEvent(block.input);
      const timeStr = block.input.time ? ` ${block.input.time}` : '（全天）';
      return { result: `已建立行事曆：${block.input.title} / ${block.input.date}${timeStr}`, flexMessage: null };
    } catch (err) {
      console.error('Calendar error:', err.message);
      return { result: `行事曆建立失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'save_expense') {
    try {
      const savedExpense = await saveExpense(block.input);
      await saveExpenseFocus(focusKey, savedExpense);
      const flex = buildExpenseFlexMessage({
        id: savedExpense.id,
        amount: block.input.amount,
        category: block.input.category,
        note: block.input.note,
        type: block.input.type,
        account: block.input.account || 'personal',
        label: block.input._label || null,
      });
      const accountLabel = (block.input.account === 'business') ? '公司' : '私人';
      return { result: `已記帳：${block.input.type === 'income' ? '收入' : '支出'} ${block.input.category} NT$${block.input.amount}（${accountLabel}）`, flexMessage: flex };
    } catch (err) {
      console.error('Expense error:', err.message);
      return { result: `記帳失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_expenses') {
    const expenses = await getExpenses(block.input.period);
    const periodLabel = { today: '今天', this_week: '本週', this_month: '本月' }[block.input.period] || block.input.period;
    if (expenses.length === 0) {
      return { result: `${periodLabel}沒有任何收支記錄。`, flexMessage: null };
    }
    await saveExpenseFocus(focusKey, expenses[0]);
    const totalIncome = expenses.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
    const totalExpense = expenses.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
    const details = expenses.map((e) => {
      const icon = e.type === 'income' ? '📈' : '📉';
      const acct = e.account === 'business' ? '[公司]' : '';
      const dateStr = new Date(e.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `${icon}${acct} ${e.category} NT$${e.amount}${e.note ? '（' + e.note + '）' : ''} - ${dateStr}`;
    }).join('\n');
    return {
      result: `${periodLabel}收支摘要：\n收入：NT$${totalIncome}\n支出：NT$${totalExpense}\n淨額：NT$${totalIncome - totalExpense}\n\n明細：\n${details}`,
      flexMessage: null,
    };
  }

  if (block.name === 'save_note') {
    try {
      await supabase.from('xlan_notes').insert({
        content: block.input.content,
        tags: block.input.tags || [],
      });
      return { result: `已記錄筆記：${block.input.content.substring(0, 30)}`, flexMessage: null };
    } catch (err) {
      console.error('Note error:', err.message);
      return { result: `筆記儲存失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_notes') {
    try {
      const keyword = block.input.keyword;
      let query = supabase.from('xlan_notes').select('*').order('created_at', { ascending: false }).limit(20);
      if (keyword) {
        query = query.ilike('content', `%${keyword}%`);
      }
      const { data } = await query;
      if (!data || data.length === 0) {
        return { result: keyword ? `找不到包含「${keyword}」的筆記。` : '目前沒有任何筆記。', flexMessage: null };
      }
      const items = data.map((n, i) => {
        const tags = (n.tags || []).length > 0 ? ` [${n.tags.join(',')}]` : '';
        const dateStr = new Date(n.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const summary = n.content.length > 40 ? n.content.substring(0, 40) + '...' : n.content;
        return `${i + 1}. ${summary}${tags} - ${dateStr}`;
      }).join('\n');
      return { result: `📝 筆記記錄（共${data.length}筆）\n\n${items}`, flexMessage: null };
    } catch (err) {
      console.error('Get notes error:', err.message);
      return { result: `查詢筆記失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'save_deployment') {
    try {
      return { result: await saveDeployment(block.input), flexMessage: null };
    } catch (err) {
      console.error('Save deployment error:', err.message);
      return { result: `部署記錄失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_deployment') {
    try {
      const keyword = String(block.input.keyword || '').trim();
      if (!keyword) return { result: await listAllDeployments(), flexMessage: null };
      const reply = await answerDeploymentFromMemory(keyword);
      return { result: reply || `找不到「${keyword}」的部署資訊。`, flexMessage: null };
    } catch (err) {
      console.error('Get deployment error:', err.message);
      return { result: `查詢部署失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'update_note') {
    try {
      const keyword = String(block.input.keyword || '').trim();
      const content = String(block.input.content || '').trim();
      if (!keyword || !content) return { result: '要更新哪一則筆記？請補關鍵字和新內容。', flexMessage: null };
      return { result: await updateNoteByKeyword(keyword, content, block.input.tags || []), flexMessage: null };
    } catch (err) {
      console.error('Update note error:', err.message);
      return { result: `更新筆記失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'delete_note') {
    try {
      const keyword = String(block.input.keyword || '').trim();
      if (!keyword) return { result: '要刪除哪一則筆記？請補關鍵字，例如「新系統網址不用記了」。', flexMessage: null };
      return { result: await deleteNoteByKeyword(keyword), flexMessage: null };
    } catch (err) {
      console.error('Delete note error:', err.message);
      return { result: `刪除筆記失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'save_recurring') {
    try {
      await supabase.from('xlan_recurring').insert({
        title: block.input.title,
        amount: block.input.amount || null,
        account: block.input.account || 'personal',
        frequency: block.input.frequency,
        day_of_month: block.input.day_of_month,
        month_of_year: block.input.month_of_year || null,
        note: block.input.note || null,
      });
      const freqText = block.input.frequency === 'yearly' ? '每年' : '每月';
      const amtText = block.input.amount ? ` NT$${block.input.amount}` : '';
      return { result: `已設定定期提醒：${block.input.title} ${freqText}${block.input.day_of_month}號${amtText}`, flexMessage: null };
    } catch (err) {
      console.error('Recurring error:', err.message);
      return { result: `定期付款設定失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'save_bug') {
    try {
      await supabase.from('xlan_bugs').insert({
        description: block.input.description,
        reporter: block.input.reporter || null,
        source_group: block.input.source_group || null,
      });
      return { result: `已記錄 bug：${block.input.description}`, flexMessage: null };
    } catch (err) {
      console.error('Bug error:', err.message);
      return { result: `Bug 記錄失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'fix_bug') {
    try {
      const { data: bugs } = await supabase
        .from('xlan_bugs').select('*').eq('status', 'pending')
        .ilike('description', `%${block.input.keyword}%`).limit(1);
      if (!bugs || bugs.length === 0) {
        return { result: `找不到包含「${block.input.keyword}」的待修 bug`, flexMessage: null };
      }
      await supabase.from('xlan_bugs').update({ status: 'fixed', fixed_at: new Date().toISOString() }).eq('id', bugs[0].id);
      return { result: `Bug 已標記修復：${bugs[0].description}`, flexMessage: null };
    } catch (err) {
      console.error('Fix bug error:', err.message);
      return { result: `Bug 標記失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_priority_todos') {
    try {
      const { data: todos } = await supabase
        .from('xlan_todos').select('*').eq('done', false).order('created_at', { ascending: true });
      if (!todos || todos.length === 0) {
        return { result: '目前沒有待辦事項！', flexMessage: null };
      }
      const urgent = todos.filter(t => t.priority === 'urgent');
      const important = todos.filter(t => t.priority === 'important');
      const normal = todos.filter(t => !t.priority || t.priority === 'normal');

      let result = '🎯 今日優先順序\n';
      if (urgent.length > 0) {
        result += `\n🔴 緊急（${urgent.length}項）\n` + urgent.map(t => {
          const src = t.source_person ? `[${t.source_person}] ` : '';
          return `• ${src}${t.text}`;
        }).join('\n');
      }
      if (important.length > 0) {
        result += `\n\n🟡 重要（${important.length}項）\n` + important.map(t => {
          const src = t.source_person ? `[${t.source_person}] ` : '';
          return `• ${src}${t.text}`;
        }).join('\n');
      }
      if (normal.length > 0) {
        result += `\n\n⚪ 一般（${normal.length}項）\n` + normal.map(t => {
          const src = t.source_person ? `[${t.source_person}] ` : '';
          return `• ${src}${t.text}`;
        }).join('\n');
      }
      result += '\n\n先處理紅色的，有問題隨時告訴我！';
      return { result, flexMessage: null };
    } catch (err) {
      console.error('Priority todos error:', err.message);
      return { result: `查詢失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'save_shipment') {
    try {
      await supabase.from('xlan_shipments').insert({
        title: block.input.title,
        expected_date: block.input.expected_date,
        note: block.input.note || null,
      });
      return { result: `已記錄到貨追蹤：${block.input.title} 預計 ${block.input.expected_date}`, flexMessage: null };
    } catch (err) {
      return { result: `記錄失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'arrive_shipment') {
    try {
      const { data: ships } = await supabase
        .from('xlan_shipments').select('*').eq('status', 'pending')
        .ilike('title', `%${block.input.keyword}%`).limit(1);
      if (!ships || ships.length === 0) {
        return { result: `找不到包含「${block.input.keyword}」的待到貨物`, flexMessage: null };
      }
      await supabase.from('xlan_shipments').update({ status: 'arrived', arrived_at: new Date().toISOString() }).eq('id', ships[0].id);
      return { result: `📦 已標記到貨：${ships[0].title}`, flexMessage: null };
    } catch (err) {
      return { result: `標記失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_shipments') {
    try {
      const { data: ships } = await supabase
        .from('xlan_shipments').select('*').eq('status', 'pending').order('expected_date', { ascending: true });
      if (!ships || ships.length === 0) {
        return { result: '目前沒有待到貨物！', flexMessage: null };
      }
      const today = new Date().toISOString().split('T')[0];
      const lines = ships.map(s => {
        const diff = Math.round((new Date(s.expected_date) - new Date(today)) / 86400000);
        const when = diff === 0 ? '今天到' : diff === 1 ? '明天到' : diff < 0 ? `已遲${-diff}天 ⚠️` : `還有${diff}天`;
        const warn = diff <= 1 ? ' ⚠️' : '';
        return `• ${s.title} — 預計 ${s.expected_date}（${when}）${warn}`;
      });
      return { result: `📦 陸貨追蹤\n\n${lines.join('\n')}`, flexMessage: null };
    } catch (err) {
      return { result: `查詢失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'save_payable') {
    try {
      await supabase.from('xlan_payables').insert({
        title: block.input.title,
        amount: block.input.amount || null,
        to_whom: block.input.to_whom,
        due_date: block.input.due_date || null,
        note: block.input.note || null,
      });
      const amtStr = block.input.amount ? ` NT$${block.input.amount}` : '';
      return { result: `已記錄應付款：付給${block.input.to_whom}${amtStr}`, flexMessage: null };
    } catch (err) {
      return { result: `記錄失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'save_vendor') {
    try {
      await supabase.from('xlan_vendors').insert({
        name: block.input.name,
        contact_person: block.input.contact_person || null,
        phone: block.input.phone || null,
        payment_terms: block.input.payment_terms || null,
        note: block.input.note || null,
      });
      return { result: `已儲存廠商：${block.input.name}`, flexMessage: null };
    } catch (err) {
      return { result: `儲存失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_vendor') {
    try {
      const { data: vendors } = await supabase
        .from('xlan_vendors').select('*').ilike('name', `%${block.input.keyword}%`).limit(5);
      if (!vendors || vendors.length === 0) {
        return { result: `找不到包含「${block.input.keyword}」的廠商`, flexMessage: null };
      }
      const lines = vendors.map(v => {
        const parts = [`🏭 ${v.name}`];
        if (v.contact_person) parts.push(`聯絡人：${v.contact_person}`);
        if (v.phone) parts.push(`電話：${v.phone}`);
        if (v.payment_terms) parts.push(`付款條件：${v.payment_terms}`);
        if (v.note) parts.push(`備註：${v.note}`);
        return parts.join('\n');
      });
      return { result: lines.join('\n\n'), flexMessage: null };
    } catch (err) {
      return { result: `查詢失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'create_project') {
    try {
      const { data: proj, error } = await supabase.from('xlan_projects').insert({
        name: block.input.name,
        description: block.input.description || null,
      }).select().single();
      if (error) throw new Error(error.message);

      const tasks = block.input.tasks || [];
      let savedTodos = [];
      if (tasks.length > 0) {
        const todoRows = tasks.map(t => ({
          text: t,
          project_id: proj.id,
          project_name: block.input.name,
          priority: 'normal',
        }));
        const { data: insertedTodos, error: todoError } = await supabase.from('xlan_todos').insert(todoRows).select('*');
        if (todoError) throw new Error(todoError.message);
        savedTodos = insertedTodos || [];
        await saveTodoFocus(focusKey, savedTodos, 'created_project');
      }

      const taskList = tasks.map((t, i) => `${i + 1}. 🔲 ${t}`).join('\n');
      const stateMap = new Map(savedTodos.map((todo) => [todo.id, { status: '待處理' }]));
      return {
        result: `📁 已建立專案：${block.input.name}\n\n工作項目（共${tasks.length}項）：\n${taskList}`,
        flexMessage: savedTodos.length > 0 ? buildTodoActionFlex(savedTodos, stateMap) : null,
      };
    } catch (err) {
      return { result: `建立專案失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_project_status') {
    try {
      const { data: projects } = await supabase
        .from('xlan_projects').select('*').ilike('name', `%${block.input.keyword}%`).eq('status', 'active').limit(1);
      if (!projects || projects.length === 0) {
        return { result: `找不到包含「${block.input.keyword}」的進行中專案`, flexMessage: null };
      }
      const proj = projects[0];
      const { data: todos } = await supabase
        .from('xlan_todos').select('*').eq('project_id', proj.id).order('created_at', { ascending: true });
      if (!todos || todos.length === 0) {
        return { result: `📁 ${proj.name}\n尚無工作項目`, flexMessage: null };
      }
      const done = todos.filter(t => t.done);
      const pending = todos.filter(t => !t.done);
      const pct = Math.round((done.length / todos.length) * 100);
      const barLen = 10;
      const filled = Math.round(barLen * done.length / todos.length);
      const bar = '▓'.repeat(filled) + '░'.repeat(barLen - filled);

      let result = `📁 ${proj.name}\n進度：${done.length}/${todos.length}（${pct}%）\n${bar}\n`;
      if (done.length > 0) result += `\n${done.map(t => `✅ ${t.text}`).join('\n')}`;
      if (pending.length > 0) result += `\n${pending.map(t => `🔲 ${t.text}`).join('\n')}`;
      return { result, flexMessage: null };
    } catch (err) {
      return { result: `查詢失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_pending_bugs') {
    try {
      const { data: bugs } = await supabase
        .from('xlan_bugs').select('*').eq('status', 'pending').order('created_at', { ascending: false });
      if (!bugs || bugs.length === 0) {
        return { result: '目前沒有待修 Bug！', flexMessage: null };
      }
      const lines = bugs.map((b, i) => {
        const reporter = b.reporter ? ` — ${b.reporter}` : '';
        const date = new Date(b.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' });
        return `${i + 1}. ${b.description}${reporter} / ${date}`;
      });
      return { result: `🐛 待修 Bug（共${bugs.length}項）\n\n${lines.join('\n')}`, flexMessage: null };
    } catch (err) {
      return { result: `查詢失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'get_pending_payables') {
    try {
      const { data: payables } = await supabase
        .from('xlan_payables').select('*').eq('status', 'pending').order('due_date', { ascending: true, nullsFirst: false });
      if (!payables || payables.length === 0) {
        return { result: '目前沒有待付款項！', flexMessage: null };
      }
      const today = new Date().toISOString().split('T')[0];
      const lines = payables.map(p => {
        const amt = p.amount ? ` NT$${p.amount.toLocaleString()}` : '';
        let dueLine = '（無到期日）';
        if (p.due_date) {
          const diff = Math.round((new Date(p.due_date) - new Date(today)) / 86400000);
          dueLine = diff === 0 ? '（今天到期）' : diff === 1 ? '（明天到期）' : diff < 0 ? `（已過期${-diff}天）` : `（${diff}天後到期）`;
        }
        return `• 付給${p.to_whom}${amt}${dueLine}`;
      });
      return { result: `💸 待付款（共${payables.length}項）\n\n${lines.join('\n')}`, flexMessage: null };
    } catch (err) {
      return { result: `查詢失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  if (block.name === 'set_reminder') {
    try {
      const { data: existing } = await supabase
        .from('xlan_kv').select('value').eq('key', 'custom_reminders').single();
      let reminders = [];
      if (existing) {
        try { reminders = JSON.parse(existing.value); } catch { reminders = []; }
      }
      // 移除同 hour 的舊設定
      reminders = reminders.filter(r => r.hour !== block.input.hour);
      reminders.push({ hour: block.input.hour, label: block.input.label });
      reminders.sort((a, b) => a.hour - b.hour);
      await supabase.from('xlan_kv').upsert({ key: 'custom_reminders', value: JSON.stringify(reminders) });
      return { result: `已設定：每天${block.input.hour}點提醒（${block.input.label}）`, flexMessage: null };
    } catch (err) {
      console.error('Set reminder error:', err.message);
      return { result: `設定提醒失敗：${err.message}`, isError: true, flexMessage: null };
    }
  }

  return { result: '未知工具', flexMessage: null };
}

// --- Claude API：AI 對話（支援 tool use）---
function buildConversationContext(context = {}) {
  const mode = context.mode === 'group' ? '群組' : '私訊一對一';
  const trigger = context.trigger || (context.mode === 'group' ? '#' : '無需關鍵字');
  const lines = [
    '【目前對話環境】',
    `位置：${mode}`,
    `觸發方式：${trigger}`,
    context.mode === 'group'
      ? '規則：這是群組中的明確 # 指令，只處理本次指令；不要處理其他沒有 # 的聊天內容。'
      : '規則：這是香奈與小瀾的一對一私訊，可以自然對話、記錄、查詢、分析與看圖。',
  ];
  if (context.intent) {
    lines.push(`系統初判意圖：${context.intent.intent} / 信心：${context.intent.confidence} / 路由：${context.intent.route} / 原因：${context.intent.reason}`);
  }
  return lines.join('\n');
}

function addContextToUserContent(userContent, context, knowledgeContext = '') {
  const contextText = buildConversationContext(context);
  const fullContext = knowledgeContext
    ? `${contextText}\n\n${knowledgeContext}`
    : contextText;
  if (typeof userContent === 'string') {
    return `${fullContext}\n\n【香奈訊息】\n${userContent}`;
  }
  if (Array.isArray(userContent)) {
    return [
      { type: 'text', text: fullContext },
      ...userContent,
    ];
  }
  return userContent;
}

async function chatWithClaude(userId, userContent, context = {}) {
  const chatStartedAt = Date.now();
  const historyPromise = supabase
    .from('xlan_conversations')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(20);
  const knowledgeContextPromise = buildAgentKnowledgeContext(userContent);
  const [{ data: history }, knowledgeContext] = await Promise.all([
    historyPromise,
    knowledgeContextPromise,
  ]);

  const messages = (history || []).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  messages.push({ role: 'user', content: addContextToUserContent(userContent, context, knowledgeContext) });

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages,
  });
  console.log('claude_timing', {
    phase: 'initial',
    elapsed_ms: Date.now() - chatStartedAt,
    mode: context.mode || 'direct',
  });

  const flexMessages = [];
  const userMessageText = typeof userContent === 'string' ? userContent : '(圖片訊息)';
  let toolUseRounds = 0;

  while (response.stop_reason === 'tool_use') {
    toolUseRounds += 1;
    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');

    const toolResults = [];
    for (const block of toolBlocks) {
      const { result, isError, flexMessage } = await handleToolUse(block, userMessageText, context);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
        ...(isError ? { is_error: true } : {}),
      });
      if (flexMessage) flexMessages.push(flexMessage);
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: ALL_TOOLS,
      messages,
    });
    console.log('claude_timing', {
      phase: 'tool_round',
      round: toolUseRounds,
      elapsed_ms: Date.now() - chatStartedAt,
      tool_count: toolBlocks.length,
      mode: context.mode || 'direct',
    });
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  const rawReply = textBlock ? textBlock.text : '已處理完成！';
  const reply = normalizeClaudeReply(rawReply, userMessageText);

  await supabase.from('xlan_conversations').insert([
    { user_id: userId, role: 'user', content: userMessageText },
    { user_id: userId, role: 'assistant', content: reply },
  ]);

  console.log('claude_timing', {
    phase: 'total',
    elapsed_ms: Date.now() - chatStartedAt,
    tool_rounds: toolUseRounds,
    flex_count: flexMessages.length,
    mode: context.mode || 'direct',
  });

  return { reply, flexMessages };
}

// --- 列出待辦 ---
async function listTodos() {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true });

  if (!data || data.length === 0) {
    return '目前沒有待辦事項，一切都處理好了！';
  }
  const stateMap = await getTodoStateMap(data);

  const items = data
    .map((t, i) => {
      const state = stateMap.get(t.id) || {};
      const source = t.source_group ? `（來自：群組）` : '';
      const due = state.due_date ? `｜延後到 ${state.due_date}` : '';
      const status = `${todoStatusIcon(state.status)}${state.status || '待處理'}`;
      return `${i + 1}. ${status} ${cleanTodoDisplayText(t.text)}${due}${source}`;
    })
    .join('\n');

  return `📋 你的待辦清單\n\n${items}\n\n共 ${data.length} 項未完成。\n可以直接點下面卡片處理。`;
}

function buildTodoActionFlex(todos, stateMap = new Map()) {
  const bubbles = todos.slice(0, 10).map((todo, i) => {
    const n = i + 1;
    const state = stateMap.get(todo.id) || {};
    const displayText = cleanTodoDisplayText(todo.text);
    const title = displayText.length > 54 ? `${displayText.slice(0, 54)}...` : displayText;
    const source = todo.source_person ? `交辦：${todo.source_person}` : (todo.project_name ? `專案：${todo.project_name}` : '待辦事項');
    const due = state.due_date ? `｜${state.due_date}` : '';
    const status = `${todoStatusIcon(state.status)} ${state.status || '待處理'}${due}`;
    return {
      type: 'bubble',
      size: 'micro',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: CARD_THEME.page,
        spacing: 'sm',
        contents: [
          { type: 'text', text: `#${n}`, weight: 'bold', size: 'xs', color: CARD_THEME.primaryDark },
          { type: 'text', text: title, weight: 'bold', size: 'sm', wrap: true, color: CARD_THEME.text },
          { type: 'text', text: status, size: 'xxs', color: CARD_THEME.primaryDark, wrap: true },
          { type: 'text', text: source, size: 'xxs', color: CARD_THEME.muted, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: CARD_THEME.primary,
            action: { type: 'message', label: '完成', text: `待辦:${todo.id}:完成` },
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '進行中', text: `待辦:${todo.id}:進行中` },
              },
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '半完成', text: `待辦:${todo.id}:半完成` },
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '等回覆', text: `待辦:${todo.id}:等待回覆` },
              },
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '明天', text: `待辦:${todo.id}:延後:明天` },
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              {
                type: 'button',
                height: 'sm',
                style: 'secondary',
                action: { type: 'message', label: '未完成', text: `待辦:${todo.id}:未完成` },
              },
              {
                type: 'button',
                height: 'sm',
                color: CARD_THEME.danger,
                action: { type: 'message', label: '刪除', text: `待辦:${todo.id}:刪除` },
              },
            ],
          },
        ],
      },
    };
  });

  return {
    type: 'flex',
    altText: '待辦操作卡片',
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

function todoDueRank(state, todayStr) {
  if (!state?.due_date) return 3;
  if (state.due_date < todayStr) return 0;
  if (state.due_date === todayStr) return 1;
  return 2;
}

function todoPressureLabel(todo, state = {}, todayStr) {
  if (state.due_date && state.due_date < todayStr) return '逾期';
  if (state.due_date === todayStr) return '今天到期';
  if (todoAgeDays(todo) >= 3 && ['待處理', '半完成', '未完成'].includes(state.status || '待處理')) return '卡超過3天';
  return '';
}

function todoStateAgeDays(state = {}) {
  if (!state.updated_at) return null;
  const updatedAt = new Date(state.updated_at).getTime();
  if (!Number.isFinite(updatedAt)) return null;
  return Math.floor((Date.now() - updatedAt) / 86400000);
}

function findTodosNeedingStatusCheck(todos, stateMap) {
  return (todos || []).filter((todo) => {
    const state = stateMap.get(todo.id) || {};
    const status = state.status || '待處理';
    const age = todoStateAgeDays(state);
    if (age === null) return false;
    if (status === '等待回覆' && age >= 2) return true;
    if (['進行中', '半完成'].includes(status) && age >= 2) return true;
    if (status === '未完成' && age >= 1) return true;
    return false;
  });
}

function summarizeStatusCheckTodos(todos, stateMap) {
  const targets = findTodosNeedingStatusCheck(todos, stateMap).slice(0, 5);
  if (targets.length === 0) return '';
  const lines = targets.map((todo) => {
    const state = stateMap.get(todo.id) || {};
    const age = todoStateAgeDays(state);
    return `- ${formatTodoLine(todo, state)}（${state.status || '待處理'}已${age}天沒更新）`;
  }).join('\n');
  return `需要確認狀態：\n${lines}`;
}

function inferTodoWorkLane(todo) {
  const raw = `${todo?.text || ''} ${todo?.source_message || ''} ${todo?.project_name || ''}`.toLowerCase();
  if (/中和|文山|龍潭|林口|永和|平鎮|經國|古華|南平|門市|店/.test(raw)) return '門市';
  if (/陸貨|1688|集運|叫貨|補貨|進貨|廠商|付款資料|到貨|運單/.test(raw)) return '陸貨/廠商';
  if (/erp|系統|網站|bug|錯誤|error|webhook|vercel|google sheet|sheet|line bot|機器人/.test(raw)) return '系統';
  if (/line@|ig|fb|facebook|脆|廣告|文案|招牌|做圖|圖片|照片|拍照/.test(raw)) return '行銷內容';
  if (/付款|付錢|匯款|帳|記帳|現金流|薪資|應付|應收|發票/.test(raw)) return '帳務';
  if (/產品|上架|包貨|寄貨|開發|規格|菜單/.test(raw)) return '產品/出貨';
  if (/員工|排班|請假|人員|教育|回報/.test(raw)) return '人員';
  return '其他';
}

function summarizeTodoWorkLanes(todos) {
  if (!todos || todos.length === 0) return '工作分布：目前沒有未完成待辦。';
  const laneCounts = new Map();
  const sourceCounts = new Map();
  (todos || []).forEach((todo) => {
    const lane = inferTodoWorkLane(todo);
    laneCounts.set(lane, (laneCounts.get(lane) || 0) + 1);
    const source = todo.source_person || todo.project_name || (todo.source_group ? '群組' : '私訊');
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  });
  const topLanes = [...laneCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `${name}${count}件`)
    .join('、');
  const topSources = [...sourceCounts.entries()]
    .filter(([name]) => name && name !== '私訊')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${name}${count}件`)
    .join('、');
  return `工作分布：${topLanes || '其他'}。${topSources ? `\n主要來源：${topSources}。` : ''}`;
}

function buildTodoRecommendation(todos, stateMap, todayStr) {
  if (!todos || todos.length === 0) return '建議：目前沒有待辦壓力，可以先整理帳務或補記資料。';

  const laneScores = new Map();
  let overdueCount = 0;
  let dueTodayCount = 0;
  let urgentCount = 0;
  let halfDoneCount = 0;
  let waitingCount = 0;

  (todos || []).forEach((todo) => {
    const state = stateMap.get(todo.id) || {};
    const lane = inferTodoWorkLane(todo);
    let score = 1;
    if (todo.priority === 'urgent') {
      urgentCount += 1;
      score += 5;
    }
    if (state.due_date && state.due_date < todayStr) {
      overdueCount += 1;
      score += 7;
    } else if (state.due_date === todayStr) {
      dueTodayCount += 1;
      score += 5;
    }
    if (state.status === '半完成') {
      halfDoneCount += 1;
      score += 3;
    }
    if (state.status === '等待回覆') {
      waitingCount += 1;
      score += 1;
    }
    if (todoAgeDays(todo) >= 3) score += 2;
    laneScores.set(lane, (laneScores.get(lane) || 0) + score);
  });

  const topLane = [...laneScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '待辦';
  if (overdueCount > 0) return `建議：先處理逾期的${topLane}，逾期會拖到後面所有安排。`;
  if (urgentCount > 0) return `建議：先處理緊急的${topLane}，再回頭清半完成事項。`;
  if (dueTodayCount > 0) return `建議：今天到期的${topLane}先收掉，不要讓它變成明天的逾期。`;
  if (halfDoneCount > 0) return `建議：先把半完成的${topLane}收尾，會比開新工作更快看到進度。`;
  if (waitingCount > 0) return `建議：先追等待回覆的${topLane}，只要補一句訊息就能推進。`;
  return `建議：目前最集中的工作是${topLane}，先挑一件 15 分鐘內能推進的處理。`;
}

function todoPriorityReason(todo, state = {}, todayStr) {
  const status = state.status || '待處理';
  if (state.due_date && state.due_date < todayStr) return '逾期';
  if (state.due_date === todayStr) return '今天到期';
  if (todo.priority === 'urgent') return '緊急';
  if (status === '半完成') return '半完成可收尾';
  if (status === '等待回覆') return '等待回覆';
  if (status === '未完成') return '需要重排';
  if (todoAgeDays(todo) >= 3) return `卡${todoAgeDays(todo)}天`;
  return inferTodoWorkLane(todo);
}

function todoNextActionHint(todo, state = {}, todayStr) {
  const status = state.status || '待處理';
  if (state.due_date && state.due_date < todayStr) return '今天先處理或改期';
  if (state.due_date === todayStr) return '今天收掉';
  if (status === '等待回覆') return '補一句追進度';
  if (status === '半完成') return '收尾或標完成';
  if (status === '進行中') return '推進到半完成';
  if (status === '未完成') return '確認是否保留';
  if (todo.priority === 'urgent') return '先推進一步';
  if (todoAgeDays(todo) >= 3) return '確認還要不要做';
  return '安排一個下一步';
}

function formatSecretaryPlanLine(todo, state = {}, todayStr, index = 0) {
  const prefix = index > 0 ? `${index}. ` : '';
  const reason = todoPriorityReason(todo, state, todayStr);
  const action = todoNextActionHint(todo, state, todayStr);
  return `${prefix}${formatTodoLine(todo, state)}｜${reason}｜${action}`;
}

function todoAgeDays(todo) {
  if (!todo.created_at) return 0;
  return Math.floor((Date.now() - new Date(todo.created_at).getTime()) / 86400000);
}

function sortTodosForBriefing(todos, stateMap, todayStr) {
  return [...(todos || [])].sort((a, b) => {
    const aState = stateMap.get(a.id) || {};
    const bState = stateMap.get(b.id) || {};
    const statusWeight = {
      未完成: 90,
      半完成: 80,
      待處理: 70,
      進行中: 65,
      等待回覆: 50,
    };
    const priorityWeight = { urgent: 120, important: 40, normal: 0 };
    const aDue = todoDueRank(aState, todayStr);
    const bDue = todoDueRank(bState, todayStr);
    const aScore = (priorityWeight[a.priority || 'normal'] || 0)
      + (statusWeight[aState.status || '待處理'] || 0)
      + (aDue === 0 ? 35 : aDue === 1 ? 25 : 0);
    const bScore = (priorityWeight[b.priority || 'normal'] || 0)
      + (statusWeight[bState.status || '待處理'] || 0)
      + (bDue === 0 ? 35 : bDue === 1 ? 25 : 0);
    if (aScore !== bScore) return bScore - aScore;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
}

function summarizeExpensesForBriefing(expenses) {
  if (!expenses || expenses.length === 0) {
    return '今天還沒有記帳。若有現金支出、進貨、匯款，可以直接傳給我。';
  }
  const sum = (items, type, account) => items
    .filter((e) => e.type === type && (!account || e.account === account))
    .reduce((total, e) => total + Number(e.amount || 0), 0);
  const income = sum(expenses, 'income');
  const expense = sum(expenses, 'expense');
  const businessExpense = sum(expenses, 'expense', 'business');
  const personalExpense = sum(expenses, 'expense', 'personal');
  return `收入 NT$${income}，支出 NT$${expense}，公司 NT$${businessExpense}，私人 NT$${personalExpense}。`;
}

function parseTodoPlanningScope(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (!/(要做|待辦|事情|工作|安排|先做|處理|行程|任務|有什麼|有沒有|要忙|忙什麼|該做|做什麼)/.test(raw)) return '';
  if (/明天/.test(raw)) return 'tomorrow';
  if (/後天/.test(raw)) return 'after_tomorrow';
  if (/本週|這週|這禮拜|這星期|一週|下週|下周|下禮拜|下星期/.test(raw)) return 'week';
  if (/今天|今日|現在/.test(raw)) return 'today';
  return '';
}

function planningScopeLabel(scope) {
  return {
    today: '今天',
    tomorrow: '明天',
    after_tomorrow: '後天',
    week: '這週',
  }[scope] || '近期';
}

function planningScopeRange(scope) {
  const today = getTaipeiDate();
  const todayStr = formatDateYmd(today);
  if (scope === 'tomorrow') {
    const target = formatDateYmd(addDays(today, 1));
    return { start: target, end: target, todayStr };
  }
  if (scope === 'after_tomorrow') {
    const target = formatDateYmd(addDays(today, 2));
    return { start: target, end: target, todayStr };
  }
  if (scope === 'week') {
    return { start: todayStr, end: formatDateYmd(addDays(today, 7)), todayStr };
  }
  return { start: todayStr, end: todayStr, todayStr };
}

function filterTodosByPlanningScope(todos, stateMap, scope) {
  const { start, end } = planningScopeRange(scope);
  if (scope === 'today') {
    return (todos || []).filter((todo) => {
      const due = stateMap.get(todo.id)?.due_date || '';
      return (due && due <= start) || todo.priority === 'urgent';
    });
  }
  return (todos || []).filter((todo) => {
    const due = stateMap.get(todo.id)?.due_date || '';
    return due && due >= start && due <= end;
  });
}

async function buildTodoPlanningMessages(scope, focusKey = '') {
  if (scope === 'today') return buildSecretaryBriefingMessages(focusKey);

  const todos = await getPendingTodos(50);
  const stateMap = await getTodoStateMap(todos);
  const { todayStr, start, end } = planningScopeRange(scope);
  const sorted = sortTodosForBriefing(todos, stateMap, todayStr);
  const matched = filterTodosByPlanningScope(sorted, stateMap, scope);
  const fallback = matched.length > 0 ? matched : sorted.slice(0, 5);
  const label = planningScopeLabel(scope);
  const rangeLabel = start === end ? start : `${start}～${end}`;

  const lines = fallback.slice(0, 8).map((todo, i) => {
    const state = stateMap.get(todo.id) || {};
    return formatSecretaryPlanLine(todo, state, todayStr, i + 1);
  });
  const lead = matched.length > 0
    ? `${label}要看的待辦：`
    : `${label}沒有明確到期的待辦，我先列近期最該處理的：`;
  const text = [
    `${lead}`,
    lines.length > 0 ? lines.join('\n') : '目前沒有未完成待辦。',
    '',
    `範圍：${rangeLabel}`,
    buildTodoRecommendation(todos, stateMap, todayStr),
  ].join('\n');

  const messages = [{ type: 'text', text }];
  if (fallback.length > 0) {
    await saveTodoFocus(focusKey, fallback, `${scope}_planning`);
    messages.push(buildTodoActionFlex(fallback, stateMap));
  }
  return messages;
}

function buildBriefingQuickActionFlex() {
  return {
    type: 'flex',
    altText: '秘書快捷卡片',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: CARD_THEME.page,
        spacing: 'md',
        contents: [
          { type: 'text', text: '快捷處理', weight: 'bold', size: 'lg', color: CARD_THEME.primaryDark },
          { type: 'text', text: '帳務或最近一筆記錯，可以直接點。', size: 'sm', color: CARD_THEME.muted, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              { type: 'button', style: 'primary', color: CARD_THEME.primary, height: 'sm', action: { type: 'message', label: '今天帳務', text: '今天帳務' } },
              { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '本月帳務', text: '本月帳務' } },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '算公司', text: '最近一筆算公司' } },
              { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '分類', text: '最近一筆分類' } },
            ],
          },
        ],
      },
    },
  };
}

async function buildSecretaryBriefingMessages(focusKey = '') {
  const todos = await getPendingTodos(50);
  const stateMap = await getTodoStateMap(todos);
  const todayStr = formatDateYmd(getTaipeiDate());
  const sorted = sortTodosForBriefing(todos, stateMap, todayStr);
  const top = sorted.slice(0, 3);
  const overdue = sorted.filter((todo) => (stateMap.get(todo.id)?.due_date || '') < todayStr && !!stateMap.get(todo.id)?.due_date).slice(0, 5);
  const dueToday = sorted.filter((todo) => stateMap.get(todo.id)?.due_date === todayStr).slice(0, 5);
  const waiting = sorted.filter((todo) => (stateMap.get(todo.id)?.status || '待處理') === '等待回覆').slice(0, 5);
  const halfDone = sorted.filter((todo) => (stateMap.get(todo.id)?.status || '待處理') === '半完成').slice(0, 5);
  const stale = sorted.filter((todo) => {
    const status = stateMap.get(todo.id)?.status || '待處理';
    return ['待處理', '未完成'].includes(status) && todoAgeDays(todo) >= 2;
  }).slice(0, 5);
  const statusCheck = summarizeStatusCheckTodos(sorted, stateMap);
  const expenses = await getExpenses('today');

  const line = (todo, i) => {
    const state = stateMap.get(todo.id) || {};
    return formatSecretaryPlanLine(todo, state, todayStr, i + 1);
  };
  const bullet = (todo) => {
    const state = stateMap.get(todo.id) || {};
    return `- ${formatSecretaryPlanLine(todo, state, todayStr)}`;
  };
  const sections = [
    summarizeTodoWorkLanes(todos),
    buildTodoRecommendation(todos, stateMap, todayStr),
    '',
    '今天我會先看這幾件：',
    top.length > 0 ? top.map(line).join('\n') : '目前沒有急件。',
  ];
  if (overdue.length > 0) sections.push(`\n逾期要追：\n${overdue.map(bullet).join('\n')}`);
  if (dueToday.length > 0) sections.push(`\n今天到期：\n${dueToday.map(bullet).join('\n')}`);
  if (waiting.length > 0) sections.push(`\n等待回覆：\n${waiting.map(bullet).join('\n')}`);
  if (halfDone.length > 0) sections.push(`\n半完成：\n${halfDone.map(bullet).join('\n')}`);
  if (stale.length > 0) sections.push(`\n卡比較久：\n${stale.map(bullet).join('\n')}`);
  if (statusCheck) sections.push(`\n${statusCheck}`);
  sections.push(`\n今日帳務：\n${summarizeExpensesForBriefing(expenses)}`);
  sections.push('\n你可以直接點下面卡片處理。');

  const messages = [{ type: 'text', text: sections.join('\n') }];
  if (sorted.length > 0) {
    await saveTodoFocus(focusKey, sorted, 'secretary_briefing');
    messages.push(buildTodoActionFlex(sorted, stateMap));
  }
  messages.push(buildBriefingQuickActionFlex());
  return messages;
}

function getReportStartDate(period) {
  const now = getTaipeiDate();
  if (period === 'this_week') {
    const day = now.getDay() || 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function summarizeStatusCounts(todos, stateMap) {
  const counts = new Map();
  (todos || []).forEach((todo) => {
    const status = stateMap.get(todo.id)?.status || '待處理';
    counts.set(status, (counts.get(status) || 0) + 1);
  });
  const order = ['待處理', '進行中', '半完成', '等待回覆', '未完成'];
  return order
    .filter((status) => counts.get(status))
    .map((status) => `${status}${counts.get(status)}件`)
    .join('、') || '無未完成待辦';
}

function summarizeDoneWorkLanes(doneTodos) {
  if (!doneTodos || doneTodos.length === 0) return '完成分布：目前沒有完成紀錄。';
  const counts = new Map();
  (doneTodos || []).forEach((todo) => {
    const lane = inferTodoWorkLane(todo);
    counts.set(lane, (counts.get(lane) || 0) + 1);
  });
  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([lane, count]) => `${lane}${count}件`)
    .join('、');
  return `完成分布：${lines}`;
}

async function buildWorkReportMessages(period = 'today', focusKey = '') {
  const label = period === 'this_week' ? '本週' : '今天';
  const startDate = getReportStartDate(period);
  const pending = await getPendingTodos(100);
  const stateMap = await getTodoStateMap(pending);
  const todayStr = formatDateYmd(getTaipeiDate());
  const sorted = sortTodosForBriefing(pending, stateMap, todayStr);
  const { data: doneTodos } = await supabase
    .from('xlan_todos')
    .select('text, source_message, source_person, project_name, priority, done_at')
    .eq('done', true)
    .gte('done_at', startDate.toISOString())
    .order('done_at', { ascending: false })
    .limit(50);
  const expenses = await getExpenses(period);
  const doneLines = (doneTodos || []).slice(0, 5).map((todo, i) => `${i + 1}. ${cleanTodoDisplayText(todo.text)}`).join('\n') || '（沒有完成紀錄）';
  const pendingLines = sorted.slice(0, 5).map((todo, i) => `${i + 1}. ${formatTodoLine(todo, stateMap.get(todo.id))}`).join('\n') || '（沒有未完成待辦）';
  const statusCheck = summarizeStatusCheckTodos(sorted, stateMap);

  const sections = [
    `📊 ${label}工作報告`,
    '',
    `完成：${(doneTodos || []).length}件`,
    `未完成：${pending.length}件`,
    `狀態：${summarizeStatusCounts(pending, stateMap)}`,
    '',
    summarizeTodoWorkLanes(pending),
    summarizeDoneWorkLanes(doneTodos || []),
    buildTodoRecommendation(pending, stateMap, todayStr),
    statusCheck || '需要確認狀態：目前沒有卡住太久的狀態。',
    '',
    `最近完成：\n${doneLines}`,
    '',
    `還要追蹤：\n${pendingLines}`,
    '',
    `${label}帳務：\n${summarizeExpensesForBriefing(expenses)}`,
    '',
    '可以直接點下面卡片處理未完成項目。',
  ];

  const messages = [{ type: 'text', text: sections.join('\n') }];
  if (sorted.length > 0) {
    await saveTodoFocus(focusKey, sorted, `work_report:${period}`);
    messages.push(buildTodoActionFlex(sorted, stateMap));
  }
  messages.push(buildBriefingQuickActionFlex());
  return messages;
}

async function listTodoReplyMessages(focusKey = '') {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true });

  if (!data || data.length === 0) {
    return [{ type: 'text', text: '目前沒有待辦事項，一切都處理好了！' }];
  }

  const text = await listTodos();
  const stateMap = await getTodoStateMap(data);
  await saveTodoFocus(focusKey, data, 'todo_list');
  return [
    { type: 'text', text },
    buildTodoActionFlex(data, stateMap),
  ];
}

// --- 標記待辦完成 ---
async function completeTodo(n) {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true });

  if (!data || n < 1 || n > data.length) {
    return `找不到第 ${n} 項待辦，目前共 ${(data || []).length} 項未完成。`;
  }

  const todo = data[n - 1];
  await supabase
    .from('xlan_todos')
    .update({ done: true, done_at: new Date().toISOString() })
    .eq('id', todo.id);
  await clearTodoState(todo.id);

  return `✅ 已完成：「${cleanTodoDisplayText(todo.text)}」`;
}

function stripTodoStatusPrefix(text) {
  return String(text || '').replace(/^\[(進行中|半完成|未完成|等待回覆|待處理)\]\s*/, '');
}

function withTodoStatusPrefix(text, status) {
  return `[${status}] ${stripTodoStatusPrefix(text)}`;
}

async function markTodoStatus(n, status) {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true });

  if (!data || n < 1 || n > data.length) {
    return `找不到第 ${n} 項待辦，目前共 ${(data || []).length} 項未完成。`;
  }

  const todo = data[n - 1];
  await saveTodoState(todo.id, { status });
  const icon = todoStatusIcon(status);
  return `${icon} 已標記${status}：「${cleanTodoDisplayText(todo.text)}」`;
}

async function deleteTodo(n) {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true });

  if (!data || n < 1 || n > data.length) {
    return `找不到第 ${n} 項待辦，目前共 ${(data || []).length} 項未完成。`;
  }

  const todo = data[n - 1];
  await supabase.from('xlan_todos').delete().eq('id', todo.id);
  await clearTodoState(todo.id);
  return `🗑️ 已刪除：「${cleanTodoDisplayText(todo.text)}」`;
}

async function postponeTodo(n, dueText) {
  const { data } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true });

  if (!data || n < 1 || n > data.length) {
    return `找不到第 ${n} 項待辦，目前共 ${(data || []).length} 項未完成。`;
  }

  const dueDate = parseTodoDueDate(dueText);
  if (!dueDate) return '要延後到什麼時候？例如：明天、下週一、6/5。';

  const todo = data[n - 1];
  await saveTodoState(todo.id, { status: '待處理', due_date: dueDate });
  return `⏳ 已延後到 ${dueDate}：「${cleanTodoDisplayText(todo.text)}」`;
}

// --- 檢查訊息是否有 @ 小瀾 ---
function isMentioned(event) {
  const mention = event.message.mention;
  if (!mention || !mention.mentionees) return false;
  return mention.mentionees.some((m) => m.type === 'all' || m.isSelf === true);
}

function stripGroupCommand(text, command) {
  return String(text || '').replace(new RegExp(`^[#＃]\\s*${command}\\s*`, 'i'), '').trim();
}

function stripGroupHashTrigger(text) {
  return String(text || '').replace(/^[#＃]\s*/, '').trim();
}

// --- 儲存 owner LINE ID ---
async function saveOwnerLineId(userId) {
  await supabase.from('xlan_kv').upsert({ key: 'owner_line_id', value: userId });
}

// --- 群組訊息處理 ---
async function handleGroupMessage(event) {
  const msgType = event.message.type;
  const focusKey = getTodoFocusSourceKey(event);

  if (await handleStaffReportEvent(event)) return;

  if (msgType === 'text') {
    const text = event.message.text;
    if (!text) return;

    if (/^待辦:[0-9a-f-]{32,36}:/i.test(text.trim())) {
      const result = await handleTodoActionCommand(text.trim());
      await replyMessage(event.replyToken, result || '這個待辦操作格式不正確。');
      return;
    }

    const hasHashTrigger = /^[#＃]/.test(text.trim());
    const isTodoCommand = /^[#＃]\s*待辦/.test(text);

    if (hasHashTrigger) {
      const quotedText = event.message.quotedMessage && event.message.quotedMessage.text;
      const contentToAnalyze = quotedText || (isTodoCommand ? stripGroupCommand(text, '待辦') : stripGroupHashTrigger(text));
      const cleanedText = contentToAnalyze.replace(/@\S+/g, '').trim();
      if (!cleanedText) {
        if (isTodoCommand) await replyMessage(event.replyToken, await listTodoReplyMessages(focusKey));
        return;
      }
      const intent = classifyTextIntent(cleanedText, { mode: 'group', cleaned: true });
      console.log('intent_router', { mode: 'group', ...intent, text: cleanedText.slice(0, 40) });

      const planningScope = parseTodoPlanningScope(cleanedText);
      if (planningScope) {
        await replyMessage(event.replyToken, await buildTodoPlanningMessages(planningScope, focusKey));
        return;
      }

      if (isBriefingCommand(cleanedText)) {
        await replyMessage(event.replyToken, await buildSecretaryBriefingMessages(focusKey));
        return;
      }

      if (/^(工作報告|今天報告|今日報告|本週報告|這週報告|週報)$/.test(cleanedText)) {
        const period = /本週|這週|週報/.test(cleanedText) ? 'this_week' : 'today';
        await replyMessage(event.replyToken, await buildWorkReportMessages(period, focusKey));
        return;
      }

      const simpleExpenseReply = await handleSimpleExpenseText(cleanedText, focusKey);
      if (simpleExpenseReply) {
        await replyMessage(event.replyToken, simpleExpenseReply);
        return;
      }

      const businessMemoryAnswer = await answerBusinessMemoryFromText(cleanedText);
      if (businessMemoryAnswer) {
        await replyMessage(event.replyToken, businessMemoryAnswer);
        return;
      }

      const focusedExpenseReply = await resolveFocusedExpenseReply(cleanedText, focusKey);
      if (focusedExpenseReply) {
        await replyMessage(event.replyToken, focusedExpenseReply);
        return;
      }

      const focusedShortReply = await resolveFocusedShortTodoReply(cleanedText, focusKey);
      if (focusedShortReply) {
        const messages = todoToolResultToMessages(focusedShortReply);
        if (messages) await replyMessage(event.replyToken, messages);
        return;
      }

      const naturalTodoAction = parseNaturalTodoAction(cleanedText);
      if (naturalTodoAction) {
        const result = await resolveNaturalTodoAction(naturalTodoAction, focusKey);
        const messages = todoToolResultToMessages(result);
        if (messages) await replyMessage(event.replyToken, messages);
        return;
      }

      const correctionMemory = await rememberCorrectionFromText(cleanedText);
      if (correctionMemory) {
        await replyMessage(event.replyToken, correctionMemory);
        return;
      }

      const userId = event.source.userId || 'group_user';
      const { reply, flexMessages } = await chatWithClaude(userId, cleanedText, {
        mode: 'group',
        trigger: '#',
        focusKey,
        intent,
      });
      const messages = [];
      if (flexMessages.length > 0) messages.push(...flexMessages);
      if (reply) messages.push({ type: 'text', text: reply });
      await replyMessage(event.replyToken, messages);
    }
  }
}

async function handleDirectFastCommand(text, focusKey = '') {
  if (/^記帳:([0-9a-f-]+):分類:(.+)$/.test(text)) {
    const match = text.match(/^記帳:([0-9a-f-]+):分類:(.+)$/);
    return [{ type: 'text', text: await updateExpenseCategory(match[1], match[2].trim()) }];
  }
  if (/^記帳:([0-9a-f-]+):(公司|私人|刪除|分類)$/.test(text)) {
    const match = text.match(/^記帳:([0-9a-f-]+):(公司|私人|刪除|分類)$/);
    const expenseId = match[1];
    const action = match[2];
    if (action === '分類') return [buildExpenseCategoryFlex(expenseId)];
    if (action === '刪除') return [{ type: 'text', text: await deleteExpense(expenseId, focusKey) }];
    return [{ type: 'text', text: await updateExpenseAccount(expenseId, action === '公司' ? 'business' : 'personal') }];
  }
  if (/^(刪掉重複|刪除重複|清掉重複|清除重複|重複的也刪|重複也刪|重複一起刪|一起刪掉重複)$/.test(text)) {
    return [{ type: 'text', text: await deleteDuplicateExpenses(focusKey) }];
  }
  if (/^(清空|清除|清掉|刪光|刪掉全部)(今天|今日|本週|這週|本月|這個月)?(的)?(記帳|帳務|帳目)$/.test(text)) {
    const period = /本週|這週/.test(text) ? 'this_week' : /本月|這個月/.test(text) ? 'this_month' : 'today';
    return [{ type: 'text', text: await requestClearExpenses(focusKey, period) }];
  }
  if (/^(確定清空|確認清空|確定清掉|確定清除|清空確認|對清空|對，清空)$/.test(text)) {
    return [{ type: 'text', text: await confirmClearExpenses(focusKey) }];
  }
  if (/^最近一筆算(公司|私人)$/.test(text)) {
    const match = text.match(/^最近一筆算(公司|私人)$/);
    return [{ type: 'text', text: await updateLatestExpenseAccount(match[1] === '公司' ? 'business' : 'personal') }];
  }
  if (/^刪除最近一筆記帳$/.test(text)) {
    return [{ type: 'text', text: await deleteLatestExpense(focusKey) }];
  }
  if (/^最近一筆分類$/.test(text)) {
    const latest = await getLatestExpense();
    return latest ? [buildExpenseCategoryFlex(latest.id)] : [{ type: 'text', text: '找不到最近一筆記帳。' }];
  }
  if (/^最近一筆分類(.+)$/.test(text)) {
    const match = text.match(/^最近一筆分類(.+)$/);
    return [{ type: 'text', text: await updateLatestExpenseCategory(match[1].trim()) }];
  }
  const simpleExpenseReply = await handleSimpleExpenseText(text, focusKey);
  if (simpleExpenseReply) {
    return simpleExpenseReply;
  }
  if (/^(本月記帳摘要|本月帳務|本月記帳|本月帳目|本月收支|本月開銷|本月花費|本月支出|這個月帳務|這個月記帳|這個月花多少)$/.test(text)) {
    return buildExpenseSummaryReplyMessages('this_month', focusKey);
  }
  if (/^(今天記帳摘要|今天帳務|今天記帳|今天帳目|今天收支|今天開銷|今天花費|今天花多少|今天花了多少|今日帳務|今日記帳)$/.test(text)) {
    return buildExpenseSummaryReplyMessages('today', focusKey);
  }
  if (/^(本週記帳摘要|本週帳務|本週記帳|本週帳目|本週收支|本週開銷|本週花費|這週帳務|這週記帳|這週花多少)$/.test(text)) {
    return buildExpenseSummaryReplyMessages('this_week', focusKey);
  }
  const planningScope = parseTodoPlanningScope(text);
  if (planningScope) {
    return buildTodoPlanningMessages(planningScope, focusKey);
  }
  if (isBriefingCommand(text)) {
    return buildSecretaryBriefingMessages(focusKey);
  }
  if (/^(工作報告|今天報告|今日報告|本週報告|這週報告|週報)$/.test(text)) {
    const period = /本週|這週|週報/.test(text) ? 'this_week' : 'today';
    return buildWorkReportMessages(period, focusKey);
  }
  if (/^(待辦|清單|檢查待辦|任務清單)$/.test(text)) {
    return listTodoReplyMessages(focusKey);
  }
  if (/^待辦:[0-9a-f-]{32,36}:/i.test(text)) {
    const result = await handleTodoActionCommand(text);
    return [{ type: 'text', text: result || '這個待辦操作格式不正確。' }];
  }
  const focusedExpenseReply = await resolveFocusedExpenseReply(text, focusKey);
  if (focusedExpenseReply) {
    return focusedExpenseReply;
  }
  const focusedShortReply = await resolveFocusedShortTodoReply(text, focusKey);
  if (focusedShortReply) {
    return todoToolResultToMessages(focusedShortReply);
  }
  const naturalTodoAction = parseNaturalTodoAction(text);
  if (naturalTodoAction) {
    const result = await resolveNaturalTodoAction(naturalTodoAction, focusKey);
    return todoToolResultToMessages(result);
  }
  if (/^完成第(\d+)項$/.test(text)) {
    const match = text.match(/^完成第(\d+)項$/);
    return [{ type: 'text', text: await completeTodo(parseInt(match[1], 10)) }];
  }
  if (/^(進行中|半完成)第(\d+)項$/.test(text)) {
    const match = text.match(/^(進行中|半完成)第(\d+)項$/);
    return [{ type: 'text', text: await markTodoStatus(parseInt(match[2], 10), match[1] === '半完成' ? '半完成' : '進行中') }];
  }
  if (/^(等待|等回覆|等待回覆)第(\d+)項$/.test(text)) {
    const match = text.match(/^(等待|等回覆|等待回覆)第(\d+)項$/);
    return [{ type: 'text', text: await markTodoStatus(parseInt(match[2], 10), '等待回覆') }];
  }
  if (/^未完成第(\d+)項$/.test(text)) {
    const match = text.match(/^未完成第(\d+)項$/);
    return [{ type: 'text', text: await markTodoStatus(parseInt(match[1], 10), '未完成') }];
  }
  if (/^刪除第(\d+)項$/.test(text)) {
    const match = text.match(/^刪除第(\d+)項$/);
    return [{ type: 'text', text: await deleteTodo(parseInt(match[1], 10)) }];
  }
  if (/^延後第(\d+)項到(.+)$/.test(text)) {
    const match = text.match(/^延後第(\d+)項到(.+)$/);
    return [{ type: 'text', text: await postponeTodo(parseInt(match[1], 10), match[2]) }];
  }
  if (/^第(\d+)項延後到(.+)$/.test(text)) {
    const match = text.match(/^第(\d+)項延後到(.+)$/);
    return [{ type: 'text', text: await postponeTodo(parseInt(match[1], 10), match[2]) }];
  }
  return null;
}

async function resolveDirectMemoryPreflight(text, intent = {}) {
  const startedAt = Date.now();
  let reply = null;

  if (intent.intent === 'memory_update') {
    reply = await updateUrlMemoryFromText(text);
  } else if (intent.intent === 'memory_delete') {
    reply = await deleteNoteFromText(text);
  } else if (intent.intent === 'correction') {
    reply = await rememberCorrectionFromText(text);
  } else if (intent.intent === 'memory_save') {
    reply = await rememberUrlFromText(text);
  } else if (intent.intent === 'url_list') {
    reply = await listAllUrlNotes();
  } else if (intent.intent === 'deploy_list') {
    reply = await listAllDeployments();
  } else if (intent.intent === 'deploy_query') {
    reply = await answerDeploymentFromMemory(text);
  } else if (intent.intent === 'memory_query') {
    reply = await answerUrlFromMemory(text) || await answerBusinessMemoryFromText(text);
  }

  if (reply) {
    console.log('direct_pre_claude_timing', {
      intent: intent.intent,
      elapsed_ms: Date.now() - startedAt,
      matched: true,
    });
    return [{ type: 'text', text: reply }];
  }

  if (['memory_update', 'memory_delete', 'correction', 'memory_save', 'url_list', 'deploy_list', 'deploy_query', 'memory_query'].includes(intent.intent)) {
    console.log('direct_pre_claude_timing', {
      intent: intent.intent,
      elapsed_ms: Date.now() - startedAt,
      matched: false,
    });
  }
  return null;
}

// --- 私訊處理 ---
async function handleDirectMessage(event) {
  const msgType = event.message.type;
  const userId = event.source.userId;
  const focusKey = getTodoFocusSourceKey(event);

  startLoadingAnimation(userId, msgType === 'image' ? 30 : 20)
    .catch((err) => console.error('startLoadingAnimation error:', err));

  // 儲存 owner LINE ID（首次私訊時 upsert）
  saveOwnerLineId(userId).catch((err) => console.error('saveOwnerLineId error:', err));

  if (await handleStaffReportEvent(event)) return;

  if (msgType === 'image') {
    try {
      const base64Data = await downloadLineImage(event.message.id);
      const imageContent = [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
        },
        {
          type: 'text',
          text: '請先判讀這張圖片，直接回答用戶可能想知道的重點。如果圖片是 LINE 對話或系統畫面，請說明畫面問題與下一步；不要要求用戶重新輸入問題。只有在圖片明確是付款、匯款、收據或費用截圖時，才提取金額、收款方/用途、日期並呼叫 save_expense 記帳。',
        },
      ];

      const { reply, flexMessages } = await chatWithClaude(userId, imageContent, {
        mode: 'direct',
        trigger: '私訊圖片',
        focusKey,
      });
      const labeledFlex = flexMessages.map((f) => {
        if (f.contents && f.contents.body && f.contents.body.contents) {
          const hasLabel = f.contents.body.contents[0] && f.contents.body.contents[0].contents &&
            f.contents.body.contents[0].contents[0] && f.contents.body.contents[0].contents[0].text === '📷 圖片判讀';
          if (!hasLabel) {
            f.contents.body.contents.unshift({
              type: 'box',
              layout: 'horizontal',
              contents: [{
                type: 'text',
                text: '📷 圖片判讀',
                size: 'xxs',
                color: '#FFFFFF',
                weight: 'bold',
              }],
              justifyContent: 'flex-end',
            });
          }
        }
        return f;
      });

      const messages = [];
      if (labeledFlex.length > 0) messages.push(...labeledFlex);
      if (reply) messages.push({ type: 'text', text: reply });
      await replyMessage(event.replyToken, messages);
    } catch (err) {
      console.error('Image processing error:', err);
      await replyMessage(event.replyToken, '圖片處理失敗，請稍後再試。');
    }
    return;
  }

  if (msgType !== 'text') return;

  const text = (event.message.text || '').trim();
  if (!text) return;

  const intent = classifyTextIntent(text, { mode: 'direct' });
  console.log('intent_router', { mode: 'direct', ...intent, text: text.slice(0, 40) });

  const fastReplyMessages = await handleDirectFastCommand(text, focusKey);
  if (fastReplyMessages) {
    console.log('direct_fast_path', { intent: intent.intent, reason: intent.reason, text: text.slice(0, 24) });
    await replyMessage(event.replyToken, fastReplyMessages);
    return;
  }

  const memoryPreflightMessages = await resolveDirectMemoryPreflight(text, intent);
  if (memoryPreflightMessages) {
    await replyMessage(event.replyToken, memoryPreflightMessages);
    return;
  }

  let replyMessages;
  if (/^記帳:([0-9a-f-]+):分類:(.+)$/.test(text)) {
    const match = text.match(/^記帳:([0-9a-f-]+):分類:(.+)$/);
    replyMessages = [{ type: 'text', text: await updateExpenseCategory(match[1], match[2].trim()) }];
  } else if (/^記帳:([0-9a-f-]+):(公司|私人|刪除|分類)$/.test(text)) {
    const match = text.match(/^記帳:([0-9a-f-]+):(公司|私人|刪除|分類)$/);
    const expenseId = match[1];
    const action = match[2];
    if (action === '分類') {
      replyMessages = [buildExpenseCategoryFlex(expenseId)];
    } else if (action === '刪除') {
      replyMessages = [{ type: 'text', text: await deleteExpense(expenseId, focusKey) }];
    } else {
      replyMessages = [{ type: 'text', text: await updateExpenseAccount(expenseId, action === '公司' ? 'business' : 'personal') }];
    }
  } else if (/^(刪掉重複|刪除重複|清掉重複|清除重複|重複的也刪|重複也刪|重複一起刪|一起刪掉重複)$/.test(text)) {
    replyMessages = [{ type: 'text', text: await deleteDuplicateExpenses(focusKey) }];
  } else if (/^最近一筆算(公司|私人)$/.test(text)) {
    const match = text.match(/^最近一筆算(公司|私人)$/);
    replyMessages = [{ type: 'text', text: await updateLatestExpenseAccount(match[1] === '公司' ? 'business' : 'personal') }];
  } else if (/^刪除最近一筆記帳$/.test(text)) {
    replyMessages = [{ type: 'text', text: await deleteLatestExpense(focusKey) }];
  } else if (/^最近一筆分類$/.test(text)) {
    const latest = await getLatestExpense();
    replyMessages = latest ? [buildExpenseCategoryFlex(latest.id)] : [{ type: 'text', text: '找不到最近一筆記帳。' }];
  } else if (/^最近一筆分類(.+)$/.test(text)) {
    const match = text.match(/^最近一筆分類(.+)$/);
    replyMessages = [{ type: 'text', text: await updateLatestExpenseCategory(match[1].trim()) }];
  } else if (/^(本月記帳摘要|本月帳務|本月記帳|本月帳目|本月收支|本月開銷|本月花費|本月支出|這個月帳務|這個月記帳|這個月花多少)$/.test(text)) {
    replyMessages = await buildExpenseSummaryReplyMessages('this_month', focusKey);
  } else if (/^(今天記帳摘要|今天帳務|今天記帳|今天帳目|今天收支|今天開銷|今天花費|今天花多少|今天花了多少|今日帳務|今日記帳)$/.test(text)) {
    replyMessages = await buildExpenseSummaryReplyMessages('today', focusKey);
  } else if (/^(本週記帳摘要|本週帳務|本週記帳|本週帳目|本週收支|本週開銷|本週花費|這週帳務|這週記帳|這週花多少)$/.test(text)) {
    replyMessages = await buildExpenseSummaryReplyMessages('this_week', focusKey);
  } else if (isBriefingCommand(text)) {
    replyMessages = await buildSecretaryBriefingMessages(focusKey);
  } else if (/^(工作報告|今天報告|今日報告|本週報告|這週報告|週報)$/.test(text)) {
    const period = /本週|這週|週報/.test(text) ? 'this_week' : 'today';
    replyMessages = await buildWorkReportMessages(period, focusKey);
  } else if (/^(待辦|清單|檢查待辦|任務清單)$/.test(text)) {
    replyMessages = await listTodoReplyMessages(focusKey);
  } else if (/^待辦:[0-9a-f-]{32,36}:/i.test(text)) {
    const result = await handleTodoActionCommand(text);
    replyMessages = [{ type: 'text', text: result || '這個待辦操作格式不正確。' }];
  } else if (/^完成第(\d+)項$/.test(text)) {
    const match = text.match(/^完成第(\d+)項$/);
    const n = parseInt(match[1], 10);
    replyMessages = [{ type: 'text', text: await completeTodo(n) }];
  } else if (/^(進行中|半完成)第(\d+)項$/.test(text)) {
    const match = text.match(/^(進行中|半完成)第(\d+)項$/);
    const n = parseInt(match[2], 10);
    replyMessages = [{ type: 'text', text: await markTodoStatus(n, match[1] === '半完成' ? '半完成' : '進行中') }];
  } else if (/^(等待|等回覆|等待回覆)第(\d+)項$/.test(text)) {
    const match = text.match(/^(等待|等回覆|等待回覆)第(\d+)項$/);
    const n = parseInt(match[2], 10);
    replyMessages = [{ type: 'text', text: await markTodoStatus(n, '等待回覆') }];
  } else if (/^未完成第(\d+)項$/.test(text)) {
    const match = text.match(/^未完成第(\d+)項$/);
    const n = parseInt(match[1], 10);
    replyMessages = [{ type: 'text', text: await markTodoStatus(n, '未完成') }];
  } else if (/^刪除第(\d+)項$/.test(text)) {
    const match = text.match(/^刪除第(\d+)項$/);
    const n = parseInt(match[1], 10);
    replyMessages = [{ type: 'text', text: await deleteTodo(n) }];
  } else if (/^延後第(\d+)項到(.+)$/.test(text)) {
    const match = text.match(/^延後第(\d+)項到(.+)$/);
    const n = parseInt(match[1], 10);
    replyMessages = [{ type: 'text', text: await postponeTodo(n, match[2]) }];
  } else if (/^第(\d+)項延後到(.+)$/.test(text)) {
    const match = text.match(/^第(\d+)項延後到(.+)$/);
    const n = parseInt(match[1], 10);
    replyMessages = [{ type: 'text', text: await postponeTodo(n, match[2]) }];
  } else {
    const { reply, flexMessages } = await chatWithClaude(userId, text, {
      mode: 'direct',
      trigger: '私訊文字',
      focusKey,
      intent,
    });
    replyMessages = [];
    if (flexMessages.length > 0) replyMessages.push(...flexMessages);
    if (reply) replyMessages.push({ type: 'text', text: reply });
  }

  await replyMessage(event.replyToken, replyMessages);
}

// --- Vercel Serverless Handler ---
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.url && req.url.includes('diag')) {
      // 唯讀診斷：只回報變數有沒有設（true/false），不洩漏值
      return res.status(200).json({
        ok: true,
        where: 'webhook',
        env: {
          spreadsheet: !!process.env.STAFF_REPORT_SPREADSHEET_ID,
          vision: !!process.env.GOOGLE_VISION_API_KEY,
          folder: !!process.env.STAFF_REPORT_IMAGE_FOLDER_ID,
          sheetName: !!process.env.STAFF_REPORT_SHEET_NAME,
          liff: !!process.env.STAFF_LIFF_ID,
          refresh: !!process.env.GOOGLE_REFRESH_TOKEN,
          anthropic: !!process.env.ANTHROPIC_API_KEY,
        },
      });
    }
    return res.status(200).send('xlan-secretary is running.');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  const signature = req.headers['x-line-signature'];
  if (!signature || !validateSignature(rawBody, signature)) {
    console.error('Invalid signature');
    return res.status(401).send('Invalid signature');
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  const events = body.events || [];

  for (const event of events) {
    if (event.type !== 'message') {
      console.log('non_message_event', {
        type: event.type,
        sourceType: event.source?.type,
        groupId: event.source?.groupId,
        roomId: event.source?.roomId,
        userId: event.source?.userId,
      });
      if (event.type === 'join' && event.replyToken) {
        try {
          await replyMessage(event.replyToken, '小瀾已進群。員工回報請輸入 #回報，再附上運單照片和問題數量。');
        } catch (err) {
          console.error('Join reply failed:', err);
        }
      }
      continue;
    }
    const msgType = event.message.type;
    if (msgType !== 'text' && msgType !== 'image') continue;

    const eventStartedAt = Date.now();
    try {
      if (event.source.type === 'group' || event.source.type === 'room') {
        await handleGroupMessage(event);
      } else if (event.source.type === 'user') {
        await handleDirectMessage(event);
      }
    } catch (err) {
      console.error('Event handling error:', err);
      try {
        await replyMessage(event.replyToken, `系統錯誤：${err.message || err}`);
      } catch (replyErr) {
        console.error('Error reply failed:', replyErr);
      }
    } finally {
      logEventTiming('webhook_event', eventStartedAt, {
        sourceType: event.source?.type,
        messageType: msgType,
      });
    }
  }

  return res.status(200).json({ ok: true });
};
