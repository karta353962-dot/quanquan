// =========================================================
// 券券日記・階段三：Gemini 票券辨識（Supabase Edge Function）
// 需要的 Secrets：GEMINI_API_KEY、GEMINI_MODEL
// 選用：AI_DAILY_LIMIT（每人每天次數，預設 20）、AI_ENABLED=false 可整個關閉
// 模型名稱只從環境變數讀取；失敗時絕不自動換成其他（可能付費的）模型。
// =========================================================
// 不載入任何外部套件：啟動更快，也少一個會失敗的地方
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const log = (...a: unknown[]) => console.log('[recognize]', ...a);

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ ok: false, code, message, ...extra });

const PLATFORMS = ['yahoo', 'momo', 'pchome', 'shopee', 'line', 'other', 'unknown'];
const CATS = ['coffee', 'food', 'store', 'movie', 'gift', 'other'];

// Structured Outputs：要求 Gemini 依照這個 JSON Schema 回答
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_voucher:    { type: 'BOOLEAN', description: '圖片是否為禮券、電子票券、兌換券或訂單票券頁面' },
    title:         { type: 'STRING', description: '商品或票券名稱，照圖片上的文字' },
    platform:      { type: 'STRING', enum: PLATFORMS, description: '購買平台' },
    platform_name: { type: 'STRING', description: '圖片上看到的購買平台或發行商名稱原文' },
    category:      { type: 'STRING', enum: CATS, description: '票券分類' },
    expiry_text:   { type: 'STRING', description: '圖片上有效期限的原文' },
    expires_on:    { type: 'STRING', description: '有效期限最後一天，西元 YYYY-MM-DD' },
    expires_time:  { type: 'STRING', description: '到期時間 HH:MM，圖片沒寫就空字串' },
    value:         { type: 'STRING', description: '面額或內容' },
    order_no:      { type: 'STRING', description: '圖片上明確標示為訂單編號的文字' },
    ticket_count:  { type: 'INTEGER', description: '圖片中可見的獨立票券數量' },
    notes:         { type: 'STRING', description: '使用限制或適用門市，50 字以內' },
    uncertain:     { type: 'ARRAY', items: { type: 'STRING' }, description: '不確定的欄位名稱' },
  },
  required: ['is_voucher', 'title', 'platform', 'platform_name', 'category', 'expiry_text', 'expires_on',
             'expires_time', 'value', 'order_no', 'ticket_count', 'notes', 'uncertain'],
};

const PROMPT = `你是台灣電子禮券／即享券的資訊擷取工具。只根據圖片上「看得到」的文字填寫欄位。
規則：
1. 看不到或不確定的欄位一律填空字串，並把欄位名稱放進 uncertain。絕對不要猜測或編造，尤其是訂單編號與日期。
2. 不要輸出任何網址、兌換碼、序號、PIN 碼、QR Code 或條碼內容。
3. 日期：民國年請加 1911 換成西元；有使用期間時 expires_on 取結束日；圖片沒寫時間時 expires_time 留空，不要自行假設 23:59。
4. expiry_text 請照抄圖片上的期限原文（含「民國」等字），方便程式核對。
5. platform 只能是 yahoo、momo、pchome、shopee、line、other、unknown；看不出平台填 unknown。
6. 一律使用繁體中文。`;

// 依模型系列決定思考設定；可用 Secret GEMINI_THINKING=off 完全不送
function thinkingFor(model: string) {
  const mode = Deno.env.get('GEMINI_THINKING') ?? 'auto';
  if (mode === 'off') return null;
  if (/gemini-2\.5/i.test(model)) return { thinkingBudget: /pro/i.test(model) ? 128 : 0 };
  if (/gemini-[3-9]/i.test(model)) return { thinkingLevel: mode === 'auto' ? 'minimal' : mode };
  return null;
}

