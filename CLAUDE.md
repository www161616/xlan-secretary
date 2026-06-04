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
- `GOOGLE_VISION_API_KEY` — 員工回報運單 OCR
- `STAFF_REPORT_SPREADSHEET_ID` / `STAFF_REPORT_IMAGE_FOLDER_ID` / `STAFF_REPORT_SHEET_NAME` / `STAFF_REPORT_ORDER_SHEET_NAME` / `STAFF_REPORT_GROUP_ID`
- `STAFF_LIFF_ID` — 員工回報 LIFF 表單的 LIFF ID（選填）
- `STAFF_LIFF_CHANNEL_ID` — LIFF 所屬 LINE Login channel ID（選填，驗身分用）

## 檔案結構

```
xlan-secretary/
├── api/
│   ├── webhook.js        # LINE Webhook 主邏輯
│   ├── reminder.js       # 每日定期付款提醒 Cron Job
│   ├── staff-report.js   # 總倉回報 LIFF 表單後端（POST /api/staff-report）
│   └── oauth.js          # 重發 Google refresh token（GET /api/oauth，存進 Supabase）
├── index.html            # 網頁儀表板（LIFF 手機版）
├── staff.html            # 總倉回報手機表單（LIFF：未到貨/有到貨兩條路）
├── setup-db.sql          # Supabase 建表語法
├── get-token.js          # Google OAuth Token 取得工具（一次性）
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
| `xlan_vendors` | 廠商資料 |
| `xlan_projects` | 專案管理（status: active/completed） |
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
7. **記帳 Flex Message** — 記帳完成回傳彩色卡片（紅=支出、綠=收入）；刪除記帳會「刪完再查一次」驗證真的不見了，並偵測「同類別＋金額＋收支＋帳戶＋備註」的重複，主動提醒「還有 N 筆一樣的」，回「刪掉重複」可一次清掉（10 分鐘內有效）；「清空今天記帳／清空本週記帳／清空本月記帳」會先回報筆數與合計、回「確定清空」才真的批次刪除（兩段式確認，5 分鐘內有效）
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
21. **廠商管理** — save_vendor / get_vendor tools
22. **專案管理** — create_project（自動拆分工作項目到 xlan_todos）/ get_project_status（進度條）
23. **Bug 清單查詢** — get_pending_bugs tool
24. **付款清單查詢** — get_pending_payables tool
25. **月底財務總結** — 每月最後一天 21 點自動推送（公司帳/私人帳/完成待辦/修復 Bug）
26. **常用連結記憶** — 丟連結（含標籤如「匯洲 https://…」）自動分類存成 `網址` 標籤筆記；問「給我匯洲的網址」「匯洲連結」會撈出**所有**匹配連結（去重後列出）；「我的連結／所有網址」列出全部常用連結。查詢時自動濾除「給我／幫我／我要」等贅詞，並做忽略空白的關鍵字比對
27. **部署清單** — `save_deployment` / `get_deployment` tools，記每台機器人/系統的部署位置與方式（平台、程式碼位置、部署/修改方式、網址、備註），存成 `部署` 標籤筆記。說「記部署 小瀾 …」會記下（同名自動更新覆蓋）；問「小瀾部署在哪」「匯洲怎麼改」回該台完整資訊；「我的部署／所有機器人」列出全部
28. **員工運單回報（群組 `#回報`）** — 運單照片 OCR + 問題回報寫入 Google Sheet `員工問題回報`。問題類型支援少貨/破損/錯貨/多貨/**未到貨**（`未到貨`/`沒到貨`/`整箱沒到`/`位到貨` 等，數量可省略）。員工口語亂打（如「他沒有到 不是少不是破」）regex 接不住時，**在回報流程中**用 Haiku AI 判斷類型，真看不出記「其他」並照寫原話。支援**一次貼多個運單號各建一列**（共用同一問題）；**未到貨只要有運單號就免拍照**。詳見 `STAFF_REPORT_AGENT.md`
29. **總倉回報 LIFF 表單**（原稱員工回報，UI 一律用「總倉/小瀾」不用「員工/主管」）— 群組 `#回報` 卡片有「📋 開回報表單」按鈕，開 `staff.html` 手機表單。第一頁問**「貨到了嗎」**:**未到貨**只填運單號（可多筆）送出;**有到貨**走步驟2 運單（掃碼 `liff.scanCodeV2` / 拍運單照片 OCR / 手打）+ 步驟3 問題照片（多張）+ 自由描述框，描述丟 Haiku 自動判類型。走 `POST /api/staff-report`，每個運單號各寫一列。Google 授權失效就開 `/api/oauth` 重發 token（存進 Supabase `xlan_kv.google_refresh_token`，即時生效免改 Vercel）。注意 Vercel「Sensitive」環境變數 function 讀不到，Sheet/資料夾/LIFF ID 已寫死後備值。設定見 `STAFF_REPORT_AGENT.md`

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
| `save_deployment` | 記錄/更新機器人部署資訊（同名覆蓋） |
| `get_deployment` | 查詢機器人部署資訊（keyword 留空列全部） |
| `save_recurring` | 儲存定期付款提醒 |
| `set_reminder` | 設定自訂每日提醒時間 |
| `save_bug` | 記錄系統 bug |
| `fix_bug` | 標記 bug 已修復 |
| `get_priority_todos` | 依優先度排序待辦清單 |
| `save_shipment` | 記錄陸貨到貨追蹤 |
| `arrive_shipment` | 標記貨物已到貨 |
| `get_shipments` | 查詢陸貨追蹤狀態 |
| `save_payable` | 記錄應付款項 |
| `save_vendor` | 儲存廠商資料 |
| `get_vendor` | 查詢廠商資料 |
| `create_project` | 建立專案 + 自動拆分工作項目 |
| `get_project_status` | 查詢專案進度 |
| `get_pending_bugs` | 查詢待修 bug 清單 |
| `get_pending_payables` | 查詢待付款清單 |

## 待辦功能

- [ ] Rich Menu 底部導航列設定
- [ ] 系統提示詞加「帳號密碼不要存筆記」規則

## 注意事項

- Vercel Cron Jobs 需要 Pro 方案才會自動觸發
- `get-token.js` 是一次性工具，不需要部署
- Google Calendar refresh token 有效期長，但如果失效需重新執行 get-token.js
- 所有 Supabase 表的 RLS 是全開的（anon 可讀寫），因為 Bot 用 anon key 連線
