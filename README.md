# GoodTrip x Herb Uncle 清邁尼曼店預約系統

Node.js 24 + Express + PostgreSQL。前台、管理後台與 API 由一個服務提供。每個時段所有預約合計最多 **12 人**，前後台皆不得超額。

## 現有功能

- 客人選擇日期、人數與時段，查詢即時空位並送出預約。
- Email 在前台與後台新增、編輯均為必填，會檢查格式及長度。
- 工作人員密碼登入後查看週行事曆、新增、修改、取消預約與重寄確認信。
- PostgreSQL 交易與時段鎖防止同時預約超額；相同送出鍵重試只建立一筆預約。
- Resend HTTPS API 寄出確認信；LINE Messaging API 通知工作群組。
- 啟動時自動執行可重複的 schema migration；健康檢查驗證資料庫連線。

## 營業規則

- 清邁時間 GMT+7，每週二公休。
- 營業 14:00–23:00；預約時段為 14:30–16:30、16:30–18:30、18:30–20:30、20:30–22:30。
- 每個時段所有組別合計上限 12 人。第一組也不能超額，後台沒有強制超額功能。
- 客人輸入超過 12 人時，顯示多人團體說明與 LINE 聯絡按鈕，由店員另行確認安排；不會建立超額預約，也不會擅自把客人填寫的人數改成 12。
- 前台只接受尚未開始的時段；後台可以補登過去時段，但仍遵守容量及週二公休。
- 座位保留 10 分鐘。遲到時由店員依現場情況處理；系統不自動取消預約。
- 已取消的預約保留在資料庫，行事曆只顯示已確認預約。

## 本機啟動

1. 安裝 Node.js 24 與 PostgreSQL 14 以上。
2. `npm ci`。
3. 複製 `.env.example` 為 `.env`，填寫 `DATABASE_URL`。
4. 執行 `npm run admin:password`，輸入至少 16 字元的密碼；把輸出的 `ADMIN_PASSWORD_HASH` 填入 `.env`，自行保管密碼。不要把密碼放進命令列參數或 Git。
5. `npm run dev`。前台 `http://localhost:3000/`，後台 `http://localhost:3000/admin`。

密碼工具在互動終端隱藏輸入；非互動模式也能從標準輸入接收密碼，只輸出雜湊。

## Railway 部署

目前以專案內的 **Dockerfile** 分階段建置。正式執行環境為固定 digest 的 Distroless Node.js 24 / Debian 13，以 UID 65532 執行，不包含 shell、npm 或 yarn；套件只在建置階段安裝。GitHub Actions 會執行 46 項測試、npm audit、實際容器建置及完整映像掃描，高風險或重大漏洞會讓檢查失敗。Railway 應設定等待 GitHub 檢查通過才部署。

1. 在 Railway 建立專案，從 `GoodTrip2017/chiangmai-booking` 建立應用服務，Root Directory 設為 repo 根目錄 `/`。
2. 同一專案與環境建立 PostgreSQL。應用與資料庫選同一區域，使用內部連線。
3. 確認服務的 Railway Config File 欄位沒有指向舊 `railway.json`。使用自動偵測到的 Dockerfile；清除舊 NIXPACKS 或開發用啟動指令覆寫。容器已設定入口與啟動命令，Start Command 請保持空白；Distroless 沒有 shell，不能填入 npm 或 shell 指令。
4. 設定應用服務 Variables：

| 變數 | 設定 |
|---|---|
| `NODE_ENV` | `production`（Dockerfile 已預設） |
| `DATABASE_URL` | 使用同環境內網的專用應用帳號；正式服務使用 `booking_app`，不要直接沿用 postgres 超級使用者 |
| `DATABASE_SSL` | Railway 內網用 `false` |
| `ADMIN_PASSWORD_HASH` | 執行密碼工具後產生的雜湊，必填 |
| `APP_ORIGIN` | 正式 HTTPS 網址，不含結尾 `/`；預設網域也可由 `RAILWAY_PUBLIC_DOMAIN` 取得 |
| `RESEND_API_KEY`、`MAIL_FROM` | 完成寄件網域驗證後啟用確認信；`MAIL_REPLY_TO` 可另設店家收信地址 |
| `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_GROUP_ID` | 啟用工作群組通知時填寫 |
| `LINE_CHANNEL_SECRET` | 啟用 LINE webhook 驗簽時填寫 |

