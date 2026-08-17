# GoodTrip 清邁店 線上預約系統

Node.js + Express + PostgreSQL。前台繁體中文預約頁 + 工作人員週行事曆後台，
自動寄確認信，並預留 LINE Bot webhook。（由原 Google Apps Script 版重寫）

## 架構

```
src/
  config.js              全域設定 CONFIG、時段 SLOTS（營業規則只改這裡）
  server.js              Express 進入點、路由掛載、啟動時自動跑 migration
  util/datetime.js       清邁時間（GMT+7）日期工具、中文格式化
  db/
    index.js             pg 連線池
    schema.sql           bookings 資料表（idempotent）
    migrate.js           執行 schema.sql
  services/
    availability.js      空位查詢、容量規則（後端唯一權威）
    booking.js           建立／修改／取消預約（advisory lock 防超賣）
    mailer.js            確認信（nodemailer；SMTP 未設定則跳過不寄）
    admin.js             後台週行事曆資料
  routes/
    public.js            GET /api/config、GET /api/availability、POST /api/bookings
    admin.js             /api/admin/*（需 X-Admin-Token）
    line.js              POST /webhook/line（LINE Bot 骨架，之後串接）
public/
  index.html             前台預約頁（/）
  admin.html             後台週行事曆（/admin?token=<ADMIN_TOKEN>）
```

## 營業規則（`src/config.js`）

- 時區 GMT+7；每週二公休；營業 14:00–23:00。
- 時段：`14:30-16:30`、`16:30-18:30`、`18:30-20:30`、`20:30-22:30`。
- 人數規則：該時段**第一組**不限人數（可包場）；**一旦有第 2 組**，該時段所有人加總不得超過 **12 人**。
- 座位保留 10 分鐘，確認信中的逾時時間 = 時段開始 + 10 分鐘（自動計算）。
- 前台只能預約未來時段；後台可補登過去（`allowPast`）。
- 防超賣：同一 (date, slot) 的寫入用 PostgreSQL advisory lock 互斥，容量判定與寫入在同一交易內。

## 本機開發

```bash
npm install
cp .env.example .env      # 填 DATABASE_URL、ADMIN_TOKEN，SMTP 可先留空
npm run dev               # 啟動時自動建表
```

- 前台：http://localhost:3000/
- 後台：http://localhost:3000/admin?token=<ADMIN_TOKEN>

## 部署到 Railway

1. 這個 repo push 到 GitHub 後，在 Railway 專案裡 **New → GitHub Repo** 選 `chiangmai-booking`。
2. 同專案 **New → Database → PostgreSQL**（或共用現有的 Postgres 服務）。
3. 在 app service 的 **Variables** 設定：
   - `DATABASE_URL`：引用 Postgres 服務的 `${{Postgres.DATABASE_URL}}`
   - `DATABASE_SSL`：走 Railway 內網（`postgres.railway.internal`）設 `false`；用對外 proxy 連線設 `true`
   - `ADMIN_TOKEN`：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` 產一組
   - SMTP 五個變數（要寄確認信才需要；Gmail 用應用程式密碼）
4. Deploy 後 Railway 會用 `railway.json` 的設定啟動（healthcheck `/healthz`）。
5. Settings → Networking → **Generate Domain** 取得對外網址。

後台網址（等同密碼，只給工作人員）：`https://<網域>/admin?token=<ADMIN_TOKEN>`

## 資料表 `bookings`

`id | created_at | source | name | pax | date | slot | first_time | line | email | referral | status | note | line_user_id`

- `source`：`WEB`（客人自己線上訂）／`WALK_IN`／`LINE`／`PHONE`
- `status`：`CONFIRMED`／`CANCELLED`（取消是軟刪除，紀錄保留）
- `note` 標記：`[MAIL_FAILED]` 信沒寄成功、`[FORCE ...]` 店員強制超額安排。後台會標紅。
- `line_user_id`：預留給之後 LINE Bot 綁定用。

## LINE Bot（之後再做）

webhook 骨架在 `src/routes/line.js`，簽名驗證已寫好：

1. LINE Developers 建 Messaging API channel，webhook URL 填 `https://<網域>/webhook/line`。
2. 環境變數加 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`。
3. 在 `handleEvent()` 實作查空位、快速預約、前一天提醒等功能。

## 與舊版（Apps Script）的差異

- 資料改存 PostgreSQL（原 Google Sheets）。
- Google Calendar 同步未搬過來（Apps Script 專屬）；之後需要可用 Google Service Account + Calendar API 加回。
- 確認信改用 SMTP（nodemailer），未設定 SMTP 時預約照常成立、只是不寄信。
- 其餘商業邏輯、前後台 UI、確認信文案完全沿用。
