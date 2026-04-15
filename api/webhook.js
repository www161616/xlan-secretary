const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

// --- 環境變數 ---
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// --- 初始化 ---
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `你是「小瀾」，香奈的專屬 AI 秘書。
香奈是包子媽生鮮小舖的負責人，旗下有 16 個門市（中和、文山、龍潭、林口、永和、平鎮、經國、古華、南平等），
同時負責管理 LT-ERP 系統、樂樂團購平台、各門市帳務與薪資。

你的工作原則：
- 繁體中文回答，親切簡潔
- 幫香奈記錄、整理、分析任何事情
- 回答問題、草擬文字、計算數字都可以
- 重要資訊用條列式整理，不廢話

【最重要的規則 — 待辦事項自動記錄】
當用戶說任何需要去做的事情，不要問問題，直接用 save_todo 工具存進待辦清單。
判斷標準：
- 要做的事、要處理的事（例如「幫各店送菜單DM」「叫林口備貨」「下午去銀行」）
- 幫某人做某事
- 任何動作性的指令
- 提到時間＋事情的組合（例如「明天要對帳」）

存完之後，在回覆的最前面加上「✅ 已記錄：{待辦內容}」，然後再接你的回覆。
如果一則訊息包含多個待辦，每個都要存，每個都要確認。
如果訊息只是聊天、問問題、打招呼，就正常回覆，不要存待辦。`;

const SAVE_TODO_TOOL = {
  name: 'save_todo',
  description: '將待辦事項存入清單。當用戶提到任何需要去做的事情時使用。',
  input_schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '待辦事項摘要，繁體中文，20字以內',
      },
    },
    required: ['task'],
  },
};

// --- LINE 簽名驗證 ---
function validateSignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// --- LINE 回覆訊息 ---
async function replyMessage(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
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
  // 從回覆中提取 JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { is_task: false, task: null };
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { is_task: false, task: null };
  }
}

// --- Claude API：AI 對話（支援 tool use 自動存待辦）---
async function chatWithClaude(userId, userMessage) {
  // 撈最近 20 則對話
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
  messages.push({ role: 'user', content: userMessage });

  // 第一次呼叫，帶 tool
  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [SAVE_TODO_TOOL],
    messages,
  });

  const savedTasks = [];

  // 處理 tool use 迴圈（可能存多個待辦）
  while (response.stop_reason === 'tool_use') {
    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');

    const toolResults = [];
    for (const block of toolBlocks) {
      if (block.name === 'save_todo' && block.input.task) {
        await supabase.from('xlan_todos').insert({
          text: block.input.task,
          source_message: userMessage,
        });
        savedTasks.push(block.input.task);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `已存入待辦：${block.input.task}`,
        });
      }
    }

    // 把 assistant 回應 + tool results 加入 messages，讓 Claude 繼續
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [SAVE_TODO_TOOL],
      messages,
    });
  }

  // 提取最終文字回覆
  const textBlock = response.content.find((b) => b.type === 'text');
  const reply = textBlock ? textBlock.text : '已處理完成！';

  // 存對話記錄（只存最終文字，不存 tool 中間過程）
  await supabase.from('xlan_conversations').insert([
    { user_id: userId, role: 'user', content: userMessage },
    { user_id: userId, role: 'assistant', content: reply },
  ]);

  return reply;
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

// --- 群組訊息處理 ---
async function handleGroupMessage(event) {
  const text = event.message.text;
  if (!text) return;

  const result = await judgeTask(text);
  if (result.is_task && result.task) {
    await supabase.from('xlan_todos').insert({
      text: result.task,
      source_group: event.source.groupId || 'unknown',
      source_message: text,
    });
    console.log('New task detected:', result.task);
  }
  // 群組不回覆
}

// --- 私訊處理 ---
async function handleDirectMessage(event) {
  const text = (event.message.text || '').trim();
  if (!text) return;

  const userId = event.source.userId;
  let reply;

  // 快捷指令：列出待辦（精確匹配，避免正常對話誤觸）
  if (/^(待辦|清單|有什麼事)$/.test(text)) {
    reply = await listTodos();
  }
  // 快捷指令：完成/刪除第N項
  else if (/^(完成|刪除)第(\d+)項$/.test(text)) {
    const match = text.match(/^(完成|刪除)第(\d+)項$/);
    const n = parseInt(match[2], 10);
    reply = await completeTodo(n);
  }
  // 所有其他訊息：AI 處理（自動判斷是否為待辦 + 對話）
  else {
    reply = await chatWithClaude(userId, text);
  }

  await replyMessage(event.replyToken, reply);
}

// --- Vercel Serverless Handler ---
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).send('xlan-secretary is running.');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // 取得 raw body 做簽名驗證
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
    if (event.type !== 'message' || event.message.type !== 'text') continue;

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
