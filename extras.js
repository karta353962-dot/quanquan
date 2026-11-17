'use strict';
/* =========================================================
   券券日記・階段四：PWA、推播、行事曆、完整備份、設定頁
   ========================================================= */
(function () {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const utf8 = s => new TextEncoder().encode(s);
  const DAY = 86400e3;

  /* =======================================================
     Service Worker：離線快取與更新
     ======================================================= */
  let updating = false;
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('有新版本可以更新', { label: '立即更新', fn: () => { updating = true; nw.postMessage('skipWaiting'); } });
          }
        });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(e => console.warn('Service Worker 註冊失敗', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'open') location.hash = new URL(e.data.url).hash || '#soon';
    });
  }

  /* =======================================================
     分享選單（Web Share Target，支援的裝置才有）
     ======================================================= */
  async function consumeShare() {
    if (!('caches' in window)) return;
    try {
      const c = await caches.open('qq-share-inbox');
      const m = await c.match('./__share/meta');
      if (!m) return;
      const meta = await m.json();
      const files = [];
      for (let i = 0; i < (meta.count || 0); i++) {
        const r = await c.match(`./__share/file-${i}`);
        if (!r) continue;
        const b = await r.blob();
        files.push(new File([b], decodeURIComponent(r.headers.get('X-Name') || 'shared'), { type: b.type || 'image/jpeg' }));
      }
      await caches.delete('qq-share-inbox');
      if (files.length) addFiles(files);
      const text = [meta.url, meta.text, meta.title].filter(Boolean).join(' ');
      if (text) handlePastedText(text);
      if (!files.length && !text) toast('沒有收到可以使用的內容');
    } catch (e) { console.warn(e); toast('讀取分享內容失敗，請改用上傳截圖'); }
  }

  /* =======================================================
     存檔：iPhone 用分享面板（可存到「檔案」），其他用下載
     ======================================================= */
  async function saveFile(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; }
      catch (e) { if (e && e.name === 'AbortError') return false; }
    }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return true;
    } catch { toast('這個環境不允許下載檔案'); return false; }
  }

  /* =======================================================
     行事曆 .ics
     ======================================================= */
  function icsText(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function fold(line) {                       // 每行最多 75 bytes（UTF-8）
    const out = []; let cur = ''; let bytes = 0;
    for (const ch of line) {
      const b = utf8(ch).length;
      if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  function duration(min) {
    const sign = min < 0 ? '-' : ''; let a = Math.abs(min);
    const d = Math.floor(a / 1440); a %= 1440;
    const h = Math.floor(a / 60), m = a % 60;
    const t = (h || m) ? 'T' + (h ? h + 'H' : '') + (m ? m + 'M' : '') : '';
    return sign + 'P' + (d ? d + 'D' : '') + (t || (d ? '' : 'T0M'));
  }
  function buildICS(tickets) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//quanquan//coupon-diary//ZH-TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:券券日記'];
    for (const t of tickets) {
      if (!t.expires_on) continue;
      const [y, m, d] = t.expires_on.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
      const [hh, mm] = (t.remind_time || '09:00').split(':').map(Number);
      const desc = [`購買平台：${platName(t)}`, t.value ? `面額：${t.value}` : '', t.expires_time ? `到期時間：${t.expires_time}` : '', '請打開券券日記查看 QR Code。'].filter(Boolean).join('\n');
      L.push('BEGIN:VEVENT', `UID:${t.id}@quanquan`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${t.expires_on.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${next}`,
        `SUMMARY:${icsText('🎫 ' + t.title + ' 到期')}`, `DESCRIPTION:${icsText(desc)}`, 'TRANSP:TRANSPARENT');
      for (const n of (t.reminders && t.reminders.length ? t.reminders : [1])) {
        L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:${duration(-n * 1440 + hh * 60 + (mm || 0))}`,
          `DESCRIPTION:${icsText(n === 0 ? `今天到期：${t.title}` : `${t.title} 還有 ${n} 天到期`)}`, 'END:VALARM');
      }
      L.push('END:VEVENT');
    }
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }
  async function exportICS(list, name) {
    const ok = list.filter(t => t.expires_on && t.status !== 'used' && !isExpired(t));
    if (!ok.length) return toast('沒有可以加入行事曆的有效票券');
    // 兌換碼、訂單編號不寫進行事曆，避免外流
    const saved = await saveFile(new Blob([buildICS(ok)], { type: 'text/calendar' }), name || '券券日記到期提醒.ics');
    if (saved) toast(`已匯出 ${ok.length} 張票券的到期提醒`);
  }

  /* =======================================================
     ZIP（不壓縮，保留原圖位元組不變）
     ======================================================= */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipFiles(files) {
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const name = utf8(f.name), data = f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dtime, true); lh.setUint16(12, ddate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dtime, true); ch.setUint16(14, ddate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const csize = central.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('不是 ZIP 檔');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const out = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 目錄損壞');
      const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
      const csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      let data = u8.slice(start, start + csize);
      if (method === 8) {
        if (!window.DecompressionStream) throw new Error('這個瀏覽器無法解壓縮，請用未壓縮的備份');
        data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      } else if (method !== 0) throw new Error('不支援的壓縮格式');
      if (crc32(data) !== crc) throw new Error(`檔案損壞：${name}`);
      out.set(name, data);
    }
    return out;
  }

  /* =======================================================
     完整備份
     ======================================================= */
  async function exportBackup() {
    const go1 = await ask('備份檔會包含所有票券、原始 QR Code／條碼圖片、訂單資訊與兌換碼，拿到檔案的人可以直接兌換。\n請存放在安全的地方，不要上傳到公開網站或傳給別人。', '我了解，開始備份');
    if (!go1) return;
    toast('正在打包備份…');
    try {
      const tickets = await all('tickets'), images = await all('ticket_images'), blobs = await all('blobs');
      const used = new Set(images.map(i => i.hash));
      const files = [], meta = [];
      for (const b of blobs) {
        if (!used.has(b.hash)) continue;
        const data = b.data ? new Uint8Array(b.data) : new Uint8Array(await b.blob.arrayBuffer());
        const ext = ((b.type || 'image/jpeg').split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'bin';
        const path = `images/${b.hash}.${ext}`;
        files.push({ name: path, data });
        meta.push({ hash: b.hash, file: path, type: b.type || 'image/jpeg', size: data.length });
      }
      const missing = [...used].filter(h => !meta.some(m => m.hash === h)).length;
      const doc = {
        format: 'quanquan-backup', version: 1, app: '券券日記', app_version: APP_VERSION, exported_at: nowISO(), timezone: TZ,
        warning: '此備份含有可直接兌換的票券資訊（QR Code、條碼、兌換碼），請妥善保管，不要分享給他人。',
        counts: { tickets: tickets.length, active: tickets.filter(t => !t.deleted_at).length, images: meta.length, images_not_downloaded: missing },
        settings: { platforms: PLATFORMS, categories: CATS, image_kinds: KINDS },
        tickets, ticket_images: images, images: meta,
      };
      files.unshift({ name: 'backup.json', data: utf8(JSON.stringify(doc, null, 1)) });
      files.unshift({ name: '說明.txt', data: utf8(`券券日記完整備份\n匯出時間：${new Date().toLocaleString('zh-TW', { timeZone: TZ })}\n票券：${doc.counts.active} 張，圖片：${meta.length} 張\n\n${doc.warning}\n還原方式：券券日記 → 設定 → 匯入備份，選擇這個 ZIP 檔。\n`) });
      const stamp = today().replace(/-/g, '') + '-' + fmtHM.format(new Date()).replace(':', '');
      const ok = await saveFile(zipFiles(files), `券券日記備份-${stamp}.zip`);
      if (!ok) return;
      await write([{ store: 'meta', value: { key: 'last_backup_at', value: nowISO(), tickets: doc.counts.active } }, { store: 'meta', del: 'backup_snooze' }], { fromSync: true });
      await refreshState();
      toast(missing ? `備份完成（有 ${missing} 張圖片還在雲端未下載，沒有包含）` : '備份完成，請把檔案存在安全的地方');
      if (location.hash === '#settings') renderSettings();
    } catch (e) { console.error(e); toast('備份失敗：' + (e.message || e)); }
  }

  async function importBackup(file) {
    let entries, data;
    try { entries = await unzip(await file.arrayBuffer()); }
    catch (e) { return toast('無法讀取這個檔案：' + (e.message || '請確認是券券日記的備份 ZIP')); }
    const mf = entries.get('backup.json');
    if (!mf) return toast('這不是券券日記的備份檔（找不到 backup.json）');
    try { data = JSON.parse(new TextDecoder().decode(mf)); } catch { return toast('備份內容損壞，無法讀取'); }
    if (data.format !== 'quanquan-backup') return toast('這不是券券日記的備份檔');
    if ((data.version || 1) > 1) return toast('這個備份來自較新版本的 App，請先更新');

    const localT = new Map((await all('tickets')).map(t => [t.id, t]));
    const localI = new Map((await all('ticket_images')).map(i => [i.id, i]));
    const localB = new Set((await all('blobs')).map(b => b.hash));
    const sig = t => [String(t.title || '').trim(), t.expires_on || '', t.order_no || '', t.batch_index || 1].join('|');
    const localSigs = new Set([...localT.values()].filter(t => !t.deleted_at).map(sig));
    const plan = { add: [], update: [], same: 0, older: 0, dup: 0, deleted: 0, images: [], blobs: [], missing: 0, bad: 0 };

    for (const t of data.tickets || []) {
      if (!t || !t.id || !t.title) continue;
      const l = localT.get(t.id);
      if (!l) {
        if (t.deleted_at) { plan.deleted++; continue; }
        if (localSigs.has(sig(t))) { plan.dup++; continue; }   // 內容一模一樣的票券（不同 id）視為重複
        plan.add.push(t); continue;
      }
      const a = t.updated_at || '', b = l.updated_at || '';
      if (a > b) plan.update.push({ ...l, ...t, version: l.version }); else if (a === b) plan.same++; else plan.older++;
    }
    const ids = new Set([...plan.add, ...plan.update].map(t => t.id));
    for (const im of data.ticket_images || []) {
      if (!im || !ids.has(im.ticket_id)) continue;
      const l = localI.get(im.id);
      if (l && (l.updated_at || '') >= (im.updated_at || '')) continue;
      plan.images.push(im);
    }
    const need = new Set(plan.images.map(i => i.hash).filter(h => !localB.has(h)));
    for (const h of need) {
      const m = (data.images || []).find(x => x.hash === h);
      const bytes = m && entries.get(m.file);
      if (!bytes) { plan.missing++; continue; }
      if (!h.startsWith('nohash-') && (await sha256(new Blob([bytes]))) !== h) { plan.bad++; continue; }   // 圖片內容和記錄不符
      plan.blobs.push({ hash: h, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type: m.type || 'image/jpeg', size: bytes.length, uploaded: false, created_at: nowISO() });
    }

    if (!plan.add.length && !plan.update.length && !plan.images.length) {
      return toast(`沒有需要匯入的新資料（${plan.same + plan.dup} 張已存在）`);
    }
    const when = data.exported_at ? new Date(data.exported_at).toLocaleString('zh-TW', { timeZone: TZ }) : '未知';
    const ok = await new Promise(res => {
      const m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = `<div class="card sheet" role="dialog" aria-modal="true">
        <h3 style="margin:0 0 6px">匯入前確認</h3>
        <p class="hint" style="margin:0 0 10px">備份時間：${esc(when)}</p>
        <dl class="kv">
          <dt>新增票券</dt><dd>${plan.add.length} 張</dd>
          <dt>更新票券</dt><dd>${plan.update.length} 張 <span class="muted">（備份裡比較新）</span></dd>
          <dt>略過</dt><dd>${plan.same} 張相同、${plan.dup} 張內容重複、${plan.older} 張這台較新${plan.deleted ? `、${plan.deleted} 張已刪除` : ''}</dd>
          <dt>圖片</dt><dd>${plan.blobs.length} 張新圖片${plan.missing ? `，<b>${plan.missing} 張缺少</b>` : ''}${plan.bad ? `，<b>${plan.bad} 張損壞已略過</b>` : ''}</dd>
        </dl>
        ${plan.add.length ? `<p class="hint" style="margin:10px 0 0">將新增：${plan.add.slice(0, 6).map(t => esc(t.title)).join('、')}${plan.add.length > 6 ? ' …' : ''}</p>` : ''}
        <p class="hint">合併匯入不會刪除這台裝置上的任何票券。</p>
        <div class="row" style="margin-top:12px"><button class="btn plain grow" data-v="0">取消</button><button class="btn coral grow" data-v="1">合併匯入</button></div></div>`;
      m.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { m.remove(); res(b.dataset.v === '1'); } });
      $('#layer').appendChild(m);
    });
    if (!ok) return;

    const ops = [];
    for (const b of plan.blobs) ops.push({ store: 'blobs', value: b });
    for (const t of plan.add) ops.push({ store: 'tickets', value: { ...t } }, queueOp('tickets', t.id, 'insert'));
    for (const t of plan.update) ops.push({ store: 'tickets', value: t }, queueOp('tickets', t.id, 'update'));
    for (const im of plan.images) ops.push({ store: 'ticket_images', value: { ...im } }, queueOp('ticket_images', im.id, localI.has(im.id) ? 'update' : 'insert'));
    try { await write(ops); }                                   // 全部在同一個交易，失敗就完全不變
    catch (e) { console.error(e); return toast('匯入失敗，原本的資料沒有任何變動'); }
    await load();
    toast(`已匯入：新增 ${plan.add.length} 張、更新 ${plan.update.length} 張`);
    go('home');
  }

  /* =======================================================
     推播通知
     ======================================================= */
  let vapidKey = null;
  function pushSupport() {
    if (!('serviceWorker' in navigator)) return { ok: false, why: '這個瀏覽器不支援背景推播' };
    if (!('PushManager' in window) || !('Notification' in window)) {
      return { ok: false, why: isIOS && !standalone() ? 'iPhone 要先把券券日記「加入主畫面」，再從主畫面打開，才能開啟推播（iOS 16.4 以上）' : '這個瀏覽器不支援背景推播' };
    }
    return { ok: true };
  }
  const b64uToU8 = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
  async function prefetchVapid() {
    if (vapidKey || !window.Sync || !Sync.status.email) return null;
    const r = await Sync.invoke('notify', { get_vapid: true }, 20000);
    if (r && r.vapid_public_key) vapidKey = r.vapid_public_key;
    return r;
  }
  async function currentSub() {
    try { const reg = await navigator.serviceWorker.getRegistration(); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
  }
  async function enablePush() {
    const sup = pushSupport();
    if (!sup.ok) return toast(sup.why);
    if (!Sync.status.email) return toast('請先登入雲端同步');
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();   // 一定要是按下按鈕後的第一步
    if (perm !== 'granted') return toast('沒有取得通知權限，可以到系統「設定 → 通知」開啟');
    if (!vapidKey) { const r = await prefetchVapid(); if (!vapidKey) return toast((r && r.message) || '無法取得推播設定，請確認已部署 notify'); }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      try { if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(vapidKey) }); }
      catch (e) {                                            // 舊的訂閱用了不同金鑰：取消後重新訂閱
        if (sub) await sub.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(vapidKey) });
      }
      const j = sub.toJSON();
      const { error } = await Sync.client().from('push_subscriptions').upsert(
        { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) },
        { onConflict: 'endpoint' });
      if (error) return toast('儲存裝置失敗：' + error.message);
      toast('已開啟推播通知，可以按「傳送測試通知」試試看');
    } catch (e) { toast('開啟推播失敗：' + (e.message || e)); }
    renderSettings();
  }
  async function disablePush() {
    const sub = await currentSub();
    if (sub) {
      try { await Sync.client().from('push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch {}
      await sub.unsubscribe().catch(() => {});
    }
    toast('已關閉這台裝置的推播通知');
    renderSettings();
  }
  async function testPush(btn) {
    btn.disabled = true; const t = btn.textContent; btn.textContent = '傳送中…';
    const r = await Sync.invoke('notify', { test: true }, 30000);
    btn.disabled = false; btn.textContent = t;
    toast((r && r.message) || '傳送失敗');
  }

  /* =======================================================
     備份提醒、安裝提示
     ======================================================= */
  const state = { lastBackup: null, snoozeUntil: 0, syncFailSince: null };
  async function refreshState() {
    try {
      const lb = await get('meta', 'last_backup_at'), sn = await get('meta', 'backup_snooze'), sf = await get('meta', 'sync_fail_since');
      state.lastBackup = lb ? lb.value : null; state.snoozeUntil = sn ? sn.until : 0; state.syncFailSince = sf ? sf.at : null;
    } catch {}
  }
  function nudgeHTML() {
    if (Date.now() < state.snoozeUntil) return '';
    const live = S.tickets.filter(t => !t.deleted_at);
    if (!live.length) return '';
    const last = state.lastBackup ? Date.parse(state.lastBackup) : 0;
    const added = live.filter(t => Date.parse(t.created_at) > last).length;
    let why = '';
    if (state.syncFailSince && Date.now() - Date.parse(state.syncFailSince) > DAY) why = '雲端同步已經異常超過一天';
    else if (!last && live.length >= 3) why = '還沒有備份過';
    else if (last && added > 10) why = `上次備份後新增了 ${added} 張票券`;
    else if (last && Date.now() - last > 7 * DAY) why = `已經 ${Math.floor((Date.now() - last) / DAY)} 天沒有備份`;
    if (!why) return '';
    return `<div class="banner" style="background:var(--take);cursor:default">${ICON.cloud}<span class="grow">${esc(why)}，建議備份一次<br><small style="font-weight:400">備份檔含可兌換的票券資訊，請妥善保存</small></span>
      <span class="row" style="gap:6px;flex-direction:column"><button class="btn small plain" data-x="backup">備份</button><button class="btn small plain" data-x="snooze" style="min-height:30px;font-size:12px">稍後</button></span></div>`;
  }
  function installHTML() {
    if (!isIOS || standalone()) return '';
    try { if (localStorage.getItem('qq_install_hide')) return ''; } catch {}
    return `<div class="banner" style="background:var(--paper);cursor:default"><span style="font-size:22px">📲</span><span class="grow">加到主畫面，才能收到到期推播<br>
      <small style="font-weight:400">點 Safari 的「分享」→「加入主畫面」，之後從主畫面打開</small></span><button class="iconbtn" data-x="install-x" aria-label="不再顯示" style="width:34px;height:34px">✕</button></div>`;
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    const x = b.dataset.x;
    if (x === 'backup') exportBackup();
    if (x === 'snooze') { await write([{ store: 'meta', value: { key: 'backup_snooze', until: Date.now() + 3 * DAY } }], { fromSync: true }); await refreshState(); renderHome(true); }
    if (x === 'install-x') { try { localStorage.setItem('qq_install_hide', '1'); } catch {} renderHome(true); }
  });
  function trackSync() {
    if (!window.Sync) return;
    Sync.onChange(async () => {
      const st = Sync.status;
      if (!st.email) return;
      if ((st.state === 'error' || st.state === 'offline') && !state.syncFailSince) {
        state.syncFailSince = nowISO();
        await write([{ store: 'meta', value: { key: 'sync_fail_since', at: state.syncFailSince } }], { fromSync: true });
      } else if (st.state === 'ok' && state.syncFailSince) {
        state.syncFailSince = null;
        await write([{ store: 'meta', del: 'sync_fail_since' }], { fromSync: true });
      }
    });
  }

  /* =======================================================
     設定頁
     ======================================================= */
  async function renderSettings() {
    await refreshState();
    const st = window.Sync ? Sync.status : {};
    const sup = pushSupport();
    const sub = sup.ok ? await currentSub() : null;
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    let usage = '';
    try { const e = await navigator.storage.estimate(); usage = `${(e.usage / 1048576).toFixed(1)} MB`; } catch {}
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    const offlineReady = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    const last = state.lastBackup ? new Date(state.lastBackup).toLocaleString('zh-TW', { timeZone: TZ }) : '還沒有備份過';

    let pushLine, pushBtns = '';
    if (!sup.ok) pushLine = sup.why;
    else if (!st.email) pushLine = '登入雲端同步後才能開啟推播（推播由雲端發送）';
    else if (perm === 'denied') pushLine = '通知權限被拒絕了，請到系統「設定 → 通知 → 券券日記」開啟';
    else if (sub && perm === 'granted') { pushLine = '✅ 這台裝置已開啟推播'; pushBtns = `<button class="btn take" id="pTest">傳送測試通知</button><button class="btn plain" id="pOff">關閉通知</button>`; }
    else { pushLine = '這台裝置還沒開啟推播'; pushBtns = `<button class="btn coral" id="pOn" style="grid-column:1/-1">開啟推播通知</button>`; }

    app.innerHTML = `<div class="bar"><button class="iconbtn" id="back" aria-label="返回">‹</button><h2>設定</h2></div>
      <section class="card panel"><h3>雲端同步與 AI</h3>
        <p class="hint" style="margin:0 0 10px">${st.email ? `已登入：${esc(st.email)}` : (st.configured ? '尚未登入' : '尚未設定雲端')}</p>
        <a class="btn plain block" href="#account">雲端同步、AI 連線測試</a></section>

      <section class="card panel"><h3>到期提醒通知</h3>
        <p style="margin:0 0 10px">${esc(pushLine)}</p>
        ${pushBtns ? `<div class="actions">${pushBtns}</div>` : ''}
        <p class="hint">・提醒時間以整點為單位，雲端每小時檢查一次，大約在整點後 5 分鐘內送出。<br>
          ・同一時間有多張票券到期會合併成一則；標記「已使用」的票券不會再提醒。<br>
          ・推播需要雲端運作；雲端暫停時無法發送，App 打開時仍會在首頁顯示到期提醒。</p></section>

      <section class="card panel"><h3>行事曆提醒（備援）</h3>
        <p class="hint" style="margin:0 0 10px">把所有有效票券的到期日匯出成 .ics，加入手機行事曆，就算推播失效也會提醒。不包含兌換碼與訂單編號。</p>
        <button class="btn mizu block" id="icsAll">匯出到期提醒到行事曆</button></section>

      <section class="card panel"><h3>備份與還原</h3>
        <p style="margin:0 0 4px">上次備份：${esc(last)}</p>
        <p class="hint" style="margin:0 0 10px">ZIP 內含所有票券資料與原始圖片。<b>備份檔可以直接兌換票券，請存放在安全的地方。</b></p>
        <div class="actions"><button class="btn take" id="bkOut">匯出完整備份</button>
          <label class="btn plain">匯入備份<input type="file" id="bkIn" accept=".zip,application/zip" class="hidden"></label></div>
        <p class="hint">匯入會先預覽，採「合併」方式：不會刪除現有票券，重複的資料會自動略過。</p></section>

      <section class="card panel"><h3>關於</h3>
        <dl class="kv"><dt>版本</dt><dd>${esc(APP_VERSION)}</dd>
          <dt>離線使用</dt><dd>${offlineReady ? '✅ 已準備好' : '下次打開後啟用'}</dd>
          <dt>本機資料</dt><dd>${usage || '—'}${persisted ? '・已申請持久保存' : ''}</dd>
          <dt>主畫面</dt><dd>${standalone() ? '✅ 從主畫面開啟' : '瀏覽器開啟'}</dd></dl>
        <p class="hint">瀏覽器或系統仍可能清除本機資料，請搭配雲端同步與定期備份。</p></section>`;

    $('#back').onclick = () => go('home');
    const on = $('#pOn'); if (on) on.onclick = enablePush;
    const off = $('#pOff'); if (off) off.onclick = disablePush;
    const tst = $('#pTest'); if (tst) tst.onclick = () => testPush(tst);
    $('#icsAll').onclick = () => exportICS(S.tickets.filter(t => !t.deleted_at));
    $('#bkOut').onclick = exportBackup;
    $('#bkIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
    if (sup.ok && st.email && !sub) prefetchVapid().catch(() => {});
  }

  window.Extras = {
    renderSettings, consumeShare, exportICS, exportBackup, importBackup, nudgeHTML, installHTML, refreshState,
    _test: { zipFiles, unzip, crc32, buildICS, duration, fold },
  };
  registerSW();
  (window.appReady || Promise.resolve()).then(async () => { await refreshState(); trackSync(); if ((location.hash.slice(1) || 'home') === 'home' && !S.draft) renderHome(true); });
})();
