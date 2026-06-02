const { createClient } = require('@supabase/supabase-js');

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function sanitizeLineText(text) {
  return String(text || '').replace(/\*\*/g, '').trim() || '已處理。';
}

async function pushMessage(userId, messages) {
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

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: userId,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('LINE push error:', err);
  }
}

function getTaipeiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

function getTodayStr(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todoStateKey(todoId) {
  return `todo_state:${todoId}`;
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

function stripTodoStatusPrefix(text) {
  return String(text || '').replace(/^\[(進行中|半完成|未完成|等待回覆|待處理)\]\s*/, '');
}

function stripTodoSchedulePrefix(text) {
  return String(text || '').replace(/^\[延後到 [^\]]+\]\s*/, '');
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

function formatTodoLine(todo, state) {
  const due = state?.due_date ? `（延後到${state.due_date}）` : '';
  const pri = todo.priority === 'urgent' ? '🔴 ' : todo.priority === 'important' ? '🟡 ' : '';
  return `${todoStatusIcon(state?.status)} ${pri}${cleanTodoDisplayText(todo.text)}${due}`;
}

function buildReminderTodoFlex(todos, stateMap = new Map()) {
  const bubbles = (todos || []).slice(0, 10).map((todo, i) => {
    const n = i + 1;
    const state = stateMap.get(todo.id) || {};
    const title = cleanTodoDisplayText(todo.text);
    const displayTitle = title.length > 54 ? `${title.slice(0, 54)}...` : title;
    const due = state.due_date ? `｜${state.due_date}` : '';
    const status = `${todoStatusIcon(state.status)} ${state.status || '待處理'}${due}`;

    return {
      type: 'bubble',
      size: 'micro',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `#${n}`, weight: 'bold', size: 'xs', color: '#6B7280' },
          { type: 'text', text: displayTitle, weight: 'bold', size: 'sm', color: '#111827', wrap: true },
          { type: 'text', text: status, size: 'xxs', color: '#374151', wrap: true },
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
            color: '#16A34A',
            action: { type: 'message', label: '完成', text: `完成第${n}項` },
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              { type: 'button', height: 'sm', action: { type: 'message', label: '半完成', text: `半完成第${n}項` } },
              { type: 'button', height: 'sm', action: { type: 'message', label: '等待', text: `等待第${n}項` } },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              { type: 'button', height: 'sm', action: { type: 'message', label: '明天', text: `延後第${n}項到明天` } },
              { type: 'button', height: 'sm', color: '#DC2626', action: { type: 'message', label: '刪除', text: `刪除第${n}項` } },
            ],
          },
        ],
      },
    };
  });

  if (bubbles.length === 0) return null;

  return {
    type: 'flex',
    altText: '待辦操作卡片',
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

function buildExpenseReminderFlex() {
  return {
    type: 'flex',
    altText: '帳務快捷卡片',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '帳務快捷處理', weight: 'bold', size: 'lg', color: '#111827' },
          { type: 'text', text: '今天有記錯的帳，可以直接點下面修正。', size: 'sm', color: '#6B7280', wrap: true },
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
              { type: 'button', height: 'sm', action: { type: 'message', label: '今天帳務', text: '今天帳務' } },
              { type: 'button', height: 'sm', action: { type: 'message', label: '本月帳務', text: '本月帳務' } },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              { type: 'button', height: 'sm', action: { type: 'message', label: '算公司', text: '最近一筆算公司' } },
              { type: 'button', height: 'sm', action: { type: 'message', label: '分類', text: '最近一筆分類' } },
            ],
          },
        ],
      },
    },
  };
}