function classify(status: number, data: any) {
  const err = data?.error ?? {};
  const msg = String(err.message ?? '');
  const st = String(err.status ?? '');
  const details = JSON.stringify(err.details ?? []);
  if (status === 429) {
    // 429 不一定是額度用完：分辨「模型沒有免費額度」「每日額度用完」「每分鐘太頻繁」
    if (/limit:\s*0\b/i.test(msg)) return fail('AI_QUOTA_EXCEEDED', '這個模型目前沒有免費額度，已停止 AI 辨識', { reason: 'not_free' });
    if (/PerDay|per day|daily/i.test(details + msg)) return fail('AI_QUOTA_EXCEEDED', 'Gemini 今天的免費額度已用完', { reason: 'google_daily' });
    const retry = (details.match(/"retryDelay":"(\d+)(?:\.\d+)?s"/) ?? [])[1];
    return fail('AI_RATE_LIMITED', 'AI 使用太頻繁，請稍後再試', { retry_after: retry ? Number(retry) : 60 });
  }
  if (status === 400 && /billing|FAILED_PRECONDITION|not available.*free/i.test(msg + st))
    return fail('AI_QUOTA_EXCEEDED', '這個模型需要付費，已停止 AI 辨識', { reason: 'not_free' });
  if (status === 400 && /image|inline_data|mime|decode|unsupported/i.test(msg))
    return fail('AI_INVALID_IMAGE', '圖片無法辨識');
  if (status === 401 || status === 403) return fail('AI_SERVICE_ERROR', 'Gemini 金鑰無效或沒有權限', { reason: 'forbidden' });
  if (status === 404) return fail('AI_SERVICE_ERROR', '找不到模型，請檢查 GEMINI_MODEL', { reason: 'model_not_found' });
  if (status === 408 || status === 504) return fail('AI_TIMEOUT', 'AI 回應逾時');
  return fail('AI_SERVICE_ERROR', `Gemini 服務錯誤（${status}）`, { reason: 'upstream_' + status });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('AI_SERVICE_ERROR', 'method not allowed');
  try {
    if (Deno.env.get('AI_ENABLED') === 'false') return fail('AI_SERVICE_ERROR', 'AI 辨識目前已關閉', { reason: 'disabled' });
    const MODEL = Deno.env.get('GEMINI_MODEL');
    const KEY = Deno.env.get('GEMINI_API_KEY');
    if (!MODEL || !KEY) return fail('AI_SERVICE_ERROR', '尚未設定 GEMINI_MODEL 或 GEMINI_API_KEY', { reason: 'not_configured' });

    // 使用者驗證：只有登入的使用者可以呼叫
    const t0 = Date.now();
    const auth = req.headers.get('Authorization') ?? '';
    const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
    const sb = (path: string, init: RequestInit = {}) => fetch(SB_URL + path, {
      ...init, headers: { apikey, Authorization: auth, 'Content-Type': 'application/json' },
    });
    const who = await sb('/auth/v1/user');
    if (!who.ok) { log('auth failed', who.status); return json({ ok: false, code: 'AI_SERVICE_ERROR', message: '請先登入', reason: 'unauthorized' }, 401); }
    log('auth ok', Date.now() - t0, 'ms');

    // 圖片檢查與大小限制
    let body: any;
    try { body = await req.json(); } catch { return fail('AI_INVALID_IMAGE', '資料格式錯誤'); }
    const { image, mime } = body ?? {};
    if (typeof image !== 'string' || !image) return fail('AI_INVALID_IMAGE', '沒有收到圖片');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return fail('AI_INVALID_IMAGE', '不支援的圖片格式');
    if (image.length > 4_000_000) return fail('AI_INVALID_IMAGE', '圖片太大');

    // 免費額度保護：每人每天上限
    const limit = Number(Deno.env.get('AI_DAILY_LIMIT') ?? '20');
    const ur = await sb('/rest/v1/rpc/qq_ai_take', { method: 'POST', body: JSON.stringify({ p_limit: limit }) });
    if (!ur.ok) { log('usage failed', ur.status, await ur.text()); return fail('AI_SERVICE_ERROR', '用量紀錄失敗，請確認已執行 ai.sql', { reason: 'usage_table' }); }
    const used = await ur.json();
    if (used === -1) return fail('AI_QUOTA_EXCEEDED', `今天的 AI 辨識次數已達上限（${limit} 次）`, { reason: 'app_daily_limit' });

    // 呼叫 Gemini：票券擷取不需要深度思考，關掉／降低「思考」可以大幅縮短等待時間
    const TIMEOUT = Number(Deno.env.get('AI_TIMEOUT_MS') ?? '50000');
    const thinking = thinkingFor(MODEL);
    const started = Date.now();
    const callGemini = async (withThinking: boolean) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const generationConfig: Record<string, unknown> = { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA };
        if (withThinking && thinking) generationConfig.thinkingConfig = thinking;
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
            generationConfig,
          }),
        });
        const raw = await r.text();
        let d: any = {};
        try { d = JSON.parse(raw); } catch { /* 非 JSON */ }
        return { res: r, data: d };
      } finally { clearTimeout(timer); }
    };
    let res: Response, data: any;
    try {
      ({ res, data } = await callGemini(true));
      // 這個模型不支援思考設定 → 不帶設定再試一次（同一個模型，不會換模型）
      if (res.status === 400 && thinking && /thinking/i.test(JSON.stringify(data))) ({ res, data } = await callGemini(false));
    } catch (e) {
      return (e as Error).name === 'AbortError'
        ? fail('AI_TIMEOUT', `Gemini 超過 ${Math.round(TIMEOUT / 1000)} 秒沒有回應`, { reason: 'upstream_timeout', ms: Date.now() - started })
        : fail('AI_SERVICE_ERROR', '無法連線到 Gemini');
    }
    log('gemini', res.status, Date.now() - started, 'ms');
    if (!res.ok) { log('gemini error', JSON.stringify(data).slice(0, 500)); return classify(res.status, data); }

    const cand = data.candidates?.[0];
    if (!cand?.content) return fail('AI_INVALID_IMAGE', 'AI 無法處理這張圖片', { reason: data.promptFeedback?.blockReason ?? cand?.finishReason ?? 'no_candidate' });
    const text = (cand.content.parts ?? []).map((p: any) => p.text ?? '').join('');
    let result: any;
    try { result = JSON.parse(text); } catch { return fail('AI_SERVICE_ERROR', 'AI 回傳格式錯誤', { reason: 'bad_json' }); }
    if (result.is_voucher === false) return fail('AI_INVALID_IMAGE', '看起來不是票券圖片');

    return json({ ok: true, model: data.modelVersion ?? MODEL, at: new Date().toISOString(), used, limit, ms: Date.now() - started, result });
  } catch (e) {
    log('unexpected', e);
    return fail('AI_SERVICE_ERROR', '伺服器錯誤：' + ((e as Error)?.message ?? String(e)));
  }
});
