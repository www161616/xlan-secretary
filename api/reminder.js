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

function todoFocusKey(sourceKey) {
  return `todo_focus:${sourceKey}`;
}

function expenseFocusKey(sourceKey) {
  return `expense_focus:${sourceKey}`;
}

async function saveTodoFocus(sourceKey, todos, reason = '') {
  const ids = (todos || []).map((todo) => todo?.id).filter(Boolean).slice(0, 10);
  if (!sourceKey || ids.length === 0) return;
  await supabase.from('xlan_kv').upsert({
    key: todoFocusKey(sourceKey),
    value: JSON.stringify({ ids, reason, updated_at: new Date().toISOString() }),
  });
}

async function saveExpenseFocus(sourceKey, expense) {
  if (!sourceKey || !expense?.id) return;
  await supabase.from('xlan_kv').upsert({
    key: expenseFocusKey(sourceKey),
    value: JSON.stringify({ id: expense.id, updated_at: new Date().toISOString() }),
  });
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

function todoDueRank(state, todayStr) {
  if (!state?.due_date) return 3;
  if (state.due_date < todayStr) return 0;
  if (state.due_date === todayStr) return 1;
  return 2;
}

function todoAgeDays(todo) {
  if (!todo.created_at) return 0;
  return Math.floor((Date.now() - new Date(todo.created_at).getTime()) / 86400000);
}

function sortTodosForReminder(todos, stateMap, todayStr) {
  return [...(todos || [])].sort((a, b) => {
    const aState = stateMap.get(a.id) || {};
    const bState = stateMap.get(b.id) || {};
    const statusWeight = { 未完成: 90, 半完成: 80, 待處理: 70, 進行中: 65, 等待回覆: 45 };
    const priorityWeight = { urgent: 120, important: 40, normal: 0 };
    const aDue = todoDueRank(aState, todayStr);
    const bDue = todoDueRank(bState, todayStr);
    const aScore = (priorityWeight[a.priority || 'normal'] || 0)
      + (statusWeight[aState.status || '待處理'] || 0)
      + (aDue === 0 ? 45 : aDue === 1 ? 35 : 0)
      + (todoAgeDays(a) >= 3 ? 12 : 0);
    const bScore = (priorityWeight[b.priority || 'normal'] || 0)
      + (statusWeight[bState.status || '待處理'] || 0)
      + (bDue === 0 ? 45 : bDue === 1 ? 35 : 0)
      + (todoAgeDays(b) >= 3 ? 12 : 0);
    if (aScore !== bScore) return bScore - aScore;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
}

function summarizeTodoPressure(todos, stateMap, todayStr) {
  const overdue = [];
  const dueToday = [];
  const stalled = [];
  (todos || []).forEach((todo) => {
    const state = stateMap.get(todo.id) || {};
    if (state.due_date && state.due_date < todayStr) overdue.push(todo);
    if (state.due_date === todayStr) dueToday.push(todo);
    const status = state.status || '待處理';
    if (['待處理', '未完成', '半完成'].includes(status) && todoAgeDays(todo) >= 3) stalled.push(todo);
  });
  const lines = [];
  if (overdue.length > 0) lines.push(`逾期 ${overdue.length} 件`);
  if (dueToday.length > 0) lines.push(`今天到期 ${dueToday.length} 件`);
  if (stalled.length > 0) lines.push(`卡超過3天 ${stalled.length} 件`);
  return lines.length ? `壓力點：${lines.join('、')}。` : '壓力點：目前沒有逾期或卡太久的待辦。';
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
            action: { type: 'message', label: '完成', text: `待辦:${todo.id}:完成` },
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              { type: 'button', height: 'sm', action: { type: 'message', label: '半完成', text: `待辦:${todo.id}:半完成` } },
              { type: 'button', height: 'sm', action: { type: 'message', label: '等待', text: `待辦:${todo.id}:等待回覆` } },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              { type: 'button', height: 'sm', action: { type: 'message', label: '明天', text: `待辦:${todo.id}:延後:明天` } },
              { type: 'button', height: 'sm', color: '#DC2626', action: { type: 'message', label: '刪除', text: `待辦:${todo.id}:刪除` } },
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

async function buildDailyExpenseCheck(todayStr, focusKey = '') {
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
  await saveExpenseFocus(focusKey, expenses[0]);

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
async function buildMorningSummary(now, todayStr, focusKey = '') {
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
    await saveTodoFocus(focusKey, top5, 'morning_summary');
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
async function checkCustomReminders(now, focusKey = '') {
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
      .order('created_at', { ascending: true }).limit(50);
    const stateMap = await getTodoStateMap(todos || []);
    const todayStr = getTodayStr(now);
    const sorted = sortTodosForReminder(todos || [], stateMap, todayStr);
    const focus = sorted
      .filter(t => ['待處理', '進行中', '半完成', '等待回覆', '未完成'].includes(stateMap.get(t.id)?.status || '待處理'))
      .slice(0, 6);
    const items = focus.map((t, i) => `${i + 1}. ${formatTodoLine(t, stateMap.get(t.id))}`).join('\n');
    const pressure = summarizeTodoPressure(todos || [], stateMap, todayStr);
    const workload = summarizeTodoWorkLanes(todos || []);
    const recommendation = buildTodoRecommendation(todos || [], stateMap, todayStr);
    const statusCheck = summarizeStatusCheckTodos(sorted, stateMap);
    const expenseCheck = await buildDailyExpenseCheck(todayStr, focusKey);
    await saveTodoFocus(focusKey, focus, 'custom_reminder');
    const messages = [
      { type: 'text', text: `📋 ${matched.label || matched.message || '提醒'}\n\n${workload}\n${recommendation}\n\n${pressure}\n${statusCheck ? `\n${statusCheck}\n` : ''}\n目前需要先看：\n${items || '（無待辦）'}\n\n${expenseCheck}\n\n可以直接點下面卡片處理。` },
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
    .order('created_at', { ascending: true }).limit(50);
  const stateMap = await getTodoStateMap(pendingTodos || []);
  const todayStr = getTodayStr(now);
  const sortedPending = sortTodosForReminder(pendingTodos || [], stateMap, todayStr).slice(0, 10);

  const doneLines = (doneTodos || []).map(t => `✅ ${t.text}`).join('\n') || '（今天沒有完成項目）';
  const pendingLines = sortedPending.map((t, i) => `${i + 1}. ${formatTodoLine(t, stateMap.get(t.id))}`).join('\n') || '（全部完成！）';
  const pressure = summarizeTodoPressure(pendingTodos || [], stateMap, todayStr);
  const workload = summarizeTodoWorkLanes(pendingTodos || []);
  const recommendation = buildTodoRecommendation(pendingTodos || [], stateMap, todayStr);
  const statusCheck = summarizeStatusCheckTodos(sortedPending, stateMap);
  const expenseCheck = await buildDailyExpenseCheck(todayStr, focusKey);
  await saveTodoFocus(focusKey, sortedPending, 'evening_summary');

  const messages = [
    { type: 'text', text: `🌙 今日總結\n\n今天完成了：\n${doneLines}\n\n${workload}\n${recommendation}\n\n${pressure}\n${statusCheck ? `\n${statusCheck}\n` : ''}\n還要追蹤：\n${pendingLines}\n\n${expenseCheck}\n\n可以直接點下面卡片處理。` },
  ];
  const todoFlex = buildReminderTodoFlex(sortedPending, stateMap);
  if (todoFlex) messages.push(todoFlex);
  messages.push(buildExpenseReminderFlex());
  return messages;
}

async function hasSentDaily(key) {
  const { data } = await supabase.from('xlan_kv').select('value').eq('key', key).single();
  return Boolean(data?.value);
}

async function markSentDaily(key) {
  await supabase.from('xlan_kv').upsert({
    key,
    value: JSON.stringify({ sent_at: new Date().toISOString() }),
  });
}

async function buildStuckTodoCheckMessages(now, todayStr, focusKey = '') {
  const { data: todos } = await supabase
    .from('xlan_todos')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: true })
    .limit(80);
  const stateMap = await getTodoStateMap(todos || []);
  const targets = findTodosNeedingStatusCheck(todos || [], stateMap).slice(0, 8);
  if (targets.length === 0) return null;

  await saveTodoFocus(focusKey, targets, 'stuck_todo_check');
  const lines = targets.map((todo, i) => {
    const state = stateMap.get(todo.id) || {};
    const age = todoStateAgeDays(state);
    return `${i + 1}. ${formatTodoLine(todo, state)}（${state.status || '待處理'}已${age}天沒更新）`;
  }).join('\n');

  const messages = [
    { type: 'text', text: `我幫你抓到幾件狀態卡住的待辦，點卡片更新一下：\n\n${lines}` },
  ];
  const todoFlex = buildReminderTodoFlex(targets, stateMap);
  if (todoFlex) messages.push(todoFlex);
  return messages;
}

// --- 月底財務總結 ---
async function buildMonthlySummary(now, focusKey = '') {
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
  await saveTodoFocus(focusKey, pending || [], 'monthly_summary');
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
    const focusKey = `direct:${ownerLineId}`;
    const now = getTaipeiNow();
    const currentHour = now.getHours();
    const todayStr = getTodayStr(now);
    const sent = [];

    // 1. 早安摘要（9點）
    if (currentHour === 9) {
      const morning = await buildMorningSummary(now, todayStr, focusKey);
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
    const customMsg = await checkCustomReminders(now, focusKey);
    if (customMsg) {
      await pushMessage(ownerLineId, customMsg);
      sent.push('custom');
    }

    // 5. 主動追問卡住待辦（每天 15 點一次）
    const stuckKey = `stuck_todo_check_sent:${todayStr}`;
    if (currentHour === 15 && !(await hasSentDaily(stuckKey))) {
      const stuckMsg = await buildStuckTodoCheckMessages(now, todayStr, focusKey);
      if (stuckMsg) {
        await pushMessage(ownerLineId, stuckMsg);
        await markSentDaily(stuckKey);
        sent.push('stuck_todo_check');
      }
    }

    // 6. 月底財務總結（每月最後一天 21 點）
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (now.getDate() === lastDay && currentHour === 21) {
      const summary = await buildMonthlySummary(now, focusKey);
      await pushMessage(ownerLineId, summary);
      sent.push('monthly_summary');
    }

    return res.status(200).json({ ok: true, hour: currentHour, sent });
  } catch (err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
};
