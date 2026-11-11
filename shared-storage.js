(function () {
  'use strict';
  const cfg = window.SHARED_STORAGE_CONFIG || {};
  const base = String(cfg.url || '').replace(/\/$/, '');
  const key = cfg.anonKey || '';
  const enabled = Boolean(base && key);
  const storageKey = 'wakuwaku-private-character-master-v1';
  const scope = `${base}:${cfg.table || 'character_masters'}:${cfg.id || 'main'}`;
  const pendingKey = `${storageKey}:pending:${scope}`;
  const migrationKey = `${storageKey}:migrated:${scope}`;
  const endpoint = `${base}/rest/v1/${cfg.table || 'character_masters'}?id=eq.${encodeURIComponent(cfg.id || 'main')}`;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${key}`;
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const same = (a, b) => a === b || (a != null && b != null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k])));
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  let baseline, desired, started, running, pending = false, initialized = false, pauseRefresh = false;

  // Three-way merge preserves other users' edits and rejects conflicting values.
  function merge(before, local, remote, path = '') {
    if (same(before, local)) return copy(remote);
    if (same(before, remote) || same(local, remote)) return copy(local);
    const field = path.split('.').pop();
    const identity = field === 'characters' ? 'encyclopediaNumber' : field === 'friendshipCatalog' ? 'name' : null;
    if (identity && Array.isArray(local) && Array.isArray(remote)) {
      const map = items => new Map((items || []).map(item => [String(item[identity]), item]));
      const a = map(before), b = map(local), c = map(remote), result = [];
      for (const id of new Set([...a.keys(), ...b.keys(), ...c.keys()])) {
        const value = merge(a.get(id), b.get(id), c.get(id), `${path}.${id}`);
        if (value !== undefined) result.push(value);
      }
      if (identity === 'encyclopediaNumber') result.sort((a, b) => b.encyclopediaNumber - a.encyclopediaNumber);
      return result;
    }
    if (object(before) && object(local) && object(remote)) {
      const result = {};
      for (const field of new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(remote)])) {
        const value = ['updatedAt', 'sharedUpdatedAt'].includes(field) ? (local[field] || remote[field]) : merge(before[field], local[field], remote[field], `${path}.${field}`);
        if (value !== undefined) result[field] = value;
      }
      return result;
    }
    throw new Error(`同じ項目が別の端末でも変更されています (${path})。端末内のJSONを書き出して内容を確認してください。`);
  }
  function status(message, kind) {
    document.querySelectorAll('[data-sync-status]').forEach(node => { node.textContent = message; node.dataset.state = kind; });
  }
  function persist() {
    if (pending) localStorage.setItem(pendingKey, JSON.stringify({ baseline, desired }));
    else localStorage.removeItem(pendingKey);
  }
  function publish(data) {
    localStorage.setItem(storageKey, JSON.stringify(data));
    window.dispatchEvent(new CustomEvent('shared-master-updated', { detail: copy(data) }));
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`共有保存に接続できません (${response.status})`);
    return response.json();
  }
  async function read() {
    const rows = await request(`${endpoint}&select=data,revision`);
    if (!rows[0]?.data?.characters || !Number.isInteger(rows[0].revision)) throw new Error('共有DBの初期データが未設定です。');
    return rows[0];
  }
  async function flush() {
    if (!enabled) return true;
    if (running) return running;
    running = (async () => {
      try {
        await started;
        for (let attempt = 0; pending && attempt < 8; attempt++) {
          status('共有データを保存中…', 'loading');
          const remote = await read(), snapshot = copy(desired);
          const combined = merge(baseline, snapshot, remote.data);
          let saved = remote.data;
          if (!same(combined, remote.data)) {
            const rows = await request(`${endpoint}&revision=eq.${remote.revision}`, {
              method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ data: combined })
            });
            if (!rows.length) continue;
            saved = rows[0].data;
          }
          desired = merge(snapshot, desired, saved);
          baseline = copy(saved);
          pending = !same(baseline, desired);
          persist(); publish(desired);
        }
        if (pending) throw new Error('同時更新が続いています。しばらくしてから再送してください。');
        status('共有データに保存済み', 'shared');
        return true;
      } catch (error) {
        console.error(error);
        status(`${error.message}（端末内に保存・未送信）`, 'error');
        return false;
      }
    })();
    try { return await running; } finally { running = null; }
  }
  async function refresh() {
    if (!enabled || !started || running) return;
    await started;
    if (!initialized) { started = null; return window.SharedMasterStore.start(desired); }
    if (pending) return flush();
    if (pauseRefresh) return;
    try {
      const remote = await read();
      if (running || pending) return;
      baseline = copy(remote.data); desired = copy(remote.data); publish(desired);
      status('共有データを使用中', 'shared');
    } catch (error) { status(`${error.message}（端末内のデータを表示中）`, 'error'); }
  }
  window.SharedMasterStore = {
    enabled,
    start(local) {
      if (started) return started;
      baseline = copy(local); desired = copy(local);
      if (!enabled) { status('この端末内に保存中', 'local'); return Promise.resolve(null); }
      started = (async () => {
        try {
          const saved = localStorage.getItem(pendingKey);
          if (saved) { const state = JSON.parse(saved); baseline = state.baseline; desired = state.desired; pending = true; }
          if (!localStorage.getItem(migrationKey)) localStorage.setItem(`${storageKey}:before-supabase`, JSON.stringify(local));
          const remote = await read();
          if (!pending) {
            desired = copy(remote.data);
            if (!localStorage.getItem(migrationKey)) {
              const numbers = new Set(desired.characters.map(c => c.encyclopediaNumber));
              desired.characters.push(...(local.characters || []).filter(c => !numbers.has(c.encyclopediaNumber)));
            }
            baseline = copy(remote.data);
            pending = !same(baseline, desired);
            persist();
          }
          localStorage.setItem(migrationKey, '1');
          initialized = true;
          publish(desired);
          status(pending ? '端末内の変更を共有DBへ送信待ち' : '共有データを使用中', pending ? 'loading' : 'shared');
          return copy(desired);
        } catch (error) {
          status(`${error.message}（端末内のデータを表示中）`, 'error');
          return null;
        }
      })();
      started.then(() => { if (pending) void flush(); });
      return started;
    },
    save(data) {
      if (!enabled) return Promise.resolve(true);
      if (!started) this.start(baseline || data);
      desired = copy(data); pending = true;
      try { persist(); } catch (error) { status('端末の保存容量が不足しています。JSONを書き出してください。', 'error'); return Promise.resolve(false); }
      return flush();
    },
    flush, refresh, pauseRefresh() { pauseRefresh = true; }
  };
  window.addEventListener('online', () => void refresh());
  window.addEventListener('focus', () => void refresh());
  window.addEventListener('beforeunload', event => { if (pending) { event.preventDefault(); event.returnValue = ''; } });
  setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
})();
