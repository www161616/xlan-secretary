// 一鍵重發 Google Refresh Token（取代一次性的 get-token.js）
// 用 Vercel 既有的 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，授權後把 refresh token 顯示出來。
// 需在 Google Cloud Console 的 OAuth 用戶端「已授權的重新導向 URI」加入本檔算出的 REDIRECT_URI：
//   Vercel（預設）：https://xlan-secretary-rqhb.vercel.app/api/oauth
//   NAS（設了 PUBLIC_BASE_URL 後）：<PUBLIC_BASE_URL>/api/oauth ← 記得也去 Google Console 加這條
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// 對外網址可設定化（搬 NAS 用）：有設 PUBLIC_BASE_URL 就用它組重導 URI，
// 沒設則 fallback 回原本寫死的 Vercel 網址，確保 Vercel 上行為完全不變。
// 去掉結尾斜線避免組出 https://host//api/oauth。
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const REDIRECT_URI = PUBLIC_BASE_URL
  ? `${PUBLIC_BASE_URL}/api/oauth`
  : 'https://xlan-secretary-rqhb.vercel.app/api/oauth';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY) ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

async function storeRefreshToken(rt) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('xlan_kv').upsert({ key: 'google_refresh_token', value: rt });
    return !error;
  } catch {
    return false;
  }
}
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

function page(title, bodyHtml) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;max-width:620px;margin:32px auto;padding:0 18px;color:#1F2937;background:#FFFBEB;line-height:1.6}
h2{color:#92400E}a.btn{display:inline-block;background:#F59E0B;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:800;font-size:18px}
textarea{width:100%;height:130px;font-size:13px;border:2px solid #FCD34D;border-radius:10px;padding:10px;background:#fff}
code{background:#FEF3C7;padding:2px 6px;border-radius:6px}.muted{color:#6B7280;font-size:14px}</style></head><body>${bodyHtml}</body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.status(500).send(page('設定缺失', '<h2>⚠️ 缺 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET</h2>'));
    return;
  }
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const url = new URL(req.url, 'https://placeholder.local');
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');

  if (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(page('授權取消', `<h2>授權沒有完成</h2><p>Google 回傳：<code>${err}</code></p><p><a class="btn" href="/api/oauth">再試一次</a></p>`));
    return;
  }

  if (!code) {
    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      include_granted_scopes: true,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(page('重發 Google 鑰匙', `
      <h2>🔑 重發 Google 授權鑰匙</h2>
      <p>按下面按鈕，用<b>香奈本人的 Google 帳號</b>登入並同意權限（行事曆／試算表／雲端硬碟）。</p>
      <p><a class="btn" href="${authUrl}">用 Google 登入授權</a></p>
      <p class="muted">授權後會出現一串新鑰匙，照畫面指示貼到 Vercel 就好。</p>`));
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    const rt = tokens.refresh_token;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!rt) {
      res.status(200).send(page('沒拿到 refresh token', `
        <h2>⚠️ 這次沒有拿到 refresh token</h2>
        <p>通常是因為這個帳號之前已經授權過。請到 <a href="https://myaccount.google.com/permissions" target="_blank">Google 帳號的第三方存取</a> 移除這個 App 的授權，再回來 <a href="/api/oauth">重試一次</a>。</p>`));
      return;
    }
    const stored = await storeRefreshToken(rt);
    const storedMsg = stored
      ? '<p style="color:#16A34A;font-weight:700">✅ 已自動存進系統，不用再貼到 Vercel、也不用重新部署，馬上就生效！</p>'
      : '<p style="color:#DC2626">⚠️ 自動存檔失敗，請改用下面手動方式：把整串貼到 Vercel 的 <code>GOOGLE_REFRESH_TOKEN</code> 覆蓋舊值、存檔後重新部署。</p>';
    res.status(200).send(page('新鑰匙', `
      <h2>✅ 授權成功！</h2>
      ${storedMsg}
      <details><summary class="muted">（備用）手動貼到 Vercel 用的鑰匙</summary>
      <textarea readonly onclick="this.select()">${rt}</textarea></details>
      <p class="muted">完成了，這個頁面可以關了。回去跟小瀾說一聲。</p>`));
  } catch (e) {
    const detail = e?.response?.data?.error_description || e?.response?.data?.error || e?.message || String(e);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(500).send(page('交換失敗', `<h2>交換鑰匙失敗</h2><p><code>${detail}</code></p>
      <p class="muted">最常見原因：Google Console 的「已授權重新導向 URI」還沒加入 <code>${REDIRECT_URI}</code>。加好後 <a href="/api/oauth">重試</a>。</p>`));
  }
};
