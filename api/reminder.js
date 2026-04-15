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

module.exports = async (req, res) => {
  try {
    const { data: kvData } = await supabase
      .from('xlan_kv')
      .select('value')
      .eq('key', 'owner_line_id')
      .single();

    if (!kvData) {
      return res.status(200).json({ ok: true, message: 'no owner' });
    }

    const ownerLineId = kvData.value;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const today = now.getDate();
    const thisMonth = now.getMonth() + 1;
    const thisYear = now.getFullYear();
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const weekday = weekdays[now.getDay()];
    const todayStr = `${thisYear}-${String(thisMonth).padStart(2, '0')}-${String(today).padStart(2, '0')}`;

    const sections = [];

    // --- 1. 今日行程 ---
    const { data: events } = await supabase
      .from('xlan_events')
      .select('*')
      .eq('date', todayStr)
      .order('time', { ascending: true });

    if (events && events.length > 0) {
      const eventLines = events.map(e => {
        const time = e.time || '全天';
        const loc = e.location ? `（${e.location}）` : '';
        return `- ${time} ${e.title}${loc}`;
      });
      sections.push(`📅 今日行程\n${eventLines.join('\n')}`);
    }

    // --- 2. 待辦清單 ---
    const { data: todos, count } = await supabase
      .from('xlan_todos')
      .select('*', { count: 'exact' })
      .eq('done', false)
      .order('created_at', { ascending: true })
      .limit(5);

    if (todos && todos.length > 0) {
      const totalCount = count || todos.length;
      const todoLines = todos.map(t => `- ${t.text}`);
      let todoSection = `📋 待辦（共${totalCount}項）\n${todoLines.join('\n')}`;
      if (totalCount > 5) {
        todoSection += `\n...還有${totalCount - 5}項`;
      }
      sections.push(todoSection);
    }

    // --- 3. 定期付款提醒 ---
    const { data: recurring } = await supabase
      .from('xlan_recurring')
      .select('*')
      .eq('active', true);

    if (recurring && recurring.length > 0) {
      const upcoming = [];

      for (const item of recurring) {
        let isDue = false;
        const dueDay = item.day_of_month;

        if (item.frequency === 'monthly') {
          for (let d = 0; d <= 3; d++) {
            if (today + d === dueDay) { isDue = true; break; }
          }
        } else if (item.frequency === 'yearly') {
          if (item.month_of_year === thisMonth) {
            for (let d = 0; d <= 3; d++) {
              if (today + d === dueDay) { isDue = true; break; }
            }
          }
        }

        if (isDue) {
          const diff = dueDay - today;
          let when;
          if (diff === 0) when = '今天';
          else if (diff === 1) when = '明天';
          else if (diff === 2) when = '後天';
          else when = `${diff}天後`;

          const amountStr = item.amount ? ` NT$${item.amount.toLocaleString()}` : '';
          const accountStr = item.account === 'business' ? '（公司）' : '';
          upcoming.push(`- ${item.title}${amountStr}${accountStr} — ${when}（${dueDay}號）`);
        }
      }

      if (upcoming.length > 0) {
        sections.push(`💰 付款提醒\n${upcoming.join('\n')}`);
      }
    }

    // --- 組合訊息 ---
    const dateLabel = `${thisMonth}月${today}日（${weekday}）`;
    let message;

    if (sections.length === 0) {
      message = `☀️ 早安香奈！今天是${dateLabel}，目前沒有特別的事項，好好加油！`;
    } else {
      message = `☀️ 早安香奈！今天是${dateLabel}\n\n${sections.join('\n\n')}\n\n有什麼需要我處理的嗎？`;
    }

    await pushMessage(ownerLineId, message);

    return res.status(200).json({ ok: true, sections: sections.length });
  } catch (err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
};
