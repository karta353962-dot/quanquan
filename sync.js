'use strict';
/* =========================================================
   券券日記・階段二：雲端同步
   - 所有修改先寫進 IndexedDB 與同步佇列，再上傳
   - 版本檢查（樂觀鎖），失敗時以「原始／本機／雲端」三方比較
   - 不同欄位自動合併；相同欄位不同內容 → 交給使用者選
   - 雲端暫停或離線時只顯示狀態，絕不清除本機資料
   ========================================================= */
(function () {
  const CFG = window.QUANQUAN_CONFIG || {};
  const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  const BUCKET = 'ticket-images';
  const TABLES = ['tickets', 'ticket_images'];
  const COLS = {
    tickets: ['id','title','platform','platform_name','category','expires_on','expires_time','value','order_no','original_url','order_url','redeem_code','note','reminders','remind_time','timezone','ticket_type','batch_id','batch_index','batch_total','status','used_at','created_at','updated_at','version','deleted_at'],
    ticket_images: ['id','ticket_id','hash','kind','sort','is_primary','created_at','updated_at','version','deleted_at'],
  };
  const STR = new Set(['title','platform','platform_name','category','value','order_no','original_url','order_url','redeem_code','note','remind_time','timezone','ticket_type','status','hash','kind']);
  const TS = new Set(['used_at','created_at','updated_at','deleted_at','server_updated_at']);
  const META = new Set(['id','version','updated_at','created_at','server_updated_at','user_id']);
  const LABEL = {
    title: '名稱', platform: '購買平台', platform_name: '平台名稱', category: '分類', expires_on: '有效期限', expires_time: '到期時間',
    value: '面額／內容', order_no: '訂單編號', original_url: '原始票券網址', order_url: '訂單網址', redeem_code: '兌換碼', note: '備註',
    reminders: '提醒天數', remind_time: '提醒時間', status: '使用狀態', used_at: '使用時間', deleted_at: '刪除', kind: '圖片類型',
    sort: '圖片順序', is_primary: '主要圖片', batch_index: '張次', batch_total: '總張數',
  };

  const Y = {
    client: null, user: null, state: CFG.supabaseUrl && CFG.supabaseKey ? 'loading' : 'off',
    detail: '', lastSync: null, failures: 0, timer: null, running: false, again: false,
    pending: 0, conflicts: 0, listeners: new Set(),
  };
  const notify = () => Y.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  const setState = (s, detail = '') => { Y.state = s; Y.detail = detail; notify(); };
  const keyOf = (table, id) => table + ':' + id;
  const sw = ops => write(ops, { fromSync: true });

  /* ---------- 資料整理 ---------- */
  function norm(table, row) {
    const o = {};
    for (const c of COLS[table]) {
      let v = row[c];
      if (v === undefined) v = null;
      if (TS.has(c) && v) { const t = Date.parse(v); v = isNaN(t) ? v : new Date(t).toISOString(); }
      if (STR.has(c) && v == null) v = '';
      if (c === 'reminders') v = Array.isArray(v) ? v.map(Number).sort((a, b) => a - b) : [];
      if (c === 'expires_on' && v === '') v = null;
      if (c === 'expires_time' && v === '') v = null;
      o[c] = v;
    }
    return o;
  }
  function toRemote(table, local) {
    const r = norm(table, local);
    r.user_id = Y.user.id;
    return r;
  }
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const dataFields = table => COLS[table].filter(c => !META.has(c));

  /* ---------- 三方比較 ---------- */
  function merge3(table, base, local, remote) {
    const merged = { ...remote };
    const conflicts = [];
    const changedL = [], changedR = [];
    for (const f of dataFields(table)) {
      const b = base ? base[f] : undefined, l = local[f], r = remote[f];
      if (base && !same(l, b)) changedL.push(f);
      if (base && !same(r, b)) changedR.push(f);
      if (same(l, r)) { merged[f] = l; continue; }
      if (base && same(l, b)) { merged[f] = r; continue; }
      if (base && same(r, b)) { merged[f] = l; continue; }
      conflicts.push(f);
    }
    const drop = f => { const i = conflicts.indexOf(f); if (i >= 0) conflicts.splice(i, 1); };

    if (table === 'tickets') {
      // 規則 1：只要任一邊標記「已使用」，就保留已使用（避免同一張券被當成還能用）
      if (conflicts.includes('status') && (local.status === 'used' || remote.status === 'used')) {
        const src = local.status === 'used' ? local : remote;
        merged.status = 'used'; merged.used_at = src.used_at; drop('status'); drop('used_at');
      }
      // 規則 2：兩邊都已使用、只是時間不同 → 取較早的時間
      if (conflicts.includes('used_at') && local.status === 'used' && remote.status === 'used') {
        merged.used_at = [local.used_at, remote.used_at].filter(Boolean).sort()[0] || null; drop('used_at');
      }
      // 規則 3：一邊刪除、另一邊修改了內容 → 不自動決定，詢問使用者
      const delL = !!local.deleted_at && !(base && base.deleted_at);
      const delR = !!remote.deleted_at && !(base && base.deleted_at);
      if (delL !== delR) {
        const otherChanged = (delL ? changedR : changedL).some(f => f !== 'deleted_at');
        if (otherChanged && !conflicts.includes('deleted_at')) conflicts.push('deleted_at');
      } else if (delL && delR) { merged.deleted_at = remote.deleted_at; drop('deleted_at'); }
    } else {
      // 圖片：順序、類型、主要圖片 → 以較晚修改的一方為準；刪除與修改衝突時保留圖片
      const later = (local.updated_at || '') > (remote.updated_at || '') ? local : remote;
      for (const f of ['kind', 'sort', 'is_primary']) if (conflicts.includes(f)) { merged[f] = later[f]; drop(f); }
      if (conflicts.includes('deleted_at')) { merged.deleted_at = null; drop('deleted_at'); }
      if (!!local.deleted_at !== !!remote.deleted_at && (changedL.length && changedR.length)) merged.deleted_at = null;
    }
    merged.id = remote.id; merged.version = remote.version; merged.created_at = remote.created_at || local.created_at;
    return { merged, conflicts };
  }

  /* ---------- 雲端存取 ---------- */
  async function fetchOne(table, id) {
    const { data, error } = await Y.client.from(table).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? norm(table, data) : null;
  }
  // 推送成功：如果本機在上傳期間沒有再被修改，就把雲端版本寫回本機
  async function accept(table, sent, remote) {
    const cur = await get(table, sent.id);
    const ops = [{ store: 'sync_base', value: { key: keyOf(table, sent.id), row: remote } }];
    if (cur && cur.updated_at === sent.updated_at) ops.push({ store: table, value: { ...cur, ...remote } });
    await sw(ops);
  }
  async function pushOne(table, local, depth = 0) {
    const key = keyOf(table, local.id);
    const baseRec = await get('sync_base', key);
    const base = baseRec && baseRec.row;
    const payload = toRemote(table, local);
    if (!base) {
      payload.version = 1;
      const { data, error } = await Y.client.from(table).insert(payload).select().single();
      if (!error) { await accept(table, local, norm(table, data)); return 'ok'; }
      if (error.code === '23505') {                       // 已經在雲端（例如上次回應遺失）
        const remote = await fetchOne(table, local.id);
        if (!remote) throw error;
        return resolve(table, local, null, remote, depth);
      }
      throw error;
    }
    payload.version = base.version + 1;
    const { data, error } = await Y.client.from(table).update(payload).eq('id', local.id).eq('version', base.version).select();
    if (error && error.code !== '40001') throw error;
    if (!error && data && data.length) { await accept(table, local, norm(table, data[0])); return 'ok'; }
    const remote = await fetchOne(table, local.id);       // 版本不符：別的裝置先改了
    if (!remote) {
      if (depth > 2) throw new Error('雲端找不到這筆資料');
      await sw([{ store: 'sync_base', del: key }]);
      return pushOne(table, local, depth + 1);
    }
    return resolve(table, local, base, remote, depth);
  }
  async function resolve(table, local, base, remote, depth) {
    const key = keyOf(table, local.id);
    const { merged, conflicts } = merge3(table, base, local, remote);
    if (conflicts.length) {
      await sw([{ store: 'conflicts', value: { key, table, id: local.id, base, local, remote, fields: conflicts, at: nowISO() } }]);
      return 'conflict';
    }
    const differs = dataFields(table).some(f => !same(merged[f], remote[f]));
    if (!differs) { await accept(table, local, remote); return 'ok'; }
    const m = { ...local, ...merged, updated_at: nowISO() };
    await sw([{ store: table, value: m }, { store: 'sync_base', value: { key, row: remote } }]);
    if (depth > 2) throw new Error('同步重試次數過多');
    return pushOne(table, m, depth + 1);
  }

  async function pushRows(table) {
    const queue = (await all('sync_queue')).filter(q => q.table === table);
    if (!queue.length) return;
    const conflictKeys = new Set((await all('conflicts')).map(c => c.key));
    const byId = new Map();
    for (const q of queue) { if (!byId.has(q.record_id)) byId.set(q.record_id, []); byId.get(q.record_id).push(q.id); }
    for (const [id, qids] of byId) {
      if (conflictKeys.has(keyOf(table, id))) continue;
      const local = await get(table, id);
      if (local) {
        try { await pushOne(table, local); }
        catch (e) {
          if (e && e.code === '23503') continue;              // 票券本身還沒上傳成功，下次再試
          throw e;
        }
      }
      await sw(qids.map(q => ({ store: 'sync_queue', del: q })));
    }
  }

  /* ---------- 圖片檔案 ---------- */
  const pathOf = hash => `${Y.user.id}/${hash}`;
  async function pushBlobs() {
    const blobs = (await all('blobs')).filter(b => !b.uploaded);
    if (!blobs.length) return;
    const used = new Set((await all('ticket_images')).map(i => i.hash));
    for (const b of blobs) {
      if (!used.has(b.hash)) continue;
      const { data: exist, error: e1 } = await Y.client.from('image_files').select('hash').eq('hash', b.hash).maybeSingle();
      if (e1) throw e1;
      if (!exist) {
        const file = b.data ? new Blob([b.data], { type: b.type || 'image/jpeg' }) : b.blob;
        const { error: e2 } = await Y.client.storage.from(BUCKET).upload(pathOf(b.hash), file, { contentType: b.type || 'image/jpeg', upsert: false });
        if (e2 && !/exist|duplicate/i.test(e2.message || '') && String(e2.statusCode) !== '409') throw e2;
        const { error: e3 } = await Y.client.from('image_files').upsert(
          { user_id: Y.user.id, hash: b.hash, path: pathOf(b.hash), content_type: b.type || 'image/jpeg', size: b.size || 0 },
          { onConflict: 'user_id,hash', ignoreDuplicates: true });
        if (e3) throw e3;
      }
      const cur = await get('blobs', b.hash);
      if (cur) await sw([{ store: 'blobs', value: { ...cur, uploaded: true } }]);
    }
  }
  async function downloadMissing(limit = 30) {
    const have = new Set((await all('blobs')).map(b => b.hash));
    const need = [...new Set((await all('ticket_images')).filter(i => !i.deleted_at && !have.has(i.hash)).map(i => i.hash))];
    let n = 0;
    for (const hash of need.slice(0, limit)) {
      const { data, error } = await Y.client.storage.from(BUCKET).download(pathOf(hash));
      if (error || !data) continue;                      // 另一台裝置可能還沒上傳完，下次再抓
      await sw([{ store: 'blobs', value: { hash, data: await data.arrayBuffer(), type: data.type || 'image/jpeg', size: data.size, uploaded: true, created_at: nowISO() } }]);
      n++;
    }
    return n;
  }

  /* ---------- 下載雲端變更 ---------- */
  async function pull() {
    const ck = 'pull_cursor:' + Y.user.id;
    const rec = await get('meta', ck);
    const since = rec ? new Date(Date.parse(rec.value) - 10 * 60 * 1000).toISOString() : '1970-01-01T00:00:00Z';
    let maxSeen = rec ? rec.value : null, changed = 0;
    const queued = new Set((await all('sync_queue')).map(q => keyOf(q.table, q.record_id)));
    const conflicted = new Set((await all('conflicts')).map(c => c.key));
    for (const table of TABLES) {
      let cursor = since;
      for (;;) {
        const { data, error } = await Y.client.from(table).select('*').gt('server_updated_at', cursor).order('server_updated_at', { ascending: true }).limit(500);
        if (error) throw error;
        const ops = [];
        for (const raw of data) {
          const r = norm(table, raw);
          const key = keyOf(table, r.id);
          if (queued.has(key) || conflicted.has(key)) continue;   // 本機有尚未上傳的修改，交給推送流程比對
          const baseRec = await get('sync_base', key);
          const local = await get(table, r.id);
          if (baseRec && local && baseRec.row.version >= r.version) continue;
          ops.push({ store: table, value: { ...(local || {}), ...r } }, { store: 'sync_base', value: { key, row: r } });
          changed++;
        }
        await sw(ops);
        if (data.length) {
          cursor = data[data.length - 1].server_updated_at;
          if (!maxSeen || Date.parse(cursor) > Date.parse(maxSeen)) maxSeen = cursor;
        }
        if (data.length < 500) break;
      }
    }
    if (maxSeen) await sw([{ store: 'meta', value: { key: ck, value: maxSeen } }]);
    return changed;
  }

  /* ---------- 主流程 ---------- */
  async function refreshCounts() {
    const q = await all('sync_queue');
    Y.pending = new Set(q.map(x => keyOf(x.table, x.record_id))).size;
    Y.conflicts = (await all('conflicts')).length;
  }
  function schedule(delay = 1500) {
    clearTimeout(Y.timer);
    Y.timer = setTimeout(run, delay);
  }
  async function run() {
    if (!Y.client || !Y.user || Y.state === 'paused') { await refreshCounts(); notify(); return; }
    if (Y.running) { Y.again = true; return; }
    if (navigator.onLine === false) { await refreshCounts(); setState('offline', '目前沒有網路'); return; }
    Y.running = true;
    setState('syncing');
    let changed = 0;
    try {
      await pushBlobs();
      await pushRows('tickets');
      await pushRows('ticket_images');
      changed += await pull();
      changed += await downloadMissing();
      Y.failures = 0; Y.lastSync = new Date();
      await refreshCounts();
      setState('ok');
    } catch (e) {
      console.warn('同步失敗', e);
      Y.failures++;
      await refreshCounts().catch(() => {});
      const offline = navigator.onLine === false || /fetch|network|load failed|timeout/i.test((e && (e.message || e.name)) || '');
      const msg = (e && (e.message || e.code)) || '未知錯誤';
      const schema = /does not exist|relation|schema cache|PGRST20[45]|42703|42P01/i.test(msg + ' ' + (e && e.code));
      setState(offline ? 'offline' : 'error', offline ? '雲端暫時連不上，資料都還在這台裝置'
        : schema ? '雲端資料表和 App 版本不符（' + msg + '），請執行 supabase/fix-old-tables.sql 與 schema.sql'
        : '同步失敗：' + msg);
      schedule(Math.min(30000 * 2 ** (Y.failures - 1), 10 * 60 * 1000));
    } finally {
      Y.running = false;
      if (changed && window.onSyncData) window.onSyncData();
      if (Y.again) { Y.again = false; schedule(300); }
    }
  }

  async function setUser(u) {
    Y.user = u || null;
    if (!u) { await refreshCounts(); setState('signedout'); return; }
    const owner = await get('meta', 'owner_uid');
    if (owner && owner.value !== u.id) {
      setState('paused', `這台裝置上的票券屬於另一個帳號（${owner.email || '未知'}），已暫停同步`);
      return;
    }
    if (!owner) {
      // 第一次在這台裝置登入：把現有的本機票券全部排入上傳
      const ops = [{ store: 'meta', value: { key: 'owner_uid', value: u.id, email: u.email || '' } }];
      for (const table of TABLES) for (const r of await all(table)) {
        if (!(await get('sync_base', keyOf(table, r.id)))) ops.push(queueOp(table, r.id, 'insert'));
      }
      await sw(ops);
    }
    schedule(200);
  }

  async function init() {
    if (Y.state === 'off') { notify(); return; }
    try {
      const create = window.__qqCreateClient || (await import(LIB)).createClient;   // __qqCreateClient 只用於測試
      Y.client = create(CFG.supabaseUrl, CFG.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
    } catch (e) {
      console.warn('雲端模組載入失敗', e);
      setState('offline', '雲端模組無法載入（可能沒有網路），本機功能照常');
      window.addEventListener('online', () => { if (!Y.client) init(); }, { once: true });
      return;
    }
    Y.client.auth.onAuthStateChange((event, session) => {
      const u = session && session.user;
      if ((u && u.id) !== (Y.user && Y.user.id)) setUser(u);
    });
    try {
      const { data } = await Y.client.auth.getSession();
      await setUser(data && data.session && data.session.user);
    } catch (e) { await setUser(null); }
    window.addEventListener('online', () => schedule(500));
    window.addEventListener('offline', () => setState('offline', '目前沒有網路'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(500); });
    setInterval(() => { if (!document.hidden) schedule(0); }, 2 * 60 * 1000);
  }

  /* ---------- 衝突處理 ---------- */
  async function resolveConflict(key, choice) {
    const c = await get('conflicts', key);
    if (!c) return;
    const { merged } = merge3(c.table, c.base, c.local, c.remote);
    for (const f of c.fields) {
      const src = choice[f] === 'local' ? c.local : c.remote;
      merged[f] = src[f];
      if (f === 'status') merged.used_at = src.used_at;
    }
    const cur = await get(c.table, c.id);
    const final = { ...(cur || c.local), ...merged, updated_at: nowISO() };
    await sw([
      { store: c.table, value: final },
      { store: 'sync_base', value: { key, row: c.remote } },
      queueOp(c.table, c.id, 'update'),
      { store: 'conflicts', del: key },
    ]);
    await refreshCounts();
    schedule(200);
  }

  async function clearLocalForNewAccount() {
    const ops = [];
    for (const s of ['tickets', 'ticket_images', 'blobs', 'sync_queue', 'sync_base', 'conflicts']) for (const r of await all(s)) ops.push({ store: s, del: r[STORES[s]] });
    for (const r of await all('meta')) if (r.key === 'owner_uid' || r.key.startsWith('pull_cursor:')) ops.push({ store: 'meta', del: r.key });
    await write(ops, { fromSync: true });
    Y.state = 'loading';
    await setUser(Y.user);
  }

  window.Sync = {
    init, schedule, merge3, LABEL,
    get status() { return { state: Y.state, detail: Y.detail, lastSync: Y.lastSync, pending: Y.pending, conflicts: Y.conflicts, email: Y.user && Y.user.email, configured: Y.state !== 'off' }; },
    onChange(fn) { Y.listeners.add(fn); },
    syncNow() { schedule(0); },
    async sendCode(email) {
      const { error } = await Y.client.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
    },
    async verifyCode(email, token) {
      const { data, error } = await Y.client.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
      return data;
    },
    async signInGoogle() {
      const { error } = await Y.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
      if (error) throw error;
    },
    async signOut() { await Y.client.auth.signOut({ scope: 'local' }); await setUser(null); },
    // 呼叫 Edge Function；所有錯誤都整理成 { ok:false, code, message }
    async invoke(name, body, ms = 40000) {
      if (!Y.client || !Y.user) return { ok: false, code: 'AI_SERVICE_ERROR', message: '請先登入雲端同步' };
      const timeout = new Promise(r => setTimeout(() => r({ ok: false, code: 'AI_TIMEOUT', message: 'AI 回應逾時' }), ms));
      const call = (async () => {
        try {
          const { data, error } = await Y.client.functions.invoke(name, { body });
          if (!error) return data;
          let payload = null;
          try { payload = error.context && await error.context.json(); } catch {}
          if (payload && payload.code) return payload;
          const status = error.context && error.context.status;
          if (status === 404) return { ok: false, code: 'AI_SERVICE_ERROR', message: 'AI 辨識功能還沒部署（Edge Function：recognize）', reason: 'not_deployed' };
          if (status === 401) return { ok: false, code: 'AI_SERVICE_ERROR', message: '登入已過期，請重新登入', reason: 'unauthorized' };
          return { ok: false, code: 'AI_SERVICE_ERROR', message: navigator.onLine === false ? '目前離線' : 'AI 服務連線失敗' };
        } catch (e) { return { ok: false, code: 'AI_SERVICE_ERROR', message: 'AI 服務連線失敗' }; }
      })();
      return Promise.race([call, timeout]);
    },
    resolveConflict, clearLocalForNewAccount,
    conflicts: () => all('conflicts'),
    ready: () => !!Y.client,
  };

  (window.appReady || Promise.resolve()).then(init);
})();
