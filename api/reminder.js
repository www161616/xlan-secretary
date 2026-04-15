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
    // 取得 owner LINE userId
    const { data: kvData } = await supabase
      .from('xlan_kv')
      .select('value')
      .eq('key', 'owner_line_id')
      .single();

    if (!kvData) {
      console.log('No owner_line_id set yet');
      return res.status(200).json({ ok: true, message: 'no owner' });
    }

    const ownerLineId = kvData.value;

    // 查詢所有啟用的定期付款
    const { data: items } = await supabase
      .from('xlan_recurring')
      .select('*')
      .eq('active', true);

    if (!items || items.length === 0) {
      return res.status(200).json({ ok: true, message: 'no recurring items' });
    }

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const today = now.getDate();
    const thisMonth = now.getMonth() + 1;

    const upcoming = [];

    for (const item of items) {
      let isDue = false;
      let dueDay = item.day_of_month;

      if (item.frequency === 'monthly') {
        // 今天或未來 3 天內到期
        for (let d = 0; d <= 3; d++) {
          const checkDay = today + d;
          if (checkDay === dueDay) {
            isDue = true;
            break;
          }
        }
      } else if (item.frequency === 'yearly') {
        if (item.month_of_year === thisMonth) {
          for (let d = 0; d <= 3; d++) {
            const checkDay = today + d;
            if (checkDay === dueDay) {
              isDue = true;
              break;
            }
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

    if (upcoming.length === 0) {
      return res.status(200).json({ ok: true, message: 'nothing due' });
    }

    const message = `⏰ 付款提醒\n\n以下項目即將到期：\n${upcoming.join('\n')}\n\n記得安排付款！`;
    await pushMessage(ownerLineId, message);

    return res.status(200).json({ ok: true, sent: upcoming.length });
  } catch (err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
};
