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

// --- 初始化 ---
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Google Calendar ---
function getCalendarClient() {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
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

// --- LINE 下載圖片 ---
async function downloadLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString('base64');
}

// --- Flex Message：記帳卡片 ---
function buildExpenseFlexMessage({ amount, category, note, type, account, label }) {
  const isIncome = type === 'income';
  const color = isIncome ? '#4CAF50' : '#FF6B6B';
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
        backgroundColor: color,
        paddingAll: '20px',
        contents: [
          ...(label ? [{
            type: 'box',
            layout: 'horizontal',
            contents: [{
              type: 'text',
              text: label,
              size: 'xxs',
              color: '#FFFFFF',
              weight: 'bold',
            }],
            justifyContent: 'flex-end',
          }] : []),
          {
            type: 'text',
            text: `${typeText}・${accountText}`,
            size: 'sm',
            color: '#FFFFFF90',
          },
          {
            type: 'text',
            text: `NT$ ${amount.toLocaleString()}`,
            size: 'xxl',
            weight: 'bold',
            color: '#FFFFFF',
            margin: 'sm',
          },
          {
            type: 'separator',
            margin: 'lg',
            color: '#FFFFFF30',
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
                  { type: 'text', text: '類別', size: 'sm', color: '#FFFFFF90', flex: 2 },
                  { type: 'text', text: category, size: 'sm', color: '#FFFFFF', flex: 5, weight: 'bold' },
                ],
              },
              ...(note ? [{
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '備註', size: 'sm', color: '#FFFFFF90', flex: 2 },
                  { type: 'text', text: note, size: 'sm', color: '#FFFFFF', flex: 5, wrap: true },
                ],
              }] : []),
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '時間', size: 'sm', color: '#FFFFFF90', flex: 2 },
                  { type: 'text', text: now, size: 'sm', color: '#FFFFFF', flex: 5 },
                ],
              },
            ],
          },
          {
            type: 'text',
            text: '✓ 已記錄',
            size: 'xs',
            color: '#FFFFFF60',
            align: 'end',
            margin: 'lg',
          },
        ],
      },
    },
  };
}

// --- System Prompt ---
const SYSTEM_PROMPT = `你是「小瀾」，香奈的專屬 AI 秘書。
香奈是包子媽生鮮小舖的負責人，旗下有 16 個門市（中和、文山、龍潭、林口、永和、平鎮、經國、古華、南平等），
同時負責管理 LT-ERP 系統、樂樂團購平台、各門市帳務與薪資。

你的工作原則：
- 繁體中文回答，親切簡潔
- 幫香奈記錄、整理、分析任何事情
- 回答問題、草擬文字、計算數字都可以
- 重要資訊用條列式整理，不廢話

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
存完回覆「📝 已記錄筆記」。
tags 根據內容自動分類，例如 ["業務","門市"]、["個人"]、["ERP"] 等。
當用戶說「查筆記」「看筆記」「之前記了什麼」，呼叫 get_notes 列出筆記，不要問用戶問題。

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
當用戶說「完成」「辦完了」「OK了」，表示最近追蹤的事項已完成，正常回覆確認。
當用戶說「延後」「改到X點」「明天再做」，幫忙更新對應行程。

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
呼叫 get_project_status 查詢進度條。`;

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

const ALL_TOOLS = [SAVE_TODO_TOOL, CREATE_CALENDAR_EVENT_TOOL, SAVE_EXPENSE_TOOL, GET_EXPENSES_TOOL, SAVE_NOTE_TOOL, GET_NOTES_TOOL, SAVE_RECURRING_TOOL, SET_REMINDER_TOOL, SAVE_BUG_TOOL, FIX_BUG_TOOL, GET_PRIORITY_TODOS_TOOL, SAVE_SHIPMENT_TOOL, ARRIVE_SHIPMENT_TOOL, GET_SHIPMENTS_TOOL, SAVE_PAYABLE_TOOL, SAVE_VENDOR_TOOL, GET_VENDOR_TOOL, CREATE_PROJECT_TOOL, GET_PROJECT_STATUS_TOOL];

