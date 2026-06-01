# 員工運單問題回報 Agent

這個功能接在既有的小瀾秘書 LINE Bot 裡。

## 員工怎麼用

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
```

`STAFF_REPORT_GROUP_ID` 可以先不填；若之後發現其他群組誤觸，再填指定群組 ID。

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
