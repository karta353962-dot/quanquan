'use strict';
/* =========================================================
   券券日記・階段三：票券辨識
   - 先算圖片 SHA-256，有快取就直接用，不重複消耗 AI 額度
   - AI（Gemini，經 Edge Function）→ 失敗時降級本機 OCR → 再不行就手動
   - 送 AI 前可以用方框遮住 QR Code、條碼、兌換碼
   - 民國年日期解析、所有辨識結果都要使用者確認後才儲存
   ========================================================= */
(function () {
  const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  const OCR_ENGINE = 'ocr:tesseract5-chi_tra+eng';
  const AI_MSG = {
    AI_QUOTA_EXCEEDED: '今天的免費 AI 額度用完了',
    AI_RATE_LIMITED: 'AI 使用太頻繁，請稍等一下',
    AI_SERVICE_ERROR: 'AI 服務暫時無法使用',
    AI_TIMEOUT: 'AI 回應逾時',
    AI_INVALID_IMAGE: '這張圖片看不出票券內容',
  };

  /* ---------- 日期解析（支援民國年） ---------- */
  function toHalf(s) {
    return String(s || '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[／]/g, '/').replace(/[．。]/g, '.').replace(/[：]/g, ':').replace(/[－—–]/g, '-').replace(/[～〜]/g, '~');
  }
  function ymd(y, m, d) {
    if (!(y >= 2000 && y <= 2100) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function findDates(text) {
    const t = toHalf(text);
    const out = [];
    const re = /(中華民國|民國)?\s*(\d{2,4})\s*(?:年|[\/.\-])\s*(\d{1,2})\s*(?:月|[\/.\-])\s*(\d{1,2})\s*日?(?:\s*[（(]?[一二三四五六日]?[)）]?\s*(\d{1,2}):(\d{2}))?/g;
    let m;
    while ((m = re.exec(t))) {
      let y = +m[2];
      const roc = !!m[1] || (y >= 100 && y <= 200) || (!!m[1] && y < 100);
      if (roc) y += 1911;
      else if (y < 1000) continue;               // 兩位數年份又沒寫民國，太模糊就跳過
      const d = ymd(y, +m[3], +m[4]);
      if (!d) continue;
      let time = null;
      if (m[5] !== undefined && +m[5] < 24 && +m[6] < 60) time = `${String(+m[5]).padStart(2, '0')}:${m[6]}`;
      out.push({ ymd: d, time, index: m.index, end: m.index + m[0].length, raw: m[0].trim(), roc });
    }
    return out;
  }
  const KEY_SRC = '(有效期限|使用期限|兌換期限|有效期間|使用期間|有效日期|到期日|到期|期限|截止|有效至|效期|使用至|兌換至)';
  const KEY_RE = new RegExp(KEY_SRC, 'g');
  const KEY_TEST = new RegExp(KEY_SRC);
  function pickExpiry(text) {
    const t = toHalf(text);
    const dates = findDates(t);
    if (!dates.length) return null;
    const keys = [];
    let k;
    while ((k = KEY_RE.exec(t))) keys.push(k.index + k[0].length);
    KEY_RE.lastIndex = 0;
    // 關鍵字後 40 字內的日期；遇到區間（A ~ B）就取較晚的那天
    const near = dates.filter(d => keys.some(p => d.index >= p - 2 && d.index - p <= 40));
    const pool = near.length ? near : dates;
    const best = pool.reduce((a, b) => (b.ymd > a.ymd || (b.ymd === a.ymd && b.time && !a.time)) ? b : a);
    return { ...best, confident: near.length > 0 };
  }

  /* ---------- 文字解析（本機 OCR 用） ---------- */
  const PLAT_RE = [
    ['momo', /momo|富邦媒/i], ['yahoo', /yahoo|奇摩/i], ['pchome', /pchome|24h購物/i],
    ['shopee', /蝦皮|shopee/i], ['line', /line\s*禮物|line\s*gift/i],
  ];
  const CAT_RE = [
    ['coffee', /咖啡|拿鐵|美式|星巴克|starbucks|cama|路易莎|louisa|85度c|茶|飲品|手搖/i],
    ['movie', /電影|影城|威秀|國賓|秀泰|美麗華/],
    ['store', /7-?11|7-eleven|統一超商|全家|萊爾富|ok\s*mart|超商|全聯|家樂福/i],
    ['food', /餐|套餐|牛排|火鍋|王品|饗|麥當勞|肯德基|摩斯|漢堡|披薩|甜點|蛋糕/],
    ['gift', /禮券|商品卡|百貨|sogo|新光|遠百|禮物卡/i],
  ];
  function parseText(text) {
    const t = toHalf(text);
    const lines = t.split(/\n+/).map(s => s.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
    const r = { title: '', platform: '', category: '', expires_on: '', expires_time: '', expiry_text: '', value: '', order_no: '', notes: '', uncertain: [] };
    for (const [id, re] of PLAT_RE) if (re.test(t)) { r.platform = id; break; }
    for (const [id, re] of CAT_RE) if (re.test(t)) { r.category = id; break; }
    const ex = pickExpiry(t);
    if (ex) { r.expires_on = ex.ymd; r.expires_time = ex.time || ''; r.expiry_text = ex.raw; if (!ex.confident) r.uncertain.push('expires_on'); }
    const on = t.match(/(?:訂單(?:編號|號碼)|訂單號|Order\s*(?:No|ID))\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-]{5,29})/i);
    if (on) r.order_no = on[1];
    const v = t.match(/(?:NT\$|NTD|\$)\s*([\d,]{2,7})|([\d,]{2,7})\s*元/);
    if (v) r.value = 'NT$' + (v[1] || v[2]).replace(/,/g, '');
    const titleLine = lines.find(l => /券|兌換|禮券|商品卡|咖啡|飲品|套餐|電影票|招待/.test(l) && l.length >= 4 && l.length <= 40 && !KEY_TEST.test(l));
    if (titleLine) r.title = titleLine.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 80);
    else r.uncertain.push('title');
    return r;
  }

  /* ---------- AI 結果整理：日期用原文再核對一次 ---------- */
  function normalizeAI(res) {
    const r = {
      title: String(res.title || '').slice(0, 80), platform: res.platform || '', platform_name: res.platform_name || '',
      category: res.category || '', expires_on: '', expires_time: '', expiry_text: res.expiry_text || '',
      value: res.value || '', order_no: res.order_no || '', notes: res.notes || '',
      ticket_count: res.ticket_count || 1, uncertain: Array.isArray(res.uncertain) ? res.uncertain.slice() : [], warnings: [],
    };
    const aiDate = /^\d{4}-\d{2}-\d{2}$/.test(res.expires_on || '') ? res.expires_on : '';
    const fromRaw = r.expiry_text ? pickExpiry(r.expiry_text) : null;
    if (fromRaw && aiDate && fromRaw.ymd !== aiDate) {
      r.expires_on = fromRaw.ymd;
      r.warnings.push(`AI 換算的日期（${aiDate}）和原文「${r.expiry_text}」不一致，已改用原文換算的 ${fromRaw.ymd}，請確認`);
    } else r.expires_on = aiDate || (fromRaw ? fromRaw.ymd : '');
    if (r.expires_on) {
      const [y, m, d] = r.expires_on.split('-').map(Number);
      if (!ymd(y, m, d)) { r.expires_on = ''; r.uncertain.push('expires_on'); }
    }
    const tm = /^(\d{2}):(\d{2})$/.exec(res.expires_time || '');
    r.expires_time = tm && +tm[1] < 24 && +tm[2] < 60 ? res.expires_time : (fromRaw && fromRaw.time) || '';
    if (r.platform === 'unknown') r.platform = '';
    if (!/^[A-Za-z0-9\-]{4,40}$/.test(r.order_no)) r.order_no = '';   // 只接受看起來像訂單編號的內容
    return r;
  }

  /* ---------- 快取 ---------- */
  async function cachedFor(hash) {
    const rows = (await all('ai_cache')).filter(c => c.hash === hash).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    return { ai: rows.find(r => r.engine.startsWith('ai:')), ocr: rows.find(r => r.engine === OCR_ENGINE) };
  }
  async function saveCache(hash, engine, model, result) {
    await write([{ store: 'ai_cache', value: { key: hash + '|' + engine, hash, engine, model, at: nowISO(), result, confirmed: false } }], { fromSync: true });
  }
  async function confirm(rec) {
    if (!rec) return;
    const c = await get('ai_cache', rec.key);
    if (c) await write([{ store: 'ai_cache', value: { ...c, confirmed: true, confirmed_at: nowISO() } }], { fromSync: true });
  }

  /* ---------- AI 暫停（額度用完、不再免費） ---------- */
  async function aiBlocked() {
    const b = await get('meta', 'ai_block');
    if (!b) return null;
    if (b.until && Date.now() > b.until) { await write([{ store: 'meta', del: 'ai_block' }], { fromSync: true }); return null; }
    return b;
  }
  function nextTaipeiMidnight() {
    const [y, m, d] = today().split('-').map(Number);
    return Date.UTC(y, m - 1, d + 1) - 8 * 3600 * 1000;
  }
  async function blockAI(r) {
    let until = null;
    if (r.code === 'AI_RATE_LIMITED') until = Date.now() + (r.retry_after || 60) * 1000;
    else if (r.code === 'AI_QUOTA_EXCEEDED' && r.reason !== 'not_free') until = Math.max(nextTaipeiMidnight(), Date.now() + 3600 * 1000);
    else if (r.code !== 'AI_QUOTA_EXCEEDED') return;
    await write([{ store: 'meta', value: { key: 'ai_block', code: r.code, reason: r.reason || '', message: r.message || AI_MSG[r.code], until } }], { fromSync: true });
  }

  /* ---------- 畫面元件 ---------- */
  function sheet(html) {
    const m = document.createElement('div');
    m.className = 'modal'; m.innerHTML = `<div class="card sheet" role="dialog" aria-modal="true">${html}</div>`;
    $('#layer').appendChild(m);
    return m;
  }
  let busyEl = null;
  function busy(text, pct) {
    if (!busyEl) busyEl = sheet(`<div class="busy">${mascotSVG('busy-mascot')}<p id="busyText"></p><div class="bar"><i id="busyBar"></i></div></div>`);
    busyEl.querySelector('#busyText').textContent = text;
    const bar = busyEl.querySelector('#busyBar');
    bar.parentElement.classList.toggle('hidden', pct == null);
    if (pct != null) bar.style.width = Math.round(pct * 100) + '%';
  }
  function unbusy() { if (busyEl) { busyEl.remove(); busyEl = null; } }

  async function blobOf(im) {
    if (im.file) return im.file;
    const rec = await get('blobs', im.hash);
    if (!rec) return null;
    return rec.data ? new Blob([rec.data], { type: rec.type || 'image/jpeg' }) : rec.blob;
  }
  function loadImg(blob) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(blob); const img = new Image();
      img.onload = () => res(img); img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('圖片無法開啟')); };
      img.src = u;
    });
  }

  // 選擇辨識方式
  function chooseEngine(st) {
    return new Promise(res => {
      const aiOk = !st.aiReason;
      const m = sheet(`<h3 style="margin:0 0 6px">辨識票券資訊</h3>
        <p class="hint" style="margin:0 0 12px">辨識結果會填進表單，<b>請確認後再儲存</b>。</p>
        ${st.cache ? `<button class="btn take block" data-v="cache">使用上次的辨識結果<br><small style="font-weight:400">${esc(st.cache.label)}・不消耗額度</small></button><div style="height:10px"></div>` : ''}
        <button class="btn coral block" data-v="ai" ${aiOk ? '' : 'disabled'}>AI 辨識${st.cache && st.cache.engine.startsWith('ai:') ? '（重新辨識）' : ''}<br><small style="font-weight:400">${aiOk ? '較準確・需要網路・會上傳這張圖片' : esc(st.aiReason)}</small></button>
        <div style="height:10px"></div>
        <button class="btn mizu block" data-v="ocr">本機 OCR<br><small style="font-weight:400">圖片不離開手機・${st.ocrReady ? '模型已下載' : '第一次需下載模型'}</small></button>
        <button class="btn plain block" data-v="" style="margin-top:12px">取消</button>`);
      m.addEventListener('click', e => {
        const b = e.target.closest('[data-v]');
        if (b || e.target === m) { m.remove(); res(b ? b.dataset.v : ''); }
      });
    });
  }

  // 遮蔽框：在 QR Code／條碼／兌換碼上拉方框，送出前塗黑
  function maskEditor(blob) {
    return new Promise(async res => {
      let img;
      try { img = await loadImg(blob); } catch { toast('圖片無法開啟'); return res(null); }
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
      const m = sheet(`<h3 style="margin:0 0 4px">遮住不需要給 AI 看的地方</h3>
        <p class="hint" style="margin:0 0 10px">用手指在 QR Code、條碼、兌換碼上拉出方框（可以拉很多個），送出的圖片會把方框塗黑。</p>
        <div class="maskwrap"><canvas id="maskCv" width="${W}" height="${H}"></canvas></div>
        <div class="row" style="margin-top:12px"><button class="btn plain grow" data-v="clear">清除方框</button><button class="btn plain grow" data-v="cancel">取消</button></div>
        <button class="btn coral block" data-v="send" style="margin-top:10px">送出辨識</button>`);
      const cv = m.querySelector('#maskCv'); const ctx = cv.getContext('2d');
      const rects = []; let cur = null;
      const draw = () => {
        ctx.drawImage(img, 0, 0, W, H);
        ctx.fillStyle = '#3E3A39';
        for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
        if (cur) { ctx.strokeStyle = '#F2A497'; ctx.lineWidth = Math.max(3, W / 150); ctx.strokeRect(cur.x, cur.y, cur.w, cur.h); }
      };
      const pt = e => { const b = cv.getBoundingClientRect(); return { x: (e.clientX - b.left) * W / b.width, y: (e.clientY - b.top) * H / b.height }; };
      let start = null;
      cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); start = pt(e); cur = { x: start.x, y: start.y, w: 0, h: 0 }; });
      cv.addEventListener('pointermove', e => {
        if (!start) return; const p = pt(e);
        cur = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; draw();
      });
      const end = () => { if (cur && cur.w > 8 && cur.h > 8) rects.push(cur); cur = null; start = null; draw(); };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      draw();
      m.addEventListener('click', e => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        if (b.dataset.v === 'clear') { rects.length = 0; draw(); return; }
        URL.revokeObjectURL(img.src);
        if (b.dataset.v === 'cancel') { m.remove(); return res(null); }
        draw();
        const data = cv.toDataURL('image/jpeg', 0.85).split(',')[1];
        m.remove();
        res({ image: data, mime: 'image/jpeg', masked: rects.length });
      });
    });
  }

  /* ---------- 套用結果到表單 ---------- */
  function applyResult(r, label, cacheKey) {
    const f = $('#form'); if (!f || !S.draft) return;
    const d = S.draft;
    d.userSet = d.userSet || new Set();
    const filled = [];
    const setInput = (name, val) => {
      if (!val || !f[name]) return;
      if (f[name].value.trim()) return;                  // 已經有內容就不覆蓋
      f[name].value = val; f[name].classList.add('ai-filled'); filled.push(name);
    };
    const setSelect = (name, val) => {
      if (!val || !f[name] || d.userSet.has(name)) return;
      if (![...f[name].options].some(o => o.value === val)) return;
      f[name].value = val; f[name].classList.add('ai-filled'); filled.push(name);
      f[name].dispatchEvent(new Event('change'));
    };
    setInput('title', r.title);
    setSelect('platform', r.platform);
    if (r.platform === 'other' || (!r.platform && r.platform_name)) { setSelect('platform', 'other'); setInput('platform_name', r.platform_name); }
    setSelect('category', r.category);
    setInput('expires_on', r.expires_on);
    setInput('expires_time', r.expires_time);
    setInput('value', r.value);
    setInput('order_no', r.order_no);
    setInput('note', r.notes);
    d.recog = { key: cacheKey };

    const unsure = (r.uncertain || []).filter(x => ['title', 'expires_on', 'order_no', 'platform', 'value'].includes(x));
    const LBL = { title: '名稱', expires_on: '有效期限', order_no: '訂單編號', platform: '平台', value: '面額' };
    const box = $('#recogBox');
    box.innerHTML = `<b>${esc(label)}已填入 ${filled.length} 個欄位</b>
      <div class="hint" style="margin:4px 0 0">黃色欄位請逐一確認，原本已經填寫的內容不會被覆蓋。</div>
      ${r.expiry_text ? `<div class="hint">期限原文：「${esc(r.expiry_text)}」</div>` : ''}
      ${(r.warnings || []).map(w => `<div class="hint warnline">⚠ ${esc(w)}</div>`).join('')}
      ${unsure.length ? `<div class="hint warnline">不確定：${unsure.map(x => LBL[x]).join('、')}</div>` : ''}
      ${!r.expires_on ? '<div class="hint warnline">沒有找到有效期限，請手動填寫</div>' : ''}
      ${r.ticket_count > 1 && !d.editId ? `<div class="hint">圖片裡看起來有 ${r.ticket_count} 張票券，如果每張 QR Code 不同，可以改選「多張」。</div>` : ''}`;
    box.classList.remove('hidden');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------- AI ---------- */
  async function runAI(im, blob) {
    const ok = await get('meta', 'ai_privacy_ok');
    if (!ok) {
      const yes = await ask('AI 辨識會把圖片傳給 Google Gemini（免費方案）。\n免費方案送出的內容可能被 Google 用來改善服務，也可能經過人工審閱。\n\n下一步可以用方框遮住 QR Code、條碼與兌換碼，建議一定要遮。', '我了解，繼續');
      if (!yes) return;
      await write([{ store: 'meta', value: { key: 'ai_privacy_ok', at: nowISO() } }], { fromSync: true });
    }
    const masked = await maskEditor(blob);
    if (!masked) return;
    busy('AI 辨識中…');
    let r;
    try { r = await Sync.invoke('recognize', { image: masked.image, mime: masked.mime }); }
    finally { unbusy(); }
    if (r && r.ok) {
      const model = r.model || 'gemini';
      await saveCache(im.hash, 'ai:' + model, model, r.result);
      applyResult(normalizeAI(r.result), 'AI 辨識', im.hash + '|ai:' + model);
      if (r.limit) toast(`今天已使用 AI ${r.used}/${r.limit} 次`);
      return;
    }
    r = r || { code: 'AI_SERVICE_ERROR' };
    await blockAI(r);
    const msg = r.message || AI_MSG[r.code] || AI_MSG.AI_SERVICE_ERROR;
    if (r.code === 'AI_INVALID_IMAGE') {
      if (await ask(`${msg}。\n要改用本機 OCR 試試看嗎？也可以直接手動填寫。`, '改用本機 OCR')) return runOCR(im, blob);
      return focusManual();
    }
    if (await ask(`${msg}。\n要改用本機 OCR 嗎？圖片不會離開這台裝置。`, '改用本機 OCR')) return runOCR(im, blob);
    focusManual();
  }

  /* ---------- 本機 OCR ---------- */
  let worker = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.Tesseract) return res();
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('script'));
      document.head.appendChild(s);
    });
  }
  async function prepForOCR(blob) {
    const img = await loadImg(blob);
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(img.src);
    const px = ctx.getImageData(0, 0, cv.width, cv.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const g = px.data[i] * 0.299 + px.data[i + 1] * 0.587 + px.data[i + 2] * 0.114;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = g;
    }
    ctx.putImageData(px, 0, 0);
    return cv;
  }
  async function runOCR(im, blob) {
    const ready = await get('meta', 'ocr_ready');
    if (!ready) {
      if (navigator.onLine === false) { toast('本機 OCR 模型還沒下載，目前離線，請手動填寫'); return focusManual(); }
      const yes = await ask('第一次使用本機 OCR 要下載中文與英文辨識模型（約 15～25 MB），建議使用 Wi-Fi。\n下載後會存在這台裝置，但瀏覽器仍可能清除快取，之後可能需要重新下載。', '下載並辨識');
      if (!yes) return focusManual();
    }
    try {
      busy('準備本機 OCR…', 0);
      await loadScript(TESS_URL);
      if (!worker) {
        worker = await Tesseract.createWorker(['chi_tra', 'eng'], 1, {
          logger: m => {
            const label = /load|download|initializ/i.test(m.status) ? '下載／載入辨識模型…' : /recogniz/i.test(m.status) ? '辨識文字中…' : '處理中…';
            busy(label, typeof m.progress === 'number' ? m.progress : null);
          },
        });
      }
      const canvas = await prepForOCR(blob);
      busy('辨識文字中…', 0);
      const { data } = await worker.recognize(canvas);
      await write([{ store: 'meta', value: { key: 'ocr_ready', at: nowISO() } }], { fromSync: true });
      const result = parseText(data.text || '');
      result.text = (data.text || '').slice(0, 4000);
      await saveCache(im.hash, OCR_ENGINE, 'tesseract.js 5', result);
      unbusy();
      applyResult(result, '本機 OCR ', im.hash + '|' + OCR_ENGINE);
    } catch (e) {
      console.warn('OCR 失敗', e);
      unbusy();
      try { if (worker) await worker.terminate(); } catch {}
      worker = null;
      toast(navigator.onLine === false ? '離線中無法下載 OCR 模型，請手動填寫' : '本機 OCR 無法使用，請手動填寫');
      focusManual();
    }
  }
  function focusManual() { const f = $('#form'); if (f && !f.title.value) f.title.focus(); }

  /* ---------- 入口 ---------- */
  async function start() {
    const d = S.draft;
    if (!d || !$('#form')) return;
    if (!d.images.length) { toast('請先加入票券截圖'); return; }
    const im = d.images.find(x => x.kind === 'info') || d.images.find(x => !isCode(x.kind)) || d.images[0];
    if (!im.hash) { const b0 = await blobOf(im); if (!b0) return toast('圖片無法開啟'); im.hash = await sha256(b0); }
    const blob = await blobOf(im);
    if (!blob) return toast('這張圖片還沒下載完成');

    const c = await cachedFor(im.hash);
    const latest = [c.ai, c.ocr].filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0];
    const st = { ocrReady: !!(await get('meta', 'ocr_ready')) };
    if (latest) st.cache = { ...latest, label: (latest.engine.startsWith('ai:') ? 'AI（' + latest.model + '）' : '本機 OCR') + '・' + new Date(latest.at).toLocaleString('zh-TW', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) };
    const blocked = await aiBlocked();
    const ss = window.Sync ? Sync.status : {};
    if (!window.Sync || !ss.configured) st.aiReason = '雲端尚未設定';
    else if (!ss.email) st.aiReason = '登入雲端同步後才能使用';
    else if (navigator.onLine === false) st.aiReason = '目前離線';
    else if (blocked) st.aiReason = blocked.reason === 'not_free' ? '模型已不提供免費額度，已停用' : (blocked.message || 'AI 暫停使用') + (blocked.until ? '・' + new Date(blocked.until).toLocaleTimeString('zh-TW', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) + ' 後恢復' : '');
    if (im.kind && isCode(im.kind)) st.aiReason = st.aiReason || '';

    const v = await chooseEngine(st);
    if (v === 'cache') {
      const r = latest.engine.startsWith('ai:') ? normalizeAI(latest.result) : latest.result;
      return applyResult(r, '上次的辨識結果', latest.key);
    }
    if (v === 'ai') return runAI(im, blob);
    if (v === 'ocr') {
      if (c.ocr && !(await ask('這張圖片已經用本機 OCR 辨識過，要重新辨識嗎？', '重新辨識'))) return applyResult(c.ocr.result, '上次的辨識結果', c.ocr.key);
      return runOCR(im, blob);
    }
  }

  window.Recog = { start, confirm, findDates, pickExpiry, parseText, normalizeAI, clearAIBlock: () => write([{ store: 'meta', del: 'ai_block' }], { fromSync: true }) };
})();