// --- LINE 簽名驗證 ---
function validateSignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// --- LINE 回覆訊息（支援 text 或 flex message 陣列）---
async function replyMessage(replyToken, messages) {
  if (typeof messages === 'string') {
    messages = [{ type: 'text', text: messages }];
  }
  if (!Array.isArray(messages)) {
    messages = [messages];
  }

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

// --- 處理 tool use 結果 ---
async function handleToolUse(block, userMessage) {
  if (block.name === 'save_todo' && block.input.task) {
    await supabase.from('xlan_todos').insert({
      text: block.input.task,
      source_message: userMessage,
      priority: block.input.priority || 'normal',
      source_person: block.input.source_person || null,
    });
    const pLabel = { urgent: '🔴', important: '🟡', normal: '' }[block.input.priority || 'normal'];
    return { result: `已存入待辦${pLabel}：${block.input.task}`, flexMessage: null };
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
      await saveExpense(block.input);
      const flex = buildExpenseFlexMessage({
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
      if (tasks.length > 0) {
        const todoRows = tasks.map(t => ({
          text: t,
          project_id: proj.id,
          project_name: block.input.name,
          priority: 'normal',
        }));
        await supabase.from('xlan_todos').insert(todoRows);
      }

      const taskList = tasks.map((t, i) => `${i + 1}. 🔲 ${t}`).join('\n');
      return { result: `📁 已建立專案：${block.input.name}\n\n工作項目（共${tasks.length}項）：\n${taskList}`, flexMessage: null };
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
async function chatWithClaude(userId, userContent) {
  const { data: history } = await supabase
    .from('xlan_conversations')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(20);

  const messages = (history || []).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  messages.push({ role: 'user', content: userContent });

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages,
  });

  const flexMessages = [];
  const userMessageText = typeof userContent === 'string' ? userContent : '(圖片訊息)';

  while (response.stop_reason === 'tool_use') {
    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');

    const toolResults = [];
    for (const block of toolBlocks) {
      const { result, isError, flexMessage } = await handleToolUse(block, userMessageText);
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
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  const reply = textBlock ? textBlock.text : '已處理完成！';

  await supabase.from('xlan_conversations').insert([
    { user_id: userId, role: 'user', content: userMessageText },
    { user_id: userId, role: 'assistant', content: reply },
  ]);

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

  const items = data
    .map((t, i) => {
      const source = t.source_group ? `（來自：群組）` : '';
      return `${i + 1}. ${t.text}${source}`;
    })
    .join('\n');

  return `📋 你的待辦清單\n\n${items}\n\n共 ${data.length} 項未完成。\n回覆「完成第1項」可以標記完成。`;
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

  return `✅ 已完成：「${todo.text}」`;
}

// --- 檢查訊息是否有 @ 小瀾 ---
function isMentioned(event) {
  const mention = event.message.mention;
  if (!mention || !mention.mentionees) return false;
  return mention.mentionees.some((m) => m.type === 'all' || m.isSelf === true);
}

// --- 儲存 owner LINE ID ---
async function saveOwnerLineId(userId) {
  await supabase.from('xlan_kv').upsert({ key: 'owner_line_id', value: userId });
}

// --- 群組訊息處理 ---
async function handleGroupMessage(event) {
  const msgType = event.message.type;

  if (msgType === 'text') {
    const text = event.message.text;
    if (!text) return;

    const mentioned = isMentioned(event);

    if (mentioned) {
      const quotedText = event.message.quotedMessage && event.message.quotedMessage.text;
      const contentToAnalyze = quotedText || text;
      const cleanedText = contentToAnalyze.replace(/@\S+/g, '').trim();
      if (!cleanedText) return;

      const userId = event.source.userId || 'group_user';
      const { reply, flexMessages } = await chatWithClaude(userId, cleanedText);
      const messages = [];
      if (flexMessages.length > 0) messages.push(...flexMessages);
      if (reply) messages.push({ type: 'text', text: reply });
      await replyMessage(event.replyToken, messages);
    } else {
      const result = await judgeTask(text);
      if (result.is_task && result.task) {
        await supabase.from('xlan_todos').insert({
          text: result.task,
          source_group: event.source.groupId || 'unknown',
          source_message: text,
        });
        console.log('New task detected:', result.task);
      }
    }
  }
}

// --- 私訊處理 ---
async function handleDirectMessage(event) {
  const msgType = event.message.type;
  const userId = event.source.userId;

  // 儲存 owner LINE ID（首次私訊時 upsert）
  saveOwnerLineId(userId).catch((err) => console.error('saveOwnerLineId error:', err));

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
          text: '這是一張付款或匯款相關的截圖，請判讀並提取：金額、收款方/用途、日期（如果有的話），然後呼叫 save_expense 記錄這筆帳。note 請填「圖片記帳：{判讀內容摘要}」。如果看不出是記帳相關的圖片，就直接描述圖片內容。',
        },
      ];

      const { reply, flexMessages } = await chatWithClaude(userId, imageContent);
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

  let replyMessages;

  if (/^(待辦|清單|有什麼事)$/.test(text)) {
    replyMessages = [{ type: 'text', text: await listTodos() }];
  } else if (/^(完成|刪除)第(\d+)項$/.test(text)) {
    const match = text.match(/^(完成|刪除)第(\d+)項$/);
    const n = parseInt(match[2], 10);
    replyMessages = [{ type: 'text', text: await completeTodo(n) }];
  } else {
    const { reply, flexMessages } = await chatWithClaude(userId, text);
    replyMessages = [];
    if (flexMessages.length > 0) replyMessages.push(...flexMessages);
    if (reply) replyMessages.push({ type: 'text', text: reply });
  }

  await replyMessage(event.replyToken, replyMessages);
}

// --- Vercel Serverless Handler ---
module.exports = async (req, res) => {
  if (req.method === 'GET') {
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
    if (event.type !== 'message') continue;
    const msgType = event.message.type;
    if (msgType !== 'text' && msgType !== 'image') continue;

    try {
      if (event.source.type === 'group' || event.source.type === 'room') {
        await handleGroupMessage(event);
      } else if (event.source.type === 'user') {
        await handleDirectMessage(event);
      }
    } catch (err) {
      console.error('Event handling error:', err);
    }
  }

  return res.status(200).json({ ok: true });
};
