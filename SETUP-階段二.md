# 階段二設定步驟（約 10 分鐘）

## 1. 建立資料表（Supabase）
1. Supabase 後台左側 **SQL Editor** → **New query**
2. 打開 `supabase/schema.sql`，全部複製貼上 → **Run**
3. 出現 `Success. No rows returned` 就完成了（可以重複執行，不會刪資料）

## 2. 設定登入（Supabase）
1. **Authentication → URL Configuration**
   - Site URL：`https://karta353962-dot.github.io/quanquan/`
   - Redirect URLs 加入同一個網址
2. **Authentication → Emails → Templates → Magic Link**（或 Sign in / OTP 範本）
   在信件內容加入一行：`你的驗證碼：{{ .Token }}`
   → 這樣信裡才會有 6 位數驗證碼。iPhone 主畫面 App 請用驗證碼登入，不要點連結。

## 3. 填寫 config.js
1. Supabase 後台上方按 **Connect**（或 Settings → Data API），複製 **Project URL**
2. Settings → **API Keys** → 複製 **Publishable key**（`sb_publishable_` 開頭）
3. 填進 `config.js`：
   ```js
   supabaseUrl: 'https://你的專案代碼.supabase.co',
   supabaseKey: 'sb_publishable_……',
   ```
⚠️ 絕對不要放 `sb_secret_` 開頭的 Secret key。

## 4. 上傳到 GitHub
把這個資料夾的檔案全部上傳到 `quanquan` repository 根目錄（覆蓋舊的 index.html），
等 1～2 分鐘 GitHub Pages 更新完成。

## 5. 測試
1. 打開網站 → 點頁首的狀態標籤 → 輸入 Email → 收驗證碼 → 登入
2. 狀態顯示「已同步」即完成
3. 用電腦打開同一個網址、登入同一個 Email，確認票券和圖片都出現

## 注意
- Supabase 內建寄信服務額度很低（每小時只能寄少量信），只適合個人使用；寄不出去時請稍等再試。
- Google 登入需要另外在 Google Cloud 建立 OAuth 用戶端，之後要用再設定，設定好把 `googleLogin` 改成 `true`。
- 免費專案一段時間沒使用可能被暫停；暫停期間 App 仍可離線使用，恢復後會自動補上傳。
