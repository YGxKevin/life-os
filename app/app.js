/* LIFE//OS — 互動邏輯
 * 看板本身就是資料來源：所有新增／修改／刪除都直接存進 data.json（透過 server.py）。
 */
(async () => {
  'use strict';
  const CODE_V = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch (e) { return ''; } })();   // 這頁載入的程式版本（server 寫進 index.html 的 ?v=）
  const SEED = window.KOS_SEED, SEED_R = window.KOS_ROUTINES;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* 重畫一律走 paint()：跟「上次畫進去的字串」比，一樣就不動 DOM（同步別台、每秒更新都不會洗掉游標和打到一半的字）。
     真的要重畫時，「新增」欄位打到一半的字和游標會帶過去；正在選中文字（輸入法組字）就先不畫，選完補畫。 */
  const painted = new WeakMap();
  let composing = false;
  const DRAFT = 'form[data-form] [name="name"]';
  function paint(el, html) {
    if (!el || painted.get(el) === html) return false;
    const act = document.activeElement, mine = !!act && el.contains(act);
    if (mine && composing) return false;
    const key = (i) => i.closest('form').dataset.form;
    const drafts = [...el.querySelectorAll(DRAFT)].map((i) => [key(i), i.value]).filter(([, v]) => v);
    const keep = mine && act.matches(DRAFT) ? [key(act), act.selectionStart, act.selectionEnd] : null;
    el.innerHTML = html; painted.set(el, html);
    const find = (k) => el.querySelector(`form[data-form="${k}"] [name="name"]`);
    for (const [k, v] of drafts) { const i = find(k); if (i) { i.value = v; if (i.matches('textarea.auto')) { i.style.height = 'auto'; i.style.height = i.scrollHeight + 4 + 'px'; } } }
    const i = keep && find(keep[0]);
    if (i) { i.focus({ preventScroll: true }); try { i.setSelectionRange(keep[1], keep[2]); } catch (e) { /* 有些欄位不支援 */ } }
    return true;
  }
  const P = (sel) => ({ set html(v) { paint($(sel), v); } });
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; setTimeout(() => { if (!views.dash.hidden) renderDash(); }, 0); });
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const TODAY = ymd(new Date());
  const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPEED = reduced ? 0.25 : 1;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const fmtDur = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const mmdd = (s) => s.slice(5).replace('-', '/');

  const PALETTE = ['c-cyan', 'c-pur', 'c-org', 'c-yel', 'c-grn', 'c-mag'];
  const DEFAULT_OPTS = {
    pStatus: [{ n: '收件匣', c: 'c-dim' }, { n: '規劃中', c: 'c-pur' }, { n: '執行中', c: 'c-cyan' }, { n: '等待中', c: 'c-org' }, { n: '暫停', c: 'c-yel' }, { n: '已結案', c: 'c-grn' }],
    confirm: [{ n: '建議草案', c: 'c-dim' }, { n: '已確認', c: 'c-grn' }],
    tStatus: [{ n: '未開始', c: 'c-dim' }, { n: '進行中', c: 'c-cyan' }, { n: '等待中', c: 'c-org' }, { n: '完成', c: 'c-grn' }],
    tType: [{ n: '里程碑', c: 'c-pur' }, { n: '行動', c: 'c-cyan' }, { n: '待確認', c: 'c-org' }],
    why: [{ n: '時間', c: 'c-cyan' }, { n: '資料', c: 'c-pur' }, { n: '協作', c: 'c-org' }, { n: '步驟太大', c: 'c-mag' }]
  };
  /* 看板邏輯會用到的選項（收件匣、執行中統計、結案、完成打勾…），不能刪 */
  const LOCKED = { pStatus: ['收件匣', '執行中', '已結案'], confirm: ['已確認'], tStatus: ['未開始', '等待中', '完成', '已放棄'], tType: ['里程碑', '待確認'] };
  const DOMAIN_C0 = { W: 'c-cyan', S: 'c-mag', L: 'c-pur', F: 'c-grn' };

  /* ══════════ 資料：讀取與存檔 ══════════ */
  const lsGet = () => { try { const v = localStorage.getItem('kos.state'); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  /* 第一次開啟：seed.js 的說明卡（每個功能一張），補齊欄位後當成起始資料 */
  function fromSeed() {
    const s = JSON.parse(JSON.stringify(SEED));
    s.projects = (s.projects || []).map(newProject);
    s.tasks = (s.tasks || []).map(newTask);
    s.reviews = (s.reviews || []).map(newReview);
    s.routines ||= { am: [...SEED_R.am], pm: [...SEED_R.pm] };
    return Object.assign(s, { v: 1, days: {}, muted: false });
  }
  function newProject(o) { return Object.assign({ id: uid('p'), code: '', name: '', domain: '', status: '收件匣', confirm: '', focus: false, next: '', block: '', result: '', done: '', verify: '', due: '', closedAt: '' }, o); }
  function newTask(o) { return Object.assign({ id: uid('t'), p: '', type: '行動', status: '未開始', name: '', sched: '', est: '', wait: '' }, o); }
  function newReview(o) { return Object.assign({ id: uid('r'), name: '', start: '', end: '', result: '', exec: '', stuck: '', why: [], adjust: '', inboxSorted: false }, o); }

  /* 這台的兩份備份：kos.state＝這台現在的樣子（含還沒送出的修改），kos.base＝上次跟主機一致時的樣子。
     兩份的 _rev 都是那時主機的版本號。打開時連不到主機、或上次有修改沒送出，靠這兩份把修改補送回去，不會丟。 */
  const lsBase = () => { try { const v = localStorage.getItem('kos.base'); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const setBase = (json) => { baseSnap = json; try { localStorage.setItem('kos.base', json); } catch (e) { /* 沒有也沒關係 */ } };
  const plain = (x) => { const { _rev, _savedAt, _by, ...o } = x; return JSON.stringify(o); };
  let online = false, seeded = false, bootOff = false, bootPush = false, bootBase = null;
  /* 主機上有資料時，看這台有沒有上次沒送出的修改：主機沒變過 → 用這台的；主機變過 → 三方合併 */
  function recoverLocal(s) {
    const ls = lsGet();
    if (!ls || !Array.isArray(ls.projects) || plain(ls) === plain(s)) return s;
    if (ls._rev === s._rev) { bootPush = true; bootBase = JSON.stringify(s); return ls; }
    const b = lsBase();
    if (b && b._rev === ls._rev && plain(b) !== plain(ls)) { bootPush = true; bootBase = JSON.stringify(s); return merge(b, ls, JSON.parse(bootBase)); }
    /* 舊版沒有 kos.base：主機最新一版正好是這台自己存的（版本只差 1）→ 這台的資料就是那一版再加上沒送出的修改 */
    const ua = navigator.userAgent, me = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '瀏覽器';
    if (!b && ls._rev === s._rev - 1 && s._by === me) { bootPush = true; bootBase = JSON.stringify(s); ls._rev = s._rev; return ls; }
    return s;
  }
  async function load() {
    if (location.protocol.startsWith('http')) {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        if (r.ok) {
          online = true;
          const s = await r.json();
          if (s && Array.isArray(s.projects)) return recoverLocal(s);
          seeded = true; return fromSeed();          // 伺服器在、但還沒有 data.json → 用初始資料開始
        }
      } catch (e) { /* 主機暫時連不到 */ }
      const ls = lsGet();
      if (ls && Array.isArray(ls.projects)) {      // 先用這台存的資料，標 OFFLINE；之後每 5 秒重試，連上就合併、存檔
        online = true; bootOff = true;
        const b = lsBase(); bootBase = b && b._rev === ls._rev ? JSON.stringify(b) : JSON.stringify(ls);
        return ls;
      }
    }
    return lsGet() || fromSeed();                    // 離線模式：只存在這個瀏覽器
  }
  let baseSnap = null;
  const state = await load();
  let day, dayKey, O;
  /* 補上缺的欄位，並把 day／O 指到目前的 state（從別的裝置載入新資料後也要重跑一次） */
  function normalize() {
    state.projects ||= []; state.tasks ||= []; state.reviews ||= []; state.days ||= {};
    state.domains ||= SEED.domains.map((d) => ({ ...d }));
    state.routines ||= { am: [...SEED_R.am], pm: [...SEED_R.pm] };
    /* 「今日」以按下結束今日為準，不是午夜：前一天還開著（沒按結束）就繼續算那一天 */
    const tp = state.days[TODAY]?.phase;
    const open = tp === 'on' || tp === 'ended' ? null
      : Object.keys(state.days).filter((k) => k < TODAY && state.days[k].phase === 'on').sort().pop();
    dayKey = open || TODAY;
    day = state.days[dayKey] ||= { phase: 'off', am: {}, pm: {}, startedAt: null, endedAt: null };
    if (!state.rtV) {                              // 11/22 以前做完的 routine 沒有完成時間：當作準時（那時過了時間就鎖住，不可能晚勾）
      for (const d of Object.values(state.days)) for (const k of ['am', 'pm']) { const it = state.routines[k] || []; if (d[k] && it.length && it.every((x) => d[k][x])) d[k + 'At'] ??= 1; }
      state.rtV = 1;
    }
    state.opts ||= {};
    for (const k in DEFAULT_OPTS) state.opts[k] ||= DEFAULT_OPTS[k].map((o) => ({ ...o }));
    state.domains.forEach((d, i) => { d.c ||= DOMAIN_C0[d.code] || PALETTE[i % PALETTE.length]; });
    state.sfx ||= { voice: 'bass', vol: 3, pitch: true };
    state.sfx.miss ||= 'thump';
    if (typeof state.sfx.cash !== 'string') state.sfx.cash = '';   // 購買的聲音：''＝收銀機（預設）、'none'＝無聲、'file:檔名'＝sounds/ 裡的音檔
    O = state.opts;
    /* 錢包：第一次啟用時，已經完成的東西記在 base 裡，不補發獎勵 */
    if (!state.wallet) { state.wallet = { rates: JSON.parse(JSON.stringify(RATE0)), base: [], log: [], habitV: 1, pmV: 1 }; state.wallet.base = rewardables().map((w) => w[0]); }
    const W = state.wallet;
    W.rates ||= {}; W.rates.types ||= {}; W.base ||= []; W.log ||= [];
    for (const k of ['other', 'project', 'am', 'pm', 'late', 'habit', 'daily', 'review', 'focus', 'wake']) W.rates[k] ??= RATE0[k];
    if (!W.pmV) { if (W.rates.pm === 10) W.rates.pm = 30; W.pmV = 1; }   // 11/19：睡前完成晚間關機程序改成 $30
    /* LIFE 區：習慣、每日紀錄（日記／三餐／體重／睡眠）、專注紀錄；任務的完成時間 doneAt（印記用） */
    state.habits ||= [];
    state.habits.forEach((x) => { x.log ||= {}; });
    state.daylog ||= {}; state.focus ||= [];
    if (!Array.isArray(state.shop)) state.shop = [];   // 商店的商品、已購紀錄
    if (!Array.isArray(state.buys)) state.buys = [];
    if (typeof state.goal !== 'string') state.goal = '';   // 鎖定的目標（商品 id）
    if (!W.habitV) {                               // 習慣開始算獎勵金之前就打過的勾不補發
      for (const x of state.habits) for (const d in x.log) W.base.push(`h:${x.id}:${d}`);
      W.habitV = 1;
    }
    /* 每日任務的類別；任務多了 cat（類別）、pri（優先級 0–3）、note（詳情）、subs（子任務）；狀態多一個「已放棄」 */
    state.cats ||= [];
    if (typeof state.brand !== 'string') state.brand = '';   // OS 前面的名字（XXX//OS），空的＝還沒取名，待機畫面會請你輸入
    if (!O.tStatus.some((o) => o.n === '已放棄')) O.tStatus.push({ n: '已放棄', c: 'c-dim' });
    if (!state.stampV) {                           // 舊資料：完成時間用入帳時間回推，查不到的記 0（不出現在印記）
      for (const t of state.tasks) if (t.status === '完成' && t.doneAt == null) t.doneAt = W.log.find((e) => e.ref === 't:' + t.id)?.at || 0;
      state.stampV = 1;
    }
  }

  /* ══════════ 結算：完成就入帳（1 點＝NT$1） ══════════
     不在各個按鈕裡加減錢，而是每次存檔前對一次帳：
     「現在已完成的東西」都該有一筆入帳；取消完成的那筆收回。這樣不管從哪裡勾、哪台裝置勾都不會漏或重複。 */
  /* 晨間啟動程序的獎勵只給 dayKey 那天 09:00 前做完的；晚間關機程序（睡前準備）只給隔天 01:00 前做完的。
     過了時間清單照樣可以勾、照樣能開始／結束今日，只是不發獎勵（11/22 使用者要求，原本是鎖住）。
     做完的時間記在 day.amAt／day.pmAt（settle() 蓋章：全部勾完那一刻；有一項取消就拿掉）。
     這幾個放在 rewardables() 前面、只用 state 本身，因為 normalize() 第一次建錢包時就會呼叫 rewardables() */
  const AM_END = 9, PM_END = 1;
  const rtEnd = (kind) => { const [y, m, d] = dayKey.split('-').map(Number); return kind === 'am' ? new Date(y, m - 1, d, AM_END) : new Date(y, m - 1, d + 1, PM_END); };
  const rtLocked = (kind) => Date.now() >= rtEnd(kind).getTime();     // 過了時間（名稱沿用，現在只代表「不給獎勵了」）
  const rtAll = (kind) => { const it = state.routines[kind] || []; return it.length > 0 && it.every((t) => day[kind][t]); };
  const rtOnTime = (kind) => rtAll(kind) && (day[kind + 'At'] ?? 0) < rtEnd(kind).getTime();
  const RATE0 = { types: { '行動': 10, '里程碑': 50, '待確認': 5 }, other: 10, project: 300, am: 10, pm: 30, late: 5, habit: 5, daily: 10, review: 30, focus: 1, wake: 50 };   // late＝逾期完成每天少幾 %
  function rewardables() {                       // 目前「已完成」的項目 → [編號, 金額, 說明]
    const R = state.wallet.rates, out = [], now = ymd(new Date());
    /* 逾期完成：超過排定日期／期限每一天少 R.late %，最低 1 元（入帳當下算一次，之後不再變） */
    const late = (amt, due, note) => {
      const d = due ? dayDiff(due, now) : 0, base = Math.max(0, Math.round(+amt || 0));
      if (d <= 0 || !R.late || base <= 1) return [base, note];
      const got = Math.max(1, Math.round(base * (1 - d * R.late / 100)));
      return [got, `${note}（逾期 ${d} 天，${money(base)} → ${money(got)}）`];
    };
    /* 每日任務照優先級加成：! +10%、!! +20%、!!! +30%（11/23 使用者要求，最多 30%），先加成再算逾期 */
    const priUp = (t) => { const n = Math.min(3, Math.max(0, +t.pri || 0)); return n ? [Math.round(R.daily * (1 + n / 10)), `（${'!'.repeat(n)} +${n * 10}%）`] : [R.daily, '']; };
    for (const t of state.tasks) if (t.status === '完成') out.push(['t:' + t.id, ...(state.projects.some((p) => p.id === t.p) ? late(R.types[t.type] ?? R.other, t.sched, `${t.type || '任務'}：${t.name || '（未命名）'}`) : late(priUp(t)[0], t.sched, `每日任務：${t.name || '（未命名）'}${priUp(t)[1]}`))]);   // 沒掛專案的算每日任務
    for (const p of state.projects) if (p.status === '已結案') out.push(['p:' + p.id, ...late(R.project, p.due, `專案結案：${p.name || '（未命名）'}`)]);
    for (const hb of state.habits || []) for (const d in hb.log || {}) out.push([`h:${hb.id}:${d}`, R.habit, `習慣：${hb.name}`]);   // 每個習慣每天一筆
    for (const r of state.reviews || []) if (r.done) out.push(['r:' + r.id, R.review, `每週復盤：${(r.name || '').replace('每週復盤｜', '') || '（未命名）'}`]);
    /* 專注：每次 分鐘 × pct%（pct 是結束當下的費率，存在紀錄上），照時間累加，跨過整數元的那一次入帳 */
    let acc = 0;
    for (const f of [...(state.focus || [])].sort((a, b) => a.at - b.at)) {
      if (!f.pct) continue;
      const before = Math.floor(acc / 100); acc += f.min * f.pct;
      const got = Math.floor(acc / 100) - before;
      if (got) out.push(['f:' + f.id, got, `專注 ${f.min} 分：${f.note || '專注'}`]);
    }
    const wk = wakeReward(day.startedAt);
    if (wk) out.push(['wake:' + dayKey, ...wk]);
    for (const k of ['am', 'pm']) if (rtOnTime(k)) out.push([k + ':' + dayKey, R[k], (k === 'am' ? '晨間' : '晚間') + ' routine 全部完成']);
    return out;
  }
  /* 開始今日的獎勵：05:30 拿 rates.wake；每早 5 分 +10%、每晚 5 分 -5%（滿 5 分才算一級），最低 $0。
     03:00 以前按的不算（那是還沒睡，不是早起）；按的那天要是 dayKey 那天。 */
  const WAKE_AT = 5 * 60 + 30, WAKE_MIN = 3 * 60;
  function wakeReward(at) {
    const R = state.wallet.rates;
    if (!at || !R.wake) return null;
    const t = new Date(at); if (ymd(t) !== dayKey) return null;
    const m = t.getHours() * 60 + t.getMinutes(); if (m < WAKE_MIN) return null;
    const diff = WAKE_AT - m, pct = diff >= 0 ? 10 * Math.floor(diff / 5) : -5 * Math.floor(-diff / 5);
    const amt = Math.max(0, Math.round(R.wake * (100 + pct) / 100));
    const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    return amt ? [amt, `開始今日 ${hm}（${diff ? `${diff > 0 ? '早' : '晚'} ${Math.abs(diff)} 分${pct ? `，${pct > 0 ? '+' : ''}${pct}%` : ''}` : '準時'}）`] : null;
  }
  function settle() {
    const stampAt = Date.now();                    // 完成時間：勾完成蓋上，取消就拿掉
    for (const t of state.tasks) { if (t.status === '完成') { if (t.doneAt == null) t.doneAt = stampAt; } else if (t.doneAt != null) delete t.doneAt; }
    for (const k of ['am', 'pm']) { if (rtAll(k)) day[k + 'At'] ??= stampAt; else delete day[k + 'At']; }   // routine 全部勾完的時間
    const W = state.wallet, want = rewardables(), wantSet = new Set(want.map((w) => w[0]));
    const have = new Set(W.log.filter((e) => e.ref).map((e) => e.ref)), base = new Set(W.base);
    const r = { gain: 0, loss: 0, note: '', n: 0 };
    for (const [ref, amt, note] of want) {
      if (have.has(ref) || base.has(ref)) continue;
      const a = Math.max(0, Math.round(+amt || 0));
      W.log.push({ id: 'e:' + ref, ref, at: Date.now(), amt: a, note });
      r.gain += a; r.note = note; r.n++;
    }
    const alive = (ref) => {                     // 項目還在（被刪掉的不收回，已經賺到的就是賺到了）
      const i = ref.indexOf(':'), k = ref.slice(0, i), id = ref.slice(i + 1);
      if (k === 'h') return state.habits.some((x) => x.id === id.slice(0, id.lastIndexOf(':')));
      if (k === 'r') return state.reviews.some((x) => x.id === id);
      if (k === 'f') return state.focus.some((x) => x.id === id);
      return k === 't' ? state.tasks.some((t) => t.id === id) : k === 'p' ? state.projects.some((p) => p.id === id) : id === dayKey;
    };
    W.log = W.log.filter((e) => { if (!e.ref || wantSet.has(e.ref) || !alive(e.ref)) return true; r.loss += e.amt; return false; });
    W.base = W.base.filter((ref) => wantSet.has(ref) || !alive(ref));
    return r;
  }
  const foCents = () => (state.focus || []).reduce((n, f) => n + (f.pct ? f.min * f.pct : 0), 0);   // 專注累積的獎勵（單位：分＝1/100 元）
  const cents = (c) => '$' + (c / 100).toFixed(2);
  const balance = () => state.wallet.log.reduce((n, e) => n + e.amt, 0);
  const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US');
  const COIN = '<svg class="coin" viewBox="0 0 12 12" aria-hidden="true" shape-rendering="crispEdges"><path fill="#b8860b" d="M4 0h4v1h2v1h1v2h1v4h-1v2h-1v1H8v1H4v-1H2v-1H1V8H0V4h1V2h1V1h2z"/><path fill="#fcee0a" d="M4 1h4v1h2v2h1v4h-1v2H8v1H4v-1H2V8H1V4h1V2h2z"/><path fill="#fff7a0" d="M4 2h2v1H4zM3 3h1v2H3z"/><path fill="#b8860b" d="M5 3h2v1h1v1H7V4H5v1h2v1h1v2H7v1H5V8H4V7h1v1h2V7H5V6H4V4h1z"/></svg>';
  normalize();
  if (online) { setBase(bootBase || JSON.stringify(state)); try { localStorage.setItem('kos.state', JSON.stringify(state)); } catch (e) { /* ignore */ } }   // 每次打開都留一份，下次連不到主機也有資料可看
  else baseSnap = JSON.stringify(state);   // 上一次跟伺服器一致時的樣子，衝突時用來算出「這台改了什麼」
  const names = (k) => O[k].map((o) => o.n);
  const colorOf = (k, v) => O[k].find((o) => o.n === v)?.c || 'c-dim';
  const domC = (code) => state.domains.find((d) => d.code === code)?.c || 'c-dim';

  /* ══════════ 存檔與多裝置同步 ══════════
     每次存檔，伺服器會蓋上版本號 state._rev 與時間戳 state._savedAt。
     存檔時附上自己載入時的版本號；別的裝置先存過 → 伺服器回 409 → 改載入最新版，不覆寫。
     另外每幾秒（以及切回這個分頁時）問一次版本號，有新版就自動載入。 */
  const UA = navigator.userAgent;
  const DEVICE = /iPhone/.test(UA) ? 'iPhone' : /iPad/.test(UA) ? 'iPad' : /Android/.test(UA) ? 'Android' : /Macintosh/.test(UA) ? 'Mac' : /Windows/.test(UA) ? 'Windows' : '瀏覽器';
  const stamp = () => (state._savedAt ? state._savedAt.replace('T', ' ').replace(/-/g, '/') : '');
  let saveTimer = null, dirty = false, pushing = false, checking = false;
  function setSave(s) {
    const el = $('#save-state');
    el.textContent = { ok: 'SAVED', saving: 'SAVING', local: 'LOCAL', err: 'ERROR', off: 'OFFLINE' }[s];
    $('#save-chip').className = 'chip-btn sv-' + s;
    $('#save-chip').title = { ok: `已存入 data.json${stamp() ? `（版本 #${state._rev}，${stamp()}，${state._by || ''}）` : ''}`, saving: '存檔中…', off: '連不到主機，修改先留在這台，連上後自動存檔', local: '沒有連上存檔伺服器，資料只存在這個瀏覽器', err: '存檔失敗，會自動重試（伺服器可能被關掉了，或網路斷線）' }[s];
  }
  function save() {
    const got = settle();
    if (got.gain || got.loss) {
      if (got.gain) coinFx(got.gain); else updateCoin(true);
      if (got.gain) { [988, 1319].forEach((f, i) => beep(f, i ? 0.22 : 0.07, 0.04, i * 0.07)); toast(`＋${money(got.gain)}　${got.n > 1 ? got.n + ' 個項目完成' : got.note}`, null, 3200); }
      else toast(`已收回 ${money(got.loss)}（取消完成）`, null, 2600);
    }
    try { localStorage.setItem('kos.state', JSON.stringify(state)); } catch (e) { /* ignore */ }
    if (!online) return setSave('local');
    dirty = true; setSave(netDown ? 'off' : 'saving');
    clearTimeout(saveTimer); saveTimer = setTimeout(push, netDown ? 1500 : 250);
  }
  async function push() {
    clearTimeout(saveTimer);
    if (pushing) { saveTimer = setTimeout(push, 150); return; }      // 一次只送一筆，免得自己跟自己衝突
    pushing = true;
    state._by = DEVICE;
    const body = JSON.stringify(state);
    try {
      const r = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      if (r.status === 409) {
        /* 別的裝置先存過了：把「這台改了什麼」套到最新版上再存一次，兩邊的修改都保留 */
        const fresh = await (await fetch('/api/state', { cache: 'no-store' })).json();
        const base = JSON.stringify(fresh);
        adopt(merge(JSON.parse(baseSnap), JSON.parse(body), fresh), `已和 ${fresh._by || '另一台裝置'} 的修改合併`, 4000, base);
        dirty = true; setSave('saving'); saveTimer = setTimeout(push, 120);
        return;
      }
      if (!r.ok) throw new Error(r.status);
      const res = await r.json();
      setNet(true);
      const same = body === JSON.stringify(state);
      state._rev = res.rev; state._savedAt = res.savedAt;
      const b = JSON.parse(body); b._rev = res.rev; b._savedAt = res.savedAt; setBase(JSON.stringify(b));
      try { localStorage.setItem('kos.state', JSON.stringify(state)); } catch (e) { /* ignore */ }
      if (same) { dirty = false; setSave('ok'); renderMeta(); }
      else saveTimer = setTimeout(push, 100);                         // 送出期間又有新修改 → 再送一次
    } catch (e) {
      setNet(false); if (!netDown) setSave('err');                      // 連續失敗就維持 OFFLINE，不在 ERROR／OFFLINE 之間跳
      saveTimer = setTimeout(push, 5000);
    } finally { pushing = false; }
  }
  window.addEventListener('pagehide', () => {
    if (online && dirty) navigator.sendBeacon('/api/state', new Blob([JSON.stringify(state)], { type: 'application/json' }));
  });
  const commit = () => { save(); renderDash(); updateHud(); };

  /* 換成伺服器上的最新資料（原地替換，state 這個物件本身不變） */
  /* 三方合併：base＝上次同步的版本、local＝這台現在的、remote＝伺服器最新的。
     以 remote 為底，把這台新增／修改／刪除／重排的項目套上去；這台沒動過的一律用 remote 的。 */
  function merge(base, local, remote) {
    const LISTS = ['projects', 'tasks', 'reviews', 'habits', 'focus', 'cats', 'shop', 'buys'];
    for (const key of LISTS) {
      const b = new Map((base[key] || []).map((x) => [x.id, JSON.stringify(x)]));
      const l = local[key] || [], lIds = new Set(l.map((x) => x.id));
      let r = (remote[key] || []).filter((x) => !(b.has(x.id) && !lIds.has(x.id)));        // 這台刪掉的
      const at = new Map(r.map((x, i) => [x.id, i]));
      for (const x of l) {
        if (!b.has(x.id)) { if (!at.has(x.id)) r.push(x); }                                  // 這台新增的
        else if (b.get(x.id) !== JSON.stringify(x) && at.has(x.id)) r[at.get(x.id)] = x;     // 這台改過的
      }
      const baseOrder = (base[key] || []).map((x) => x.id).filter((id) => lIds.has(id)).join();
      if (baseOrder !== l.map((x) => x.id).filter((id) => b.has(id)).join()) {               // 這台重排過順序
        const byId = new Map(r.map((x) => [x.id, x]));
        r = [...l.filter((x) => byId.has(x.id)).map((x) => byId.get(x.id)), ...r.filter((x) => !lIds.has(x.id))];
      }
      remote[key] = r;
    }
    for (const key of Object.keys(local)) {
      if (key.startsWith('_') || LISTS.includes(key) || key === 'wallet' || key === 'daylog') continue;
      if (JSON.stringify(local[key]) !== JSON.stringify(base[key])) remote[key] = local[key];  // 選項、routine、今日狀態、音效設定
    }
    remote.daylog ||= {};                            // 每日紀錄：一天一筆，這台改過的那幾天才蓋過去
    for (const d of new Set([...Object.keys(local.daylog || {}), ...Object.keys(base.daylog || {})])) {
      const l = local.daylog?.[d], b = base.daylog?.[d];
      if (JSON.stringify(l) === JSON.stringify(b)) continue;
      if (l) remote.daylog[d] = l; else delete remote.daylog[d];
    }
    const lw = local.wallet, rw = remote.wallet, bw = base.wallet;
    if (lw && !(rw && bw)) remote.wallet = lw;
    else if (lw) {                                   // 錢包：兩邊的入帳／花費紀錄都留，這台刪掉的才刪
      const bIds = new Set(bw.log.map((e) => e.id)), lIds = new Set(lw.log.map((e) => e.id)), rIds = new Set(rw.log.map((e) => e.id));
      rw.log = [...rw.log.filter((e) => !(bIds.has(e.id) && !lIds.has(e.id))), ...lw.log.filter((e) => !bIds.has(e.id) && !rIds.has(e.id))].sort((a, b) => a.at - b.at);
      if (JSON.stringify(lw.rates) !== JSON.stringify(bw.rates)) rw.rates = lw.rates;
      rw.base = (rw.base || []).filter((x) => lw.base.includes(x) || !bw.base.includes(x));
    }
    return remote;
  }
  function adopt(fresh, msg, ms, base) {
    if (!fresh || !Array.isArray(fresh.projects)) return;
    closePop();
    if (modalCtl && !modalCtl.sticky) modalCtl.close('cancel');       // 專案／復盤視窗手上是舊物件，直接關掉
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, fresh);
    normalize();
    setBase(base || JSON.stringify(state));
    try { localStorage.setItem('kos.state', JSON.stringify(state)); } catch (e) { /* ignore */ }
    clearTimeout(saveTimer); dirty = false; setSave('ok');
    if (modalCtl) modalCtl.rerender();                                // routine 視窗：照新資料重畫
    renderDash(); renderOff(); updateHud(); syncView();
    if (msg) toast(msg, null, ms);
  }
  /* 別的裝置按了開始今日／結束今日，這裡的畫面也跟著切 */
  function syncView() {
    if (busy) return;
    if (day.phase === 'on' && views.dash.hidden) enterDash(false);
    else if (day.phase !== 'on' && !views.dash.hidden) show('off');
  }
  const editingNow = () => { const a = document.activeElement; return !!a && views.dash.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'file')); };
  const midEdit = () => editingNow() && !!document.activeElement.value;   // 游標停在空欄位不算正在打字
  /* 連不到主機（連兩次）→ 上排標 OFFLINE 並提示；恢復後自己亮回來。修改先留在這台，連上後自動存檔 */
  let netFails = 0, netDown = false;
  function setNet(ok) {
    if (ok) {
      netFails = 0; if (!netDown) return;
      netDown = false; views.dash.classList.remove('net-down'); $('.hud-online').lastChild.textContent = 'ONLINE';
      if (!dirty) setSave('ok');
      toast('已重新連上主機');
      return;
    }
    if (++netFails < 2 || netDown) return;
    netDown = true; views.dash.classList.add('net-down'); $('.hud-online').lastChild.textContent = 'OFFLINE';
    setSave('off'); toast('連不到主機：修改先留在這台，連上後會自動存檔', null, 5000);
  }
  /* 自動更新：/api/rev 會帶程式版本 code；跟這頁載入時的不一樣（部署了新版）就找空檔重新載入 */
  let codeV = CODE_V;
  async function checkRemote() {
    if (!online || checking || dirty || pushing || document.hidden) return;
    checking = true;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 6000);   // 主機沒回應不會永遠掛著
    try {
      const r = await fetch('/api/rev', { cache: 'no-store', signal: ac.signal });
      if (!r.ok) throw new Error(r.status);
      const m = await r.json();
      setNet(true);
      if (m.code) codeV ||= m.code;
      if (ymd(new Date()) !== TODAY || (m.code && m.code !== codeV)) { if (!editingNow() && !modalCtl && !busy) location.reload(); return; }   // 跨日或有新版：重新載入   // 跨日了：重新載入（正在打字或開著視窗就先等）
      if ((modalCtl && !modalCtl.sticky) || midEdit() || touching) return;   // 正在編輯、打字或拖曳，先不打擾
      if ((m.rev || 0) === (state._rev || 0)) return;
      const fresh = await (await fetch('/api/state', { cache: 'no-store', signal: ac.signal })).json();
      if (dirty || pushing || (modalCtl && !modalCtl.sticky) || midEdit()) return;
      adopt(fresh, `已同步 ${fresh._by || '其他裝置'} 的修改`);
    } catch (e) { setNet(false); } finally { clearTimeout(timer); checking = false; }
  }
  function renderMeta() {
    $('#foot-info').textContent = online
      ? `資料存在主機的 data.json，每天第一次修改前會自動備份到 backups/。${stamp() ? `最新版本 #${state._rev}：${stamp()} 由 ${state._by || '?'} 存檔。` : ''}`
      : '沒有連上存檔伺服器：資料目前只存在這個瀏覽器。請用「開啟看板.command」開啟，才會存進 data.json。';
  }

  const proj = (id) => state.projects.find((p) => p.id === id);
  const task = (id) => state.tasks.find((t) => t.id === id);
  const routine = (kind) => state.routines[kind];
  const doneCount = (kind) => routine(kind).filter((t) => day[kind][t]).length;
  const amLocked = () => rtLocked('am');
  const amDead = () => amLocked() && !rtOnTime('am');   // 過了 09:00 而且沒有準時做完：HUD 顯示「失效」（還是可以勾，只是沒獎勵）

  /* ══════════ 音效 ══════════ */
  let actx = null, actxSeen = { t: -1, at: 0 }, lastGesture = -1e9, plays = 0, warmAt = 0;
  /* 取得「真的會出聲」的 AudioContext 再播放。
     11/16：桌面版是 Safari 網頁 App（WebKit）。實測切到別的視窗再回來，AudioContext 一直是 running，
     但喇叭那端要一段時間才真的出聲：以前等 0.5 秒等不到就丟（＝沒聲音），換新引擎照排（＝延遲很大）。
     現在：視窗一拿回焦點／畫面一出現就先 resume 並播一小段無聲，把輸出叫醒——等你點的時候已經醒了。
     只用同一個引擎，不再一直換新的（換新的要重新開喇叭，更慢）。 */
  const AC = window.AudioContext || window.webkitAudioContext;
  const inGesture = () => (navigator.userActivation ? navigator.userActivation.isActive : false) || performance.now() - lastGesture < 1000;
  ['pointerdown', 'touchstart', 'keydown', 'mousedown'].forEach((ev) => document.addEventListener(ev, () => { lastGesture = performance.now(); }, { capture: true, passive: true }));
  const alog = () => {};                                             // 除錯紀錄已關（11/16 修好後）；要查再接回 /api/debug/audio
  /* 叫醒輸出：resume＋播 0.25 秒無聲（真的有東西在播，WebKit 才會把喇叭打開） */
  function warm(why) {
    if (!actx || actx.state === 'closed') return;
    const now = performance.now(); if (now - warmAt < 300) return; warmAt = now;
    actx.resume().catch(() => {});
    try {
      const b = actx.createBuffer(1, Math.ceil(actx.sampleRate * 0.25), actx.sampleRate), n = actx.createBufferSource();
      n.buffer = b; n.connect(actx.destination); n.start();
    } catch (e) { /* 沒關係 */ }

  }
  /* 11/16 第三版：使用者實測切回來後「每一下都慢好幾秒、要重新整理才好」，但程式端每一下都馬上送出 →
     積壓在 Safari 內部（視窗不在前面時引擎繼續跑，聲音堆在後面）。所以視窗一被切走就把引擎整個關掉，
     回來第一下再開一個乾淨的（在使用者操作當下開，才允許出聲）。 */
  function release(why) {
    if (!actx) return;
    alog('release ' + why);
    try { actx.close(); } catch (e) { /* 已經關了 */ }
    actx = null;
  }
  window.addEventListener('blur', () => release('blur'));
  window.addEventListener('pagehide', () => release('pagehide'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) release('hidden'); });
  function audio(play) {
    try {
      const now = performance.now(), gesture = inGesture();
      if (actx && actx.state === 'running') {
        if (actx.currentTime !== actxSeen.t) actxSeen = { t: actx.currentTime, at: now };
        else if (now - actxSeen.at > 1500) { try { actx.close(); } catch (e) { /* */ } actx = null; }   // 時鐘不走（輸出裝置換過）→ 換新的
        if (actx) { plays++; return play(actx); }
      }
      if (!gesture) { if (actx && actx.state !== 'closed') actx.resume().catch(() => {}); return; }   // 不是使用者操作：叫醒就好，不補播
      if (!actx || actx.state === 'closed') { actx = new AC(); actxSeen = { t: -1, at: now }; alog('new ctx'); warm('new'); }
      const ctx = actx;
      ctx.resume().then(() => { alog('resumed ' + Math.round(performance.now() - now) + 'ms'); if (ctx === actx && performance.now() - now < 300) { plays++; play(ctx); } }, () => {});
    } catch (e) { window.__kosAudioErr = String(e); alog('ERR ' + e); }
  }
  window.__kosAudio = () => ({ state: actx?.state || 'none', plays, err: window.__kosAudioErr || '' });   // 除錯用：看音效引擎狀態
  /* iPhone 只認「手指放開／點擊」當作解鎖音效的手勢（按下那一刻不算），所以這些事件都順手叫醒一次 */
  const wakeAudio = () => { if (actx && actx.state === 'suspended') actx.resume().catch(() => {}); };
  ['touchend', 'pointerup', 'mouseup', 'click', 'keydown'].forEach((ev) => document.addEventListener(ev, wakeAudio, { capture: true, passive: true }));
  window.addEventListener('pageshow', wakeAudio);
  function beep(freq = 880, dur = 0.08, vol = 0.035, when = 0, type = 'square') {
    if (state.muted) return;
    audio((actx) => {
      const o = actx.createOscillator(), g = actx.createGain();
      const t = actx.currentTime + when;
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol * (VOL[state.sfx.vol] ?? 1), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    });
  }
  /* 按鍵聲：每次點擊都會響。音色、音量、音高模式可在右上角 SFX 選單調整（存在 state.sfx）。
     音高預設跟點擊的水平位置走（左低右高），像在彈一排鍵盤。 */
  const SCALE = [110, 130.81, 146.83, 164.81, 196, 220, 261.63, 293.66, 329.63, 392, 440, 523.25];
  const VOL = [0, 0.3, 0.6, 1, 1.6, 2.4];
  /*voice-begin*/
  /* o=振盪器[波形, 頻率倍數]　oct=八度倍數　q=濾波器共振　f0→f1=濾波器掃頻（基頻的倍數）
     sweep=掃頻秒數　dur=長度　gain=音量　drop=起音時的音高倍數（往下滑）　noise=雜訊量 */
  const VOICES = {
    bass:  { name: '類比貝斯', o: [['sawtooth', 1], ['square', 0.5]], oct: 1, q: 9, f0: 12, f1: 1.2, sweep: 0.14, dur: 0.2, gain: 0.055 },
    pluck: { name: '合成撥弦', o: [['sawtooth', 1], ['sawtooth', 1.006]], oct: 2, q: 5, f0: 9, f1: 1, sweep: 0.05, dur: 0.11, gain: 0.06 },
    acid:  { name: '酸性共振', o: [['sawtooth', 1]], oct: 1, q: 17, f0: 2, f1: 11, sweep: 0.07, dur: 0.15, gain: 0.03 },
    chip:  { name: '8-bit 方波', o: [['square', 1]], oct: 4, q: 0.7, f0: 30, f1: 30, sweep: 0.05, dur: 0.06, gain: 0.03 },
    thump: { name: '低頻悶擊', o: [['sine', 1]], oct: 0.5, q: 0.7, f0: 40, f1: 40, sweep: 0.05, dur: 0.16, gain: 0.2, drop: 4 },
    click: { name: '機械鍵帽', o: [['square', 1]], oct: 8, q: 0.7, f0: 8, f1: 8, sweep: 0.02, dur: 0.025, gain: 0.02, noise: 0.12 }
  };
  let noiseBuf = null;
  function playVoice(ctx, v, base, level) {
    const t = ctx.currentTime, f = base * v.oct;
    const clamp = (x) => Math.min(16000, Math.max(40, x));
    const lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.Q.setValueAtTime(v.q, t);
    lp.frequency.setValueAtTime(clamp(f * v.f0), t);
    lp.frequency.exponentialRampToValueAtTime(clamp(f * v.f1), t + v.sweep);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v.gain * level), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + v.dur);
    lp.connect(g); g.connect(ctx.destination);
    for (const [type, mul] of v.o) {
      const o = ctx.createOscillator(); o.type = type;
      if (v.drop) { o.frequency.setValueAtTime(f * mul * v.drop, t); o.frequency.exponentialRampToValueAtTime(f * mul, t + 0.06); }
      else o.frequency.setValueAtTime(f * mul, t);
      o.connect(lp); o.start(t); o.stop(t + v.dur + 0.02);
    }
    if (v.noise) {
      if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
        noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
        const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const n = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), ng = ctx.createGain();
      n.buffer = noiseBuf; hp.type = 'highpass'; hp.frequency.setValueAtTime(1800, t);
      ng.gain.setValueAtTime(Math.max(0.0002, v.noise * level), t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      n.connect(hp); hp.connect(ng); ng.connect(ctx.destination); n.start(t);
    }
  }
  /*voice-end*/

  /* 音效庫：sounds/ 資料夾裡的音檔（由 server.py 列出）會自動變成可選的音色 */
  const sampleData = {}, sampleBuf = {}, samplePending = {};
  if (online) {
    fetch('/api/sounds').then((r) => (r.ok ? r.json() : [])).then((list) => {
      for (const file of list) {
        const key = 'file:' + file;
        VOICES[key] = { name: file.replace(/\.[^.]+$/, ''), file: 'sounds/' + encodeURIComponent(file) };
        fetch(VOICES[key].file).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => { if (b) sampleData[key] = b; }).catch(() => {});
      }
    }).catch(() => {});
  }
  function playSample(ctx, key, base, level, boost = 1) {
    const go = (buf) => {
      const n = ctx.createBufferSource(), g = ctx.createGain();
      n.buffer = buf;
      n.playbackRate.value = state.sfx.pitch && boost === 1 ? Math.sqrt(base / 220) : 1;   // 音高跟位置時只小幅變調，保留原本的音色（購買聲不變調）
      g.gain.value = buf.kosNorm * level * boost;
      n.connect(g); g.connect(ctx.destination); n.start();
    };
    if (sampleBuf[key] && sampleBuf[key].kosCtx === ctx) return go(sampleBuf[key]);   // 音檔解碼結果跟著引擎走：換新引擎就重新解碼
    if (sampleBuf[key]) { delete sampleBuf[key]; delete samplePending[key]; }
    if (!sampleData[key]) return;                    // 還沒載完
    (samplePending[key] ||= ctx.decodeAudioData(sampleData[key].slice(0)).then((buf) => {
      let peak = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
      buf.kosCtx = ctx; buf.kosNorm = peak ? 0.16 / peak : 1;          // 音量對齊到跟合成音色差不多
      return (sampleBuf[key] = buf);
    })).then(go).catch(() => {});
  }
  let lastKey = 0, lastX = 0.5;
  /* kind：'voice'＝按到東西的音色、'miss'＝沒按到東西（點空白處）的音色 */
  function keySound(x = lastX, kind = 'voice') {
    if (state.muted) return;
    const v = VOICES[state.sfx[kind]];
    if (!v) return;                                   // 這種情況選了「無聲」
    const now = performance.now(); if (now - lastKey < 30) return; lastKey = now;
    audio((actx) => {
      const c = state.sfx;
      const base = c.pitch ? SCALE[Math.min(SCALE.length - 1, Math.floor(x * SCALE.length))] : 220;
      if (v.file) playSample(actx, c[kind], base, VOL[c.vol] ?? 1);
      else playVoice(actx, v, base, VOL[c.vol] ?? 1);
    });
  }
  const HIT = 'button, a, input, textarea, select, summary, label, [data-act], [tabindex], [draggable="true"]';
  const isHit = (e) => !!e.target.closest?.(HIT);               // 有沒有按到可操作的東西
  const noVoice = (e) => e.target.closest?.('[data-novoice]');   // 音效設定裡的按鈕：改完設定後再用新音色試聽
  document.addEventListener('pointerdown', (e) => { lastX = Math.min(0.999, Math.max(0, e.clientX / window.innerWidth)); if (!noVoice(e)) keySound(lastX, isHit(e) ? 'voice' : 'miss'); }, true);
  document.addEventListener('click', (e) => { if (e.detail === 0 && !noVoice(e)) keySound(); }, true);   // 鍵盤 Enter／空白鍵觸發的點擊
  const softKey = () => { if (performance.now() - lastKey > 400) keySound(); };            // 非點擊觸發的動作（例如 Enter 送出）才補一聲

  const sfx = {
    tick: () => beep(1400, 0.02, 0.012),
    check: softKey,
    uncheck: softKey,
    post: () => beep(1046, 0.16, 0.04),
    ready: () => [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.1, 0.035, i * 0.09)),
    down: () => [784, 659, 523, 392, 262].forEach((f, i) => beep(f, 0.12, 0.035, i * 0.1)),
    hum: () => beep(55, 0.9, 0.05, 0, 'sawtooth'),
    click: () => beep(120, 0.05, 0.06),
    deny: () => { beep(180, 0.09, 0.05); beep(140, 0.12, 0.05, 0.09); }
  };

  /* ══════════ 畫面切換、開關機特效 ══════════ */
  const screen = $('#screen'), glow = $('#glow');
  const views = { off: $('#v-off'), term: $('#v-term'), dash: $('#v-dash') };
  function show(name) { for (const k in views) views[k].hidden = k !== name; }
  function animEnd(el, name, fallback) {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; el.removeEventListener('animationend', on); res(); } };
      const on = (e) => { if (e.target === el && e.animationName === name) fin(); };
      el.addEventListener('animationend', on);
      setTimeout(fin, fallback);
    });
  }
  async function powerOn(view) {
    screen.classList.add('is-dark');
    sfx.click();
    await sleep(380);
    show(view);
    screen.classList.remove('is-dark');
    screen.classList.add('pwr-on');
    sfx.hum();
    await animEnd(screen, 'pwrOn', 1100);
    screen.classList.remove('pwr-on');
  }
  async function powerOff() {
    screen.classList.add('pwr-off');
    sfx.click();
    await animEnd(screen, 'pwrOff', 900);
    screen.classList.add('is-dark');
    screen.classList.remove('pwr-off');
    glow.classList.remove('on'); void glow.offsetWidth; glow.classList.add('on');
    await sleep(1500);
    glow.classList.remove('on');
  }

  /* 終端機逐行輸出 */
  const term = $('#term');
  async function typeLines(lines) {
    term.innerHTML = '';
    const cur = document.createElement('span'); cur.className = 'cur';
    for (const ln of lines) {
      const el = document.createElement('div');
      if (ln.cls) el.className = ln.cls;
      term.appendChild(el); el.after(cur);
      if (ln.count) {
        const steps = 14;
        for (let i = 1; i <= steps; i++) {
          el.textContent = ln.t.replace('%', String(Math.round(ln.count * i / steps)).padStart(5, '0'));
          if (i % 3 === 0) sfx.tick();
          await sleep(40);
        }
        el.innerHTML = esc(ln.t.replace('%', ln.count)) + ' <span class="ok">OK</span>';
      } else if (ln.type) {
        for (const ch of ln.t) { el.textContent += ch; sfx.tick(); await sleep(34); }
      } else {
        el.innerHTML = ln.html || esc(ln.t);
        sfx.tick();
      }
      await sleep(ln.d ?? 150);
    }
  }
  const dots = (s, n = 38) => s + ' ' + '.'.repeat(Math.max(3, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const ok = (s) => ({ html: esc(dots(s)) + ' <span class="ok">OK</span>' });

  function bootLines() {
    const now = new Date();
    const focus = state.projects.filter((p) => p.focus).map((p) => p.code || p.name);
    const overdue = state.projects.filter((p) => p.due && p.status !== '已結案' && dayDiff(TODAY, p.due) < 0).length;
    const lines = [
      { t: `${NAME()}-OS BIOS v2.6`, cls: 'head', d: 260 },
      { t: `(C) 2026 ${NAME()} SYSTEMS · LIFE DASHBOARD`, d: 300 },
      { t: ' ', d: 60 },
      ok('CPU  CORTEX-K @ 1 LIFE'),
      { t: 'MEMORY TEST  %K', count: 65536, d: 160 },
      ok(`MOUNT ${online ? `/${NAME().toLowerCase()}os/data.json` : '/browser/localStorage'}`),
      ok(`LOAD projects  [${state.projects.length} 專案]`),
      ok(`LOAD tasks     [${state.tasks.length} 任務]`),
      ok(`LOAD reviews   [${state.reviews.length} 筆]`),
      ok(`CHECK focus[${focus.length}]  ${focus.join(' ')}`)
    ];
    if (overdue) lines.push({ html: `<span class="warn">WARN  ${overdue} 個專案期限已逾期</span>`, d: 320 });
    lines.push({ t: ' ', d: 120 });
    lines.push({ t: `> 早安，${NAME()}。今天是 ${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}（${WEEK[now.getDay()]}）`, cls: 'hi', type: true, d: 260 });
    lines.push({ t: '> 啟動晨間程序 ...', cls: 'hi', type: true, d: 480 });
    return lines;
  }
  function shutdownLines() {
    const up = day.startedAt ? fmtDur((day.endedAt || Date.now()) - day.startedAt) : '--:--';
    return [
      { t: 'SHUTDOWN SEQUENCE', cls: 'head', d: 240 },
      ok('SAVE  今日紀錄'),
      { html: `今日運作時間  <span class="hi">${up}</span>`, d: 200 },
      { html: `晨間 routine  <span class="ok">${doneCount('am')}/${routine('am').length}</span>   晚間 routine  <span class="ok">${doneCount('pm')}/${routine('pm').length}</span>`, d: 240 },
      ok('CLOSE projects'),
      ok('CLOSE tasks'),
      ok(`SYNC  ${online ? 'data.json' : 'localStorage'}`),
      { t: ' ', d: 100 },
      { t: `> 辛苦了，${NAME()}。晚安，明天見。`, cls: 'hi', type: true, d: 420 },
      { html: '<span class="mag">SYSTEM HALT</span>', d: 600 }
    ];
  }

  /* ══════════ 視窗共用 ══════════ */
  const modal = $('#modal'), box = $('#modal-box');
  let modalCtl = null;
  function openModal(cls, o) {
    box.className = 'modal-box pxb ' + cls;
    modal.className = 'modal' + (o.top ? ' top' : '');
    box.onclick = o.click || null; box.oninput = o.input || null; box.onchange = o.change || null; box.onsubmit = o.submit || null;
    box.ondragstart = box.ondragover = box.ondrop = box.ondragend = null;
    const ctl = modalCtl = {
      dismiss: o.dismiss || (() => false),
      rerender: o.render,
      sticky: !!o.sticky,
      close(r) { modal.hidden = true; modalCtl = null; box.innerHTML = ''; if (o.onClose) o.onClose(r); }
    };
    modal.hidden = false; modal.scrollTop = 0;
    o.render();
    return ctl;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (popState) return closePop(true);
    if (modalCtl && modalCtl.dismiss()) modalCtl.close('cancel');
  });
  modal.addEventListener('mousedown', (e) => { if (e.target === modal && modalCtl && modalCtl.dismiss()) modalCtl.close('cancel'); });

  let toastTimer = null;
  function toast(msg, undo, ms) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="btn btn-sm" id="toast-undo">復原</button>' : ''}`;
    el.hidden = false;
    if (undo) $('#toast-undo').onclick = () => { undo(); el.hidden = true; };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms || (undo ? 6000 : 2600));
  }

  /* ══════════ 選項集合（可增減）與像素風選單 ══════════ */
  const SETS = {
    pStatus: { manage: true, items: () => O.pStatus.map((o) => ({ v: o.n, l: o.n, c: o.c })), used: (v) => state.projects.filter((p) => p.status === v).length, unit: '個專案' },
    confirm: { manage: true, items: () => [{ v: '', l: '—' }, ...O.confirm.map((o) => ({ v: o.n, l: o.n, c: o.c }))], used: (v) => state.projects.filter((p) => p.confirm === v).length, unit: '個專案' },
    tStatus: { manage: true, items: () => O.tStatus.map((o) => ({ v: o.n, l: o.n, c: o.c })), used: (v) => state.tasks.filter((t) => t.status === v).length, unit: '個任務' },
    tType: { manage: true, items: () => O.tType.map((o) => ({ v: o.n, l: o.n, c: o.c })), used: (v) => state.tasks.filter((t) => t.type === v).length, unit: '個任務' },
    why: { manage: true, items: () => O.why.map((o) => ({ v: o.n, l: o.n, c: o.c })), used: (v) => state.reviews.filter((r) => r.why.includes(v)).length, unit: '筆復盤' },
    domain: { manage: true, domain: true, items: () => [{ v: '', l: '—' }, ...state.domains.map((d) => ({ v: d.code, l: `${d.code}｜${d.name}`, c: d.c }))], used: (v) => state.projects.filter((p) => p.domain === v).length, unit: '個專案' },
    cat: { manage: false, items: () => [{ v: '', l: '未分類' }, ...state.cats.map((c) => ({ v: c.id, l: c.name }))] },
    pri: { manage: false, items: () => [{ v: '0', l: '無優先級' }, { v: '1', l: '低優先級', c: 'c-grn' }, { v: '2', l: '中優先級', c: 'c-yel' }, { v: '3', l: '高優先級', c: 'c-mag' }] },
    project: { manage: false, items: () => [{ v: '', l: '不掛專案' }, ...state.projects.filter((p) => p.status !== '已結案').map((p) => ({ v: p.id, l: `${p.code || 'NEW'} ${p.name}`, c: domC(p.domain) }))] }
  };
  function addOpt(kind, fd) {
    const name = String(fd.get('name') || '').trim();
    if (!name) return '請輸入名稱';
    if (kind === 'domain') {
      const code = String(fd.get('code') || '').trim().toUpperCase();
      if (!code) return '請輸入領域代碼（例如 H）';
      if (state.domains.some((d) => d.code === code)) return `代碼 ${code} 已經有了`;
      state.domains.push({ code, name, desc: '', c: PALETTE[state.domains.length % PALETTE.length] });
    } else {
      if (O[kind].some((o) => o.n === name)) return `「${name}」已經有了`;
      O[kind].push({ n: name, c: PALETTE[O[kind].length % PALETTE.length] });
    }
    commit(); return null;
  }
  function delOpt(kind, v) {
    if (LOCKED[kind]?.includes(v)) return false;
    const n = SETS[kind].used(v);
    if (n) { sfx.deny(); toast(`還有 ${n} ${SETS[kind].unit}在用「${v}」，先改掉再刪`); return false; }
    if (kind === 'domain') state.domains = state.domains.filter((d) => d.code !== v);
    else O[kind] = O[kind].filter((o) => o.n !== v);
    commit(); return true;
  }
  /* 取代原生 <select> 與日期輸入的按鈕；name 有給的話會多一個 hidden input 供表單送出 */
  function selBtn(kind, val, attrs = '', o = {}) {
    const it = SETS[kind].items().find((x) => x.v === val);
    return `${o.name ? `<input type="hidden" name="${o.name}" value="${esc(val)}">` : ''}<button type="button" class="in sel ${o.sm ? 'sm' : ''}" data-opt="${kind}" value="${esc(val)}" ${o.name ? `data-name="${o.name}"` : ''} ${attrs} aria-haspopup="listbox"><span class="sel-l">${esc(it ? it.l : (val || '—'))}</span></button>`;
  }
  const dateLabel = (v) => (v ? v.replace(/-/g, '/') : '年/月/日');
  function dateBtn(val, attrs = '', o = {}) {
    return `${o.name ? `<input type="hidden" name="${o.name}" value="${esc(val)}">` : ''}<button type="button" class="in datebtn ${o.sm ? 'sm' : ''}" data-date value="${esc(val)}" ${attrs} aria-haspopup="dialog"><span class="sel-l">${dateLabel(val)}</span></button>`;
  }
  function applyPick(anchor, v, label) {
    anchor.value = v;
    const l = anchor.querySelector('.sel-l'); if (l && anchor.dataset.multi === undefined) l.textContent = label;
    const hid = anchor.previousElementSibling; if (hid && hid.type === 'hidden') hid.value = v;
    anchor.dispatchEvent(new Event('change', { bubbles: true }));
    if (anchor.isConnected) anchor.focus();
  }

  const pop = $('#pop');
  let popState = null;
  function placePop(anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.minWidth = Math.max(r.width, 190) + 'px';
    pop.style.left = '0px'; pop.style.top = '0px';
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const x = Math.min(Math.max(8, r.left), window.innerWidth - w - 14);
    let y = r.bottom + 7; if (y + h > window.innerHeight - 14) y = Math.max(8, r.top - h - 7);
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  }
  function openPop(anchor, render) {
    closePop();
    popState = { anchor };
    pop.hidden = false; render(); placePop(anchor);
    anchor.setAttribute('aria-expanded', 'true');
  }
  function closePop(focusBack) {
    if (!popState) return;
    const a = popState.anchor; popState = null;
    pop.hidden = true; pop.innerHTML = ''; pop.onclick = pop.onsubmit = pop.onkeydown = null;
    a.removeAttribute('aria-expanded');
    if (focusBack && a.isConnected) a.focus();
  }
  document.addEventListener('pointerdown', (e) => { if (popState && !pop.contains(e.target) && !popState.anchor.contains(e.target)) closePop(); }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button.sel, button.datebtn'); if (!b) return;
    e.preventDefault();
    if (popState && popState.anchor === b) return closePop(true);
    b.classList.contains('sel') ? openSelect(b) : openDate(b);
  });
  function openSelect(anchor) {
    const kind = anchor.dataset.opt, set = SETS[kind], multi = anchor.dataset.multi !== undefined;
    const render = () => {
      const cur = multi ? JSON.parse(anchor.dataset.vals || '[]') : [anchor.value];
      pop.className = 'pop pxb';
      pop.innerHTML = `<div class="pop-list" role="listbox">${set.items().map((it) => `
        <div class="pop-row"><button type="button" class="pop-opt ${cur.includes(it.v) ? 'on' : ''}" role="option" aria-selected="${cur.includes(it.v)}" data-v="${esc(it.v)}"><i class="sw ${it.c || ''}"></i><span>${esc(it.l)}</span></button>${
          set.manage && it.v !== '' ? (LOCKED[kind]?.includes(it.v) ? '<span class="pop-lock" title="看板運作需要這個選項，不能刪">固定</span>' : `<button type="button" class="x" data-del="${esc(it.v)}" aria-label="刪除選項 ${esc(it.l)}">X</button>`) : ''}</div>`).join('')}</div>
        ${set.manage ? `<form class="pop-add">${set.domain ? '<input class="in sm" name="code" placeholder="代碼" maxlength="3" autocomplete="off" aria-label="領域代碼">' : ''}<input class="in sm grow" name="name" placeholder="＋ 新增選項" autocomplete="off" aria-label="新選項名稱"><button class="btn btn-sm" aria-label="新增選項">＋</button></form>` : ''}`;
    };
    openPop(anchor, render);
    pop.onclick = (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const v = del.dataset.del;
        if (!delOpt(kind, v)) return;
        if (!multi && anchor.value === v) { const f = set.items()[0]; closePop(); applyPick(anchor, f.v, f.l); return; }
        render(); placePop(anchor); pop.querySelector('.pop-opt')?.focus();
        return;
      }
      const o = e.target.closest('.pop-opt'); if (!o) return;
      const it = set.items().find((x) => x.v === o.dataset.v);
      closePop(); applyPick(anchor, it.v, it.l);
    };
    pop.onsubmit = (e) => {
      e.preventDefault();
      const err = addOpt(kind, new FormData(e.target));
      if (err) { sfx.deny(); toast(err); return; }
      sfx.check(); render(); placePop(anchor);
      pop.querySelector(`.pop-add input[name="${set.domain ? 'code' : 'name'}"]`)?.focus();
    };
    pop.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const opts = [...pop.querySelectorAll('.pop-opt')], i = opts.indexOf(document.activeElement);
      if (i < 0 && document.activeElement.tagName === 'INPUT') return;
      e.preventDefault();
      opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus();
    };
    (pop.querySelector('.pop-opt.on') || pop.querySelector('.pop-opt'))?.focus();
  }
  function openDate(anchor) {
    let [y, m] = (anchor.value || TODAY).split('-').map(Number);
    const render = () => {
      const start = (new Date(y, m - 1, 1).getDay() + 6) % 7, days = new Date(y, m, 0).getDate();
      const cells = Array.from({ length: start }, () => '<span></span>');
      for (let d = 1; d <= days; d++) {
        const v = `${y}-${pad(m)}-${pad(d)}`;
        cells.push(`<button type="button" class="cal-d ${v === anchor.value ? 'on' : ''} ${v === TODAY ? 'today' : ''}" data-v="${v}" aria-label="${v}">${d}</button>`);
      }
      pop.className = 'pop pxb cal';
      pop.innerHTML = `
        <div class="cal-h"><button type="button" class="x" data-nav="-1" aria-label="上個月">&lt;</button><b>${y}/${pad(m)}</b><button type="button" class="x" data-nav="1" aria-label="下個月">&gt;</button></div>
        <div class="cal-g">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<i>${w}</i>`).join('')}${cells.join('')}</div>
        <div class="cal-f"><button type="button" class="btn btn-ghost btn-sm" data-v="">清除</button><button type="button" class="btn btn-sm" data-v="${TODAY}">今天</button></div>`;
    };
    openPop(anchor, render);
    pop.onclick = (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        m += +nav.dataset.nav; if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
        render(); placePop(anchor); pop.querySelector(`[data-nav="${nav.dataset.nav}"]`).focus();
        return;
      }
      const d = e.target.closest('[data-v]'); if (!d) return;
      const v = d.dataset.v; closePop(); applyPick(anchor, v, dateLabel(v));
    };
    (pop.querySelector('.cal-d.on') || pop.querySelector('.cal-d.today') || pop.querySelector('.cal-d'))?.focus();
  }
  function openSound(anchor) {
    const seg = (key, list, cur) => `<div class="seg">${list.map(([v, l]) => `<button type="button" data-novoice data-set="${key}" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;
    let target = 'voice';                 // 目前在設定哪一種情況的音色
    const render = () => {
      const c = state.sfx;
      pop.className = 'pop pxb snd';
      pop.innerHTML = `
        <div class="snd-h">SOUND</div>
        <div class="snd-r"><span>音效</span>${seg('muted', [[0, '開'], [1, '關']], +state.muted)}</div>
        <div class="snd-r"><span>音量</span>${seg('vol', [1, 2, 3, 4, 5].map((n) => [n, n]), c.vol)}</div>
        <div class="snd-r"><span>音高</span>${seg('pitch', [[1, '跟位置'], [0, '固定']], +c.pitch)}</div>
        <div class="snd-l">音色（點了會試聽）${seg('target', [['voice', '按到東西'], ['miss', '沒按到'], ['cash', '購買']], target)}</div>
        <div class="pop-list">${(target === 'cash'
          ? [['', '收銀機', 'c-cyan'], ...Object.entries(VOICES).filter(([, v]) => v.file).map(([k, v]) => [k, v.name, 'c-yel']), ['none', '（無聲）', '']]
          : [...Object.entries(VOICES).map(([k, v]) => [k, v.name, v.file ? 'c-yel' : 'c-cyan']), ['none', '（無聲）', '']]).map(([k, n, col]) => `<div class="pop-row"><button type="button" data-novoice class="pop-opt ${c[target] === k ? 'on' : ''}" data-set="tone" data-v="${esc(k)}" aria-pressed="${c[target] === k}"><i class="sw ${col}"></i><span>${esc(n)}</span></button></div>`).join('')}</div>`;
    };
    openPop(anchor, render);
    pop.onclick = (e) => {
      const b = e.target.closest('[data-set]'); if (!b) return;
      const k = b.dataset.set, v = b.dataset.v;
      if (k === 'muted') state.muted = v === '1';
      else if (k === 'vol') state.sfx.vol = +v;
      else if (k === 'pitch') state.sfx.pitch = v === '1';
      else if (k === 'target') target = v;
      else state.sfx[target] = v;
      save(); updateHud(); render(); placePop(anchor);
      [...pop.querySelectorAll(`[data-set="${k}"]`)].find((x) => x.dataset.v === v)?.focus();
      if (target === 'cash' && (k === 'target' || k === 'tone')) { primeCash(); kaching(); }
      else { lastKey = 0; keySound(lastX, k === 'target' || k === 'tone' ? target : 'voice'); }
    };
    pop.querySelector('.pop-opt.on')?.focus();
  }
  /* 齒輪：所有設定的入口。之後有新的設定畫面，在 SETTINGS 加一列就好 */
  const SETTINGS = [
    { k: 'name', l: '名稱', v: () => NAME() + '//OS', go: () => { closePop(); openName(); } },
    { k: 'sound', l: '音效', v: () => (state.muted ? 'OFF' : 'ON'), go: (a) => openSound(a) },
    { k: 'rates', l: '獎勵金額', v: () => '', go: () => { closePop(); openRates(); } },
    { k: 'phone', l: '手機', v: () => (lanInfo?.on ? 'ON' : 'OFF'), show: () => !!(lanInfo?.available && lanInfo.local), go: () => { closePop(); openPhone(); } },
    { k: 'ver', l: '版本', v: () => verInfo?.version || '', show: () => !!verInfo?.updatable, go: () => { closePop(); checkUpdate(); } }
  ];
  /* 手機連線（Windows 版）：開了伺服器會重開、改聽所有網卡；同一個 Wi-Fi 的手機掃 QR code（網址帶鑰匙）進來 */
  let lanInfo = null;
  const loadLan = () => fetch('/api/lan', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((v) => { lanInfo = v; return v; }).catch(() => null);
  function openPhone() {
    let busyLan = false;
    const render = () => {
      const L = lanInfo || {};
      box.innerHTML = `
        <div class="m-head"><span class="rt-head">PHONE</span><button class="x" data-act="close" aria-label="關閉">X</button></div>
        <h3 class="rt-title">手機連線</h3>
        <div class="snd-r"><span></span><div class="seg">${[[1, '開'], [0, '關']].map(([v, l]) => `<button type="button" data-act="lan" data-v="${v}" class="${+!!L.on === v ? 'on' : ''}" aria-pressed="${+!!L.on === v}" ${busyLan ? 'disabled' : ''}>${l}</button>`).join('')}</div></div>
        ${busyLan ? '<p class="rt-sub">重新啟動中…</p>'
          : L.on && L.url ? `<div class="ph-qr"><img src="/api/lan/qr.svg?t=${Date.now()}" alt="手機掃這個 QR code" width="220" height="220"></div>
            <p class="rt-sub">手機連同一個 Wi-Fi，用相機掃。</p><p class="ph-url">${esc(L.url)}</p>`
          : L.on ? '<p class="rt-sub">找不到這台電腦的網路位址，先確認有連上 Wi-Fi。</p>'
          : '<p class="rt-sub">打開後用手機掃 QR code，就能在手機上用。第一次 Windows 防火牆會跳出來，請按「允許」。</p>'}
        <div class="rt-foot"><span class="sp"></span><button class="btn" data-act="close">完成</button></div>`;
    };
    const ctl = openModal('wl', {
      dismiss: () => !busyLan, render,
      async click(e) {
        const el = e.target.closest('[data-act]'); if (!el) return;
        if (el.dataset.act === 'close') return ctl.close();
        if (el.dataset.act !== 'lan' || busyLan || +el.dataset.v === +!!lanInfo?.on) return;
        busyLan = true; render();
        try { const r = await fetch('/api/lan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: el.dataset.v === '1' }) }); if (!r.ok) throw new Error(r.status); } catch (er) { busyLan = false; render(); return toast('改不了：' + er.message); }
        for (let i = 0; i < 40; i++) {                 // 等伺服器重開（約 1–2 秒）
          await sleep(400);
          const v = await loadLan();
          if (v && v.on === (el.dataset.v === '1')) break;
        }
        busyLan = false; if (modalCtl === ctl) render();
      }
    });
  }
  /* 版本與自動更新（Windows 版）：伺服器每 6 小時自己檢查；這裡可以立刻檢查一次 */
  let verInfo = null;
  const loadVer = () => fetch('/api/update', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((v) => { verInfo = v; }).catch(() => {});
  async function checkUpdate() {
    toast('檢查更新中…', null, 30000);
    try { const r = await fetch('/api/update', { method: 'POST' }); if (!r.ok) throw new Error(r.status); verInfo = await r.json(); } catch (e) { return toast('連不到看板伺服器'); }
    const v = verInfo;
    toast({ latest: `已經是最新版 ${v.version}`, staged: `新版 ${v.latest} 下載好了，等一下會自己換上`, skipped: `${v.latest} 上次裝了開不起來，已經退回 ${v.version}`, offline: '連不到更新伺服器，之後會自動再試' }[v.status] || `更新失敗：${v.error || v.status}`, null, 4500);
  }
  function openSettings(anchor) {
    openPop(anchor, () => {
      pop.className = 'pop pxb';
      pop.innerHTML = `<div class="snd-h">SETTINGS</div><div class="pop-list">${SETTINGS.filter((s) => !s.show || s.show()).map((s) => `<div class="pop-row"><button type="button" class="pop-opt set-opt" data-go="${s.k}"><span>${s.l}</span><em>${esc(s.v())}</em><i class="set-arrow">▸</i></button></div>`).join('')}</div>`;
    });
    pop.onclick = (e) => { const b = e.target.closest('[data-go]'); if (b) SETTINGS.find((s) => s.k === b.dataset.go).go(anchor); };
    pop.querySelector('.pop-opt')?.focus();
  }
  const fmtAt = (ms) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  /* 錢包：上面兩個分頁「商店」「紀錄」；停在哪一頁記在這台的 localStorage（kos.wtab） */
  const wtab = (v) => { try { if (v) localStorage.setItem('kos.wtab', v); return localStorage.getItem('kos.wtab') || 'shop'; } catch (e) { return v || 'shop'; } };
  function openWallet(tab) {
    let err = '', keep = { note: '', amt: '' }, cur = wtab(tab);
    primeCash();
    const logTab = () => {
      const W = state.wallet, ym = TODAY.slice(0, 7);
      const mon = W.log.filter((e) => ymd(new Date(e.at)).slice(0, 7) === ym);
      const earn = mon.reduce((n, e) => n + Math.max(0, e.amt), 0), spent = mon.reduce((n, e) => n + Math.max(0, -e.amt), 0);
      const rows = W.log.filter((e) => e.amt).slice(-60).reverse().map((e) => `
        <div class="wl-row"><span class="wl-at">${fmtAt(e.at)}</span><span class="wl-note">${esc(e.note)}</span><b class="${e.amt < 0 ? 'wl-out' : 'wl-in'}">${e.amt < 0 ? '-' : '+'}${money(Math.abs(e.amt))}</b>${
          e.ref ? '<span class="wl-x"></span>' : `<button class="x" data-act="del-spend" data-id="${e.id}" aria-label="${e.buy ? '退貨' : '刪除這筆花費'}：${esc(e.note)}">X</button>`}</div>`).join('');
      return `
        <p class="rt-sub">完成就自動入帳；專注照時長累積，滿 $1 入帳。1 點＝NT$1。</p>
        <div class="wl-stat"><span>本月獲得<b class="wl-in">+${money(earn)}</b></span><span>本月花費<b class="wl-out">-${money(spent)}</b></span>${foCents() ? `<span>專注累積<b class="wl-in">${cents(foCents() % 100)}</b></span>` : ''}</div>
        <form class="wl-form" data-form="spend">
          <input class="in" name="note" placeholder="買了什麼" autocomplete="off" aria-label="買了什麼" value="${esc(keep.note)}">
          <input class="in wl-amt" name="amt" type="number" inputmode="numeric" min="1" step="1" placeholder="金額" aria-label="金額" value="${esc(keep.amt)}">
          <button class="btn btn-mag btn-sm" data-novoice>花費</button>
        </form>
        ${err ? `<p class="wl-err" role="alert">${esc(err)}</p>` : ''}
        <h4 class="wl-h">紀錄</h4>
        <div class="wl-log">${rows || empty('NO RECORDS', '完成一個任務就會有第一筆入帳')}</div>`;
    };
    const shopTab = () => {
      const bal = balance();
      const cards = shopLive().map((s) => ({ s, left: shopLeft(s) }))
        .sort((a, b) => (b.s.id === state.goal) - (a.s.id === state.goal) || (a.left > 0 ? 0 : 1) - (b.left > 0 ? 0 : 1) || a.s.price - b.s.price)
        .map(({ s, left }) => {
          const out = left <= 0, can = !out && bal >= s.price, pct = can ? 100 : Math.min(99, Math.floor(Math.max(0, bal) / s.price * 100)), goal = s.id === state.goal && !out;
          return `<button class="sh-card${can ? ' can' : ''}${out ? ' out' : ''}${goal ? ' goal' : ''}" data-act="item" data-id="${s.id}" aria-label="${goal ? '目標：' : ''}${esc(s.name)}，${money(s.price)}${out ? '，已售完' : can ? '，可以買' : `，還差 ${money(s.price - bal)}`}">
            <span class="sh-pic">${sprite(s)}${goal ? '<i class="sh-tgt">GOAL</i>' : ''}${out ? '<i class="sh-sold">SOLD OUT</i>' : left !== Infinity && left > 1 ? `<i class="sh-qty">×${left}</i>` : ''}</span>
            <span class="sh-name">${esc(s.name)}</span>
            <span class="sh-price">${COIN}${money(s.price)}</span>
            ${out ? '' : `<span class="sh-bar"><i style="width:${pct}%"></i></span>`}</button>`;
        }).join('');
      const bought = [...state.buys].sort((a, b) => (a.got ? 1 : 0) - (b.got ? 1 : 0) || b.at - a.at).slice(0, 60).map((b) => `
        <div class="sh-buy${b.got ? ' got' : ''}">
          <span class="sh-bpic">${sprite(state.shop.find((x) => x.id === b.sid))}</span>
          <span class="sh-bname">${esc(b.name)}${b.n > 1 ? ` ×${b.n}` : ''}<small>${fmtAt(b.at)}<b class="wl-out">-${money(b.price * b.n)}</b></small></span>
          <button class="ckline sh-got" data-act="got" data-id="${b.id}" aria-pressed="${!!b.got}"><span class="chk ${b.got ? 'on' : ''}"></span>入手</button>
          <button class="x" data-act="refund" data-id="${b.id}" aria-label="退貨：${esc(b.name)}">X</button>
        </div>`).join('');
      return `<div class="sh-grid">${cards}<button class="sh-card sh-add" data-act="add"><span class="sh-pic">${PLUS}</span><span class="sh-name">上架</span></button></div>
        ${bought ? `<h4 class="wl-h">已購</h4><div class="sh-buys">${bought}</div>` : ''}`;
    };
    const render = () => {
      const bal = balance(), can = shopLive().filter((s) => shopLeft(s) > 0 && s.price <= bal).length;
      box.innerHTML = `
        <div class="rt-head">WALLET</div>
        <div class="wl-bal ${bal < 0 ? 'neg' : ''}">${COIN}<b>${money(bal)}</b></div>
        <div class="wl-tabs" role="tablist">${[['shop', '商店', can], ['log', '紀錄', 0]].map(([k, l, n]) => `<button role="tab" data-act="tab" data-tab="${k}" aria-selected="${cur === k}" class="${cur === k ? 'on' : ''}">${l}${n ? `<em>${n}</em>` : ''}</button>`).join('')}</div>
        ${cur === 'shop' ? shopTab() : logTab()}
        <div class="rt-foot"><button class="btn btn-ghost" data-act="rates">獎勵金額設定</button><span class="sp"></span><button class="btn" data-act="close">完成</button></div>`;
    };
    const refund = (bid) => {
      const b = state.buys.find((x) => x.id === bid), undo = refundBuy(bid); if (!undo) return;
      err = ''; sfx.uncheck(); render();
      toast(`已退貨「${b.name}」，${money(b.price * b.n)} 退回錢包`, () => { undo(); if (modalCtl === ctl) render(); });
    };
    const ctl = openModal('wl', {
      dismiss: () => true, render,
      click(e) {
        const el = e.target.closest('[data-act]'); if (!el) return;
        const act = el.dataset.act, id = el.dataset.id;
        if (act === 'close') ctl.close();
        else if (act === 'tab') { cur = wtab(el.dataset.tab); err = ''; render(); }
        else if (act === 'rates') { ctl.close(); openRates(true); }
        else if (act === 'add') { ctl.close(); openShopEdit(null); }
        else if (act === 'item') { ctl.close(); openShopItem(id); }
        else if (act === 'got') {
          const b = state.buys.find((x) => x.id === id); if (!b) return;
          if (b.got) { delete b.got; sfx.uncheck(); } else { b.got = Date.now(); sfx.check(); }
          save(); render();
        }
        else if (act === 'refund') refund(id);
        else if (act === 'del-spend') {
          const W = state.wallet, i = W.log.findIndex((x) => x.id === id); if (i < 0) return;
          if (W.log[i].buy) return refund(W.log[i].buy);               // 商店買的：連同「已購」一起退
          const [gone] = W.log.splice(i, 1); err = '';
          save(); updateCoin(); render();
          toast(`已刪除花費「${gone.note}」，${money(-gone.amt)} 退回錢包`, () => { W.log.push(gone); W.log.sort((a, b) => a.at - b.at); save(); updateCoin(); if (modalCtl === ctl) render(); });
        }
      },
      submit(e) {
        e.preventDefault();
        const f = e.target, note = f.note.value.trim(), amt = Math.round(+f.amt.value);
        keep = { note, amt: f.amt.value };
        if (!note) err = '請填買了什麼。';
        else if (!(amt > 0)) err = '金額要是大於 0 的整數。';
        else if (amt > balance()) err = `錢包只有 ${money(balance())}，不夠花 ${money(amt)}。`;
        else { err = ''; keep = { note: '', amt: '' }; state.wallet.log.push({ id: uid('s'), at: Date.now(), amt: -amt, note }); save(); updateCoin(true); kaching(); }
        if (err) sfx.deny();
        render();
        box.querySelector(err ? (note ? '.wl-amt' : '[name="note"]') : '[name="note"]')?.focus();
      }
    });
  }
  function openRates(fromWallet) {
    const R = () => state.wallet.rates;
    const fields = () => [
      { k: 'daily', l: '每日任務（優先級每級 +10%）', v: R().daily },
      ...O.tType.map((o) => ({ k: 't:' + o.n, l: `專案「${o.n}」`, v: R().types[o.n] ?? R().other })),
      { k: 'project', l: '專案結案', v: R().project },
      { k: 'wake', l: '開始今日（05:30）', v: R().wake },
      { k: 'am', l: '晨間 routine', v: R().am },
      { k: 'pm', l: '晚間關機程序（01:00 前）', v: R().pm },
      { k: 'habit', l: '習慣（每個每天）', v: R().habit },
      { k: 'review', l: '每週復盤', v: R().review },
      { k: 'focus', l: '專注（分鐘數的 %）', v: R().focus },
      { k: 'late', l: '逾期每天扣 %', v: R().late }
    ];
    const render = () => {
      box.innerHTML = `
        <div class="rt-head">REWARDS</div>
        <h3 class="rt-title">獎勵金額</h3>
        <p class="rt-sub">單位 NT$，只影響之後完成的項目。逾期最低剩 $1。</p>
        <div class="wl-rates">${fields().map((f) => `<label class="wl-rate"><span>${esc(f.l)}</span><input class="in" type="number" inputmode="numeric" min="0" step="1" data-rate="${esc(f.k)}" value="${f.v}"></label>`).join('')}</div>
        <div class="rt-foot"><button class="btn btn-ghost" data-act="reset">恢復建議值</button><span class="sp"></span><button class="btn" data-act="close">完成</button></div>`;
    };
    const ctl = openModal('wl', {
      dismiss: () => true, render,
      change(e) {
        const el = e.target.closest('[data-rate]'); if (!el) return;
        const k = el.dataset.rate, n = Math.min(k === 'late' || k === 'focus' ? 100 : 1e7, Math.max(0, Math.round(+el.value || 0))); el.value = n;
        if (k.startsWith('t:')) R().types[k.slice(2)] = n; else R()[k] = n;
        save();
      },
      click(e) {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') { ctl.close(); if (fromWallet) openWallet(); }
        else if (act === 'reset') { state.wallet.rates = JSON.parse(JSON.stringify(RATE0)); save(); render(); }
      }
    });
  }

  /* ══════════ 商店：自己想買的東西，錢夠了自己按購買 ══════════
     shop [{ id, name, price, qty, img, px, link, note, at, del }]　qty＝上架總數（null＝不限）；剩幾個＝qty－已買的數量（算出來的，兩台同時買也不會亂）
     buys [{ id, sid, name, price, n, at, got }]　買的當下的品名、單價；got＝真的入手的時間
     錢包紀錄多一筆負的（沒有 ref，帶 buy＝購買 id），退貨時兩筆一起刪。有買過的商品下架只標 del，已購清單還看得到圖 */
  const shopLive = () => state.shop.filter((s) => !s.del);
  const shopLeft = (s) => (s.qty == null ? Infinity : s.qty - state.buys.reduce((n, b) => n + (b.sid === s.id ? b.n : 0), 0));
  const earnRate = () => { const since = Date.now() - 14 * 864e5; return state.wallet.log.reduce((n, e) => n + (e.amt > 0 && e.at >= since ? e.amt : 0), 0) / 14; };   // 最近兩週平均每天賺多少
  const GIFT = '<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges"><path fill="#ff2a6d" d="M2 7h12v8H2z"/><path fill="#ff6b96" d="M1 5h14v2H1z"/><path fill="#a3123f" d="M2 14h12v1H2z"/><path fill="#fcee0a" d="M7 5h2v10H7zM4 2h3v1h1v2H4zM9 2h3v3H8V3h1z"/></svg>';
  const PLUS = '<svg viewBox="0 0 9 9" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M3 0h3v3h3v3H6v3H3V6H0V3h3z"/></svg>';
  const CAM = '<svg viewBox="0 0 16 12" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M5 0h6v2h4v10H1V2h4z"/><path fill="#0e0c1b" d="M6 4h4v1h1v4h-1v1H6V9H5V5h1z"/><path fill="currentColor" d="M7 6h2v2H7z"/></svg>';
  const sprite = (s) => (s?.img ? `<img src="${esc(s.img)}" alt="" draggable="false">` : GIFT);
  function refundBuy(bid) {                        // 退貨：刪掉已購＋錢包那筆，回傳「復原」用的函式
    const i = state.buys.findIndex((x) => x.id === bid); if (i < 0) return null;
    const [b] = state.buys.splice(i, 1), W = state.wallet, j = W.log.findIndex((e) => e.buy === bid);
    const e = j >= 0 ? W.log.splice(j, 1)[0] : null;
    save(); updateCoin(true);
    return () => {
      if (!state.buys.some((x) => x.id === b.id)) { state.buys.push(b); state.buys.sort((x, y) => x.at - y.at); }
      if (e && !W.log.some((x) => x.id === e.id)) { W.log.push(e); W.log.sort((x, y) => x.at - y.at); }
      save(); updateCoin(true);
    };
  }

  /* 合成的收銀機聲（備用）：「喀」按鍵＋拉桿、抽屜滑出、「鏘」一聲鈴、幾枚硬幣落下 */
  let cashNoise = null;
  function cashSound(ctx, level) {
    const t = ctx.currentTime + 0.005, out = ctx.createGain();
    out.gain.value = Math.min(1.6, level); out.connect(ctx.destination);
    if (!cashNoise || cashNoise.sampleRate !== ctx.sampleRate) {
      cashNoise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
      const d = cashNoise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const env = (g, at, peak, dec) => { g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.003 + dec); };
    const tone = (f, at, peak, dec, type = 'sine', f1) => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
      o.frequency.setValueAtTime(f, at); if (f1) o.frequency.exponentialRampToValueAtTime(f1, at + dec);
      env(g, at, peak, dec); o.connect(g); g.connect(out); o.start(at); o.stop(at + dec + 0.05);
    };
    const hiss = (at, dec, f, q, peak) => {
      const n = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      n.buffer = cashNoise; bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      env(g, at, peak, dec); n.connect(bp); bp.connect(g); g.connect(out); n.start(at, Math.random() * 0.2); n.stop(at + dec + 0.05);
    };
    tone(150, t, 0.1, 0.07, 'square', 60); hiss(t, 0.03, 3200, 0.9, 0.42);                 // 喀
    hiss(t + 0.05, 0.03, 1900, 1.4, 0.3);                                                 // 拉桿彈回
    hiss(t + 0.08, 0.2, 520, 1.6, 0.3); tone(70, t + 0.08, 0.06, 0.18, 'triangle', 50);   // 抽屜滑出
    const b = t + 0.07;                                                                    // 鏘：鈴的不和諧泛音，兩個主音差一點點，會有一點閃爍
    [[1, 0.15, 1.4], [1.004, 0.09, 1.2], [2.76, 0.06, 0.7], [5.4, 0.035, 0.35], [8.93, 0.015, 0.2]].forEach(([m, a, d]) => tone(1760 * m, b, a, d));
    tone(3520, b, 0.03, 0.08, 'triangle');                                                // 敲擊瞬間的亮點
    [0.22, 0.3, 0.35, 0.44, 0.52].forEach((dt, i) => tone(2600 + ((i * 677) % 1700), b + dt, 0.035 - i * 0.004, 0.07, 'triangle'));   // 硬幣
  }
  /* 實際用的是 fx/cash.wav：使用者給的兩段錄影（遊戲裡按「出售」那一聲：清脆的按鍵聲 → 0.39 秒後一聲鈴，鈴帶回音），從實況主的人聲裡抽出來的（做法見 fx/cash_build.py）。
     打開錢包時先抓檔、先解碼好；還沒載到或解不開才用上面合成的那一聲 */
  const CASH_URL = 'fx/cash.wav?5';                // 音檔快取 30 天：換檔要改這裡的 ?5
  let cashData = null, cashBuf = null, cashLoad = null;
  const loadCash = () => (cashLoad ||= fetch(CASH_URL).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))).then((b) => { cashData = b; }).catch(() => { cashLoad = null; }));
  const decodeCash = (ctx) => (cashBuf && cashBuf.kosCtx === ctx ? Promise.resolve(cashBuf)
    : ctx.decodeAudioData(cashData.slice(0)).then((buf) => { buf.kosCtx = ctx; return (cashBuf = buf); }));
  function primeCash() {                           // 打開錢包／商品頁時呼叫：之後按購買就能馬上響
    loadCash()?.then(() => { if (cashData && actx && actx.state === 'running') decodeCash(actx).catch(() => {}); });
  }
  function kaching() {
    if (state.muted || state.sfx.cash === 'none') return;
    const lv = VOL[state.sfx.vol] ?? 1; if (!lv) return;
    const own = VOICES[state.sfx.cash];             // 自己選的音檔（sounds/）；檔案不見了就回到收銀機
    if (own?.file) return audio((ctx) => playSample(ctx, state.sfx.cash, 220, lv, 2.8));
    audio((ctx) => {
      if (!cashData) { loadCash(); return cashSound(ctx, lv); }
      decodeCash(ctx).then((buf) => {
        const n = ctx.createBufferSource(), g = ctx.createGain();
        n.buffer = buf; g.gain.value = Math.min(1.1, lv * 0.7);
        n.connect(g); g.connect(ctx.destination); n.start();
      }, () => cashSound(ctx, lv));
    });
  }

  /* ══════════ 商店：照片 → 像素圖 ══════════
     全部在瀏覽器裡用 canvas 算：照片縮到最長邊 512 → 邊緣大多是同一色（或透明）就從邊緣往內去背、裁到主體 →
     每格取平均 → 加一點飽和與對比 → k-means 減色 → 去背的加一圈深色描邊。
     存成 n×n 的 PNG（約 1–3 KB）放在 data.json，畫面上用整數倍放大（96＝24×4＝32×3＝48×2）。原圖不存。 */
  const PX_K = { 24: 12, 32: 16, 48: 24 };          // 邊長 → 顏色數
  const dist2 = (d, i, c) => { const r = d[i] - c[0], g = d[i + 1] - c[1], b = d[i + 2] - c[2]; return r * r + g * g + b * b; };
  async function readPhoto(file) {
    let src, url;
    try { src = await createImageBitmap(file); }
    catch (e) { url = URL.createObjectURL(file); src = new Image(); src.src = url; await src.decode(); }
    try {
      const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
      if (!w0 || !h0) throw new Error('empty image');
      const k = Math.min(1, 512 / Math.max(w0, h0)), w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, w, h);
      const P = { w, h, d: g.getImageData(0, 0, w, h).data };
      P.bg = bgOf(P);
      return P;
    } finally { if (src && src.close) src.close(); if (url) URL.revokeObjectURL(url); }
  }
  function bgOf(P) {                               // 看邊緣一圈：大多透明，或大多接近同一個顏色 → 預設去背
    const { w, h, d } = P, pts = [], st = Math.max(1, Math.round((w + h) / 400));
    for (let x = 0; x < w; x += st) pts.push(x * 4, ((h - 1) * w + x) * 4);
    for (let y = 0; y < h; y += st) pts.push(y * w * 4, (y * w + w - 1) * 4);
    if (pts.filter((i) => d[i + 3] < 128).length > pts.length / 2) return { clear: true, auto: true };
    const c = [0, 1, 2].map((k) => { const v = pts.map((i) => d[i + k]).sort((a, b) => a - b); return v[v.length >> 1]; });
    return { c, auto: pts.filter((i) => dist2(d, i, c) < 1600).length > pts.length * 0.6 };
  }
  function bgMask(P) {                             // 從邊緣往內長：接近背景色，或在漸層／陰影裡跟旁邊差很少的，都算背景（1）
    const { w, h, d, bg } = P, m = new Uint8Array(w * h), st = new Int32Array(w * h); let n = 0;
    const near = (p, q) => {
      const i = p * 4; if (d[i + 3] < 128) return true;
      if (bg.clear) return false;
      const k = dist2(d, i, bg.c); if (k < 3364) return true;                            // 58²
      if (q < 0 || k > 12100) return false;                                               // 110²
      const j = q * 4, r = d[i] - d[j], g = d[i + 1] - d[j + 1], b = d[i + 2] - d[j + 2];
      return r * r + g * g + b * b < 64;                                                  // 8²
    };
    const go = (p, q) => { if (!m[p] && near(p, q)) { m[p] = 1; st[n++] = p; } };
    for (let x = 0; x < w; x++) { go(x, -1); go((h - 1) * w + x, -1); }
    for (let y = 0; y < h; y++) { go(y * w, -1); go(y * w + w - 1, -1); }
    while (n) { const p = st[--n], x = p % w; if (x) go(p - 1, p); if (x < w - 1) go(p + 1, p); if (p >= w) go(p - w, p); if (p < w * h - w) go(p + w, p); }
    return m;
  }
  const punch = (r, g, b) => {                     // 像素畫的顏色比照片鮮豔一點
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    return [r, g, b].map((v) => (l + (v - l) * 1.25 - 128) * 1.08 + 128);
  };
  function quantize(px, k) {                       // k-means 減色；亂數種子固定，同一張照片每次結果一樣
    const idx = []; for (let i = 0; i < px.length; i += 4) if (px[i + 3]) idx.push(i);
    if (idx.length <= k) return;
    let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const d2 = (i, c) => { const r = px[i] - c[0], g = px[i + 1] - c[1], b = px[i + 2] - c[2]; return 2 * r * r + 4 * g * g + 3 * b * b; };
    const C = [[px[idx[0]], px[idx[0] + 1], px[idx[0] + 2]]], D = new Float64Array(idx.length).fill(Infinity);
    while (C.length < k) {                         // k-means++：離現有中心越遠越容易被選成新中心
      const c = C[C.length - 1]; let sum = 0;
      idx.forEach((i, j) => { D[j] = Math.min(D[j], d2(i, c)); sum += D[j]; });
      if (!sum) break;
      let r = rnd() * sum, j = 0; while (j < idx.length - 1 && (r -= D[j]) > 0) j++;
      C.push([px[idx[j]], px[idx[j] + 1], px[idx[j] + 2]]);
    }
    const near = (i) => { let best = 0, bd = Infinity; C.forEach((c, j) => { const v = d2(i, c); if (v < bd) { bd = v; best = j; } }); return best; };
    for (let it = 0; it < 10; it++) {
      const S = C.map(() => [0, 0, 0, 0]);
      for (const i of idx) { const s = S[near(i)]; s[0] += px[i]; s[1] += px[i + 1]; s[2] += px[i + 2]; s[3]++; }
      S.forEach((s, j) => { if (s[3]) C[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    }
    for (const i of idx) { const c = C[near(i)]; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
  }
  function outline(px, n) {                        // 去掉落單的點，再在主體外面加一圈：取旁邊最暗的顏色壓暗，像遊戲道具
    const on = (q, x, y) => x >= 0 && y >= 0 && x < n && y < n && q[(y * n + x) * 4 + 3];
    const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let src = px.slice();
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (src[(y * n + x) * 4 + 3] && !N4.some(([a, b]) => on(src, x + a, y + b))) px[(y * n + x) * 4 + 3] = 0;
    src = px.slice();
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4; if (src[o + 3]) continue;
      let best = -1, lum = Infinity;
      for (const [a, b] of N4) {
        if (!on(src, x + a, y + b)) continue;
        const q = ((y + b) * n + x + a) * 4, l = src[q] * 0.3 + src[q + 1] * 0.59 + src[q + 2] * 0.11;
        if (l < lum) { lum = l; best = q; }
      }
      if (best < 0) continue;
      px[o] = src[best] * 0.3 + 6; px[o + 1] = src[best + 1] * 0.3 + 4; px[o + 2] = src[best + 2] * 0.3 + 14; px[o + 3] = 255;
    }
  }
  function pixelize(P, n, cut) {
    const { w, h, d } = P;
    let m = null, x0, y0, side;
    if (cut) {
      m = P.mask ||= bgMask(P);
      let l = w, t = h, r = -1, b = -1, cnt = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!m[y * w + x]) { cnt++; if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
      if (cnt < w * h * 0.01) cut = false;          // 幾乎整張都被當成背景：不去背
      else { side = Math.max(r - l + 1, b - t + 1) * 1.04; x0 = (l + r + 1 - side) / 2; y0 = (t + b + 1 - side) / 2; }
    }
    if (!cut) { m = null; side = Math.min(w, h); x0 = (w - side) / 2; y0 = (h - side) / 2; }
    const pad = cut ? 1 : 0, g = n - pad * 2, cell = side / g, out = new Uint8ClampedArray(n * n * 4);
    for (let ty = 0; ty < g; ty++) for (let tx = 0; tx < g; tx++) {
      const ax = x0 + tx * cell, ay = y0 + ty * cell;
      let r = 0, gg = 0, b = 0, f = 0, all = 0;
      for (let y = Math.floor(ay); y < Math.ceil(ay + cell); y++) for (let x = Math.floor(ax); x < Math.ceil(ax + cell); x++) {
        all++;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const p = y * w + x, i = p * 4;
        if ((m && m[p]) || d[i + 3] < 128) continue;
        r += d[i]; gg += d[i + 1]; b += d[i + 2]; f++;
      }
      if (!f || f < all * 0.45) continue;
      const o = ((ty + pad) * n + tx + pad) * 4, c = punch(r / f, gg / f, b / f);
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
    quantize(out, PX_K[n] || 16);
    if (cut) outline(out, n);
    const cv = document.createElement('canvas'); cv.width = cv.height = n;
    cv.getContext('2d').putImageData(new ImageData(out, n, n), 0, 0);
    return cv.toDataURL('image/png');
  }

  /* 商品頁：大圖、價格、剩幾個、還差多少（照最近兩週的速度約幾天）、買幾個、購買 → 收據 */
  function openShopItem(id) {
    let n = 1, sold = null;
    primeCash();
    const render = () => {
      const s = state.shop.find((x) => x.id === id);
      if (!s) { ctl.close(); return openWallet('shop'); }
      if (sold) return receipt(s);
      const bal = balance(), left = shopLeft(s), max = Math.min(left, 99, Math.max(1, Math.floor(Math.max(0, bal) / s.price)));
      n = Math.max(1, Math.min(n, max));
      const total = s.price * n, need = total - bal, rate = earnRate(), days = need > 0 && rate > 0 ? Math.ceil(need / rate) : 0;
      const pct = Math.min(99, Math.floor(Math.max(0, bal) / total * 100));
      box.innerHTML = `
        <div class="rt-head">SHOP</div>
        <div class="sh-item">
          <div class="sh-big sh-pic">${sprite(s)}</div>
          <div class="sh-info">
            <h3 class="rt-title">${esc(s.name)}</h3>
            <div class="sh-p">${COIN}<b>${money(s.price)}</b><em>${left === Infinity ? '∞' : left > 0 ? `剩 ${left}` : 'SOLD OUT'}</em></div>
            ${s.note ? `<p class="sh-note">${esc(s.note)}</p>` : ''}
            ${s.link ? `<a class="sh-link" href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">商品連結 ↗</a>` : ''}
            ${left > 0 ? `<button class="ckline sh-goal" data-act="goal" aria-pressed="${state.goal === s.id}"><span class="chk ${state.goal === s.id ? 'on' : ''}"></span>鎖定目標</button>` : ''}
          </div>
        </div>
        ${left > 0 && need > 0 ? `<div class="sh-need"><span class="sh-bar"><i style="width:${pct}%"></i></span><span>還差 <b>${money(need)}</b>${days ? ` · 約 ${days} 天` : ''}</span></div>` : ''}
        ${left > 0 ? `<div class="sh-buyrow">
          ${max > 1 || n > 1 ? `<div class="sh-step"><button type="button" data-act="n-" aria-label="少買一個" ${n <= 1 ? 'disabled' : ''}>−</button><b aria-live="polite">${n}</b><button type="button" data-act="n+" aria-label="多買一個" ${n >= max ? 'disabled' : ''}>＋</button></div>` : ''}
          <button class="btn btn-mag sh-go" data-act="buy" data-novoice ${need > 0 ? 'disabled' : ''}>購買 ${money(total)}</button>
        </div>` : ''}
        <div class="rt-foot"><button class="btn btn-ghost danger" data-act="del">下架</button><button class="btn btn-ghost" data-act="edit">編輯</button><span class="sp"></span><button class="btn" data-act="back">返回</button></div>`;
    };
    const receipt = (s) => {                       // 收據從上往下印出來，最後蓋 PAID
      const no = String(state.buys.filter((b) => b.at <= sold.at).length).padStart(4, '0');
      box.innerHTML = `
        <div class="rt-head">SHOP</div>
        <div class="sh-rcpt">
          <div class="sh-paper" role="status">
            <div class="rc-h">${esc(NAME())}//OS MART</div>
            <div class="rc-pic">${sprite(s)}</div>
            <div class="rc-l"><span>${esc(sold.name)}</span><span>×${sold.n}</span></div>
            <div class="rc-l"><span>單價</span><span>${money(sold.price)}</span></div>
            <div class="rc-l rc-t"><span>TOTAL</span><span>${money(sold.price * sold.n)}</span></div>
            <div class="rc-l"><span>餘額</span><span>${money(balance())}</span></div>
            <div class="rc-f">${fmtAt(sold.at)} · #${no}</div>
            <div class="rc-f rc-ty">THANK YOU</div>
            <i class="rc-paid">PAID</i>
          </div>
        </div>
        <div class="rt-foot"><span class="sp"></span><button class="btn" data-act="back">完成</button></div>`;
    };
    function buy() {
      const s = state.shop.find((x) => x.id === id); if (!s) return;
      const total = s.price * n;
      if (shopLeft(s) < n || balance() < total) { sfx.deny(); return render(); }
      kaching();
      const b = { id: uid('b'), sid: s.id, name: s.name, price: s.price, n, at: Date.now() };
      state.buys.push(b);
      state.wallet.log.push({ id: 'e' + b.id, at: b.at, amt: -total, note: `購買 ${s.name}${n > 1 ? ` ×${n}` : ''}`, buy: b.id });
      save(); updateCoin(true);
      sold = b; render();
      if (!reduced) for (let i = 0; i < 9; i++) setTimeout(() => { if (modalCtl === ctl && sold === b) sfx.tick(); }, 420 + i * 90);   // 印收據的聲音
      toast(`已購買「${s.name}」${n > 1 ? ` ×${n}` : ''}　-${money(total)}`, () => { refundBuy(b.id); if (modalCtl === ctl) { sold = null; render(); } else if (modalCtl) modalCtl.rerender(); });
    }
    const ctl = openModal('wl sh', {
      dismiss: () => true, render,
      click(e) {
        const el = e.target.closest('[data-act]'); if (!el) return;
        const act = el.dataset.act, s = state.shop.find((x) => x.id === id);
        if (act === 'back') { ctl.close(); openWallet('shop'); }
        else if (act === 'n-') { n--; render(); }
        else if (act === 'n+') { n++; render(); }
        else if (act === 'buy') buy();
        else if (act === 'goal') { state.goal = state.goal === id ? '' : id; state.goal ? sfx.check() : sfx.uncheck(); save(); updateGoal(); render(); }
        else if (act === 'edit') { ctl.close(); openShopEdit(id); }
        else if (act === 'del' && s) {
          const had = state.buys.some((b) => b.sid === s.id), i = state.shop.indexOf(s);
          if (had) s.del = Date.now(); else state.shop.splice(i, 1);
          sfx.uncheck(); save(); updateGoal(); ctl.close(); openWallet('shop');
          toast(`已下架「${s.name}」`, () => {
            if (had) delete s.del; else if (!state.shop.includes(s)) state.shop.splice(Math.min(i, state.shop.length), 0, s);
            save(); updateGoal(); if (modalCtl) modalCtl.rerender();
          });
        }
      }
    });
  }

  /* 上架／編輯：選照片（手機可拍照或選相簿；電腦也能拖進來或 ⌘V 貼上）→ 自動轉像素圖，可調粗細和去背 */
  function openShopEdit(id) {
    const s0 = id ? state.shop.find((x) => x.id === id) : null;
    const left0 = s0 ? shopLeft(s0) : 1;
    const d = { name: s0?.name || '', price: s0 ? String(s0.price) : '', qty: String(left0 === Infinity ? 1 : Math.max(0, left0)), inf: left0 === Infinity,
      link: s0?.link || '', note: s0?.note || '', img: s0?.img || '', px: s0?.px || 32, cut: true };
    let photo = null, working = false, err = '';
    const prevHtml = () => (working ? '<span class="sh-busy">PIXELIZING…</span>' : d.img ? `<img src="${esc(d.img)}" alt="像素圖預覽">` : `<span class="sh-ph">${CAM}<em>選照片</em></span>`);
    const optsHtml = () => `<div class="sh-opts" ${photo ? '' : 'hidden'}>
        <div class="seg" role="group" aria-label="像素粗細">${[[24, '粗'], [32, '中'], [48, '細']].map(([v, l]) => `<button type="button" data-act="px" data-v="${v}" class="${d.px === v ? 'on' : ''}" aria-pressed="${d.px === v}">${l}</button>`).join('')}</div>
        <button type="button" class="ckline" data-act="cut" aria-pressed="${d.cut}"><span class="chk ${d.cut ? 'on' : ''}"></span>去背</button>
      </div>`;
    const render = () => {
      box.innerHTML = `
        <div class="rt-head">SHOP</div>
        <h3 class="rt-title">${s0 ? '編輯商品' : '上架商品'}</h3>
        <form class="sh-form" data-form="shop" novalidate>
          <div class="sh-up">
            <label class="sh-drop sh-pic"><input type="file" accept="image/*" name="photo" class="sh-file" aria-label="選照片"><span class="sh-prev">${prevHtml()}</span></label>
            ${optsHtml()}
          </div>
          <div class="sh-fields">
            <input class="in" name="name" placeholder="品名" aria-label="品名" maxlength="40" autocomplete="off" value="${esc(d.name)}">
            <div class="sh-row">
              <label class="sh-money"><input class="in" name="price" type="number" inputmode="numeric" min="1" step="1" placeholder="價格" aria-label="價格" value="${esc(d.price)}"></label>
              <div class="sh-qtyin" role="group" aria-label="數量">
                <button type="button" data-act="q-" aria-label="少一個" ${d.inf ? 'disabled' : ''}>−</button>
                <input class="in" name="qty" type="number" inputmode="numeric" min="0" step="1" aria-label="數量" value="${d.inf ? '' : esc(d.qty)}" placeholder="${d.inf ? '∞' : ''}" ${d.inf ? 'disabled' : ''}>
                <button type="button" data-act="q+" aria-label="多一個" ${d.inf ? 'disabled' : ''}>＋</button>
                <button type="button" class="sh-inf ${d.inf ? 'on' : ''}" data-act="inf" aria-pressed="${d.inf}" aria-label="數量不限">∞</button>
              </div>
            </div>
            <input class="in" name="link" type="url" inputmode="url" placeholder="商品連結（選填）" aria-label="商品連結" autocomplete="off" value="${esc(d.link)}">
            <input class="in" name="note" placeholder="備註：尺寸、顏色…（選填）" aria-label="備註" maxlength="80" autocomplete="off" value="${esc(d.note)}">
          </div>
          ${err ? `<p class="wl-err" role="alert">${esc(err)}</p>` : ''}
          <div class="rt-foot"><button type="button" class="btn btn-ghost" data-act="cancel">取消</button><span class="sp"></span><button class="btn btn-mag">${s0 ? '儲存' : '上架'}</button></div>
        </form>`;
    };
    const paintPrev = () => {                      // 只換預覽和選項，不重畫表單（打到一半的字、鍵盤都不動）
      const pv = box.querySelector('.sh-prev'), op = box.querySelector('.sh-opts');
      if (pv) pv.innerHTML = prevHtml();
      if (op) op.outerHTML = optsHtml();
    };
    const redo = () => { if (photo) { d.img = pixelize(photo, d.px, d.cut); paintPrev(); } };
    async function take(file) {
      if (!file || working) return;
      working = true; err = ''; box.querySelector('.wl-err')?.remove(); paintPrev();
      try { photo = await readPhoto(file); d.cut = photo.bg.auto; d.img = pixelize(photo, d.px, d.cut); sfx.check(); }
      catch (e) { photo = null; err = '這張照片讀不出來，換一張試試。'; sfx.deny(); }
      working = false;
      if (modalCtl !== ctl) return;
      if (err) render(); else paintPrev();
    }
    const back = () => { ctl.close(); s0 && state.shop.includes(s0) ? openShopItem(s0.id) : openWallet('shop'); };
    const onPaste = (e) => {
      if (modalCtl !== ctl) return document.removeEventListener('paste', onPaste);
      const f = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
      if (f) { e.preventDefault(); take(f); }
    };
    const ctl = openModal('wl sh', {
      dismiss: () => true, render,
      onClose: () => document.removeEventListener('paste', onPaste),
      input(e) {
        const el = e.target;
        if (el.name in d && el.name !== 'img' && el.type !== 'file') d[el.name] = el.value;
      },
      change(e) {
        const el = e.target;
        if (el.name === 'photo') { take(el.files?.[0]); el.value = ''; }
      },
      click(e) {
        const el = e.target.closest('[data-act]'); if (!el) return;
        const act = el.dataset.act, q = box.querySelector('[name="qty"]');
        if (act === 'cancel') back();
        else if (act === 'px') { d.px = +el.dataset.v; redo(); }
        else if (act === 'cut') { d.cut = !d.cut; redo(); }
        else if (act === 'q-' || act === 'q+') { d.qty = String(Math.max(s0 ? 0 : 1, Math.min(999, (Math.round(+d.qty) || 0) + (act === 'q+' ? 1 : -1)))); if (q) q.value = d.qty; }
        else if (act === 'inf') { d.inf = !d.inf; render(); }
      },
      submit(e) {
        e.preventDefault();
        const name = d.name.trim(), price = Math.round(+d.price), q = Math.round(+d.qty);
        let link = d.link.trim();
        if (link && !/^https?:\/\//i.test(link)) link = /^[\w-]+(\.[\w-]+)+/.test(link) ? 'https://' + link : '';
        if (working) err = '照片還在轉，等一下再按。';
        else if (!name) err = '請填品名。';
        else if (shopLive().some((x) => x !== s0 && x.name.trim().toLowerCase() === name.toLowerCase())) err = `已經有「${name}」了，改它的數量就好。`;
        else if (!(price >= 1)) err = '價格要是大於 0 的整數。';
        else if (!d.inf && !(q >= (s0 ? 0 : 1))) err = s0 ? '數量不能是負的。' : '數量至少 1 個。';
        else if (d.link.trim() && !link) err = '商品連結看不懂，貼完整的網址（https://…）。';
        else err = '';
        if (err) {
          sfx.deny(); render();
          return box.querySelector(!name || err.startsWith('已經') ? '[name="name"]' : err.startsWith('價格') ? '[name="price"]' : err.startsWith('數量') ? '[name="qty"]' : err.startsWith('商品') ? '[name="link"]' : '.sh-file')?.focus();
        }
        const bought = s0 ? state.buys.reduce((n, b) => n + (b.sid === s0.id ? b.n : 0), 0) : 0;
        const rec = { name, price, qty: d.inf ? null : q + bought, img: d.img, px: d.px, link, note: d.note.trim() };
        let sid = s0?.id;
        if (s0) Object.assign(s0, rec); else { sid = uid('sh'); state.shop.push({ id: sid, at: Date.now(), ...rec }); }
        sfx.check(); save(); updateGoal(); ctl.close();
        s0 ? openShopItem(sid) : openWallet('shop');
      }
    });
    box.ondragover = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); };
    box.ondrop = (e) => { const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type)); if (f) { e.preventDefault(); take(f); } };
    document.addEventListener('paste', onPaste);
  }
  views.dash.addEventListener('scroll', () => closePop(), { passive: true });
  modal.addEventListener('scroll', () => closePop(), { passive: true });

  /* ══════════ routine 視窗 ══════════ */
  const RT = {
    am: { head: 'MORNING ROUTINE', title: '晨間啟動程序', sub: '起床後的固定流程，全部打勾後進入看板。', go: '進入看板', ico: '▶' },
    pm: { head: 'SHUTDOWN ROUTINE', title: '晚間關機程序', sub: '收尾今天的事，全部打勾後關機。', go: '關機', ico: '■' }
  };
  function openRoutine(kind, review = false) {
    return new Promise((resolve) => {
      const cfg = RT[kind];
      let editing = false;
      function render() {
        const items = routine(kind);
        const n = items.filter((t) => day[kind][t]).length;
        const all = n === items.length, dead = rtLocked(kind) && !rtOnTime(kind);
        if (editing) {
          box.innerHTML = `
            <div class="rt-head">${cfg.head} · EDIT</div>
            <h3 class="rt-title">編輯${esc(cfg.title)}</h3>
            <p class="rt-sub">一行一個項目。</p>
            <div class="rt-edit"><textarea id="rt-ta" spellcheck="false">${esc(items.join('\n'))}</textarea></div>
            <div class="rt-foot">
              <button class="btn btn-ghost" data-act="reset">恢復預設</button><span class="sp"></span>
              <button class="btn btn-ghost" data-act="back">取消</button>
              <button class="btn" data-act="save">存檔</button>
            </div>`;
          return;
        }
        box.innerHTML = `
          <div class="rt-head">${cfg.head}</div>
          <h3 class="rt-title">${esc(cfg.title)}</h3>
          <p class="rt-sub ${dead ? 'rt-dead' : ''}">${dead ? `${pad(kind === 'am' ? AM_END : PM_END)}:00 已過，不給獎勵。` : esc(cfg.sub)}</p>
          <div class="rt-bar"><div class="segs">${items.map((t) => `<i class="${day[kind][t] ? 'on' : ''}"></i>`).join('')}</div><span>${n}/${items.length}</span></div>
          <ul class="rt-list">${items.map((t, i) => `
            <li><button class="rt-item ${day[kind][t] ? 'on' : ''}" data-i="${i}" aria-pressed="${!!day[kind][t]}">
              <span class="box"></span><span class="txt">${esc(t)}</span><span class="sp" style="flex:1"></span><span class="no">${pad(i + 1)}</span>
            </button></li>`).join('')}</ul>
          <div class="rt-foot">
            <button class="btn btn-ghost" data-act="edit">編輯清單</button><span class="sp"></span>
            ${review
              ? '<button class="btn" data-act="cancel">關閉</button>'
              : `<button class="btn btn-ghost" data-act="${kind === 'pm' ? 'cancel' : 'skip'}">${kind === 'pm' ? '取消' : '略過'}</button>
                 ${kind === 'pm' && !all ? '<button class="btn btn-ghost" data-act="skip">直接關機</button>' : ''}
                 <button class="btn ${kind === 'pm' ? 'btn-mag' : ''} ${all ? 'ready' : ''}" data-act="done" ${all ? '' : 'disabled'}><span class="ico">${cfg.ico}</span> ${cfg.go}</button>`}
          </div>`;
      }
      const ctl = openModal(kind, {
        render, onClose: resolve, sticky: true,
        dismiss: () => !editing && (review || kind === 'pm' || (kind === 'am' && amLocked())),
        click(e) {
          const it = e.target.closest('.rt-item');
          if (it) {
            const items = routine(kind), t = items[+it.dataset.i];
            day[kind][t] = !day[kind][t]; save();
            day[kind][t] ? (items.every((x) => day[kind][x]) ? sfx.ready() : sfx.check()) : sfx.uncheck();
            render(); updateHud();
            box.querySelector(`.rt-item[data-i="${it.dataset.i}"]`)?.focus();
            return;
          }
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (!act) return;
          if (act === 'edit') { editing = true; render(); $('#rt-ta').focus(); }
          else if (act === 'back') { editing = false; render(); }
          else if (act === 'reset') { state.routines[kind] = [...SEED_R[kind]]; save(); editing = false; render(); updateHud(); }
          else if (act === 'save') {
            const list = $('#rt-ta').value.split('\n').map((s) => s.trim()).filter(Boolean);
            if (list.length) { state.routines[kind] = list; save(); }
            editing = false; render(); updateHud();
          }
          else ctl.close(act);
        }
      });
      (box.querySelector('.rt-item:not(.on):not(:disabled)') || box.querySelector('[data-act="done"], .rt-foot .ready'))?.focus();
    });
  }

  /* ══════════ 資料操作 ══════════ */
  function toggleTask(id) {
    const t = task(id); if (!t) return;
    t.status = t.status === '完成' ? '未開始' : '完成';
    t.status === '完成' ? sfx.check() : sfx.uncheck();
    commit();
  }
  function deleteTask(id) {
    const i = state.tasks.findIndex((t) => t.id === id); if (i < 0) return;
    const [t] = state.tasks.splice(i, 1);
    sfx.uncheck(); commit();
    toast(`已刪除「${t.name}」`, () => { state.tasks.splice(Math.min(i, state.tasks.length), 0, t); commit(); modalCtl?.rerender(); });
  }
  function toggleFocus(id) {
    const p = proj(id); if (!p) return false;
    if (!p.focus && state.projects.filter((x) => x.focus).length >= 3) { sfx.deny(); toast('本週重點最多 3 個，先取消一個再加'); return false; }
    p.focus = !p.focus; p.focus ? sfx.check() : sfx.uncheck();
    commit(); return true;
  }
  function setStatus(p, s) {
    if (p.status === s) return;
    p.status = s;
    if (s === '已結案') { p.closedAt = TODAY; p.focus = false; } else p.closedAt = '';
  }
  function nextCode(d) {
    const ns = state.projects.filter((p) => p.code && p.code.startsWith(d)).map((p) => parseInt(p.code.slice(d.length), 10)).filter((n) => !isNaN(n));
    return d + pad((ns.length ? Math.max(...ns) : 0) + 1);
  }

  /* ══════════ 專案視窗 ══════════ */
  function refocus(el, render) {
    const row = el.closest('.trow');
    const q = el.dataset.f ? `[data-f="${el.dataset.f}"]` : (el.dataset.tf && row) ? `.trow[data-tid="${row.dataset.tid}"] [data-tf="${el.dataset.tf}"]` : null;
    render();
    if (q) box.querySelector(q)?.focus();
  }
  /* 單行欄位字多就自己長高，不要把字截掉 */
  const autoGrow = (el) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 4 + 'px'; };
  document.addEventListener('keydown', (e) => {   // 這些欄位是單行的（字多會換行顯示）：Enter 收鍵盤，新增欄是送出，不換行
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.shiftKey || !e.target.matches?.('textarea.auto')) return;
    e.preventDefault();
    if (e.target.dataset.enter === 'submit') e.target.form?.requestSubmit(); else e.target.blur();
  });
  new MutationObserver(() => box.querySelectorAll('textarea.auto').forEach(autoGrow)).observe(box, { childList: true, subtree: true });
  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('textarea.auto')) autoGrow(e.target); });
  function openProject(id) {
    const p = proj(id); if (!p) return;
    let armed = false, addType = '行動';
    function render() {
      const ts = state.tasks.filter((t) => t.p === p.id);
      if (!names('tType').includes(addType)) addType = names('tType')[0];
      box.innerHTML = `
        <div class="m-head"><span class="rt-head">PROJECT${p.code ? ' // ' + esc(p.code) : ''}</span><button class="x" data-act="close" aria-label="關閉">X</button></div>
        <input class="in in-title" data-f="name" value="${esc(p.name)}" placeholder="專案名稱" aria-label="專案名稱">
        <div class="fgrid">
          <div class="fld">狀態${selBtn('pStatus', p.status, 'data-f="status" aria-label="狀態"')}</div>
          <div class="fld">領域${selBtn('domain', p.domain, 'data-f="domain" aria-label="領域"')}</div>
          <label class="fld">編號<input class="in" data-f="code" value="${esc(p.code)}" maxlength="8" placeholder="例 W05"></label>
          <div class="fld">確認狀態${selBtn('confirm', p.confirm, 'data-f="confirm" aria-label="確認狀態"')}</div>
          <div class="fld">期限${dateBtn(p.due, 'data-f="due" aria-label="期限"')}</div>
          <div class="fld">本週重點<button class="ckline" data-act="tog-focus" data-id="${p.id}" aria-pressed="${p.focus}"><span class="chk ${p.focus ? 'on' : ''}"></span>${p.focus ? '是' : '否'}</button></div>
        </div>
        <label class="fld">下一步<textarea class="in auto" data-f="next" rows="1" placeholder="下一個具體動作">${esc(p.next)}</textarea></label>
        <label class="fld">卡點／等待<textarea class="in auto" data-f="block" rows="1">${esc(p.block)}</textarea></label>
        <label class="fld">本週成果<textarea class="in auto" data-f="result" rows="1">${esc(p.result)}</textarea></label>
        <label class="fld">完成標準<textarea class="in" data-f="done" rows="2">${esc(p.done)}</textarea></label>
        <label class="fld">完成如何確認<textarea class="in auto" data-f="verify" rows="1">${esc(p.verify)}</textarea></label>
        <div class="tsec">${names('tType').map((ty) => {
          const l = ts.filter((t) => t.type === ty);
          return `<div class="tgrp" data-type="${esc(ty)}"><h4>${esc(ty)}<span>${l.filter((t) => t.status === '完成').length}/${l.length}</span></h4>${l.map((t) => `
            <div class="trow ${t.status === '完成' ? 'done' : ''}" data-tid="${t.id}">
              <span class="grip" draggable="true" title="拖到其他類型（里程碑／行動／待確認）" aria-hidden="true"></span>
              ${chk(t)}
              <textarea class="in bare grow auto" data-tf="name" rows="1" aria-label="任務名稱">${esc(t.name)}</textarea>
 ${selBtn('tType', t.type, 'data-tf="type" aria-label="類型"', { sm: true }).replace('class="in sel sm', 'class="in sel sm t-type')}
              ${selBtn('tStatus', t.status, 'data-tf="status" aria-label="狀態"', { sm: true })}
              ${ty === '待確認' ? '' : dateBtn(t.sched, 'data-tf="sched" aria-label="排定日期"', { sm: true })}
              ${ty !== '里程碑' && t.status !== '完成' && t.status !== '已放棄' && t.sched !== ymd(new Date()) ? `<button class="h-act lf-to" data-act="t-today" data-id="${t.id}" aria-label="排到今天的每日任務：${esc(t.name)}">→今天</button>` : ''}
              <button class="x" data-act="del-task" data-id="${t.id}" aria-label="刪除任務">X</button>
              ${t.status === '等待中' ? `<input class="in sm wait" data-tf="wait" value="${esc(t.wait)}" placeholder="等待對象（誰／什麼資料）">` : ''}
            </div>`).join('') || '<p class="none">拖任務到這裡</p>'}</div>`;
        }).join('')}</div>
        <form class="qadd" data-form="add-task">
          ${selBtn('tType', addType, 'aria-label="類型"', { sm: true, name: 'type' })}
          <input class="in grow" name="name" placeholder="＋ 新增任務，按 Enter" autocomplete="off">
          <button class="btn btn-sm">新增</button>
        </form>
        <div class="rt-foot">
          ${armed
            ? `<p class="del-ask">確定要刪除這個專案嗎？${ts.length ? `會連同 ${ts.length} 個任務一起刪除，` : ''}刪了無法復原。</p>
               <button class="btn btn-ghost" data-act="del-cancel">取消</button>
               <button class="btn btn-mag" data-act="del-p">確定刪除</button>`
            : `<button class="btn btn-ghost" data-act="del-p">刪除專案</button><span class="sp"></span>
               <button class="btn" data-act="close">完成</button>`}
        </div>`;
      box.querySelectorAll('textarea.auto').forEach(autoGrow);
    }
    const isText = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'date' && el.type !== 'checkbox');
    const ctl = openModal('wide', {
      top: true, render, dismiss: () => true,
      input(e) {
        const el = e.target; if (!isText(el)) return;
        if (el.classList.contains('auto')) autoGrow(el);
        if (el.dataset.f) { p[el.dataset.f] = el.value; commit(); }
        else if (el.dataset.tf) { const t = task(el.closest('.trow').dataset.tid); if (t) { t[el.dataset.tf] = el.value; commit(); } }
      },
      change(e) {
        const el = e.target; if (isText(el)) return;
        if (el.dataset.name === 'type') { addType = el.value; return; }
        if (el.dataset.f) {
          const f = el.dataset.f, v = el.value;
          if (f === 'status') setStatus(p, v);
          else if (f === 'domain') { p.domain = v; if (!p.code && v) p.code = nextCode(v); }
          else p[f] = v;
        } else if (el.dataset.tf) {
          const t = task(el.closest('.trow').dataset.tid); if (!t) return;
          t[el.dataset.tf] = el.value;
        } else return;
        commit(); refocus(el, render);
      },
      click(e) {
        const el = e.target.closest('[data-act]'); if (!el) return;
        const act = el.dataset.act;
        if (act === 'close') return ctl.close();
        if (act === 'tog-task') { toggleTask(el.dataset.id); render(); }
        else if (act === 'del-task') { deleteTask(el.dataset.id); render(); }
        else if (act === 't-today') {              // 里程碑以外的任務 → 今天的每日任務（有復原）
          const t = task(el.dataset.id); if (!t) return;
          const was = t.sched; t.sched = ymd(new Date()); sfx.check(); commit(); render();
          toast('已排到今天的每日任務', () => { t.sched = was; commit(); if (modalCtl === ctl) render(); });
        }
        else if (act === 'tog-focus') { toggleFocus(p.id); render(); box.querySelector('.ckline')?.focus(); }
        else if (act === 'del-cancel') { armed = false; render(); box.querySelector('[data-act="del-p"]').focus(); }
        else if (act === 'del-p') {
          if (!armed) { armed = true; render(); const b = box.querySelector('[data-act="del-p"]'); b.scrollIntoView({ block: 'nearest' }); b.focus(); return; }
          state.tasks = state.tasks.filter((t) => t.p !== p.id);
          state.projects = state.projects.filter((x) => x.id !== p.id);
          sfx.uncheck(); commit(); ctl.close();
        }
      },
      submit(e) {
        e.preventDefault();
        const fd = new FormData(e.target), name = String(fd.get('name') || '').trim();
        if (!name) return;
        addType = fd.get('type');
        state.tasks.push(newTask({ p: p.id, type: addType, name }));
        sfx.check(); commit(); render();
        box.querySelector('.qadd input[name="name"]').focus();
      }
    });
    if (!p.name) box.querySelector('[data-f="name"]').focus();
  }

  /* ══════════ 復盤視窗 ══════════ */
  /* 復盤的自動分析：開始～結束這段時間的專注（次數、時長、每天、花在什麼上、什麼時段）、習慣、完成的任務 */
  function reviewStats(from, to) {
    if (!from || !to || to < from) return '';
    const day0 = (ms) => ymd(new Date(ms)), inR = (k) => k >= from && k <= to, n = Math.min(31, dayDiff(from, to) + 1);
    const days = Array.from({ length: n }, (_, i) => { const x = new Date(from + 'T00:00:00'); x.setDate(x.getDate() + i); return ymd(x); });
    const fs = (state.focus || []).filter((f) => inR(day0(f.at))), total = fs.reduce((a, f) => a + f.min, 0);
    const perDay = Object.fromEntries(days.map((d) => [d, 0])), by = {}, slot = [0, 0, 0];
    for (const f of fs) {
      const d = day0(f.at); if (d in perDay) perDay[d] += f.min;
      by[f.note || '沒指定'] = (by[f.note || '沒指定'] || 0) + f.min;
      const h = new Date(f.at).getHours(); slot[h >= 5 && h < 12 ? 0 : h >= 12 && h < 18 ? 1 : 2] += f.min;
    }
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5), max = Math.max(1, ...Object.values(perDay)), long = fs.reduce((a, f) => Math.max(a, f.min), 0);
    const done = state.tasks.filter((t) => t.status === '完成' && t.doneAt && inR(day0(t.doneAt))).length;
    const hm = (m) => m >= 60 ? `${Math.floor(m / 60)} 時 ${m % 60} 分` : `${m} 分`;
    return `<div class="rv-an">
      <div class="lf-mk-sum">${chip(`專注 ${fs.length} 次 · ${hm(total)}`, 'c-cyan')}${chip(`完成任務 ${done}`, 'c-grn')}${long ? chip(`最長 ${long} 分`, 'c-pur') : ''}</div>
      ${fs.length ? `${n <= 14 ? `<div class="rv-days" style="grid-template-columns:repeat(${n}, 1fr)">${days.map((d) => `<div title="${mmdd(d)} ${perDay[d]} 分"><i><u style="height:${Math.round(perDay[d] / max * 100)}%"></u></i><b>${perDay[d] || ''}</b><span>${WEEK[new Date(d + 'T00:00:00').getDay()]}</span></div>`).join('')}</div>` : ''}
      ${top.map(([name, m]) => `<div class="rv-top"><span>${esc(name)}</span><i><u style="width:${Math.round(m / top[0][1] * 100)}%"></u></i><b>${hm(m)}</b></div>`).join('')}
      <div class="lf-mk-chips">${[['早上', slot[0]], ['下午', slot[1]], ['晚上', slot[2]]].filter((q) => q[1]).map((q) => chip(`${q[0]} ${hm(q[1])}`, 'c-dim')).join('')}</div>` : ''}
      ${state.habits.length ? `<div class="lf-mk-chips">${state.habits.map((x) => { const c = days.filter((d) => x.log[d]).length; return chip(`${x.name} ${c}/${n}`, c ? 'c-yel' : 'c-dim'); }).join('')}</div>` : ''}
    </div>`;
  }
  function openReview(id) {
    const r = state.reviews.find((x) => x.id === id); if (!r) return;
    let armed = false;
    function render() {
      box.innerHTML = `
        <div class="m-head"><span class="rt-head">WEEKLY REVIEW</span><button class="x" data-act="close" aria-label="關閉">X</button></div>
        <input class="in in-title" data-f="name" value="${esc(r.name)}" placeholder="每週復盤｜日期範圍" aria-label="標題">
        <div class="fgrid">
          <div class="fld">開始${dateBtn(r.start, 'data-f="start" aria-label="開始"')}</div>
          <div class="fld">結束${dateBtn(r.end, 'data-f="end" aria-label="結束"')}</div>
          <div class="fld">收件匣已分類<button class="ckline" data-act="tog-inbox" aria-pressed="${r.inboxSorted}"><span class="chk ${r.inboxSorted ? 'on' : ''}"></span>${r.inboxSorted ? '是' : '否'}</button></div>
        </div>
        ${reviewStats(r.start, r.end)}
        <label class="fld">本週成果（具體完成的成果與證據）<textarea class="in" data-f="result" rows="2">${esc(r.result)}</textarea></label>
        <label class="fld">執行情況（習慣、專注時間）<textarea class="in" data-f="exec" rows="2">${esc(r.exec)}</textarea></label>
        <label class="fld">卡在哪一步<textarea class="in" data-f="stuck" rows="2">${esc(r.stuck)}</textarea></label>
        <div class="fld">阻礙原因<div class="chips">${names('why').map((b) => `<button class="chip pick ${r.why.includes(b) ? 'on' : ''}" data-act="tog-why" data-v="${esc(b)}" aria-pressed="${r.why.includes(b)}">${esc(b)}</button>`).join('')}<button type="button" class="chip pick sel" data-opt="why" data-multi data-vals="${esc(JSON.stringify(r.why))}" value="" aria-haspopup="listbox"><span class="sel-l">＋／－ 選項</span></button></div></div>
        <label class="fld">下週如何調整<textarea class="in" data-f="adjust" rows="2">${esc(r.adjust)}</textarea></label>
        <div class="rt-foot">
          ${armed
            ? `<p class="del-ask">確定要刪除這筆復盤嗎？刪了無法復原。</p>
               <button class="btn btn-ghost" data-act="del-cancel">取消</button>
               <button class="btn btn-mag" data-act="del-r">確定刪除</button>`
            : `<button class="btn btn-ghost" data-act="del-r">刪除</button>${r.done ? '<button class="btn btn-ghost" data-act="undo-fin">取消完成</button>' : ''}<span class="sp"></span>
               ${r.done ? '<button class="btn" data-act="close">關閉</button>' : `<button class="btn" data-act="fin">完成復盤 +${money(state.wallet.rates.review)}</button>`}`}
        </div>`;
    }
    const ctl = openModal('wide', {
      top: true, render, dismiss: () => true,
      input(e) { const el = e.target; if (el.dataset.f && el.tagName !== 'BUTTON') { r[el.dataset.f] = el.value; commit(); } },
      change(e) {
        const el = e.target;
        if (el.dataset.date !== undefined && el.dataset.f) { r[el.dataset.f] = el.value; commit(); refocus(el, render); }
        else if (el.dataset.opt === 'why') {
          const v = el.value; r.why = r.why.includes(v) ? r.why.filter((x) => x !== v) : [...r.why, v];
          commit(); render(); box.querySelector('.chips .sel')?.focus();
        }
      },
      click(e) {
        const el = e.target.closest('[data-act]'); if (!el) return;
        const act = el.dataset.act;
        if (act === 'close') return ctl.close();
        if (act === 'fin') { r.done = true; r.doneAt = Date.now(); sfx.check(); commit(); return ctl.close(); }
        if (act === 'undo-fin') { r.done = false; delete r.doneAt; sfx.uncheck(); commit(); render(); return; }
        if (act === 'tog-inbox') { r.inboxSorted = !r.inboxSorted; sfx.check(); commit(); render(); box.querySelector('.ckline').focus(); }
        else if (act === 'tog-why') {
          const v = el.dataset.v; r.why = r.why.includes(v) ? r.why.filter((x) => x !== v) : [...r.why, v];
          commit(); render(); box.querySelector(`[data-v="${v}"]`).focus();
        }
        else if (act === 'del-cancel') { armed = false; render(); box.querySelector('[data-act="del-r"]').focus(); }
        else if (act === 'del-r') {
          if (!armed) { armed = true; render(); const b = box.querySelector('[data-act="del-r"]'); b.scrollIntoView({ block: 'nearest' }); b.focus(); return; }
          state.reviews = state.reviews.filter((x) => x.id !== r.id); sfx.uncheck(); commit(); ctl.close();
        }
      }
    });
  }
  function addReview() {
    const now = new Date(), mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const r = newReview({ name: `每週復盤｜${mon.getFullYear()}/${mon.getMonth() + 1}/${mon.getDate()}–${sun.getMonth() + 1}/${sun.getDate()}`, start: ymd(mon), end: ymd(sun) });
    state.reviews.unshift(r); commit(); openReview(r.id);
  }

  /* ══════════ 看板渲染 ══════════ */
  const ui = { openGrp: null, addCat: null, addPri: 0 };
  const tag = (p) => (p ? `<span class="tag ${p.code ? domC(p.domain) : 'c-dim'}">${esc(p.code || 'NEW')}</span>` : '');
  const chip = (text, cls) => `<span class="chip ${cls || ''}">${esc(text)}</span>`;
  const empty = (en, zh) => `<div class="empty">${en}<span>${zh}</span></div>`;
  function chk(t) {
    const on = t.status === '完成';
    return `<button class="chk ${on ? 'on' : ''}" data-act="tog-task" data-id="${t.id}" aria-pressed="${on}" aria-label="${on ? '標為未完成' : '標為完成'}：${esc(t.name)}"></button>`;
  }
  function dueInfo(due) {
    const d = dayDiff(TODAY, due);
    if (d < 0) return { text: `逾期 ${-d} 天`, cls: 'c-mag' };
    if (d === 0) return { text: '今天', cls: 'c-yel' };
    return { text: `剩 ${d} 天`, cls: d <= 7 ? 'c-yel' : 'c-cyan' };
  }

  function renderDash() {
    const projects = state.projects, tasks = state.tasks;
    const open = (t) => t.status !== '完成' && t.status !== '已放棄';
    const focus = projects.filter((p) => p.focus);
    const running = projects.filter((p) => p.status === '執行中');
    const waiting = tasks.filter((t) => t.status === '等待中');
    const confirms = tasks.filter((t) => t.type === '待確認' && open(t));
    const dued = projects.filter((p) => p.due && p.status !== '已結案').sort((a, b) => a.due.localeCompare(b.due));
    const overdue = dued.filter((p) => dayDiff(TODAY, p.due) < 0);
    const inbox = projects.filter((p) => p.status === '收件匣');

    P('#stats').html = [
      [running.length, '執行中專案', 'c-cyan'],
      [`${focus.length}/3`, '本週重點', 'c-yel'],
      [overdue.length, '逾期期限', overdue.length ? 'c-mag' : 'c-grn'],
      [confirms.length, '待確認', 'c-org'],
      [inbox.length, '收件匣', 'c-pur']
    ].map(([n, l, c]) => `<div class="stat pxb ${c}"><b>${n}</b><span>${l}</span></div>`).join('');

    /* 01 本週執行看板 */
    P('#focus').html = focus.length ? focus.map((p) => {
      const mine = tasks.filter((t) => t.p === p.id);
      const ms = mine.filter((t) => t.type === '里程碑');
      const done = ms.filter((t) => t.status === '完成').length;
      const on = ms.length ? Math.round(done / ms.length * 10) : 0;
      const todoT = mine.filter((t) => t.type !== '待確認' && open(t));
      const warn = [];
      if (p.status !== '執行中') warn.push('不在執行中');
      if (p.confirm !== '已確認') warn.push('尚未確認');
      const due = p.due ? dueInfo(p.due) : null;
      return `<article class="fcard pxb" draggable="true" data-act="open-p" data-id="${p.id}" tabindex="0">
        <div class="fcard-top">${tag(p)}${chip(p.status, colorOf('pStatus', p.status))}${warn.length ? chip('! ' + warn.join('・'), 'c-org') : ''}${due ? chip(`${mmdd(p.due)} ${due.text}`, due.cls) : ''}</div>
        <h3>${esc(p.name || '（未命名）')}</h3>
        <dl class="kv">
          <dt>下一步</dt><dd class="${p.next ? '' : 'none'}">${esc(p.next || '—')}</dd>
          <dt>卡點</dt><dd class="${p.block ? '' : 'none'}">${esc(p.block || '—')}</dd>
        </dl>
        ${todoT.length ? `<ul class="ftasks">${todoT.slice(0, 4).map((t) => `<li>${chk(t)}<span>${esc(t.name)}</span></li>`).join('')}${todoT.length > 4 ? `<li class="more">還有 ${todoT.length - 4} 項…</li>` : ''}</ul>` : ''}
        <div class="bar"><div class="bar-segs">${Array.from({ length: 10 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div><span>里程碑 ${done}/${ms.length}</span></div>
      </article>`;
    }).join('') : empty('NO FOCUS SET', '在下面專案看板的卡片上按「重點」，選出本週最多 3 個重點');

    /* 02 等待中（11/23 拿掉了「本週要做」：跟每日任務重複） */
    P('#waiting').html = waiting.length ? waiting.map((t) => {
      const p = proj(t.p);
      return `<div class="row">${chk(t)}${tag(p)}<span class="grow ${p ? 'link' : ''}" ${p ? `data-act="open-p" data-id="${p.id}" tabindex="0"` : ''}>${esc(t.name)}<span class="sub">等待：${esc(t.wait || '未填')}</span></span></div>`;
    }).join('') : empty('NO BLOCKERS', '把任務狀態改成「等待中」就會出現在這裡');

    /* 04 專案看板 */
    $('#kanban').style.setProperty('--cols', O.pStatus.length);
    P('#kanban').html = names('pStatus').map((s) => {
      const list = projects.filter((p) => p.status === s);
      return `<div class="kcol ${colorOf('pStatus', s)}" data-s="${esc(s)}">
        <h4>${esc(s)}<span>${pad(list.length)}</span><button class="kadd" data-act="new-p" data-s="${esc(s)}" aria-label="在「${esc(s)}」新增專案">＋</button></h4>
        ${s === '收件匣' ? `<form class="kform" data-form="add-inbox"><input class="in" name="name" placeholder="＋ 新想法，按 Enter" autocomplete="off" aria-label="新想法"></form>` : ''}
        ${list.map((p) => `
        <div class="kcard" draggable="true" data-act="open-p" data-id="${p.id}" tabindex="0">
          <div class="kcard-top">${tag(p)}${p.confirm === '建議草案' ? chip('草案', 'c-dim') : ''}${p.due ? chip(mmdd(p.due), dueInfo(p.due).cls) : ''}
            ${s === '已結案' ? '' : `<button class="fbtn ${p.focus ? 'on' : ''}" data-act="tog-focus" data-id="${p.id}" aria-pressed="${p.focus}" title="${p.focus ? '取消本週重點' : '設為本週重點'}">重點</button>`}</div>
          <strong>${esc(p.name || '（未命名）')}</strong>
          ${p.next ? `<p>▸ ${esc(p.next)}</p>` : ''}
        </div>`).join('') || (s === '收件匣' ? '' : '<div class="kempty">拖到這裡</div>')}
      </div>`;
    }).join('');

    /* 05 待確認 */
    const groups = projects.map((p) => [p, confirms.filter((t) => t.p === p.id)]).filter(([, l]) => l.length)
      .sort((a, b) => (b[0].focus - a[0].focus) || String(a[0].code).localeCompare(String(b[0].code)));
    if (!ui.openGrp) ui.openGrp = new Set(groups.filter(([p]) => p.focus).map(([p]) => p.id));
    P('#confirm').html = groups.length ? groups.map(([p, l]) => `
      <details class="grp" data-id="${p.id}" ${ui.openGrp.has(p.id) ? 'open' : ''}>
        <summary>${tag(p)}<span class="grow">${esc(p.name)}</span>${chip(l.length + ' 項', 'c-org')}<button class="h-act" data-act="open-p" data-id="${p.id}">編輯</button></summary>
        <ul>${l.map((t) => `<li>${chk(t)}<span>${esc(t.name)}</span></li>`).join('')}</ul>
      </details>`).join('') : empty('ALL CONFIRMED', '沒有待確認的問題');

    /* 06 期限時間軸 */
    P('#timeline').html = dued.length ? `<div class="tl">${dued.map((p) => {
      const d = dueInfo(p.due);
      return `<div class="tl-item ${d.cls}" data-act="open-p" data-id="${p.id}" tabindex="0">
        <span class="tl-date">${p.due.replace(/-/g, '/')}</span>
        <span class="line">${tag(p)}<span>${esc(p.name)}</span>${chip(d.text, d.cls)}</span>
      </div>`;
    }).join('')}</div>` : empty('NO DEADLINES', '在專案裡填上期限就會出現在這裡');

    /* 07 各領域 */
    P('#domains').html = state.domains.map((d) => {
      const list = projects.filter((p) => p.domain === d.code);
      const run = list.filter((p) => p.status === '執行中').length;
      return `<div class="dom ${d.c || ''}"><div class="dom-h"><i>${esc(d.code)}</i><strong>${esc(d.name)}</strong></div><p>${esc(d.desc)}</p><div class="dom-n">專案 <b>${list.length}</b>　執行中 <b>${run}</b></div></div>`;
    }).join('');

    /* 08 每週復盤 */
    P('#reviews').html = state.reviews.length ? state.reviews.map((r) => `
      <div class="row link" draggable="true" data-act="open-r" data-id="${r.id}" tabindex="0">
        <span class="grow">${esc(r.name.replace('每週復盤｜', '') || '（未命名）')}<span class="sub">調整：${esc(r.adjust || '—')}</span></span>
        ${r.done ? chip('已完成', 'c-yel') : ''}${chip(r.inboxSorted ? '收件匣已分類' : '收件匣未分類', r.inboxSorted ? 'c-grn' : 'c-org')}
      </div>`).join('') : empty('NO REVIEWS', '按右上角「＋ 新增」開始本週復盤');

    renderLife();
    navN = { '02': waiting.length, '03': tasks.filter((t) => t.sched && t.sched <= ymd(new Date()) && open(t)).length, '04': state.habits.filter((x) => !x.log[dayKey]).length, '07': inbox.length, '08': confirms.length, '09': overdue.length };   // 鍵＝面板編號，改編號要一起改
    renderNav();
    renderMeta();
  }

  /* ══════════ 看板上的操作 ══════════ */
  const dash = views.dash;
  /* ══════════ 左側選單：點了跳到該區塊、捲動時亮起目前所在區塊；電腦版固定可收合，手機版 ≡ 拉出抽屜 ══════════
     區塊從畫面上的面板自動產生（編號＋標題），之後新增面板不用改這裡。右邊的小數字是「還有幾件要處理」。 */
  let navN = {};
  const snavList = $('#snav-list'), snavBack = $('#snav-back');
  const mqMobile = window.matchMedia('(max-width: 900px)');
  const lsNav = { get: () => { try { return localStorage.getItem('kos.nav'); } catch (e) { return null; } }, set: (v) => { try { localStorage.setItem('kos.nav', v); } catch (e) { /* 沒有也沒關係 */ } } };
  const NAV_SECS = [...dash.querySelectorAll('.wrap > .zone, .wrap .panel')].map((el) => {
    if (el.classList.contains('zone')) return { zone: el.querySelector('span').textContent };
    const h = el.querySelector('h2'), num = h.querySelector('b').textContent;
    el.id ||= 'p' + num;
    return { id: el.id, num, title: [...h.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(), el };
  });
  NAV_SECS.unshift({ id: 'top', num: '00', title: '總覽', el: $('#stats') });
  let navActive = 'top';
  function renderNav() {
    paint(snavList, NAV_SECS.map((x) => x.zone ? `<div class="snav-z">${esc(x.zone)}</div>`
      : `<a href="#${x.id}" class="snav-i ${x.id === navActive ? 'on' : ''}" data-nav="${x.id}" title="${esc(x.num + ' ' + x.title)}">
          <b>${x.num}</b><span>${esc(x.title)}</span>${navN[x.num] ? `<em>${esc(navN[x.num])}</em>` : ''}</a>`).join(''));
  }
  const hudH = () => dash.querySelector('.hud').offsetHeight;
  function goSec(id) {
    const x = NAV_SECS.find((y) => y.id === id); if (!x) return;
    const behavior = reduced ? 'auto' : 'smooth';
    if (id === 'top') dash.scrollTo({ top: 0, behavior }); else x.el.scrollIntoView({ behavior, block: 'start' });   // 面板有 scroll-margin-top＝HUD 高度，不會被蓋住
    setTimeout(() => {                                               // 平滑捲動被打斷或瀏覽器沒跑完：直接跳到位
      const off = id === 'top' ? dash.scrollTop : x.el.getBoundingClientRect().top - dash.getBoundingClientRect().top - hudH() - 16;
      if (Math.abs(off) > 8) { if (id === 'top') dash.scrollTop = 0; else x.el.scrollIntoView({ block: 'start' }); }
    }, 900);
    navActive = id; renderNav();
    if (mqMobile.matches) setDrawer(false);
  }
  snavList.addEventListener('click', (e) => { const a = e.target.closest('[data-nav]'); if (!a) return; e.preventDefault(); goSec(a.dataset.nav); });
  let spyRaf = 0;
  dash.addEventListener('scroll', () => {
    if (spyRaf) return;
    spyRaf = requestAnimationFrame(() => {
      spyRaf = 0;
      const line = dash.getBoundingClientRect().top + hudH() + 40;
      let cur = 'top';
      for (const x of NAV_SECS) if (x.el && x.el.getBoundingClientRect().top <= line) cur = x.id;
      if (dash.scrollTop + dash.clientHeight >= dash.scrollHeight - 4) cur = NAV_SECS[NAV_SECS.length - 1].id;   // 捲到底：最後一塊
      const topOf = (id) => NAV_SECS.find((x) => x.id === id)?.el?.getBoundingClientRect().top;
      if (cur !== navActive && Math.abs(topOf(cur) - topOf(navActive)) < 2) return;   // 並排的兩塊（同一列）：維持剛點的那一塊
      if (cur !== navActive) { navActive = cur; renderNav(); }
    });
  }, { passive: true });
  function setFold(f) { dash.classList.toggle('nav-fold', f); $('#snav-fold').textContent = f ? '>>' : '<<'; $('#snav-fold').setAttribute('aria-label', f ? '展開選單' : '收合選單'); lsNav.set(f ? 'fold' : 'open'); }
  function setDrawer(o) { dash.classList.toggle('nav-open', o); snavBack.hidden = !o; $('#nav-open').setAttribute('aria-expanded', String(o)); }
  $('#snav-fold').addEventListener('click', () => { if (mqMobile.matches) return setDrawer(false); setFold(!dash.classList.contains('nav-fold')); });
  $('#nav-open').addEventListener('click', () => setDrawer(!dash.classList.contains('nav-open')));
  snavBack.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dash.classList.contains('nav-open')) setDrawer(false); });
  mqMobile.addEventListener?.('change', () => setDrawer(false));
  setFold(lsNav.get() === 'fold');
  new ResizeObserver(() => dash.style.setProperty('--hudh', hudH() + 'px')).observe(dash.querySelector('.hud'));   // 選單貼在 HUD 下面：HUD 高度會隨寬度變
  dash.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el || !dash.contains(el)) return;
    const ctl = e.target.closest('input,select,textarea,button,summary');
    if (ctl && ctl !== el && el.contains(ctl)) return;        // 點到卡片裡的其他控制項，不要當成點卡片
    const { act, id } = el.dataset;
    if (act === 'open-p') { e.preventDefault(); openProject(id); }
    else if (act === 'open-r') openReview(id);
    else if (act === 'tog-task') toggleTask(id);
    else if (act === 'del-task') deleteTask(id);
    else if (act === 'tog-focus') toggleFocus(id);
    else if (act === 'new-r') addReview();
    else if (act === 'new-p') { const p = newProject({ status: el.dataset.s }); state.projects.push(p); commit(); openProject(p.id); }
  });
  dash.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-act][tabindex]')) { e.preventDefault(); e.target.click(); }
  });
  dash.addEventListener('change', (e) => {
    const el = e.target;
  });
  dash.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, fd = new FormData(f), name = String(fd.get('name') || '').trim();
    if (!name) return;
    if (f.dataset.form === 'add-inbox') state.projects.push(newProject({ name, status: '收件匣' }));
    else if (f.dataset.form === 'add-cal') { const nd = ui.addCat === ND; state.tasks.push(newTask({ name, sched: nd ? '' : ui.calDay, cat: nd ? '' : ui.addCat || '', ...(ui.addPri ? { pri: ui.addPri } : {}) })); }
    else if (f.dataset.form === 'add-cat') { if (state.cats.some((c) => c.name === name)) { sfx.deny(); return toast(`「${name}」已經有了`); } state.cats.push({ id: uid('c'), name }); }
    else if (f.dataset.form === 'add-habit') state.habits.push({ id: uid('h'), name, log: {} });
    else return;
    f.querySelector('[name="name"]').value = '';   // 先清空：重畫會把欄位裡的字帶回去
    sfx.check(); commit();
    $(`[data-form="${f.dataset.form}"] [name="name"]`, dash)?.focus();
  });
  dash.addEventListener('toggle', (e) => {
    const d = e.target; if (!d.matches?.('details.grp') || !ui.openGrp) return;
    d.open ? ui.openGrp.add(d.dataset.id) : ui.openGrp.delete(d.dataset.id);
  }, true);

  /* ══════════ 拖曳：改狀態／類型，並可手動排順序（滑鼠與觸控共用） ══════════
     順序就是資料陣列裡的順序：projects、tasks、reviews 排在前面的就顯示在前面。
     觸控：卡片要長按約 0.35 秒才開始拖（免得跟捲動打架）；任務列的握把一碰就能拖。 */
  let touching = false, suppressClick = 0;
  document.addEventListener('click', (e) => { if (performance.now() - suppressClick < 600) { e.stopPropagation(); e.preventDefault(); } }, true);

  /* 把 item 移到 before 前面；沒有 before 就排到同組（sameGroup）最後一個的後面。回傳順序有沒有變 */
  function reorder(arr, item, before, sameGroup) {
    const old = arr.map((x) => x.id).join();
    arr.splice(arr.indexOf(item), 1);
    let j = before && before !== item ? arr.indexOf(before) : -1;
    if (j < 0) { arr.forEach((x, k) => { if (sameGroup(x)) j = k; }); j = j < 0 ? arr.length : j + 1; }
    arr.splice(j, 0, item);
    return old !== arr.map((x) => x.id).join();
  }
  function moveProject(id, status, beforeId, byFocus) {
    const p = proj(id); if (!p) return;
    const was = p.status; if (status) setStatus(p, status);
    const moved = reorder(state.projects, p, beforeId ? proj(beforeId) : null, byFocus ? (x) => x.focus : (x) => x.status === p.status);
    if (moved || was !== p.status) commit(); else renderDash();
  }
  function moveTask(id, type, beforeId) {
    const t = task(id); if (!t) return;
    const was = t.type; if (type) t.type = type;
    const moved = reorder(state.tasks, t, beforeId ? task(beforeId) : null, (x) => x.p === t.p && x.type === t.type);
    if (moved || was !== t.type) commit();
    modalCtl?.rerender();
  }
  function moveReview(id, beforeId) {
    const r = state.reviews.find((x) => x.id === id); if (!r) return;
    if (reorder(state.reviews, r, beforeId ? state.reviews.find((x) => x.id === beforeId) : null, () => true)) commit(); else renderDash();
  }

  /* 指標落在 group 裡的哪個項目「之前」；同一列有並排的項目（格狀）就看左右，否則看上下 */
  function insertionPoint(group, itemSel, x, y, dragEl) {
    const items = [...group.querySelectorAll(itemSel)].filter((el) => el !== dragEl);
    const rects = items.map((el) => el.getBoundingClientRect());
    const grid = rects.some((r, i) => i > 0 && Math.abs(r.top - rects[i - 1].top) < 4);
    for (let i = 0; i < items.length; i++) {
      const r = rects[i];
      if (grid ? (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) : y < r.top + r.height / 2) return [items[i], grid];
    }
    return [null, grid];
  }
  /* o：itemSel 可拖的項目、groupSel 可放的區塊、handleSel 握把（沒有就整個項目）、longPress 觸控要不要長按、
        skip 觸控時碰到這些不算拖、scroller 邊緣自動捲動的容器、onDrop(item, group, before) */
  function bindSort(root, o) {
    const clear = () => {
      root.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
      root.querySelectorAll('.ins-before, .ins-before-x').forEach((x) => x.classList.remove('ins-before', 'ins-before-x'));
    };
    const aim = (x, y, item) => {
      const g = document.elementFromPoint(x, y)?.closest(o.groupSel);
      clear();
      if (!g || !root.contains(g)) return { g: null, b: null };
      g.classList.add('over');
      const [b, grid] = insertionPoint(g, o.itemSel, x, y, item);
      if (b) b.classList.add(grid ? 'ins-before-x' : 'ins-before');
      return { g, b };
    };

    /* 滑鼠（瀏覽器內建拖放） */
    let dragEl = null;
    root.addEventListener('dragstart', (e) => {
      const h = e.target.closest?.(o.handleSel || o.itemSel); if (!h || !root.contains(h)) return;
      if (touching) { e.preventDefault(); return; }
      dragEl = h.closest(o.itemSel); dragEl.classList.add('drag');
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'kos');
      if (o.handleSel) { try { e.dataTransfer.setDragImage(dragEl, 12, 14); } catch (err) { /* ignore */ } }
    });
    root.addEventListener('dragover', (e) => {
      if (!dragEl) return;
      if (aim(e.clientX, e.clientY, dragEl).g) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
    });
    root.addEventListener('drop', (e) => {
      if (!dragEl) return;
      e.preventDefault();
      const { g, b } = aim(e.clientX, e.clientY, dragEl), it = dragEl;
      dragEl = null; clear(); it.classList.remove('drag');
      if (g) o.onDrop(it, g, b);
    });
    root.addEventListener('dragend', () => { dragEl?.classList.remove('drag'); dragEl = null; clear(); });

    /* 觸控 */
    let st = null;
    const finish = (drop) => {
      if (!st) return;
      clearTimeout(st.timer); cancelAnimationFrame(st.raf);
      const cur = st; st = null; touching = false;
      if (!cur.active) return;
      cur.ghost.remove(); cur.item.classList.remove('drag'); clear();
      suppressClick = performance.now();                      // 放開後瀏覽器會補一個點擊，吃掉它免得打開視窗
      if (drop && cur.g) o.onDrop(cur.item, cur.g, cur.b);
    };
    const update = () => {
      st.ghost.style.left = (st.x - st.dx) + 'px'; st.ghost.style.top = (st.y - st.dy) + 'px';
      const a = aim(st.x, st.y, st.item); st.g = a.g; st.b = a.b;
    };
    const loop = () => {                                      // 拖到畫面上下邊緣時自動捲動
      if (!st || !st.active) return;
      const sc = o.scroller();
      if (st.y < 130) sc.scrollTop -= 14; else if (st.y > window.innerHeight - 90) sc.scrollTop += 14;
      update(); st.raf = requestAnimationFrame(loop);
    };
    const activate = () => {
      if (!st || !st.item.isConnected) { st = null; touching = false; return; }
      st.active = true;
      const r = st.item.getBoundingClientRect(), g = st.item.cloneNode(true);
      g.classList.add('drag-ghost'); g.removeAttribute('data-act');
      g.style.width = r.width + 'px'; st.dx = st.x - r.left; st.dy = st.y - r.top;
      screen.appendChild(g); st.ghost = g; st.item.classList.add('drag');
      lastKey = 0; keySound();
      loop();
    };
    root.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || st) return;
      const h = e.target.closest(o.handleSel || o.itemSel); if (!h || !root.contains(h) || (o.skip && e.target.closest(o.skip))) return;
      const t = e.touches[0];
      st = { item: h.closest(o.itemSel), x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, g: null, b: null };
      touching = true;
      if (o.longPress) st.timer = setTimeout(activate, 350); else { e.preventDefault(); activate(); }
    }, { passive: false });
    root.addEventListener('touchmove', (e) => {
      if (!st) return;
      const t = e.touches[0]; st.x = t.clientX; st.y = t.clientY;
      if (!st.active) { if (Math.hypot(st.x - st.sx, st.y - st.sy) > 10) finish(false); return; }   // 還沒長按完就滑動 → 當成捲動
      e.preventDefault(); update();
    }, { passive: false });
    root.addEventListener('touchend', () => finish(true));
    root.addEventListener('touchcancel', () => finish(false));
    root.addEventListener('contextmenu', (e) => { if (st) e.preventDefault(); });
  }

  const kanban = $('#kanban');
  bindSort(kanban, {            // 04 專案看板：換欄＝改狀態，同欄內＝排順序
    itemSel: '.kcard', groupSel: '.kcol', skip: 'button, input', longPress: true, scroller: () => dash,
    onDrop: (card, col, before) => moveProject(card.dataset.id, col.dataset.s, before?.dataset.id)
  });
  bindSort($('#focus'), {       // 01 本週執行看板：重點卡片的順序
    itemSel: '.fcard', groupSel: '#focus', skip: 'button', longPress: true, scroller: () => dash,
    onDrop: (card, grid, before) => moveProject(card.dataset.id, null, before?.dataset.id, true)
  });
  bindSort($('#reviews'), {     // 08 每週復盤
    itemSel: '.row', groupSel: '#reviews', longPress: true, scroller: () => dash,
    onDrop: (row, list, before) => moveReview(row.dataset.id, before?.dataset.id)
  });
  bindSort(box, {               // 專案視窗裡的任務：換區塊＝改類型，同區塊內＝排順序
    itemSel: '.trow', groupSel: '.tgrp', handleSel: '.grip', longPress: false, scroller: () => modal,
    onDrop: (row, grp, before) => moveTask(row.dataset.tid, grp.dataset.type, before?.dataset.tid)
  });

  /* ══════════ LIFE：月曆、習慣、今日紀錄、專注、印記（借鑑 MindKit 的概覽與印記） ══════════
     「今天」跟看板一樣是還沒結束的那一天（dayKey）；月曆上的今天是真正的日期。 */
  const lfAdd = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return ymd(x); };
  const lfDate = (ms) => ymd(new Date(ms));
  const lfHM = (ms) => { const x = new Date(ms); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
  const lfLabel = (d) => { const x = new Date(d + 'T00:00:00'); return `${x.getMonth() + 1}月${x.getDate()}日 週${WEEK[x.getDay()]}`; };
  let lunarFmt = null;
  try { lunarFmt = new Intl.DateTimeFormat('zh-TW-u-ca-chinese-nu-latn', { month: 'long', day: 'numeric' }); } catch (e) { /* 沒有農曆也沒關係 */ }
  const LD = '一二三四五六七八九十', lunarMemo = new Map();
  /* 農曆的「日」各家瀏覽器給的不一樣：Chrome 給數字（10），Safari 給國字（初十、廿三、十八）。都轉成 1–30 */
  function lunarNum(v) {
    const digits = String(v).replace(/\D/g, ''); if (digits) return +digits;
    const c = String(v).replace(/[初日號]/g, ''), one = (ch) => '一二三四五六七八九'.indexOf(ch) + 1;
    if (c === '十') return 10; if (c === '二十' || c === '廿') return 20; if (c === '三十' || c === '卅') return 30;
    if (c[0] === '十') return 10 + one(c[1]);
    if (c[0] === '廿') return 20 + one(c[1]);
    if (c.startsWith('二十')) return 20 + one(c[2]);
    return one(c[0]);
  }
  function lunar(d) {
    if (!lunarFmt) return '';
    if (lunarMemo.has(d)) return lunarMemo.get(d);
    let out = '';
    try {
      const p = lunarFmt.formatToParts(new Date(d + 'T12:00:00')), n = lunarNum(p.find((x) => x.type === 'day').value), m = p.find((x) => x.type === 'month').value;
      if (!n) throw new Error('lunar');
      out = n === 1 ? m : n <= 10 ? '初' + LD[n - 1] : n < 20 ? '十' + LD[n - 11] : n === 20 ? '二十' : n < 30 ? '廿' + LD[n - 21] : '三十';
    } catch (e) { /* ignore */ }
    lunarMemo.set(d, out); return out;
  }

  /* 收合的類別和子任務只記在這台裝置（kos.fold）：類別用 id（未分類是 '_'），子任務用 's:<任務id>' */
  function lfFold(tog) {
    if (!ui.fold) { try { ui.fold = new Set(JSON.parse(localStorage.getItem('kos.fold') || '[]')); } catch (e) { ui.fold = new Set(); } }
    if (tog !== undefined) {
      const k = tog || '_'; ui.fold.has(k) ? ui.fold.delete(k) : ui.fold.add(k);
      try { localStorage.setItem('kos.fold', JSON.stringify([...ui.fold])); } catch (e) { /* 沒有也沒關係 */ }
    }
    return ui.fold;
  }

  /* 「無日期」區（04 最下面）：沒排日期的每日任務放這裡，不會因為不在任何一天而看不到。
     掛在專案下、又沒有類別的任務不放（那是專案的里程碑／待確認，在專案裡看）。今天才做完的留著到明天 */
  const ND = '~';
  /* 04 月曆：圓點＝那天有排定的任務（黃＝還沒做完、暗＝都做完）、紅點＝專案期限。點一天看那天的事，下面的印記也跳到那天 */
  function renderCal() {
    if (ui.drag) return;                           // 拖曳中不重畫，放開後再畫
    const now = ymd(new Date());
    ui.calM ||= now.slice(0, 7); ui.calDay ||= now;
    const [y, m] = ui.calM.split('-').map(Number);
    const lead = new Date(y, m - 1, 1).getDay(), days = new Date(y, m, 0).getDate();
    const open = {}, done = {}, due = {};
    const live = (t) => t.status !== '完成' && t.status !== '已放棄';
    for (const t of state.tasks) if (t.sched && t.status !== '已放棄') (live(t) ? open : done)[t.sched] = 1;
    for (const p of state.projects) if (p.due && p.status !== '已結案') due[p.due] = 1;
    const late = state.tasks.filter((t) => t.sched && t.sched < now && live(t)).length;
    let cells = '<i></i>'.repeat(lead);
    for (let i = 1; i <= days; i++) {
      const d = `${y}-${pad(m)}-${pad(i)}`;
      cells += `<button class="lf-d ${d === now ? 'now' : ''} ${d === ui.calDay ? 'sel' : ''}" data-act="cal-day" data-d="${d}" aria-label="${lfLabel(d)}"><b>${i}</b><span>${lunar(d)}</span><em>${open[d] ? '<u class="o"></u>' : done[d] ? '<u></u>' : ''}${due[d] ? '<u class="p"></u>' : ''}</em></button>`;
    }
    /* 選到的那天的任務，照類別分組；選的是今天時，之前沒做完的也一起列出來（標紅字） */
    const sel = ui.calDay, dues = state.projects.filter((p) => p.due === sel);
    const list = state.tasks.filter((t) => t.sched === sel || (sel === now && t.sched && t.sched < now && live(t)));
    const fold = lfFold();
    const fmin = {}; for (const f of state.focus) if (f.tid) fmin[f.tid] = (fmin[f.tid] || 0) + f.min;
    const ago = (t) => { const n = dayDiff(t.sched, now); return !t.sched || t.sched >= sel || !live(t) ? '' : `<span class="sub lf-late">${n === 1 ? '昨天' : n === 2 ? '前天' : mmdd(t.sched)}</span>`; };
    const subBtn = (t) => { const n = (t.subs || []).length, shut = fold.has('s:' + t.id); return n ? `<button class="lf-sf" data-act="sub-fold" data-id="${t.id}" aria-expanded="${!shut}" aria-label="${shut ? '展開' : '收起'}子任務：${esc(t.name)}">${shut ? '▸' : '▾'} ${t.subs.filter((q) => q.done).length}/${n}</button>` : ''; };
    /* 每個類別裡照優先級（3→0）排；同一級裡照 ord（拖曳排的），沒排過的照建立順序放後面 */
    const idx = new Map(state.tasks.map((t, i) => [t.id, i]));
    const sortL = (l) => l.sort((a, b) => (b.pri || 0) - (a.pri || 0) || (a.ord ?? 1e6 + idx.get(a.id)) - (b.ord ?? 1e6 + idx.get(b.id)));
    let hand = null;   // 這個類別裡可以拖的任務：同一個優先級有 2 個以上
    let toDay = null;  // 無日期區：每列多一顆「→ 選的那天」
    const row = (t) => `<div class="lf-ti" data-id="${t.id}" data-g="${t.pri || 0}"><div class="lf-t ${t.status === '完成' ? 'done' : ''} ${t.status === '已放棄' ? 'drop' : ''}">${hand ? `<span class="lf-h ${hand.has(t.id) ? '' : 'off'}" ${hand.has(t.id) ? `data-drag="${t.id}"` : ''} aria-hidden="true"></span>` : ''}${chk(t)}${t.pri ? `<i class="lf-pri p${t.pri}">${'!'.repeat(t.pri)}</i>` : ''}
        <span class="grow link" data-act="open-t" data-id="${t.id}" tabindex="0">${esc(t.name || '（未命名）')}${ago(t)}</span>${subBtn(t)}${fmin[t.id] ? `<span class="lf-min">${fmin[t.id]} 分</span>` : ''}${tag(proj(t.p))}
        ${toDay && live(t) ? `<button class="h-act lf-to" data-act="t-to" data-id="${t.id}" aria-label="排到${toDay.l}：${esc(t.name)}">→${toDay.s}</button>` : ''}${live(t) ? `<button class="lf-go ${foRun && foRun.tid === t.id ? 'on' : ''}" data-act="t-fo" data-id="${t.id}" aria-label="${foRun && foRun.tid === t.id ? '結束專注' : '開始專注'}：${esc(t.name)}">${foRun && foRun.tid === t.id ? '■' : '▶'}</button>` : ''}</div>${(fold.has('s:' + t.id) ? [] : t.subs || []).map((s) => `
        <div class="lf-t sub ${hand ? 'hh' : ''} ${s.done ? 'done' : ''}"><button class="chk ${s.done ? 'on' : ''}" data-act="sub-tog" data-id="${t.id}" data-sid="${s.id}" aria-pressed="${!!s.done}" aria-label="${esc(s.name)}"></button><span class="grow">${esc(s.name)}</span></div>`).join('')}</div>`;
    const rows = (l, nd) => {
      sortL(l);
      const by = {}; for (const t of l) (by[t.pri || 0] ||= []).push(t.id);
      const ids = Object.values(by).filter((a) => a.length > 1).flat();
      hand = ids.length ? new Set(ids) : null;
      toDay = nd ? { s: sel === now ? '今天' : mmdd(sel), l: lfLabel(sel) } : null;
      const out = l.map(row).join(''); hand = toDay = null; return out;
    };
    const undated = state.tasks.filter((t) => !t.sched && (!proj(t.p) || t.cat) && (live(t) || (t.status === '完成' && t.doneAt && lfDate(t.doneAt) === now)));
    const known = new Set(state.cats.map((c) => c.id));
    const groups = [...state.cats.map((c) => [c.id, c.name, list.filter((t) => t.cat === c.id)]), ['', '未分類', list.filter((t) => !known.has(t.cat))]].filter(([id, , l]) => id || l.length || !state.cats.length);
    groups.push([ND, '無日期', undated]);
    paint($('#lf-cal'), `
      <div class="lf-cal-h"><button class="h-act" data-act="cal-m" data-n="-1" aria-label="上個月">&lt;</button><strong>${y}年${m}月</strong><button class="h-act" data-act="cal-m" data-n="1" aria-label="下個月">&gt;</button>
        <button class="h-act" data-act="cal-m" data-n="0">今天</button>${late ? chip(`逾期 ${late}`, 'c-mag') : ''}</div>
      <div class="lf-cal-g">${WEEK.map((w) => `<i class="lf-w">${w}</i>`).join('')}${cells}</div>
      <div class="lf-cal-a"><div class="lf-at">${lfLabel(sel)}</div>
        ${dues.map((p) => `<div class="row">${tag(p)}<span class="grow link" data-act="open-p" data-id="${p.id}" tabindex="0">${esc(p.name)}</span>${chip('期限', 'c-mag')}</div>`).join('')}
        ${groups.map(([id, name, l]) => { const n = l.filter((t) => t.status !== '已放棄'), shut = fold.has(id || '_'); return `
        <div class="lf-g ${shut ? 'shut' : ''}"><button class="lf-fold" data-act="cat-fold" data-c="${id}" aria-expanded="${!shut}"><i>${shut ? '▸' : '▾'}</i><strong>${esc(name)}</strong></button><span>${n.length ? `${n.filter((t) => t.status === '完成').length}/${n.length}` : '0'}</span>
          ${id && id !== ND ? `<button class="x" data-act="cat-del" data-c="${id}" aria-label="刪除類別「${esc(name)}」">X</button>` : ''}<button class="kadd" data-act="cat-add" data-c="${id}" aria-label="在「${esc(name)}」新增任務">＋</button></div>
        <div class="lf-tl" data-c="${id}">${shut ? '' : rows(l, id === ND)}</div>${ui.addCat === id ? `<form class="qadd lf-add" data-form="add-cal"><textarea class="in grow auto" name="name" rows="1" data-enter="submit" enterkeyhint="send" placeholder="＋ ${esc(name)}" autocomplete="off" aria-label="新任務名稱"></textarea><span class="lf-ap" role="group" aria-label="優先級">${[0, 1, 2, 3].map((n) => `<button type="button" class="lf-apb p${n} ${(ui.addPri || 0) === n ? 'on' : ''}" data-act="add-pri" data-v="${n}" aria-pressed="${(ui.addPri || 0) === n}" aria-label="${SETS.pri.items()[n].l}">${n ? '!'.repeat(n) : '—'}</button>`).join('')}</span><button class="btn btn-sm">新增</button></form>` : ''}`; }).join('')}
        <form class="qadd" data-form="add-cat"><input class="in grow" name="name" placeholder="＋ 新類別" autocomplete="off" aria-label="新類別名稱"><button class="btn btn-sm">新增</button></form></div>`);
  }

  /* 拖曳排序（任務、子任務共用）：按住握把上下拖，只跟旁邊「同一組」的換位置。
     一律搬旁邊那個元素，拖著的元素不離開 DOM（不然會失去 pointer capture，放開收不到 pointerup）。
     放開時 done(有沒有動過, 這一組現在的順序)。拖曳中 ui.drag = true，renderCal() 會跳過不重畫 */
  function dragRow(e, h, item, same, done) {
    const list = item.parentElement;
    e.preventDefault(); ui.drag = true;
    try { h.setPointerCapture(e.pointerId); } catch (er) { /* 沒有也沒關係 */ }
    let y0 = e.clientY, moved = false;
    item.classList.add('lf-drag');
    const sib = (up) => { const el = up ? item.previousElementSibling : item.nextElementSibling; return el && same(el) ? el : null; };
    const move = (ev) => {
      let dy = ev.clientY - y0, n;
      while ((n = sib(false)) && dy > n.offsetHeight / 2) { const hh = n.offsetHeight; list.insertBefore(n, item); y0 += hh; dy -= hh; moved = true; sfx.tick(); }
      while ((n = sib(true)) && dy < -n.offsetHeight / 2) { const hh = n.offsetHeight; list.insertBefore(n, item.nextSibling); y0 -= hh; dy += hh; moved = true; sfx.tick(); }
      item.style.transform = `translateY(${dy}px)`;
    };
    const end = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      item.style.transform = ''; item.classList.remove('lf-drag'); ui.drag = false;
      done(moved, [...list.children].filter(same));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  /* 子任務照畫面上的順序排回 t.subs（只排有出現在畫面上的，其他的照原本的位置留在後面） */
  function orderSubs(t, ids) {
    const by = new Map((t.subs || []).map((q) => [q.id, q]));
    t.subs = [...ids.map((id) => by.get(id)).filter(Boolean), ...(t.subs || []).filter((q) => !ids.includes(q.id))];
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    /* 任務：同一個類別、同一個優先級裡換位置；放開後把那一組的順序寫進 ord */
    let h = e.target.closest('#lf-cal [data-drag]');
    if (h) {
      const item = h.closest('.lf-ti'), g = item.dataset.g;
      return dragRow(e, h, item, (x) => x.classList.contains('lf-ti') && x.dataset.g === g, (moved, l) => {
        if (moved) { l.forEach((x, i) => { const t = task(x.dataset.id); if (t) t.ord = i; }); sfx.check(); commit(); } else renderCal();
      });
    }
    /* 子任務：只在任務視窗裡排（11/22 使用者要求：主畫面不能拖，要點進任務才能拖） */
    h = e.target.closest('#modal-box [data-sdrag]');
    if (h) {
      const t = task(h.dataset.sdrag); if (!t) return;
      return dragRow(e, h, h.closest('.trow'), (x) => x.matches('.trow'), (moved, l) => {
        if (moved) { orderSubs(t, l.map((x) => x.dataset.sid)); sfx.check(); commit(); }
        modalCtl?.rerender();
      });
    }
  });

  /* 任務詳情：一次設定好日期、類別、優先級、子任務；「移動到／複製到」讓同一件事不用重打 */
  function openTask(id) {
    const t = task(id); if (!t) return;
    const isTxt = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'hidden');
    const dayOf = (to) => (to === 'none' ? '' : lfAdd(ymd(new Date()), +to));
    const copyTo = (d) => {
      state.tasks.push(newTask({ p: t.p, type: t.type, name: t.name, note: t.note || '', cat: t.cat || '', pri: t.pri || 0, sched: d, subs: (t.subs || []).map((s, i) => ({ id: uid('s') + i, name: s.name, done: false })) }));
      commit(); toast(`已複製到 ${mmdd(d)}`);
    };
    /* 補登專注：忘了按計時的，事後補一筆（帶 add: 1，只有補登的可以刪） */
    let fo = null;   // { d: 日期, s: 'HH:MM' 開始, e: 'HH:MM' 結束 }；結束比開始早＝跨過午夜
    const hm2m = (v) => /^\d\d:\d\d/.test(v || '') ? +v.slice(0, 2) * 60 + +v.slice(3, 5) : null;
    const m2hm = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
    const foMin = () => { const a = hm2m(fo.s), b = hm2m(fo.e); return a == null || b == null ? 0 : (b - a + 1440) % 1440; };
    const foDur = (n) => n >= 60 ? `${Math.floor(n / 60)} 時${n % 60 ? ` ${n % 60} 分` : ''}` : `${n} 分`;
    const foBad = () => { const n = foMin(); return !n ? '開始和結束一樣' : n <= 600 ? '' : hm2m(fo.e) < hm2m(fo.s) ? '結束比開始早' : '超過 10 小時'; };
    const foSum = () => { const n = foMin(), bad = foBad(); return bad ? `<b class="tk-fo-n bad">${bad}</b>` : `<b class="tk-fo-n">${foDur(n)}</b>${hm2m(fo.e) < hm2m(fo.s) ? '<i>跨午夜</i>' : ''}`; };
    const foList = () => state.focus.filter((f) => f.tid === t.id).sort((a, b) => b.at - a.at);
    const foRows = () => { const l = foList(); return l.length ? `<div class="tk-fl">${l.map((f) => `<div class="tk-fr"><span>${mmdd(ymd(new Date(f.at)))} ${lfHM(f.at)}–${lfHM(f.end)}${f.add ? '<i>補登</i>' : ''}</span><b>${f.min} 分</b>${f.add ? `<button class="x" data-act="fo-del" data-id="${f.id}" aria-label="刪除這筆補登">X</button>` : ''}</div>`).join('')}</div>` : ''; };
    function render() {
      const done = t.status === '完成', drop = t.status === '已放棄';
      box.innerHTML = `
        <div class="m-head"><span class="rt-head">TASK</span><button class="x" data-act="close" aria-label="關閉">X</button></div>
        <textarea class="in in-title auto" data-f="name" rows="1" placeholder="任務名稱" aria-label="任務名稱">${esc(t.name)}</textarea>
        <textarea class="in tk-note" data-f="note" rows="2" placeholder="詳情" aria-label="詳情">${esc(t.note || '')}</textarea>
        <div class="fgrid tk-grid">
          <div class="fld">日期${dateBtn(t.sched || '', 'data-f="sched" aria-label="日期"')}</div>
          <div class="fld">類別${selBtn('cat', state.cats.some((c) => c.id === t.cat) ? t.cat : '', 'data-f="cat" aria-label="類別"')}</div>
          <div class="fld">優先級${selBtn('pri', String(t.pri || 0), 'data-f="pri" aria-label="優先級"')}</div>
          <div class="fld">專案${selBtn('project', proj(t.p) ? t.p : '', 'data-f="p" aria-label="專案"')}</div>
        </div>
        <div class="tk-subs">${(t.subs || []).map((s) => `
          <div class="trow ${s.done ? 'done' : ''}" data-sid="${s.id}">${t.subs.length > 1 ? `<span class="lf-h" data-sdrag="${t.id}" aria-hidden="true"></span>` : ''}<button class="chk ${s.done ? 'on' : ''}" data-act="sub-tog" data-sid="${s.id}" aria-pressed="${!!s.done}" aria-label="子任務完成"></button>
            <textarea class="in bare grow auto" data-sf="${s.id}" rows="1" aria-label="子任務名稱">${esc(s.name)}</textarea><button class="x" data-act="sub-del" data-sid="${s.id}" aria-label="刪除子任務">X</button></div>`).join('')}
          <form class="qadd" data-form="add-sub"><textarea class="in grow auto" name="name" rows="1" data-enter="submit" enterkeyhint="send" placeholder="＋ 子任務" autocomplete="off" aria-label="新子任務"></textarea><button class="btn btn-sm">新增</button></form></div>
        <div class="tk-acts">
          <div class="tk-a"><span>專注</span><button class="h-act" data-act="fo" data-m="pomo">▶ 番茄鐘</button><button class="h-act" data-act="fo" data-m="up">▶ 正計時</button><button class="h-act ${fo ? 'on' : ''}" data-act="fo-add" aria-expanded="${!!fo}">＋ 補登</button></div>
          ${fo ? `<form class="tk-fo" data-form="fo-add">
            ${dateBtn(fo.d, 'data-f="fo-d" aria-label="補登日期"')}
            <div class="tk-fo-t"><input class="in" type="time" name="s" value="${esc(fo.s)}" required aria-label="開始時間"><span aria-hidden="true">→</span><input class="in" type="time" name="e" value="${esc(fo.e)}" required aria-label="結束時間"></div>
            <div class="tk-fo-f"><span class="tk-fo-sum" aria-live="polite">${foSum()}</span><button class="btn btn-sm">補登</button></div></form>` : ''}
          ${foRows()}
          <div class="tk-a"><span>移動到</span><button class="h-act" data-act="mv" data-to="0">今天</button><button class="h-act" data-act="mv" data-to="1">明天</button><button class="h-act" data-act="mv" data-to="none">無日期</button></div>
          <div class="tk-a"><span>複製到</span><button class="h-act" data-act="cp" data-to="0">今天</button><button class="h-act" data-act="cp" data-to="1">明天</button>${dateBtn('', 'data-f="copyto" aria-label="複製到其他日期"', { sm: true })}</div>
        </div>
        <div class="rt-foot tk-foot"><button class="btn btn-ghost danger" data-act="del">刪除</button><button class="btn btn-ghost" data-act="drop">${drop ? '恢復' : '標記為已放棄'}</button><span class="sp"></span><button class="btn" data-act="done">${done ? '取消完成' : '標記為完成'}</button></div>`;
    }
    const ctl = openModal('tk', {
      top: true, render, dismiss: () => true,
      input(e) {
        const el = e.target; if (!isTxt(el)) return;
        if (fo && (el.name === 's' || el.name === 'e')) { fo[el.name] = el.value; const o = box.querySelector('.tk-fo-sum'); if (o) o.innerHTML = foSum(); return; }
        if (el.dataset.f) { t[el.dataset.f] = el.value; commit(); }
        else if (el.dataset.sf) { const s = (t.subs || []).find((q) => q.id === el.dataset.sf); if (s) { s.name = el.value; commit(); } }
      },
      change(e) {
        const el = e.target, f = el.dataset.f;
        if (fo && (el.name === 's' || el.name === 'e')) { fo[el.name] = el.value; const o = box.querySelector('.tk-fo-sum'); if (o) o.innerHTML = foSum(); return; }   // 有些瀏覽器的時間欄只發 change
        if (isTxt(el) || !f) return;
        if (f === 'copyto') { if (el.value) copyTo(el.value); return render(); }
        if (f === 'fo-d') { if (el.value) fo.d = el.value; return render(); }
        if (f === 'pri') t.pri = +el.value; else t[f] = el.value;
        commit(); refocus(el, render);
      },
      submit(e) {
        e.preventDefault();
        if (e.target.dataset.form === 'fo-add') {
          const fd = new FormData(e.target); fo.s = String(fd.get('s') || ''); fo.e = String(fd.get('e') || '');
          const min = foMin();
          if (hm2m(fo.s) == null || hm2m(fo.e) == null) { sfx.deny(); return toast('選開始和結束時間'); }
          if (foBad()) { sfx.deny(); return toast(foBad()); }
          const [y, m, d] = fo.d.split('-').map(Number), s0 = hm2m(fo.s);
          const at = new Date(y, m - 1, d, Math.floor(s0 / 60), s0 % 60).getTime(), end = at + min * 60000;
          if (end > Date.now()) { sfx.deny(); return toast('結束時間還沒到，不能補登'); }
          state.focus.push({ id: uid('f'), at, end, min, note: t.name || '', tid: t.id, hid: '', pid: '', pct: state.wallet.rates.focus || 0, add: 1 });
          fo = null; commit(); render(); toast(`已補登 ${min} 分`);
          return;
        }
        const name = String(new FormData(e.target).get('name') || '').trim(); if (!name) return;
        (t.subs ||= []).push({ id: uid('s'), name, done: false });
        commit(); render(); box.querySelector('[data-form="add-sub"] [name="name"]').focus();
      },
      click(e) {
        const el = e.target.closest('[data-act]'); if (!el) return;
        const a = el.dataset.act;
        if (a === 'close') ctl.close();
        else if (a === 'done') { toggleTask(t.id); ctl.close(); }
        else if (a === 'drop') { t.status = t.status === '已放棄' ? '未開始' : '已放棄'; commit(); ctl.close(); }
        else if (a === 'del') { ctl.close(); deleteTask(t.id); }
        else if (a === 'mv') { t.sched = dayOf(el.dataset.to); commit(); render(); toast(t.sched ? `已移到 ${mmdd(t.sched)}` : '已改成無日期'); }
        else if (a === 'cp') copyTo(dayOf(el.dataset.to));
        else if (a === 'sub-tog') { const s = t.subs.find((q) => q.id === el.dataset.sid); if (s) { s.done = !s.done; commit(); render(); } }
        else if (a === 'sub-del') { t.subs = t.subs.filter((q) => q.id !== el.dataset.sid); commit(); render(); }
        else if (a === 'fo-add') {
          const n = new Date(), e0 = Math.floor((n.getHours() * 60 + n.getMinutes()) / 5) * 5;   // 預設：剛剛那 30 分鐘（取到 5 分）
          fo = fo ? null : { d: t.sched && t.sched <= ymd(n) ? t.sched : ymd(n), s: m2hm(Math.max(0, e0 - 30)), e: m2hm(e0) };
          render();
        }
        else if (a === 'fo-del') {
          const i = state.focus.findIndex((f) => f.id === el.dataset.id && f.add); if (i < 0) return;
          const [gone] = state.focus.splice(i, 1); commit(); render();
          toast(`已刪除補登的 ${gone.min} 分`, () => { state.focus.push(gone); commit(); if (modalCtl === ctl) render(); });
        }
        else if (a === 'fo') {
          if (foRun) { sfx.deny(); return toast('已經有一個專注在計時，先結束它'); }
          foMode = el.dataset.m; lsFo.set('kos.fomode', foMode);
          ctl.close(); foStart(t);
        }
      }
    });
  }

  /* 05 習慣：一週七格，點一下打勾；今天以前沒做的標暗 */
  function habitStreak(x) { let n = 0, d = dayKey; if (!x.log[d]) d = lfAdd(d, -1); while (x.log[d]) { n++; d = lfAdd(d, -1); } return n; }
  function renderHabits() {
    const s0 = lfAdd(dayKey, -new Date(dayKey + 'T00:00:00').getDay()), wk = Array.from({ length: 7 }, (_, i) => lfAdd(s0, i));
    paint($('#lf-habits'), (state.habits.length ? state.habits.map((x) => {
      const s = habitStreak(x);
      return `<div class="lf-hb"><span class="grow">${esc(x.name)}${s > 1 ? `<span class="sub">連續 ${s} 天</span>` : ''}</span>
        <span class="lf-hb-w">${wk.map((d, i) => `<button class="lf-hb-c ${x.log[d] ? 'on' : d < dayKey ? 'miss' : ''} ${d === dayKey ? 'now' : ''}" data-act="habit-tog" data-id="${x.id}" data-d="${d}" ${d > dayKey ? 'disabled' : ''} aria-pressed="${!!x.log[d]}" aria-label="${esc(x.name)} 週${WEEK[i]}">${x.log[d] ? '' : WEEK[i]}</button>`).join('')}</span>
        <button class="x" data-act="habit-del" data-id="${x.id}" aria-label="刪除習慣">X</button></div>`;
    }).join('') : empty('NO HABITS', '在下面新增想每天做的事')) + `
      <form class="qadd" data-form="add-habit"><input class="in grow" name="name" placeholder="＋ 新習慣" autocomplete="off" aria-label="新習慣名稱"><button class="btn btn-sm">新增</button></form>`);
  }

  /* 06 今日紀錄：欄位是固定的 HTML（不重畫，打字不會被洗掉），這裡只把存的值填回沒在打字的欄位，並畫兩張小圖 */
  function renderDaylog() {
    const rec = state.daylog[dayKey] || {};
    for (const el of document.querySelectorAll('#lf-log [data-df]')) {
      if (document.activeElement === el) continue;
      const v = String(rec[el.dataset.df] ?? ''); if (el.value !== v) el.value = v;
    }
    const vals = Object.keys(state.daylog).filter((d) => state.daylog[d].kg).sort().slice(-7).map((d) => +state.daylog[d].kg);
    const lo = Math.min(...vals), span = (Math.max(...vals) - lo) || 1;
    paint($('#lf-kg'), vals.length > 1 ? `<svg viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${vals.map((v, i) => `${(i / (vals.length - 1) * 116 + 2).toFixed(1)},${(32 - (v - lo) / span * 28).toFixed(1)}`).join(' ')}"/></svg>` : '');
    paint($('#lf-sleep'), `<div class="lf-bars">${Array.from({ length: 7 }, (_, i) => lfAdd(dayKey, i - 6)).map((d) => { const n = +(state.daylog[d]?.sleep) || 0; return `<i title="${mmdd(d)} ${n || '—'} h"><u style="height:${Math.min(100, n * 10)}%"></u></i>`; }).join('')}</div>`);
  }
  dash.addEventListener('change', (e) => {
    const el = e.target, k = el.dataset.df; if (!k) return;
    let v = el.value.trim();
    if (k === 'kg' || k === 'sleep') v = v === '' ? '' : (Math.max(0, Math.round(+v * 10) / 10) || '');
    const rec = (state.daylog[dayKey] ||= {});
    if (v === '') delete rec[k]; else rec[k] = v;
    if (!Object.keys(rec).length) delete state.daylog[dayKey];
    commit();
  });

  /* 07 專注：番茄鐘（25 分自動結束）／正計時。計時狀態存在這台裝置（重新整理、關掉再開都接著跑），結束才寫進資料 */
  const FO_MIN = 25;
  const lsFo = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* 沒有也沒關係 */ } } };
  let foRun = null; try { foRun = JSON.parse(lsFo.get('kos.focus') || 'null'); } catch (e) { /* ignore */ }
  let foMode = foRun?.mode || lsFo.get('kos.fomode') || 'pomo';
  function foStop(auto) {
    const r = foRun; if (!r) return;
    foRun = null; lsFo.set('kos.focus', null);
    const end = r.mode === 'pomo' ? Math.min(Date.now(), r.start + FO_MIN * 60000) : Date.now(), min = Math.round((end - r.start) / 60000);
    const note = r.note || '';
    foPick = null;
    if (min < 1) { toast('不到 1 分鐘，不記錄'); renderCal(); return renderFocus(); }
    const pct = state.wallet.rates.focus || 0, c0 = foCents();
    state.focus.push({ id: uid('f'), at: r.start, end, min, note, tid: task(r.tid) ? r.tid : '', hid: r.hid || '', pid: r.pid || '', pct });
    const hb = r.hid && state.habits.find((x) => x.id === r.hid), ticked = hb && !hb.log[dayKey];   // 專注在習慣上：結束就幫今天打勾
    if (ticked) hb.log[dayKey] = 1;
    if (auto) sfx.ready();
    const c1 = foCents(), paid = Math.floor(c1 / 100) - Math.floor(c0 / 100);
    commit(); toast(`專注 ${min} 分${note ? '：' + note : ''}${ticked ? '，習慣已打勾' : ''}${pct ? `，+${cents(c1 - c0)}${paid ? `（入帳 ${money(paid)}）` : `（累積 ${cents(c1 % 100)}）`}` : ''}`);
  }
  /* 開始專注。t＝從每日任務按 ▶ 帶進來的任務；沒有就用「專注在…」選好的那一項（任務／習慣／專案／自己打的字） */
  let foPick = null;   // { k: 't' | 'h' | 'p' | '', id, name }
  function openFoPick(anchor) {
    const grp = (title, k, list) => list.length ? `<div class="fo-pg">${title}</div>${list.map((x) => `
      <div class="pop-row"><button type="button" class="pop-opt ${foPick && foPick.k === k && foPick.id === x.id ? 'on' : ''}" role="option" data-k="${k}" data-id="${esc(x.id)}"><span>${esc(x.name || '（未命名）')}</span></button></div>`).join('')}` : '';
    openPop(anchor, () => {
      pop.className = 'pop pxb fo-pop';
      pop.innerHTML = `<div class="pop-list" role="listbox">${grp('任務', 't', foTasks())}${grp('習慣', 'h', state.habits)}${grp('專案', 'p', state.projects.filter((p) => p.status === '執行中'))}</div>
        <form class="pop-add"><input class="in sm grow" name="name" placeholder="其他，自己打" autocomplete="off" aria-label="其他要專注的事" value="${esc(foPick && !foPick.k ? foPick.name : '')}"><button class="btn btn-sm">用這個</button></form>`;
    });
    const done = (v) => { foPick = v; closePop(true); renderFocus(); };
    pop.onclick = (e) => {
      const o = e.target.closest('.pop-opt'); if (!o) return;
      const k = o.dataset.k, id = o.dataset.id;
      if (foPick && foPick.k === k && foPick.id === id) return done(null);   // 再點一次＝取消選擇
      const x = k === 't' ? task(id) : k === 'h' ? state.habits.find((h) => h.id === id) : state.projects.find((p) => p.id === id);
      if (x) done({ k, id, name: x.name || '' });
    };
    pop.onsubmit = (e) => { e.preventDefault(); const name = String(new FormData(e.target).get('name') || '').trim(); done(name ? { k: '', id: '', name } : null); };
  }
  function foStart(t) {
    if (foRun) { sfx.deny(); return toast('已經有一個專注在計時，先結束它'); }
    if (t) foPick = { k: 't', id: t.id, name: t.name };
    const s = foPick || { k: '', id: '', name: '' };
    foRun = { start: Date.now(), mode: foMode, note: s.name, tid: s.k === 't' ? s.id : '', hid: s.k === 'h' ? s.id : '', pid: s.k === 'p' ? s.id : '' }; lsFo.set('kos.focus', JSON.stringify(foRun));
    renderFocus(); renderCal();
    if (t) toast(`開始專注：${t.name}`);
  }
  const foTasks = () => { const now = ymd(new Date()); return state.tasks.filter((t) => t.sched && t.sched <= now && t.status !== '完成' && t.status !== '已放棄'); };   // 今天和之前沒做完的
  function renderFocus() {
    const run = foRun, el = run ? Date.now() - run.start : 0, mode = run ? run.mode : foMode;
    if (run && mode === 'pomo' && el >= FO_MIN * 60000) return foStop(true);
    const sec = Math.max(0, Math.floor(el / 1000)), show = mode === 'pomo' ? FO_MIN * 60 - sec : sec;
    const t = `${pad(Math.floor(show / 60))}:${pad(show % 60)}`, tEl = $('#fo-time'); if (tEl.textContent !== t) tEl.textContent = t;
    $('#lf-fo').classList.toggle('run', !!run);
    for (const b of document.querySelectorAll('#lf-fo [data-m]')) { b.classList.toggle('on', b.dataset.m === mode); b.disabled = !!run; }
    const pk = run ? run.note : foPick ? foPick.name : '', pEl = $('#fo-pick'), pl = $('#fo-pick-l');
    if (pl.textContent !== (pk || '專注在…')) pl.textContent = pk || '專注在…';
    pEl.classList.toggle('empty', !pk); pEl.disabled = !!run;
    const go = run ? '■ 結束' : '▶ 開始', gEl = $('#fo-go'); if (gEl.textContent !== go) gEl.textContent = go;
    const now = ymd(new Date()), td = state.focus.filter((f) => lfDate(f.at) === now), sum = td.length ? `今日 ${td.length} 次 · ${td.reduce((n, f) => n + f.min, 0)} 分` : '';
    const sEl = $('#fo-sum'); if (sEl.textContent !== sum) sEl.textContent = sum;
  }

  /* 08 印記：每天留下了什麼——完成的任務、堅持的習慣、專注的時段，加上那天的日記、三餐、體重、睡眠、錢包進出。可看日／週／月 */
  function renderMarks() {
    const now = ymd(new Date()); ui.mkDate ||= now; ui.mkView ||= 'day';
    const d = ui.mkDate, x = new Date(d + 'T00:00:00');
    let from = d, to = d, label = lfLabel(d);
    if (ui.mkView === 'week') { from = lfAdd(d, -x.getDay()); to = lfAdd(from, 6); label = `${mmdd(from)} – ${mmdd(to)}`; }
    else if (ui.mkView === 'month') { from = d.slice(0, 8) + '01'; to = ymd(new Date(x.getFullYear(), x.getMonth() + 1, 0)); label = `${x.getFullYear()}年${x.getMonth() + 1}月`; }
    paint($('#lf-mk-nav'), `<button class="h-act" data-act="mk-go" data-n="-1" aria-label="往前">&lt;</button><strong>${label}</strong><button class="h-act" data-act="mk-go" data-n="1" aria-label="往後">&gt;</button>${[['day', '日'], ['week', '週'], ['month', '月']].map(([k, l]) => `<button class="h-act ${ui.mkView === k ? 'on' : ''}" data-act="mk-view" data-v="${k}">${l}</button>`).join('')}`);
    const by = {}, at = (k) => (by[k] ||= { tasks: [], habits: [], focus: [], gain: 0, spend: 0, log: null }), inR = (k) => k >= from && k <= to;
    for (const t of state.tasks) if (t.status === '完成' && t.doneAt) { const k = lfDate(t.doneAt); if (inR(k)) at(k).tasks.push(t); }
    for (const k in state.days) if (inR(k)) for (const r of ['am', 'pm']) { const it = state.routines[r] || [], c = state.days[k][r] || {}; if (it.length && it.every((n) => c[n])) at(k).habits.push(r === 'am' ? '晨間 routine' : '晚間 routine'); }
    for (const hb of state.habits) for (const k in hb.log) if (inR(k)) at(k).habits.push(hb.name);
    for (const f of state.focus) { const k = lfDate(f.at); if (inR(k)) at(k).focus.push(f); }
    for (const e of state.wallet.log) { const k = lfDate(e.at); if (inR(k)) { if (e.amt >= 0) at(k).gain += e.amt; else at(k).spend -= e.amt; } }
    for (const k in state.daylog) if (inR(k)) at(k).log = state.daylog[k];
    const keys = Object.keys(by).sort().reverse();
    const card = (k) => {
      const r = by[k], fm = r.focus.reduce((n, f) => n + f.min, 0), G = r.log || {}, meals = [['早', G.b], ['中', G.l], ['晚', G.d]].filter((q) => q[1]);
      const chips = meals.map((q) => chip(`${q[0]} ${q[1]}`, 'c-dim')).join('') + (G.kg ? chip(`${G.kg} kg`, 'c-cyan') : '') + (G.sleep ? chip(`睡 ${G.sleep} h`, 'c-pur') : '') + (r.gain ? chip('+' + money(r.gain), 'c-yel') : '') + (r.spend ? chip('-' + money(r.spend), 'c-mag') : '');
      return `<div class="lf-mk">${ui.mkView === 'day' ? '' : `<div class="lf-mk-d">${lfLabel(k)}</div>`}
        ${r.tasks.length ? `<h4>完成了 ${r.tasks.length} 個任務</h4><ul>${r.tasks.map((t) => `<li><i class="lf-ok"></i>${tag(proj(t.p))}<span>${esc(t.name)}</span></li>`).join('')}</ul>` : ''}
        ${r.habits.length ? `<h4>堅持了 ${r.habits.length} 個習慣</h4><ul>${r.habits.map((n) => `<li><i class="lf-ok y"></i><span>${esc(n)}</span></li>`).join('')}</ul>` : ''}
        ${r.focus.length ? `<h4>專注 ${r.focus.length} 次，共 ${fm} 分</h4>${r.focus.map((f) => `<div class="lf-mk-fo p${task(f.tid)?.pri || 0}"><b>${lfHM(f.at)}</b><span>${esc(f.note || '專注')}</span><em>${lfHM(f.at)} – ${lfHM(f.end)}（${f.min} 分）</em></div>`).join('')}` : ''}
        ${G.note ? `<blockquote>${esc(G.note)}</blockquote>` : ''}
        ${chips ? `<div class="lf-mk-chips">${chips}</div>` : ''}</div>`;
    };
    let sum = '';
    if (ui.mkView !== 'day' && keys.length) {
      const T = keys.reduce((a, k) => { const r = by[k]; a.t += r.tasks.length; a.h += r.habits.length; a.f += r.focus.reduce((n, f) => n + f.min, 0); a.g += r.gain; return a; }, { t: 0, h: 0, f: 0, g: 0 });
      sum = `<div class="lf-mk-sum">${chip(`任務 ${T.t}`, 'c-grn')}${chip(`習慣 ${T.h}`, 'c-yel')}${chip(`專注 ${T.f} 分`, 'c-cyan')}${T.g ? chip('+' + money(T.g), 'c-yel') : ''}</div>`;
    }
    paint($('#lf-marks'), keys.length ? sum + keys.map(card).join('') : empty('NO MARKS', '這段時間沒有留下紀錄'));
  }
  function renderLife() { renderCal(); renderHabits(); renderDaylog(); renderFocus(); renderMarks(); }

  dash.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el || !dash.contains(el)) return;
    const a = el.dataset.act;
    if (a === 'cal-day') { ui.calDay = ui.mkDate = el.dataset.d; ui.mkView = 'day'; renderDash(); }
    else if (a === 'open-t') { if (!busy && !modalCtl) openTask(el.dataset.id); }
    else if (a === 't-to') {                       // 無日期 → 排到選的那天（有復原）
      const t = task(el.dataset.id); if (!t) return;
      t.sched = ui.calDay; sfx.check(); commit();
      toast(`已排到 ${ui.calDay === ymd(new Date()) ? '今天' : mmdd(ui.calDay)}`, () => { t.sched = ''; commit(); });
    }
    else if (a === 'sub-tog') { const s = task(el.dataset.id)?.subs?.find((q) => q.id === el.dataset.sid); if (s) { s.done = !s.done; commit(); } }
    else if (a === 'sub-fold') { lfFold('s:' + el.dataset.id); sfx.tick(); renderCal(); $(`#lf-cal [data-act="sub-fold"][data-id="${el.dataset.id}"]`)?.focus({ preventScroll: true }); }
    else if (a === 'cat-fold') { lfFold(el.dataset.c); if (ui.addCat === el.dataset.c) ui.addCat = null; sfx.tick?.(); renderCal(); $(`#lf-cal [data-act="cat-fold"][data-c="${el.dataset.c}"]`)?.focus({ preventScroll: true }); }
    else if (a === 'add-pri') {                    // 新增任務時先選優先級：選了就一直用，直到關掉這個新增欄
      ui.addPri = +el.dataset.v; renderCal();
      const inp = $('#lf-cal [data-form="add-cal"] [name="name"]');
      if (inp && !inp.value) inp.focus(); else $(`#lf-cal [data-act="add-pri"][data-v="${ui.addPri}"]`)?.focus({ preventScroll: true });
    }
    else if (a === 'cat-add') { ui.addPri = 0; ui.addCat = ui.addCat === el.dataset.c ? null : el.dataset.c; if (ui.addCat !== null && lfFold().has(ui.addCat || '_')) lfFold(ui.addCat); renderCal(); $('#lf-cal [data-form="add-cal"] [name="name"]')?.focus(); }
    else if (a === 'cat-del') {
      const i = state.cats.findIndex((c) => c.id === el.dataset.c); if (i < 0) return;
      const [gone] = state.cats.splice(i, 1); commit();
      toast(`已刪除類別「${gone.name}」，裡面的任務移到未分類`, () => { state.cats.splice(i, 0, gone); commit(); });
    }
    else if (a === 'cal-m') {
      const n = +el.dataset.n, [y, m] = ui.calM.split('-').map(Number);
      if (n) ui.calM = ymd(new Date(y, m - 1 + n, 1)).slice(0, 7); else { const t = ymd(new Date()); ui.calM = t.slice(0, 7); ui.calDay = ui.mkDate = t; }
      renderDash();
    }
    else if (a === 'habit-tog') {
      const x = state.habits.find((q) => q.id === el.dataset.id), d = el.dataset.d; if (!x) return;
      if (x.log[d]) delete x.log[d]; else x.log[d] = 1;
      commit();
    }
    else if (a === 'habit-del') {
      const i = state.habits.findIndex((q) => q.id === el.dataset.id); if (i < 0) return;
      const [gone] = state.habits.splice(i, 1); commit();
      toast(`已刪除習慣「${gone.name}」`, () => { state.habits.splice(i, 0, gone); commit(); });
    }
    else if (a === 'mk-view') { ui.mkView = el.dataset.v; renderMarks(); }
    else if (a === 'mk-go') {
      const n = +el.dataset.n, x = new Date(ui.mkDate + 'T00:00:00');
      ui.mkDate = ui.mkView === 'month' ? ymd(new Date(x.getFullYear(), x.getMonth() + n, 1)) : lfAdd(ui.mkDate, n * (ui.mkView === 'week' ? 7 : 1));
      renderMarks();
    }
    else if (a === 'fo-mode') { if (foRun) return; foMode = el.dataset.m; lsFo.set('kos.fomode', foMode); renderFocus(); }
    else if (a === 'fo-pick') { if (foRun) return; popState && popState.anchor === el ? closePop(true) : openFoPick(el); }
    else if (a === 'fo-go') {
      if (foRun) return foStop(false);
      foStart();
    }
    else if (a === 't-fo') { const t = task(el.dataset.id); if (!t) return; if (foRun && foRun.tid === t.id) foStop(false); else foStart(t); }
  });

  /* ══════════ HUD、待機畫面 ══════════ */
  function updateHud() {
    const now = new Date();
    const date = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}（${WEEK[now.getDay()]}）`;
    $('#hud-clock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    $('#hud-date').textContent = date;
    $('#hud-up').textContent = day.startedAt ? fmtDur(Date.now() - day.startedAt) : '00:00';
    const dead = amDead(); $('#am-count').textContent = dead ? '失效' : `${doneCount('am')}/${routine('am').length}`;
    $('#btn-am').classList.toggle('dead', dead);
    updateCoin();
    if (foRun) renderFocus();
    $('#off-date').textContent = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  let coinShown = null, coinAnim = 0, lastPt = null;
  document.addEventListener('pointerdown', (e) => { lastPt = { x: e.clientX, y: e.clientY, at: performance.now() }; }, true);
  /* 收到錢的特效：金幣從剛剛點的地方噴出來，一枚一枚飛進錢包，金額跟著往上跳 */
  function coinFx(gain) {
    const chip = $('#btn-wallet'), amtEl = $('#coin-amt'), to = balance(), from = to - gain;
    const r = chip.getBoundingClientRect();
    if (reduced || !r.width || !chip.animate) return updateCoin(true);   // 看板沒顯示或關閉動畫：直接更新數字
    const recent = lastPt && performance.now() - lastPt.at < 1500;
    const x0 = recent ? lastPt.x : window.innerWidth / 2, y0 = recent ? lastPt.y : window.innerHeight / 2;
    const tx = r.left + 16, ty = r.top + r.height / 2;
    const n = Math.max(5, Math.min(14, 4 + Math.round(gain / 10)));
    const my = ++coinAnim;
    amtEl.textContent = money(from); chip.classList.toggle('neg', from < 0);
    const plus = document.createElement('div');
    plus.className = 'coin-plus'; plus.textContent = '+' + money(gain);
    plus.style.left = x0 + 'px'; plus.style.top = y0 + 'px';
    document.body.appendChild(plus);
    plus.animate([{ transform: 'translate(-50%, -60%) scale(.6)', opacity: 0 }, { transform: 'translate(-50%, -150%) scale(1.15)', opacity: 1, offset: 0.18 },
      { transform: 'translate(-50%, -230%) scale(1)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%, -300%) scale(1)', opacity: 0 }], { duration: 1300, easing: 'steps(13)' }).onfinish = () => plus.remove();
    let landed = 0;
    const els = [plus];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div'); els.push(c);
      c.className = 'coin-fly'; c.innerHTML = COIN;
      document.body.appendChild(c);
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, dist = 46 + Math.random() * 60;
      const bx = x0 + Math.cos(ang) * dist, by = y0 + Math.sin(ang) * dist - 20;
      const at = (x, y, sc) => `translate(${Math.round(x - 9)}px, ${Math.round(y - 9)}px) scale(${sc})`;
      c.animate([{ transform: at(x0, y0, 0.4), opacity: 0, easing: 'cubic-bezier(.2,.8,.3,1)' }, { transform: at(bx, by, 1.5), opacity: 1, offset: 0.3, easing: 'cubic-bezier(.6,0,.9,.4)' },
        { transform: at(bx, by + 10, 1.4), opacity: 1, offset: 0.42, easing: 'cubic-bezier(.5,0,.8,.3)' }, { transform: at(tx, ty, 0.8), opacity: 1 }],
        { duration: 760, delay: i * 55, fill: 'backwards' }).onfinish = () => {
        c.remove(); landed++;
        if (my !== coinAnim) return;                 // 中途又收到一筆：交給新的那一次
        beep(1568 + (landed % 3) * 262, 0.03, 0.022);
        amtEl.textContent = money(landed >= n ? to : from + Math.round(gain * landed / n));
        chip.classList.toggle('neg', to < 0 && landed >= n);
        chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump');
        if (landed >= n) { coinAnim = 0; coinShown = null; updateCoin(true); }
      };
    }
    setTimeout(() => { els.forEach((el) => el.remove()); if (my === coinAnim) { coinAnim = 0; coinShown = null; updateCoin(); } }, 760 + n * 55 + 1500);   // 保險：動畫被瀏覽器停掉也要把數字更新回來
  }
  /* 目標：商品頁勾「鎖定目標」，上排錢包旁邊一顆進度（小圖＋進度條＋%）；手機放不下，改成錢包底下一條細線。
     錢從不夠變成夠的那一刻（這次打開之後）跳提示。只認還買得到的商品，下架或賣完就不顯示 */
  const goalItem = () => { const s = state.goal && state.shop.find((x) => x.id === state.goal && !x.del); return s && shopLeft(s) > 0 ? s : null; };
  let goalKey = null, goalWasReady = null;
  function updateGoal() {
    const s = goalItem(), bal = balance(), chip = $('#btn-goal'), line = $('#coin-goal');
    const pct = s ? Math.min(100, Math.floor(Math.max(0, bal) * 10000 / s.price) / 100) : 0, ready = !!s && bal >= s.price;   // 無條件捨去到小數點後兩位（沒到就不會顯示 100.00%）
    const key = s ? [s.id, s.name, s.price, (s.img || '').length, bal].join('|') : '';
    if (key === goalKey) return;
    goalKey = key; chip.hidden = line.hidden = !s;
    if (!s) { goalWasReady = null; return; }
    $('#goal-pic').innerHTML = sprite(s);
    $('#goal-fill').style.width = line.firstElementChild.style.width = pct + '%';
    $('#goal-pct').textContent = ready ? 'GO!' : pct.toFixed(2) + '%';
    chip.classList.toggle('ready', ready); line.classList.toggle('ready', ready);
    chip.title = `目標：${s.name}　${money(bal)} / ${money(s.price)}${ready ? '（可以買了）' : `（還差 ${money(s.price - bal)}）`}`;
    chip.setAttribute('aria-label', chip.title);
    if (ready && goalWasReady === false) { const nm = s.name; setTimeout(() => toast(`目標「${nm}」可以買了！`, null, 4000), 0); sfx.ready(); }   // 延後一拍：別台入帳時 adopt() 會接著跳同步提示，不要被蓋掉
    goalWasReady = ready;
  }
  function updateCoin(flash) {
    const b = balance(), el = $('#coin-amt');
    if (coinAnim) return;                          // 跳錢特效正在數錢，數完會自己更新
    updateGoal();
    if (b === coinShown && !flash) return;
    coinShown = b; el.textContent = money(b);
    const chip = $('#btn-wallet'); chip.classList.toggle('neg', b < 0);
    chip.title = `錢包：${money(b)}（點開可以記花費、看紀錄）`;
    if (flash) { chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump'); }
  }
  /* 名稱：XXX//OS 的 XXX 存在 state.brand。還沒取名時，待機畫面的大標題變成輸入欄 */
  const brandOf = () => String(state.brand || '').trim();
  const NAME = () => brandOf() || 'LIFE';
  const cleanBrand = (v) => String(v || '').replace(/\/\/\s*OS\s*$/i, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 10);
  function fitLogoIn() {
    const i = $('#logo-in'); if (!i) return;
    const n = Math.max(1, [...(i.value || i.placeholder)].length);
    i.style.width = `calc(${n}em + ${n * 2}px)`;
  }
  function renderBrand() {
    const b = brandOf(), full = NAME() + '//OS', logo = $('#logo');
    if (document.title !== full) document.title = full;
    $('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', full);
    $('#logo-s').textContent = full;
    const ic = encodeURIComponent(NAME()[0]);                      // 圖示照名稱第一個字畫（server.py），改名就換網址讓瀏覽器重抓
    for (const [rel, f] of [['icon', 'icon.png'], ['apple-touch-icon', 'apple-touch-icon.png']]) { const l = $(`link[rel="${rel}"]`); if (l && !l.href.endsWith(`${f}?n=${ic}`)) l.href = `${f}?n=${ic}`; }
    if (!b) {
      if ($('#logo-in')) return;
      logo.classList.remove('glitch'); delete logo.dataset.text;
      logo.innerHTML = '<input id="logo-in" class="logo-in" maxlength="10" placeholder="NAME" aria-label="名字（顯示在 //OS 前面）" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done">//OS';
      fitLogoIn();
    } else if (logo.dataset.text !== full) { logo.classList.add('glitch'); logo.dataset.text = full; logo.textContent = full; }
  }
  function setBrand(v) {
    const b = cleanBrand(v);
    if (!b) return false;
    if (b !== state.brand) { state.brand = b; save(); }
    renderBrand();
    return true;
  }
  function needBrand() {
    const i = $('#logo-in'); if (!i) return;
    sfx.deny(); i.classList.remove('need'); void i.offsetWidth; i.classList.add('need'); i.focus();
  }
  document.addEventListener('input', (e) => {
    const i = e.target; if (i.id !== 'logo-in') return;
    if (!e.isComposing) { const v = i.value.toUpperCase(); if (v !== i.value) { const p = i.selectionStart; i.value = v; i.setSelectionRange(p, p); } }
    i.classList.remove('need'); fitLogoIn();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'logo-in' || e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault(); e.stopPropagation();
    if (setBrand(e.target.value)) { sfx.check(); $('#btn-start').focus(); } else needBrand();
  }, true);
  document.addEventListener('focusout', (e) => { if (e.target.id === 'logo-in' && cleanBrand(e.target.value)) setBrand(e.target.value); });
  function openName() {
    let v = brandOf();
    const render = () => {
      box.innerHTML = `
        <div class="rt-head">NAME</div>
        <h3 class="rt-title nm-prev">${esc(cleanBrand(v) || 'NAME')}//OS</h3>
        <form class="nm-form" data-form="name"><input class="in" name="nm" maxlength="10" value="${esc(v)}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="名字（顯示在 //OS 前面）"></form>
        <div class="rt-foot"><span class="sp"></span><button class="btn btn-ghost" data-act="close">取消</button><button class="btn" data-act="save">存檔</button></div>`;
    };
    const done = () => { if (setBrand(v)) { sfx.check(); ctl.close(); } else { sfx.deny(); box.querySelector('[name="nm"]').focus(); } };
    const ctl = openModal('wl', {
      dismiss: () => true, render,
      input(e) {
        const i = e.target; if (i.name !== 'nm') return;
        if (!e.isComposing) { const u = i.value.toUpperCase(); if (u !== i.value) { const p = i.selectionStart; i.value = u; i.setSelectionRange(p, p); } }
        v = i.value; box.querySelector('.nm-prev').textContent = (cleanBrand(v) || 'NAME') + '//OS';
      },
      submit(e) { e.preventDefault(); done(); },
      click(e) { const act = e.target.closest('[data-act]')?.dataset.act; if (act === 'close') ctl.close(); else if (act === 'save') done(); }
    });
    const i = box.querySelector('[name="nm"]'); i.focus(); i.select();
  }
  function renderOff() {
    renderBrand();
    const ended = day.phase === 'ended';
    $('#off-state').textContent = ended ? 'POWER OFF' : 'STANDBY';
    $('#off-msg').textContent = ended && day.startedAt ? `今日已結束 · 運作 ${fmtDur((day.endedAt || Date.now()) - day.startedAt)} · 明天見` : '';
    $('#btn-start').innerHTML = `<span class="ico">▶</span> ${ended ? '重新開始今日' : '開始今日'}`;
  }

  /* ══════════ 流程：開始今日 / 結束今日 ══════════ */
  let busy = false;
  async function startDay() {
    if (busy) return;
    if (!brandOf()) { const i = $('#logo-in'); if (!i || !setBrand(i.value)) return needBrand(); }
    busy = true;
    await powerOn('term');
    sfx.post();
    await typeLines(bootLines());
    await openRoutine('am');
    if (day.phase !== 'on') { day.startedAt = day.phase === 'ended' && day.startedAt ? day.startedAt : Date.now(); day.endedAt = null; }
    day.phase = 'on'; save();
    enterDash(true);
    busy = false;
  }
  function enterDash(animate) {
    renderDash(); updateHud();
    show('dash');
    dash.scrollTop = 0;
    if (animate) {
      sfx.ready();
      dash.classList.remove('enter'); void dash.offsetWidth; dash.classList.add('enter');
    }
  }
  async function endDay() {
    if (busy || modalCtl) return; busy = true;
    const r = await openRoutine('pm');
    if (r === 'cancel') { busy = false; return; }
    day.phase = 'ended'; day.endedAt = Date.now(); save();
    show('term');
    sfx.down();
    await typeLines(shutdownLines());
    await powerOff();
    normalize();                                   // 過了午夜才結束：關機後換到真正的今天，等你按開始今日
    renderOff(); updateHud();
    show('off');
    screen.classList.remove('is-dark');
    $('#btn-start').focus();
    busy = false;
  }

  $('#btn-start').addEventListener('click', startDay);
  $('#btn-end').addEventListener('click', endDay);
  $('#btn-am').addEventListener('click', () => { if (!busy && !modalCtl) openRoutine('am', true); });
  $('#btn-set').addEventListener('click', (e) => { popState && popState.anchor === e.currentTarget ? closePop(true) : openSettings(e.currentTarget); });
  $('#btn-wallet').addEventListener('click', () => { if (!busy && !modalCtl) openWallet(); });
  $('#btn-goal').addEventListener('click', () => { const s = goalItem(); if (s && !busy && !modalCtl) openShopItem(s.id); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !views.off.hidden && !busy && document.activeElement !== $('#btn-start')) startDay(); });

  /* ══════════ 初始化 ══════════ */
  setSave(online ? 'ok' : 'local');
  if (online) { loadVer(); loadLan(); }
  if (seeded) save();                      // 第一次啟動：把初始資料寫成 data.json
  if (bootOff) { setNet(false); setNet(false); dirty = true; saveTimer = setTimeout(push, 5000); }   // 打開時連不到主機：一直重試，連上就送
  else if (bootPush) { save(); toast('上次沒存到主機的修改已補送'); }
  renderOff(); updateHud();
  if (day.phase === 'on') enterDash(false); else { show('off'); $('#logo-in')?.focus(); }
  /* 只有一個每秒的計時器：時鐘每秒、問主機版本號每 5 秒。分頁在背景時全部停掉 */
  let ticks = 0;
  setInterval(() => { if (document.hidden) return; updateHud(); if (++ticks % 5 === 0) checkRemote(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateHud(); checkRemote(); } });
  window.addEventListener('focus', checkRemote);
})();
