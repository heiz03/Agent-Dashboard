// Agent command center: tiles, alerts, stats, live log, details drawer, clients and live updates.
(() => {
  const $ = id => document.getElementById(id);
  const { esc, COLOR, LABEL } = window.AgentMap;
  const CELL = { done: ['done', '✓'], mistake: ['mistake', '✗'], working: ['working', '…'], blocked: ['blocked', 'Blocked'], pending: ['pending', '–'], skipped: ['skipped', 'Skip'] };
  const FINISHED = new Set(['done', 'mistake', 'skipped']);
  const LIVE_MS = 3 * 3600e3;
  let state = null, filter = 'all', paused = false, frozenLog = null, selected = null, lastSeen = 0, receivedAt = 0;
  const queue = []; let playing = false;

  const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)} days`;
  }
  const tokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
  // Needs-you, stalled and working tiles come first; the rest keep their configured order.
  const RANK = { needs: 0, stalled: 1, working: 2 };
  const tiles = () => state ? [...state.agents, ...state.sessions]
    .map((t, i) => [t, i]).sort((a, b) => ((RANK[a[0].live.state] ?? 3) - (RANK[b[0].live.state] ?? 3)) || a[1] - b[1]).map(x => x[0]) : [];
  const tileOf = k => tiles().find(t => t.key === k);
  const nameOf = k => k === 'josh' ? 'Josh' : (tileOf(k)?.short || tileOf(k)?.name || k);
  const sessionLink = t => t.sessionId ? `claude://claude.ai/epitaxy/${encodeURIComponent(t.sessionId)}` : null;
  // Only touch the DOM when content changed, so images and animations don't restart.
  function setHTML(el, html) { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; return true; } return false; }

  function elapsedText(st, since) {
    if (!since) return '';
    const d = Date.now() - since;
    if (st === 'working') return `on this step ${dur(d)}`;
    if (st === 'needs') return `waiting ${dur(d)}`;
    if (st === 'stalled') return `quiet for ${dur(d)}`;
    if (st === 'none') return '';
    return d < 48 * 3600e3 ? `idle ${dur(d)}` : `last active ${fmtDay.format(new Date(since))}`;
  }
  const sparkPoints = arr => { const max = Math.max(4, ...arr); return arr.map((v, i) => `${(i * 120 / (arr.length - 1)).toFixed(1)},${(25 - v / max * 22).toFixed(1)}`).join(' '); };

  function tileHTML(t) {
    const L = t.live, st = L.state;
    const shot = L.shotTs
      ? `<span class="shot"><span class="shot-bar"><i></i><i></i><em>${esc(L.url || 'Browser')}</em></span><img src="/api/shot/${encodeURIComponent(t.key)}?t=${L.shotTs}" alt="Latest screenshot from ${esc(t.name)}" loading="lazy"><span class="shot-age" data-shot="${L.shotTs}"></span></span>`
      : `<span class="shot empty"><span class="shot-bar"><i></i><i></i><em>${esc(L.url || 'No page yet')}</em></span><span class="shot-none">No screenshot yet</span></span>`;
    return `<button type="button" class="tile st-${st}${selected === t.key ? ' sel' : ''}" data-k="${esc(t.key)}" aria-label="${esc(`${t.name}: ${LABEL[st]}. ${L.now}`)}">
      <span class="t-head"><span class="t-name"><i class="dot${st === 'working' || st === 'needs' ? ' blink' : ''}"></i><span>${esc(t.short || t.name)}</span></span><span class="pill ${st}">${LABEL[st]}</span></span>
      <span class="t-now">${esc(L.now)}</span>
      <span class="t-meta"><span>${esc(L.where || (t.kind === 'session' ? 'Session' : ''))}</span><span class="t-elapsed" data-since="${L.since || ''}" data-st="${st}"></span></span>
      ${shot}
      <span class="t-foot"><svg width="120" height="26" viewBox="0 0 120 26" aria-hidden="true"><polyline points="${sparkPoints(L.spark)}" stroke="${COLOR[st]}"></polyline></svg>
        <span>${L.tokensToday ? `${tokens(L.tokensToday)} tokens today` : t.kind === 'agent' ? 'Agent' : 'Session'}<br>${esc(L.progress || '')}</span></span>
    </button>`;
  }

  function renderTiles() {
    const box = $('tiles'), list = tiles();
    // Rebuild the grid only when the set of tiles changes; otherwise patch each tile.
    const keys = list.map(t => t.key).join('|');
    if (box.dataset.keys !== keys) { box.innerHTML = list.map(t => `<div class="tile-slot" data-slot="${esc(t.key)}"></div>`).join(''); box.dataset.keys = keys; }
    for (const t of list) {
      const slot = box.querySelector(`[data-slot="${CSS.escape(t.key)}"]`);
      if (setHTML(slot, tileHTML(t))) slot.firstElementChild.onclick = () => open(t.key);
    }
    $('wallNote').textContent = `${state.agents.length} agents · ${state.sessions.length} other sessions active in the last 3 hours · click a tile for details`;
    tickTimes();
  }

  function renderStats() {
    const all = tiles(), now = Date.now();
    const count = s => all.filter(t => t.live.state === s).length;
    const perMin = state.log.filter(e => e.kind === 'step' && now - e.ts < 60e3).length;
    const tok = all.reduce((n, t) => n + (t.live.tokensToday || 0), 0);
    const live = all.filter(t => t.live.lastTs && now - t.live.lastTs < LIVE_MS).length;
    const stats = [['Working', count('working'), 'working'], ['Needs you', count('needs'), 'needs'], ['Stalled', count('stalled'), 'stalled'],
      ['Steps / min', perMin, ''], ['Tokens today', tokens(tok), ''], ['Live sessions', live, '']];
    setHTML($('stats'), stats.map(([l, v, c]) => `<div class="stat ${c}"><span>${l}</span><b>${v}</b></div>`).join(''));
  }

  function renderAlerts() {
    const all = tiles();
    const items = all.filter(t => t.live.state === 'needs' || t.live.state === 'stalled')
      .sort((a, b) => (a.live.state === 'needs' ? 0 : 1) - (b.live.state === 'needs' ? 0 : 1));
    const html = items.length ? items.map(t => {
      const L = t.live, link = sessionLink(t), needs = L.state === 'needs';
      return `<div class="alert ${needs ? 'needs' : 'stalled'}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${needs ? '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'}</svg>
        <div class="alert-text"><b>${esc(t.short || t.name)} ${needs ? 'needs you' : 'looks stalled'}</b>${L.where ? ` · ${esc(L.where)}` : ''} · ${esc(needs ? `"${L.now}"` : `last step: ${L.now}`)} <span class="alert-age" data-since="${L.since || ''}" data-st="${L.state}"></span></div>
        ${link ? `<a class="alert-btn" href="${link}">Open session</a>` : `<button type="button" class="alert-btn" data-open="${esc(t.key)}">Details</button>`}
      </div>`;
    }).join('') : '<div class="alert clear">✓ Nothing needs you right now</div>';
    if (setHTML($('alerts'), html)) $('alerts').querySelectorAll('[data-open]').forEach(b => b.onclick = () => open(b.dataset.open));
    tickTimes();
  }

  function renderLog() {
    const src = paused ? frozenLog : state.log;
    const active = [...new Set(state.log.map(e => e.key))].slice(0, 8);
    if (filter !== 'all' && !active.includes(filter)) active.push(filter);
    setHTML($('chips'), ['all', ...active].map(k => `<button type="button" class="chip${filter === k ? ' on' : ''}" data-f="${esc(k)}">${esc(k === 'all' ? 'All' : nameOf(k))}</button>`).join(''));
    $('chips').querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; renderLog(); });
    const rows = src.filter(e => filter === 'all' || e.key === filter).slice(0, 80);
    const fresh = paused ? state.log.filter(e => e.ts > (frozenLog[0]?.ts || 0)).length : 0;
    $('pauseBtn').textContent = paused ? `Resume${fresh ? ` (${fresh} new)` : ''}` : 'Pause';
    setHTML($('log'), rows.map(e => {
      const t = tileOf(e.key), st = t ? t.live.state : 'idle';
      return `<div class="log-row k-${e.kind}"><time>${fmtTime.format(new Date(e.ts))}</time><span><b style="color:${COLOR[st] === COLOR.idle ? 'var(--text)' : `var(--${st}-tx)`}">${esc(nameOf(e.key))}</b> ${esc(e.text)}</span></div>`;
    }).join('') || '<p class="muted">No steps logged yet.</p>');
  }

  function open(k) { selected = k; renderDrawer(); renderTiles(); }
  function closeDrawer() { selected = null; renderDrawer(); renderTiles(); }

  function renderDrawer() {
    const d = $('drawer'), t = selected && tileOf(selected);
    d.hidden = !t; $('backdrop').hidden = !t;
    if (!t) { d.dataset.html = ''; return; }
    const L = t.live, link = sessionLink(t);
    const check = L.checklist.length ? `<h3>Checklist for this client</h3><div class="steps">${L.checklist.map(c => `<span class="step ${c.value === 'ok' ? 'ok' : c.value === 'issue' ? 'bad' : c.value === 'cur' ? 'cur' : c.value === 'skip' ? 'skip' : ''}">${esc(c.label)}</span>`).join('')}</div>` : '';
    const steps = L.steps.map(e => `<div class="log-row k-${e.kind}"><time>${fmtTime.format(new Date(e.ts))}</time><span>${esc(e.text)}</span></div>`).join('') || '<p class="muted">No steps logged in this session yet.</p>';
    setHTML(d, `<div class="d-head"><h2><i class="dot" style="background:${COLOR[L.state]}"></i>${esc(t.name)}</h2><button type="button" class="icon-btn" id="dClose" aria-label="Close details">×</button></div>
      <div class="d-now"><span class="muted">Right now · ${LABEL[L.state]}</span><p>${esc(L.now)}</p><span class="muted">${esc(L.where || '')} <span data-since="${L.since || ''}" data-st="${L.state}"></span></span></div>
      ${L.shotTs ? `<figure class="d-shot"><img src="/api/shot/${encodeURIComponent(t.key)}?t=${L.shotTs}" alt="Latest screenshot from ${esc(t.name)}"><figcaption class="muted">${esc(L.url || '')} · <span data-shot="${L.shotTs}"></span></figcaption></figure>` : ''}
      ${check}<h3>Recent steps</h3><div class="d-steps">${steps}</div>
      <div class="d-foot">${link ? `<a class="btn-primary" href="${link}">Open session</a>` : ''}<span class="muted">${esc(L.cwd || '')}${L.logId ? ` · log ${esc(L.logId.slice(0, 8))}` : ''}</span></div>`);
    $('dClose').onclick = closeDrawer;
    tickTimes();
  }

  function reviewCell(c) {
    const cellFor = (a, cl) => a.clients[cl.name] || a.clients[cl.short || cl.name] || null;
    const rv = state.agents.find(a => a.key === state.orchestrator), own = rv && cellFor(rv, c);
    const setup = state.agents.filter(a => a.setup);
    const ready = setup.length > 0 && setup.every(a => FINISHED.has(cellFor(a, c)?.status));
    if (own) return [...(own.status === 'working' ? ['working', 'Reviewing'] : CELL[own.status] || CELL.pending), ready];
    return ready ? ['working', 'Ready', true] : ['pending', 'Waiting', false];
  }
  function renderGrid() {
    const cols = state.agents.filter(a => a.setup || a.key === 'a2p');
    const cellFor = (a, c) => a.clients[c.name] || a.clients[c.short || c.name] || null;
    let ready = 0;
    const head = `<tr><th>Client</th>${cols.map(a => `<th>${esc(a.short || a.name)}</th>`).join('')}<th>Review</th></tr>`;
    const rows = state.clients.map(c => {
      const rc = reviewCell(c); if (rc[2]) ready++;
      return `<tr><td>${esc(c.short || c.name)}</td>${cols.map(a => { const v = cellFor(a, c); const [cls, txt] = v ? CELL[v.status] : ['pending', '–']; return `<td><span class="pill ${cls}" title="${esc(v?.note || '')}">${txt}</span></td>`; }).join('')}<td><span class="pill ${rc[0]}">${rc[1]}</span></td></tr>`;
    }).join('');
    setHTML($('grid'), head + rows);
    $('ready').textContent = `From agent reports · ${ready} ready for review`;
  }

  function renderReplayOptions() {
    const sel = $('replaySel'); if (sel.options.length > 1) return;
    for (const c of state.clients) sel.add(new Option(c.short || c.name, c.name));
  }

  // Live timers, clocks and "x ago" labels, every second.
  function tickTimes() {
    document.querySelectorAll('[data-since]').forEach(el => { el.textContent = elapsedText(el.dataset.st, Number(el.dataset.since) || 0); });
    document.querySelectorAll('[data-shot]').forEach(el => { el.textContent = `Latest screenshot · ${dur(Date.now() - Number(el.dataset.shot))} ago`; });
  }
  function tickClocks() {
    const f = tz => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date());
    $('clockPT').textContent = f('America/Los_Angeles'); $('clockPH').textContent = f('Asia/Manila');
    if (receivedAt) $('liveText').textContent = `Live from session logs · updated ${dur(Date.now() - receivedAt)} ago`;
  }

  function render() {
    if (!state) return;
    renderStats(); renderAlerts(); renderTiles(); renderLog(); renderGrid(); renderReplayOptions();
    window.AgentMap.render(state);
    window.AgentMap.timeline(tiles(), Date.now());
    if (selected) renderDrawer();
    // Flash map nodes for steps that arrived since the last update.
    for (const e of state.log) if (e.ts > lastSeen && lastSeen) window.AgentMap.pulse(e.key);
    lastSeen = Math.max(lastSeen, state.log[0]?.ts || 0);
    $('foot').textContent = `Read-only. Session logs, status folder ${state.statusDir} and Nexus ${state.nexusDir}.`;
  }

  async function drain() {
    if (playing) return; playing = true;
    while (queue.length) { const e = queue.shift(); await window.AgentMap.packet(e.from, e.to || e.from, e.kind, state.orchestrator); }
    playing = false;
  }

  $('pauseBtn').onclick = () => { paused = !paused; frozenLog = paused ? state.log.slice() : null; renderLog(); };
  $('backdrop').onclick = closeDrawer;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && selected) closeDrawer(); });
  $('replayBtn').onclick = async () => {
    const name = $('replaySel').value, btn = $('replayBtn'); if (!name) return;
    const flash = t => { btn.textContent = t; setTimeout(() => btn.textContent = 'Play', 1500); };
    let evs = [];
    try { evs = (await (await fetch('/api/events?client=' + encodeURIComponent(name))).json()).filter(e => e.kind !== 'step'); } catch { return flash('Failed'); }
    if (!evs.length) return flash('No events');
    flash(`${evs.length} events`); queue.push(...evs); drain();
  };

  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('state', m => { state = JSON.parse(m.data); receivedAt = Date.now(); render(); });
    es.addEventListener('events', m => { for (const e of JSON.parse(m.data)) queue.push(e); drain(); });
    es.onopen = () => { $('liveDot').className = 'live-dot on'; };
    es.onerror = () => { $('liveDot').className = 'live-dot off'; $('liveText').textContent = 'Reconnecting…'; };
  }
  setInterval(() => { tickClocks(); tickTimes(); }, 1000);
  tickClocks();
  connect();
})();
