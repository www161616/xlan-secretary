# 員工運單問題回報 Agent

這個功能接在既有的小瀾秘書 LINE Bot 裡。

> 用詞：UI 一律用「總倉／小瀾」，不要「員工／主管」。但 Sheet 分頁名稱仍是 `員工問題回報`、欄位標題仍含「員工」（資料結構，別改否則寫錯分頁）。

## 最推薦：總倉回報 LIFF 表單（`staff.html`）

群組 `#回報` 卡片有 **「📋 開回報表單」**，點了開手機表單。第一頁先問 **「貨到了嗎？」**：

- **🚫 未到貨**：只出現一個框填運單號（可多筆）→ 送出。
- **✅ 有到貨**：
  - 步驟2 運單號：`📷 掃運單條碼`（`liff.scanCodeV2`）／`🖼 拍運單照片`（後端 Vision OCR 讀號）／手打（可多筆）
  - 步驟3 問題商品照片（可多張，壓到 1024px/JPEG 0.6）
  - 自由描述框（例「粉色少3、白色少2」）→ 後端丟 Haiku 自動判類型

送出走 `POST /api/staff-report`，**每個運單號各寫一列**;運單照片、問題照片分欄，描述原話寫進「員工文字」欄。

### 安裝設定（一次性）

1. LINE Login channel 新增 LIFF app：Endpoint `https://xlan-secretary-rqhb.vercel.app/staff.html`、Size `Full`、開 **Scan QR**。把 LIFF ID 設給 `STAFF_LIFF_ID`（或 `staff.html` 的 `FALLBACK_LIFF_ID` 後備常數）。
2. （選填）`STAFF_LIFF_CHANNEL_ID` 設了會驗 idToken。
3. **Google 授權失效時**（送出回 `invalid_grant`）：開 `https://xlan-secretary-rqhb.vercel.app/api/oauth` 用香奈的 Google 登入授權，新 token 會自動存進 Supabase `xlan_kv.google_refresh_token`，即時生效、不用改 Vercel。
4. ⚠️ Vercel「Sensitive」環境變數 function 讀不到（見 CLAUDE.md／記憶），所以 Sheet ID／資料夾 ID／LIFF ID 已在 `api/staff-report.js` 寫死後備值。

## 聊天版 `#回報`（仍保留）

建議在群組裡照這樣做：

```text
1. 傳運單照片
2. 傳破損/少貨照片
3. 傳：少3 / 破2 / 錯1
```

如果先打文字，群組請加「回報」避免誤判一般聊天：

```text
回報 少3
```

私訊小瀾時可以直接：

```text
少3
```

支援文字：

- `少3`、`少貨3`、`短少3`
- `破2`、`破損2`
- `錯1`、`錯貨1`
- `多1`、`多貨1`
- `未到貨`、`沒到貨`、`整箱沒到`、`位到貨`（整筆沒到，數量可省略，預設 1）

### 看不懂也沒關係（AI 補刀）

員工常常不照格式打字。如果上面的關鍵字都對不上（例如「他沒有到 不是少不是破」「整箱都沒收到」），小瀾會在「已經進入 `#回報` 流程」時，把這句話丟給 AI 判斷是少貨/破損/錯貨/多貨/未到貨/其他，盡量接住。

- 只有在回報流程中才會用 AI，不會亂花 token、也不會劫持一般聊天。
- 真的看不出類型就記成「其他」，原話照寫進 Sheet，讓主管自己判讀。

### 一次回報多筆運單

員工可以一次貼多個運單號（換行或空白分隔），例如：

```text
#回報
465318757396717
435160949819079
JT3162111794106
以上3筆都沒到貨
```

小瀾會在 Google Sheet 建立 **3 列**，每列共用同一個問題（未到貨）。

### 未到貨免拍照

「未到貨」通常沒有東西可拍。只要員工已經打了運單號（或拍了運單照片），小瀾就不會再卡著要問題照片，直接建立回報。其他類型（少貨/破損/錯貨/多貨）仍建議附問題照片當證據。

## 系統會做什麼

湊齊「問題文字 + 至少兩張圖片」後：

1. 下載 LINE 圖片
2. 用 Google Vision OCR 辨識運單號
3. 到 Google Sheet 的 `所有訂單` 分頁用 D 欄運單號查資料
4. 寫入 `員工問題回報` 分頁
5. 回覆員工建立成功，或要求重拍運單

## Vercel 環境變數

既有小瀾秘書環境變數保留，再新增：

```text
GOOGLE_VISION_API_KEY=Google Cloud Vision API key
STAFF_REPORT_SPREADSHEET_ID=陸貨主表 ID
STAFF_REPORT_IMAGE_FOLDER_ID=Google Drive 存照片的資料夾 ID
STAFF_REPORT_SHEET_NAME=員工問題回報
STAFF_REPORT_ORDER_SHEET_NAME=所有訂單
STAFF_REPORT_GROUP_ID=指定員工回報群組 ID（選填）
STAFF_LIFF_ID=員工回報表單的 LIFF ID（設了卡片才會出現「開回報表單」）
STAFF_LIFF_CHANNEL_ID=LIFF 所屬 LINE Login channel ID（選填，設了會驗證員工身分）
```

`STAFF_REPORT_GROUP_ID` 可以先不填；若之後發現其他群組誤觸，再填指定群組 ID。
`STAFF_LIFF_ID` 不填時，聊天版 `#回報` 照常可用，只是卡片不會有表單按鈕。

## 權限注意

這版用既有 Google OAuth refresh token 操作 Google Sheets / Drive。

如果部署後出現 Google 權限錯誤，代表當初授權的 refresh token 可能只有 Calendar scope，需要重新產生包含以下權限的 token：

```text
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/calendar
```

Google Vision OCR 另外使用 `GOOGLE_VISION_API_KEY`。

## 寫入欄位

`員工問題回報` 會自動建立，欄位：

```text
回報時間、員工、LINE來源、運單號、1688訂單號、商品編號、商品名稱、
原訂數量、用途、問題類型、問題數量、員工文字、運單照片、問題照片、
狀態、備註、所有訂單列號、Offer ID
```
