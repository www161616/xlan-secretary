# CLAUDE.md

# 小瀾秘書 LINE Bot

香奈的個人 AI 秘書，透過 LINE 私訊/群組互動，自動記錄待辦、記帳、建行程、做筆記。

## 技術架構

- **Runtime**: Node.js (Vercel Serverless Function)
- **部署**: Vercel
- **資料庫**: Supabase (PostgreSQL + REST API)
- **LINE**: Messaging API + LIFF SDK
- **AI**: Anthropic Claude API (Sonnet 4.6 對話 / Haiku 4.5 群組判斷)
- **行事曆**: Google Calendar API (OAuth2 refresh token)

## 部署

- **Vercel**: https://xlan-secretary-rqhb.vercel.app
- **GitHub**: github.com/www161616/xlan-secretary
- **LIFF ID**: 2009806013-ON2KtCsF
- **Webhook URL**: https://xlan-secretary-rqhb.vercel.app/webhook

## 環境變數（Vercel 設定）

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_REFRESH_TOKEN`

## 檔案結構

```
xlan-secretary/
├── api/
│   ├── webhook.js       # LINE Webhook 主邏輯
│   └── reminder.js      # 每日定期付款提醒 Cron Job
├── index.html           # 網頁儀表板（LIFF 手機版）
├── setup-db.sql         # Supabase 建表語法
├── get-token.js         # Google OAuth Token 取得工具（一次性）
├── package.json
├── vercel.json
└── .gitignore
```

## Supabase 資料表

| 表名 | 用途 |
|------|------|
| `xlan_todos` | 待辦事項 |
| `xlan_conversations` | AI 對話記錄 |
| `xlan_expenses` | 記帳（含 account: personal/business） |
| `xlan_notes` | 筆記 |
| `xlan_events` | 行程快取（同步 Google Calendar） |
| `xlan_recurring` | 定期付款提醒 |
| `xlan_shipments` | 陸貨到貨追蹤（status: pending/arrived） |
| `xlan_payables` | 應付款追蹤（status: pending/paid） |
| `xlan_bugs` | Bug 追蹤（status: pending/fixed） |
| `xlan_kv` | KV 設定（存 owner_line_id 等） |

所有表皆啟用 RLS，Policy 為 anon/authenticated 全開（Bot 用 anon key）。

## 已完成功能

### LINE Bot（api/webhook.js）

1. **私訊 AI 對話** — Claude Sonnet 4.6，帶最近 20 則歷史記錄
2. **自動判斷待辦** — Claude tool use `save_todo`，偵測到需要做的事自動存入
3. **Google Calendar 行程** — `create_calendar_event` tool，有時間加 30 分鐘前 popup 提醒，同步寫入 xlan_events
4. **群組靜默監控** — 群組訊息用 Haiku 判斷是否為待辦，存入但不回覆
5. **群組 @ 主動回應** — 被 @ 時分析 quote 原文或整則訊息，支援 tool use
6. **記帳** — `save_expense` tool，自動分類（餐飲/交通/購物等），支援 personal/business 分帳
7. **記帳 Flex Message** — 記帳完成回傳彩色卡片（紅=支出、綠=收入）
8. **圖片記帳** — 下載 LINE 圖片 → Claude vision 判讀 → 自動存帳 + 📷 標籤
9. **收支查詢** — `get_expenses` tool，支援 today/this_week/this_month
10. **筆記** — `save_note` tool，自動加標籤
11. **查詢筆記** — `get_notes` tool，支援關鍵字 ilike 搜尋
12. **定期付款** — `save_recurring` tool，支援 monthly/yearly
13. **Owner ID 自動儲存** — 首次私訊 upsert owner_line_id 到 xlan_kv
14. **待辦快捷指令** — 「待辦」「清單」「完成第N項」精確匹配
15. **自訂提醒** — `set_reminder` tool，設定每日自訂提醒時間存入 xlan_kv
16. **Bug 追蹤** — `save_bug` / `fix_bug` tools，記錄和標記修復系統 bug
17. **優先待辦** — `get_priority_todos` tool，依 urgent/important/normal 排序
18. **待辦優先度** — save_todo 加 priority + source_person 欄位
19. **陸貨追蹤** — save_shipment / arrive_shipment / get_shipments tools
20. **應付款** — save_payable tool，付款後自動存入 xlan_expenses

### 每小時提醒系統（api/reminder.js）

- Vercel Cron Job，每小時執行一次（`0 * * * *`）
- **9 點早安摘要**：今日行程 + 待辦（前 5 筆）+ 定期付款（3 天內到期）
- **行程提前提醒**：每小時檢查 30~90 分鐘後的行程，推送提醒
- **行程完成追蹤**：行程結束後 60~90 分鐘推送追蹤（「辦完了嗎？」）
- **自訂提醒**：從 xlan_kv `custom_reminders` 讀取設定，支援下午提醒/晚間總結
- LINE Push Message 主動通知 owner

### 網頁儀表板（index.html）

- LIFF SDK 整合，顯示 LINE 用戶名稱
- 手機優先設計，底部固定導航列
- 明亮可愛風配色（淡紫主題）
- 5 個頁面：待辦 / 記事 / 帳務 / 行程 / 定期付款
- 帳務支援私人/公司切換、月份選擇、CSV 匯出
- 行程依日期分組顯示
- 定期付款顯示下次到期日

## Claude Tool Use 清單

| Tool | 用途 |
|------|------|
| `save_todo` | 儲存待辦事項 |
| `create_calendar_event` | 建立 Google Calendar 行程 |
| `save_expense` | 記錄收入/支出 |
| `get_expenses` | 查詢收支記錄 |
| `save_note` | 儲存筆記 |
| `get_notes` | 查詢筆記 |
| `save_recurring` | 儲存定期付款提醒 |
| `set_reminder` | 設定自訂每日提醒時間 |
| `save_bug` | 記錄系統 bug |
| `fix_bug` | 標記 bug 已修復 |
| `get_priority_todos` | 依優先度排序待辦清單 |
| `save_shipment` | 記錄陸貨到貨追蹤 |
| `arrive_shipment` | 標記貨物已到貨 |
| `get_shipments` | 查詢陸貨追蹤狀態 |
| `save_payable` | 記錄應付款項 |

## 待辦功能

- [ ] Rich Menu 底部導航列設定
- [ ] 系統提示詞加「帳號密碼不要存筆記」規則

## 注意事項

- Vercel Cron Jobs 需要 Pro 方案才會自動觸發
- `get-token.js` 是一次性工具，不需要部署
- Google Calendar refresh token 有效期長，但如果失效需重新執行 get-token.js
- 所有 Supabase 表的 RLS 是全開的（anon 可讀寫），因為 Bot 用 anon key 連線