5. Settings → Networking → Generate Domain。先產生網域或填 `APP_ORIGIN`，再確認部署啟動；正式環境缺少網站來源或有效密碼雜湊會拒絕啟動。
6. Settings → Healthcheck Path 設 `/healthz`，Timeout 設 `300` 秒。這項必須在 Railway 設定，不能只依賴 Dockerfile。
7. Restart Policy 設 `ON_FAILURE`，最多 5 次；初期一個應用實例即可。應用不需要額外 Volume；PostgreSQL 的持久儲存與備份須在資料庫服務配置。2026-09-23 使用者升級 Pro 後，已啟用每日、每週、每月原生備份（API 保留期分別 6、27、89 天），並建立第一份原生備份。另有 2026-09-14 手動備份的隔離還原演練；未對正式資料庫執行還原。
8. 部署後測試登入、12 人預約、滿額拒絕、修改、取消、重寄信、LINE 群組通知，以及重啟後資料仍存在。

正式環境必須明確設定 `DATABASE_SSL`。若用 TLS，憑證及目標名稱（包含 IP 位址）都必須驗證；請把連線網址中的 `sslmode`、`sslrootcert` 等參數移除，統一用 `DATABASE_SSL=true` 及必要的 `DATABASE_CA_CERT`，避免 pg 覆蓋設定。禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

Railway 正式環境的限流只讀取平台重寫的 `X-Real-IP`，不使用訪客可偽造的 `X-Forwarded-For`。已在真正 HTTPS 入口驗證偽造來源不能繞過預約／登入限制。不要替應用增加公開 TCP 直連入口；更换平台或增加其他代理時必須重新驗證。

### 寄信設定

本版完全移除 SMTP 依賴，使用 `https://api.resend.com/emails`。Railway Free／Trial／Hobby 不支援 SMTP；HTTPS API 不受此限制。

在 Resend 驗證自己的寄件網域後，再設定 `RESEND_API_KEY` 與 `MAIL_FROM`。建議使用專用子網域，保留官網既有 MX 記錄；`MAIL_REPLY_TO` 可設定店家的 Gmail，讓客人回覆至店家信箱。範例寄件地址或未驗證網域不能當成已完成正式寄信設定。2026-09-23 已驗證 notify.goodtrip2017.com 的專用寄信金鑰；使用正式寄件設定及應用版型寄出一封驗證信，使用者確認收到且內容正常。驗證信由本機驗證程式發出，不建立預約；不等同正式預約端到端寄信測試。

確認信重寄同一筆每分鐘最多 1 次，全站每小時最多 60 次；限制存在資料庫，重新部署不會清除。

一次寄信最多等待 8 秒。逾時或服務拒絕時，預約仍成立；後台會標示未寄出，店員可重寄。`ACCEPTED` 僅表示寄信服務已接受請求，不保證客人的信箱已收到；沒有啟用送達或退信 webhook。

| `mail_status` | 意義 |
|---|---|
| `NOT_REQUESTED` | 未要求寄信，或預約資訊變更後尚未重寄 |
| `NO_EMAIL` | 沒有 Email |
| `NOT_CONFIGURED` | 寄信服務未設定 |
| `ACCEPTED` | 寄信服務已接受 |
| `FAILED` | 逾時或寄送失敗 |

相同請求重送時，若店員已修改或取消原預約，系統會請客人聯絡確認，不會回傳修改後的個資或誤報成功。

通知結果的資料庫記錄若另外失敗，只記錄錯誤，不把已提交的預約回報成失敗。重複送出預約使用同一 `requestId`；資料內容變更時須產生新的 UUID，前後台已自動處理。

前台防灌單同一 IP 每分鐘 3 次、每天 20 次，失敗的送出也計數；IPv6 以 /56 合併。限制由資料庫原子操作執行，重新啟動或多實例共用計數。這無法單獨阻止大量不同網段的分散式灌單。

### 後台保護

- 固定使用 `/admin` 登入，不再接受 `?token=` 或 `X-Admin-Token`。
- 密碼以 scrypt（N=16384、r=8、p=5）與獨立 salt 保存；符合 OWASP 列出的低記憶體參數組合。舊版 `scrypt:salt:hash` 格式不再接受，部署前必須重新執行密碼工具。密碼更換後既有登入立即失效。
- 登入狀態保存於 PostgreSQL，Cookie 使用 HttpOnly、SameSite=Strict；正式 HTTPS 使用 Secure 與 `__Host-` 名稱，8 小時到期。
- 登入限制保存於資料庫：同一 IP 每 15 分鐘最多 5 次，全站每 15 分鐘最多 60 次；IPv6 以 /56 網段合併計算，每個服務同時最多執行 2 次密碼驗證。
- 修改資料與登出均要求同源 JSON 請求及 CSRF 驗證，也拒絕跨站 Fetch Metadata；後台頁面和 API 不快取（包含大小寫路徑）。
- 管理頁不再放在公開靜態目錄；`/admin.html` 會回到受保護的入口。
- 安全標頭限制腳本來源、嵌入與 referrer；前端腳本已拆到獨立檔案。
- 密碼遺失時，重新執行工具生成新雜湊並更新環境變數、重新部署。這是共用工作人員登入，尚未提供個別帳號、個人操作稽核或多因素驗證。

