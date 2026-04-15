const { createClient } = require('@supabase/supabase-js');

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function pushMessage(userId, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text }],
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
    const urgent = todos.filter(t => t.priority === 'urgent');
    const important = todos.filter(t => t.priority === 'important');
    const normal = todos.filter(t => !t.priority || t.priority === 'normal');
    const sorted = [...urgent, ...important, ...normal];
    const top5 = sorted.slice(0, 5);
    const lines = top5.map(t => {
      const icon = t.priority === 'urgent' ? '🔴 ' : t.priority === 'important' ? '🟡 ' : '⚪ ';
      return `- ${icon}${t.text}`;
    });
    let sec = `📋 待辦（共${todos.length}項）\n${lines.join('\n')}`;
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
      .from('xlan_todos').select('text').eq('done', false)
      .order('created_at', { ascending: true }).limit(10);
    const items = (todos || []).map(t => `• ${t.text}`).join('\n');
    return `📋 ${matched.label || matched.message || '提醒'}！目前待辦：\n${items || '（無待辦）'}\n\n有什麼需要處理的嗎？`;
  }

  // 晚間總結：列出今天完成+未完成
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const { data: doneTodos } = await supabase
    .from('xlan_todos').select('text').eq('done', true)
    .gte('done_at', todayStart).order('done_at', { ascending: true });
  const { data: pendingTodos } = await supabase
    .from('xlan_todos').select('text').eq('done', false)
    .order('created_at', { ascending: true }).limit(10);

  const doneLines = (doneTodos || []).map(t => `✅ ${t.text}`).join('\n') || '（今天沒有完成項目）';
  const pendingLines = (pendingTodos || []).map(t => `🔲 ${t.text}`).join('\n') || '（全部完成！）';

  return `🌙 今日總結\n\n今天完成了：\n${doneLines}\n\n未完成：\n${pendingLines}\n\n需要延後或調整什麼嗎？`;
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
    .from('xlan_todos').select('text').eq('done', false)
    .order('created_at', { ascending: true }).limit(5);
  const pendingLines = (pending || []).map(t => `- ${t.text}`).join('\n') || '（無）';

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