async function buildDailyExpenseCheck(todayStr) {
  const tomorrow = new Date(`${todayStr}T00:00:00+08:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = getTodayStr(tomorrow);
  const { data: expenses } = await supabase
    .from('xlan_expenses')
    .select('*')
    .gte('created_at', `${todayStr}T00:00:00+08:00`)
    .lt('created_at', `${tomorrowStr}T00:00:00+08:00`)
    .order('created_at', { ascending: false });

  if (!expenses || expenses.length === 0) {
    return '💰 今日帳務\n今天還沒有記帳。若有現金支出、進貨、匯款，可以直接傳給我記。';
  }

  const sum = (items, type, account) => items
    .filter((e) => e.type === type && (!account || e.account === account))
    .reduce((total, e) => total + Number(e.amount || 0), 0);
  const income = sum(expenses, 'income');
  const expense = sum(expenses, 'expense');
  const personalExpense = sum(expenses, 'expense', 'personal');
  const businessExpense = sum(expenses, 'expense', 'business');
  const recent = expenses.slice(0, 3).map((e) => {
    const account = e.account === 'business' ? '公司' : '私人';
    const type = e.type === 'income' ? '收入' : '支出';
    return `- ${account}${type} ${e.category} NT$${e.amount}`;
  }).join('\n');

  return `💰 今日帳務\n收入：NT$${income}\n支出：NT$${expense}\n私人支出：NT$${personalExpense}\n公司支出：NT$${businessExpense}\n最近：\n${recent}\n\n若分類錯，可回「最近一筆算公司」或「最近一筆分類餐飲」。`;
}

// 把 "HH:MM" 轉成當天的分鐘數
function timeToMinutes(timeStr) {
  if (!timeStr) return -1;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}

// --- 早安摘要（9點）---
async function buildMorningSummary(now, todayStr) {
  const today = now.getDate();
  const thisMonth = now.getMonth() + 1;
  const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const weekday = weekdays[now.getDay()];
  const dateLabel = `${thisMonth}月${today}日（${weekday}）`;
  const sections = [];

  // 今日行程
  const { data: events } = await supabase
    .from('xlan_events').select('*').eq('date', todayStr).order('time', { ascending: true });
  if (events && events.length > 0) {
    const lines = events.map(e => {
      const loc = e.location ? `（${e.location}）` : '';
      return `- ${e.time || '全天'} ${e.title}${loc}`;
    });
    sections.push(`📅 今日行程\n${lines.join('\n')}`);
  }

  // 待辦（依優先度排序）
  const { data: todos } = await supabase
    .from('xlan_todos').select('*').eq('done', false)
    .order('created_at', { ascending: true });
  if (todos && todos.length > 0) {
    const stateMap = await getTodoStateMap(todos);
    const urgent = todos.filter(t => t.priority === 'urgent');
    const important = todos.filter(t => t.priority === 'important');
    const normal = todos.filter(t => !t.priority || t.priority === 'normal');
    const waiting = todos.filter(t => (stateMap.get(t.id)?.status) === '等待回覆');
    const inProgress = todos.filter(t => ['進行中', '半完成'].includes(stateMap.get(t.id)?.status));
    const sorted = [...waiting, ...inProgress, ...urgent, ...important, ...normal]
      .filter((todo, index, arr) => arr.findIndex((item) => item.id === todo.id) === index);
    const top5 = sorted.slice(0, 5);
    const lines = top5.map(t => `- ${formatTodoLine(t, stateMap.get(t.id))}`);
    let sec = `📋 待辦（共${todos.length}項）\n${lines.join('\n')}`;
    if (waiting.length > 0) sec += `\n🔵 等待回覆：${waiting.length}項`;
    if (inProgress.length > 0) sec += `\n🟡 進行中/半完成：${inProgress.length}項`;
    if (todos.length > 5) sec += `\n...還有${todos.length - 5}項`;
    sections.push(sec);
  }

  // 定期付款
  const { data: recurring } = await supabase
    .from('xlan_recurring').select('*').eq('active', true);
  if (recurring && recurring.length > 0) {
    const upcoming = [];
    for (const item of recurring) {
      let isDue = false;
      const dueDay = item.day_of_month;
      if (item.frequency === 'monthly') {
        for (let d = 0; d <= 3; d++) { if (today + d === dueDay) { isDue = true; break; } }
      } else if (item.frequency === 'yearly' && item.month_of_year === thisMonth) {
        for (let d = 0; d <= 3; d++) { if (today + d === dueDay) { isDue = true; break; } }
      }
      if (isDue) {
        const diff = dueDay - today;
        const when = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '後天' : `${diff}天後`;
        const amt = item.amount ? ` NT$${item.amount.toLocaleString()}` : '';
        const acct = item.account === 'business' ? '（公司）' : '';
        upcoming.push(`- ${item.title}${amt}${acct} — ${when}（${dueDay}號）`);
      }
    }
    if (upcoming.length > 0) sections.push(`💰 付款提醒\n${upcoming.join('\n')}`);
  }

  // 陸貨到貨提醒
  const tomorrow = new Date(now);
  tomorrow.setDate(today + 1);
  const tomorrowStr = getTodayStr(tomorrow);
  const { data: ships } = await supabase
    .from('xlan_shipments').select('*').eq('status', 'pending')
    .or(`expected_date.eq.${todayStr},expected_date.eq.${tomorrowStr}`)
    .order('expected_date', { ascending: true });
  if (ships && ships.length > 0) {
    const shipLines = ships.map(s => {
      const isToday = s.expected_date === todayStr;
      return isToday
        ? `- 📦 今日到貨：${s.title}（記得安排出貨）`
        : `- 📦 明日到貨預告：${s.title}（提前準備）`;
    });
    sections.push(shipLines.join('\n'));
  }

  // 應付款提醒
  const { data: payables } = await supabase
    .from('xlan_payables').select('*').eq('status', 'pending')
    .order('due_date', { ascending: true });
  if (payables && payables.length > 0) {
    const payLines = [];
    for (const p of payables) {
      if (!p.due_date) continue;
      const diff = Math.round((new Date(p.due_date) - new Date(todayStr)) / 86400000);
      if (diff >= 0 && diff <= 3) {
        const when = diff === 0 ? '今天到期' : diff === 1 ? '明天到期' : `${diff}天後到期`;
        const amt = p.amount ? ` NT$${p.amount.toLocaleString()}` : '';
        payLines.push(`- 💸 付給${p.to_whom}${amt}（${when}）`);
      }
    }
    if (payLines.length > 0) sections.push(payLines.join('\n'));
  }

  // 進行中專案
  const { data: projects } = await supabase
    .from('xlan_projects').select('id, name').eq('status', 'active');
  if (projects && projects.length > 0) {
    const projLines = [];
    for (const proj of projects) {
      const { count } = await supabase
        .from('xlan_todos').select('*', { count: 'exact', head: true }).eq('project_id', proj.id).eq('done', false);
      if (count > 0) projLines.push(`- ${proj.name}（${count}項待完成）`);
    }
    if (projLines.length > 0) sections.push(`📁 進行中專案\n${projLines.join('\n')}`);
  }

  if (sections.length === 0) {
    return `☀️ 早安香奈！今天是${dateLabel}，目前沒有特別的事項，好好加油！`;
  }
  return `☀️ 早安香奈！今天是${dateLabel}\n\n${sections.join('\n\n')}\n\n有什麼需要我處理的嗎？`;
}

// --- 行程提前提醒（每小時）---
async function checkUpcomingEvents(now, todayStr) {
  const { data: events } = await supabase
    .from('xlan_events').select('*').eq('date', todayStr).not('time', 'is', null);
  if (!events || events.length === 0) return [];

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const messages = [];

  for (const e of events) {
    const eventMinutes = timeToMinutes(e.time);
    if (eventMinutes < 0) continue;
    const diff = eventMinutes - nowMinutes;
    // 30~90 分鐘後的行程
    if (diff >= 30 && diff <= 90) {
      const loc = e.location ? `\n地點：${e.location}` : '';
      messages.push(`⏰ 提醒：${diff}分鐘後 ${e.time} ${e.title}${loc}\n需要準備什麼嗎？`);
    }
  }
  return messages;
}

// --- 行程完成追蹤（每小時）---
async function checkFinishedEvents(now, todayStr) {
  const { data: events } = await supabase
    .from('xlan_events').select('*').eq('date', todayStr).not('time', 'is', null);
  if (!events || events.length === 0) return [];

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const messages = [];

  for (const e of events) {
    const eventMinutes = timeToMinutes(e.time);
    if (eventMinutes < 0) continue;
    const diff = nowMinutes - eventMinutes;
    // 剛結束（0~30分鐘前，假設行程1小時）
    if (diff >= 60 && diff <= 90) {
      messages.push(`${e.title} 應該差不多結束了，辦完了嗎？\n回覆「完成」或「延後到{時間}」`);
    }
  }
  return messages;
}

// --- 自訂提醒 ---
async function checkCustomReminders(now) {
  const currentHour = now.getHours();
  const { data: kvData } = await supabase
    .from('xlan_kv').select('value').eq('key', 'custom_reminders').single();
  if (!kvData) return null;

  let reminders;
  try { reminders = JSON.parse(kvData.value); } catch { return null; }
  if (!Array.isArray(reminders)) return null;

  const matched = reminders.find(r => r.hour === currentHour);
  if (!matched) return null;

  // 下午提醒：列出待辦
  if (currentHour < 20) {
    const { data: todos } = await supabase
      .from('xlan_todos').select('*').eq('done', false)
      .order('created_at', { ascending: true }).limit(10);
    const stateMap = await getTodoStateMap(todos || []);
    const focus = (todos || [])
      .filter(t => ['待處理', '進行中', '半完成', '等待回覆', '未完成'].includes(stateMap.get(t.id)?.status || '待處理'))
      .slice(0, 6);
    const items = focus.map((t, i) => `${i + 1}. ${formatTodoLine(t, stateMap.get(t.id))}`).join('\n');
    const expenseCheck = await buildDailyExpenseCheck(getTodayStr(now));
    const messages = [
      { type: 'text', text: `📋 ${matched.label || matched.message || '提醒'}\n\n目前需要盤點：\n${items || '（無待辦）'}\n\n${expenseCheck}\n\n可以直接點下面卡片處理。` },
    ];
    const todoFlex = buildReminderTodoFlex(focus, stateMap);
    if (todoFlex) messages.push(todoFlex);
    messages.push(buildExpenseReminderFlex());
    return messages;
  }

  // 晚間總結：列出今天完成+未完成
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const { data: doneTodos } = await supabase
    .from('xlan_todos').select('text').eq('done', true)
    .gte('done_at', todayStart).order('done_at', { ascending: true });
  const { data: pendingTodos } = await supabase
    .from('xlan_todos').select('*').eq('done', false)
    .order('created_at', { ascending: true }).limit(10);
  const stateMap = await getTodoStateMap(pendingTodos || []);

  const doneLines = (doneTodos || []).map(t => `✅ ${t.text}`).join('\n') || '（今天沒有完成項目）';
  const pendingLines = (pendingTodos || []).map((t, i) => `${i + 1}. ${formatTodoLine(t, stateMap.get(t.id))}`).join('\n') || '（全部完成！）';
  const expenseCheck = await buildDailyExpenseCheck(getTodayStr(now));

  const messages = [
    { type: 'text', text: `🌙 今日總結\n\n今天完成了：\n${doneLines}\n\n還要追蹤：\n${pendingLines}\n\n${expenseCheck}\n\n可以直接點下面卡片處理。` },
  ];
  const todoFlex = buildReminderTodoFlex(pendingTodos || [], stateMap);
  if (todoFlex) messages.push(todoFlex);
  messages.push(buildExpenseReminderFlex());
  return messages;
}

// --- 月底財務總結 ---
async function buildMonthlySummary(now) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthStart = new Date(y, m, 1).toISOString();
  const monthEnd = new Date(y, m + 1, 1).toISOString();
  const monthLabel = `${m + 1}`;

  const { data: expenses } = await supabase
    .from('xlan_expenses').select('*')
    .gte('created_at', monthStart).lt('created_at', monthEnd);

  const biz = (expenses || []).filter(e => e.account === 'business');
  const personal = (expenses || []).filter(e => e.account === 'personal');
  const sum = (arr, type) => arr.filter(e => e.type === type).reduce((s, e) => s + e.amount, 0);

  const bizIncome = sum(biz, 'income'), bizExpense = sum(biz, 'expense');
  const perIncome = sum(personal, 'income'), perExpense = sum(personal, 'expense');

  // 完成待辦數
  const { count: doneCount } = await supabase
    .from('xlan_todos').select('*', { count: 'exact', head: true }).eq('done', true)
    .gte('done_at', monthStart).lt('done_at', monthEnd);

  // 修復 bug 數
  const { count: fixedCount } = await supabase
    .from('xlan_bugs').select('*', { count: 'exact', head: true }).eq('status', 'fixed')
    .gte('fixed_at', monthStart).lt('fixed_at', monthEnd);

  // 未完成待辦前5
  const { data: pending } = await supabase
    .from('xlan_todos').select('*').eq('done', false)
    .order('created_at', { ascending: true }).limit(5);
  const stateMap = await getTodoStateMap(pending || []);
  const pendingLines = (pending || []).map(t => `- ${formatTodoLine(t, stateMap.get(t.id))}`).join('\n') || '（無）';

  return `📊 ${monthLabel}月財務總結\n\n💼 公司帳\n收入：NT$${bizIncome.toLocaleString()}\n支出：NT$${bizExpense.toLocaleString()}\n淨額：NT$${(bizIncome - bizExpense).toLocaleString()}\n\n👤 私人帳\n收入：NT$${perIncome.toLocaleString()}\n支出：NT$${perExpense.toLocaleString()}\n淨額：NT$${(perIncome - perExpense).toLocaleString()}\n\n✅ 本月完成待辦：${doneCount || 0}項\n🐛 本月修復Bug：${fixedCount || 0}項\n\n📋 未完成待辦（前5項）\n${pendingLines}`;
}

// --- Main Handler ---
module.exports = async (req, res) => {
  try {
    const { data: kvData } = await supabase
      .from('xlan_kv').select('value').eq('key', 'owner_line_id').single();

    if (!kvData) {
      return res.status(200).json({ ok: true, message: 'no owner' });
    }

    const ownerLineId = kvData.value;
    const now = getTaipeiNow();
    const currentHour = now.getHours();
    const todayStr = getTodayStr(now);
    const sent = [];

    // 1. 早安摘要（9點）
    if (currentHour === 9) {
      const morning = await buildMorningSummary(now, todayStr);
      await pushMessage(ownerLineId, morning);
      sent.push('morning');
    }

    // 2. 行程提前提醒
    const upcomingMsgs = await checkUpcomingEvents(now, todayStr);
    for (const msg of upcomingMsgs) {
      await pushMessage(ownerLineId, msg);
      sent.push('upcoming');
    }

    // 3. 行程完成追蹤
    const finishedMsgs = await checkFinishedEvents(now, todayStr);
    for (const msg of finishedMsgs) {
      await pushMessage(ownerLineId, msg);
      sent.push('finished');
    }

    // 4. 自訂提醒
    const customMsg = await checkCustomReminders(now);
    if (customMsg) {
      await pushMessage(ownerLineId, customMsg);
      sent.push('custom');
    }

    // 5. 月底財務總結（每月最後一天 21 點）
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (now.getDate() === lastDay && currentHour === 21) {
      const summary = await buildMonthlySummary(now);
      await pushMessage(ownerLineId, summary);
      sent.push('monthly_summary');
    }

    return res.status(200).json({ ok: true, hour: currentHour, sent });
  } catch (err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
};