## 既有資料升級

Migration 保留舊資料，不自動取消或縮減人數。舊時段如果超過 12 人，後台會顯示「舊資料超過上限，請調整」，不允許再新增；店員仍可取消預約或調整到符合上限的時段。單筆資料庫人數限制對新增及修改生效，已取消紀錄可保留舊人數。

舊資料如果沒有 Email 仍會保留；店員編輯儲存時必須補上 Email，取消操作不要求補填。

新增 `mail_status`、`request_key`、`request_hash`、登入資料表及 `request_limits` 限流資料表。正式升級前應先備份。原 Google Sheets 或 Calendar 的既有預約不會自動匯入。

## 測試

相依套件已更新，並透過 `overrides` 將 `qs` 升至已修補的 6.16 以上版本（Express 4.22.2 原本限制在有漏洞的 6.15 系列）。後續更新 Express 時應重新檢查是否仍需此覆寫。修補依據：[qs 安全公告](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)。

- `npm test`：日期、表單、12 人容量、輸入安全、寄信與密碼雜湊檢查。
- `TEST_DATABASE_URL=... npm run test:integration`：在指定 PostgreSQL 建立隨機獨立 schema，測完清除該 schema；不清空既有資料表。涵蓋遷移、登入、CSRF、容量、20 筆同時預約、重複送出與改期。
- `TEST_DATABASE_URL=... npm run test:security`：22 組安全案例，涵蓋所有後台操作的權限／CSRF、注入、資料外洩、真實程序重啟／多實例、LINE 驗簽與異常資料、TLS 憑證及名稱驗證。TLS 測試另需系統 `openssl` 指令。
- `TEST_DATABASE_URL=... npm run test:all`：一次執行所有 46 組測試。測試只建立隨機獨立 schema，仍建議使用專用測試資料庫；需要允許 localhost 監聽與子程序。
- `npm audit --omit=dev`：查詢鎖定套件的最新已知漏洞。
- 測試不寄送 Email 或 LINE 訊息。完整實際送達仍需在正式憑證配置後驗證。安全測試結果及未驗項目請見 [安全性檢測報告](安全性檢測報告.md)。

## 尚未提供的功能

臨時公休管理、報到與自動取消、LINE 一對一預約及前一天提醒、Google Calendar 同步、舊資料匯入。現有 webhook 僅驗簽及檢查事件格式，不記錄訊息或群組 ID；工作群組 ID 需在 LINE 整合設定流程取得。群組通知與私訊功能應分開理解。

## 官方參考

- [Railway Dockerfile 建置](https://docs.railway.com/builds/dockerfiles)
- [Railway 舊設定檔淘汰與新設定方式](https://docs.railway.com/infrastructure-as-code)
- [Railway Email 連線限制](https://docs.railway.com/networking/outbound-networking)
- [Railway 健康檢查](https://docs.railway.com/deployments/healthchecks)
- [Resend 寄信 API](https://resend.com/docs/api-reference/emails/send-email)
- [Resend 網域驗證](https://resend.com/docs/dashboard/domains/introduction)

Railway 正式環境會以平台提供的 `X-Real-IP` 計算預約與登入限制，不信任訪客可自行填寫的 `X-Forwarded-For`。辨識依據為 `NODE_ENV=production` 與 Railway 自動提供的 `RAILWAY_ENVIRONMENT_ID`。請勿增加可繞過 Railway HTTPS 邊緣的公開 TCP 入口。

### 執行環境維護

映像固定 digest 以便重現；更新 Node.js 或 Distroless 時要修改 Dockerfile、重新掃描並確認健康檢查成功。Distroless 沒有 shell，所以 Railway SSH 的互動 shell 不適用；查看日誌、健康檢查或建立隔離的診斷環境，不要為方便而改用 root/debug 正式映像。應用帳號擁有自己的四張表與 schema 建表權以執行 migration，但沒有超級使用者、建資料庫、建角色或複製權限。
