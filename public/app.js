// Cards, client grid, blockers, activity feed and live updates.
(() => {
  const $ = id => document.getElementById(id);
  const { esc } = window.Canvas;
  const LABEL = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done', idle: 'Idle', none: 'Not set up' };
  const CELL = { done: ['done', '✓'], mistake: ['mistake', '✗'], working: ['working', '…'], blocked: ['blocked', 'Blocked'], pending: ['pending', '–'], skipped: ['skipped', 'Skip'] };
  const FINISHED = new Set(['done', 'mistake', 'skipped']);
  const ACTIVE = new Set(['working', 'blocked', 'waiting']);
  const STALE_MS = 5 * 60_000; // a working agent silent this long gets flagged
  const OLD_MS = 6 * 3600_000; // a waiting or blocked status this old may no longer be true
  const SEC_LABEL = { ok: 'OK', issue: 'Issue', working: 'Checking', skip: 'Skipped' };
  let state = null, filter = 'all', selected = null, openClient = null;
  const queue = []; let playing = false;

  const pst = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function when(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
    if (Number.isNaN(s)) return '';
    if (s < 10) return 'just now'; if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return pst.format(new Date(ts)) + ' PT';
  }
  // Only touch the DOM when content changed, so animations don't replay on every update.
  function setHTML(el, html) { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; return true; } return false; }
  const agent = k => state.agents.find(a => a.key === k);
  function keyOf(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    if (n === 'josh' || n === 'you') return 'josh';
    const a = state.agents.find(x => [x.key, x.name, x.short].some(v => v && v.toLowerCase() === n));
    return a ? a.key : n;
  }
  const nameOf = k => k === 'josh' ? 'Josh' : (agent(k)?.short || agent(k)?.name || k);
  const short = c => c.short || c.name;
  function cellFor(a, c) { return a.clients[c.name] || a.clients[short(c)] || null; }
  const clientOf = name => state.clients.find(c => c.name === name || short(c) === name);
  const age = a => a.updated ? Date.now() - Date.parse(a.updated) : 0;
  const stale = a => (a.state === 'working' && age(a) > STALE_MS) || (['waiting', 'blocked'].includes(a.state) && age(a) > OLD_MS);
  // "No update 7m" for recent times, "No update since Nov 11, 6:09 AM PT" for older ones.
  const noUpdate = ts => { const w = when(ts); return w.endsWith(' ago') ? `No update ${w.replace(' ago', '')}` : `No update since ${w}`; };
  const clientLabel = name => { const c = name && clientOf(name); return c ? short(c) : name; };
  const doing = a => [a.client, a.section || a.task].filter(Boolean).join(' · ');

  // Section chips for one agent on one client: done, issue, current or not started.
  function stepper(a, c) {
    const secs = a.sections || [];
    if (!secs.length) return '';
    const got = (c && cellFor(a, c)?.sections) || {};
    const isCurrent = c && a.clientKey === c.name;
    return `<div class="steps">${secs.map(s => {
      const v = got[s], cur = isCurrent && a.section === s && ACTIVE.has(a.state);
      const cls = cur ? 'cur' : v === 'ok' ? 'ok' : v === 'issue' ? 'bad' : v === 'skip' ? 'skip' : v === 'working' ? 'seen' : '';
      const tip = cur ? 'Checking now' : SEC_LABEL[v] || 'Not started';
      const issue = cellFor(a, c || {})?.issues?.[s];
      return `<span class="step ${cls}" title="${esc(s + ': ' + tip + (issue ? ' - ' + issue : ''))}">${cur ? '<span class="pulse-dot"></span>' : ''}${esc(s)}</span>`;
    }).join('')}</div>`;
  }

  function renderNow() {
    const list = state.agents.filter(a => ACTIVE.has(a.state) && a.source === 'status');
    const html = list.map(a => {
      const c = a.clientKey && clientOf(a.clientKey);
      const pos = c ? `${state.clients.indexOf(c) + 1} of ${state.clients.length}` : '';
      const p = a.progress ? `${a.progress.done}/${a.progress.total} done` : '';
      const quiet = stale(a);
      return `<div class="now-row ${quiet ? 'stale' : ''}" data-k="${a.key}">
        <div class="now-who"><b>${esc(a.short || a.name)}</b><span class="pill ${a.state}">${a.state === 'working' ? '<span class="pulse-dot"></span>' : ''}${LABEL[a.state]}</span></div>
        <div class="now-what"><div class="now-client">${c ? esc(short(c)) : esc(a.client || 'No client yet')}${pos ? ` <span class="muted">client ${pos}</span>` : ''}${p ? ` <span class="muted">· ${p}</span>` : ''}</div>
          ${stepper(a, c)}
          <div class="muted">${esc(a.needsJosh ? 'Needs you: ' + a.needsJosh : a.detail || a.task || '')}${a.tab ? ` · tab ${esc(a.tab)}` : ''}</div></div>
        <div class="now-when">${quiet ? `<span class="pill waiting">${esc(noUpdate(a.updated))}</span>` : `<span class="muted">${esc(when(a.updated))}</span>`}
          ${a.sectionStarted && a.section ? `<span class="muted">on section ${esc(when(a.sectionStarted).replace(' ago', ''))}</span>` : ''}</div>
      </div>`;
    }).join('') || '<p class="muted">No agent is working right now.</p>';
    if (setHTML($('now'), html)) $('now').querySelectorAll('.now-row').forEach(r => r.onclick = () => select(r.dataset.k));
  }

  function renderBlockers() {
    const items = state.agents.filter(a => a.state === 'blocked' || a.needsJosh);
    setHTML($('blockers'), items.length
      ? `<div class="banner bad"><b>⚠ Waiting on you (${items.length})</b><ul>${items.map(a => `<li><b>${esc(a.short || a.name)}</b>${a.client ? ' · ' + esc(a.client) : ''}: ${esc(a.needsJosh || a.task || 'Blocked')}${stale(a) ? ` <i class="old">(${esc(noUpdate(a.updated))}: may be out of date)</i>` : ''}</li>`).join('')}</ul></div>`
      : `<div class="banner good">✓ Nothing waiting on you</div>`);
  }

  function renderFilters() {
    const opts = [['all', 'All'], ['working', 'Working'], ['waiting', 'Waiting'], ['blocked', 'Blocked'], ['done', 'Done'], ['idle', 'Idle']];
    $('filters').innerHTML = opts.map(([k, l]) => {
      const n = k === 'all' ? state.agents.length : state.agents.filter(a => a.state === k).length;
      return `<button type="button" data-f="${k}" class="${filter === k ? 'on' : ''}">${l} <span class="muted">${n}</span></button>`;
    }).join('');
    $('filters').querySelectorAll('button').forEach(b => b.onclick = () => { filter = b.dataset.f; render(); });
  }

  function renderCards() {
    const list = state.agents.filter(a => filter === 'all' || a.state === filter);
    const html = list.map(a => {
      const p = a.progress, pct = p && p.total ? Math.round(p.done / p.total * 100) : 0;
      const what = a.state === 'none' ? 'No session yet' : doing(a) || (a.state === 'done' ? 'Finished all clients' : 'No report yet');
      const src = a.source === 'nexus' ? 'from Nexus save' : a.source === 'status' ? 'live status' : '';
      return `<article class="card ${selected === a.key ? 'sel' : ''}" data-k="${a.key}">
        <div class="row"><span class="name">${esc(a.short || a.name)}</span><span class="pill ${a.state}">${a.state === 'working' ? '<span class="pulse-dot"></span>' : ''}${LABEL[a.state]}</span></div>
        <p title="${esc(what)}">${esc(what)}</p>
        ${p ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
        <div class="meta"><span>${p ? `${p.done}/${p.total} clients` : esc(src)}</span><span>${esc(when(a.updated))}</span></div>
        ${a.sessionId ? `<div class="meta"><a href="claude://claude.ai/epitaxy/${esc(a.sessionId)}" onclick="event.stopPropagation()">Open session ↗</a></div>` : ''}
      </article>`;
    }).join('') || '<p class="muted">No agents match this filter.</p>';
    if (setHTML($('cards'), html)) $('cards').querySelectorAll('.card').forEach(c => c.onclick = () => select(c.dataset.k));
  }

  function select(k) { selected = selected === k ? null : k; openClient = null; render(); }

  function renderDetail() {
    if (openClient) return renderClientDetail(openClient);
    const a = selected && agent(selected);
    if (!a) { $('detail').innerHTML = ''; return; }
    const hs = a.handoffs.map(h => `<p class="muted">• ${esc(h.topic)} <span class="src">${esc(when(h.recorded))}</span>${h.next ? `<br>&nbsp;&nbsp;Next: ${esc(h.next)}` : ''}</p>`).join('');
    $('detail').innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(a.name)} <span class="pill ${a.state}">${LABEL[a.state]}</span></h2><button type="button" id="dx">Close</button></div>
      <p class="muted">${esc(a.role || '')}</p><p class="muted">Tools: ${esc((a.tools || []).join(', '))}${a.waitingOn ? ` · Waiting on: ${esc(a.waitingOn)}` : ''}</p>
      ${a.needsJosh ? `<div class="banner bad">Needs you: ${esc(a.needsJosh)}</div>` : ''}
      <h2 style="margin-top:10px">Recent Nexus saves</h2>${hs || '<p class="muted">None in the last few days.</p>'}</div>`;
    $('dx').onclick = () => select(null);
  }

  function gridAgents() { return state.agents.filter(a => a.setup || a.key === 'a2p'); }
  function reviewCell(c) {
    const rv = agent(state.orchestrator), own = rv && cellFor(rv, c);
    const setup = state.agents.filter(a => a.setup);
    const ready = setup.length > 0 && setup.every(a => FINISHED.has(cellFor(a, c)?.status));
    if (own) return [...(own.status === 'working' ? ['working', 'Reviewing'] : CELL[own.status] || CELL.pending), ready];
    return ready ? ['working', 'Ready', true] : ['pending', 'Waiting', false];
  }

  function renderGrid() {
    const cols = gridAgents();
    let ready = 0;
    const head = `<tr><th>Client</th>${cols.map(a => `<th class="${a.key === selected ? 'hl' : ''}">${esc(a.short || a.name)}</th>`).join('')}<th>Review</th></tr>`;
    const rows = state.clients.map(c => {
      const rc = reviewCell(c); if (rc[2]) ready++;
      return `<tr class="r" data-c="${esc(c.name)}"><td>${esc(short(c))}</td>${cols.map(a => {
        const v = cellFor(a, c); const [cls, txt] = v ? CELL[v.status] : ['pending', '–'];
        // The agent's live position wins over an older result, so re-audits show where it is.
      const here = a.clientKey === c.name && a.section && ACTIVE.has(a.state) && !stale(a);
      const label = here ? `… ${esc(a.section)}` : txt;
      return `<td class="${a.key === selected ? 'hl' : ''}"><span class="pill ${here ? 'working' : cls}" title="${esc(here ? a.detail || a.section : v?.note || '')}" data-cell="${esc(a.key + '|' + c.name)}">${label}</span></td>`;
      }).join('')}<td><span class="pill ${rc[0]}">${rc[1]}</span></td></tr>`;
    }).join('');
    const prev = new Map([...document.querySelectorAll('[data-cell]')].map(e => [e.dataset.cell, e.textContent]));
    $('grid').innerHTML = head + rows;
    document.querySelectorAll('[data-cell]').forEach(e => { if (prev.size && prev.get(e.dataset.cell) !== e.textContent) e.classList.add('flash'); });
    $('ready').textContent = `${ready} ready for review`;
    $('grid').querySelectorAll('tr.r').forEach(t => t.onclick = () => { openClient = openClient === t.dataset.c ? null : t.dataset.c; selected = null; render(); });
  }

  function renderClientDetail(name) {
    const c = state.clients.find(x => x.name === name); if (!c) return;
    const cells = gridAgents().map(a => { const v = cellFor(a, c); const [cls, txt] = v ? CELL[v.status] : ['pending', 'No report'];
      return `<div>${esc(a.short || a.name)}<br><span class="pill ${cls}">${txt}</span>${v?.note ? `<small>${esc(v.note)}</small>` : ''}${stepper(a, c)}</div>`; }).join('');
    const ev = state.feed.filter(e => e.client && [c.name, short(c)].includes(e.client)).slice(0, 8)
      .map(e => `<p class="muted">• <b>${esc(nameOf(keyOf(e.from)))}</b>: ${esc(e.text)} <span class="src">${esc(when(e.ts))}</span></p>`).join('');
    $('detail').innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(c.name)} <span class="muted">Excel row ${c.row ?? '?'}</span></h2><button type="button" id="dx">Close</button></div>
      <div class="detail-grid">${cells}</div>${ev || '<p class="muted">No activity logged for this client yet.</p>'}</div>`;
    $('dx').onclick = () => { openClient = null; render(); };
  }

  function renderFeed() {
    setHTML($('feed'), state.feed.slice(0, 40).map(e => {
      const f = nameOf(keyOf(e.from)), t = e.to ? nameOf(keyOf(e.to)) : null;
      return `<p class="${e.kind === 'step' ? 'step-line' : ''}"><b>${esc(f)}</b>${t ? ` → <b>${esc(t)}</b>` : ''}${e.client ? ` · ${esc(clientLabel(e.client))}` : ''}: ${esc(e.text)} <span class="src">${esc(when(e.ts))}${e.source === 'nexus' ? ' · Nexus' : ''}</span></p>`;
    }).join('') || '<p>No activity yet.</p>');
  }

  function renderReplayOptions() {
    const sel = $('replaySel'); if (sel.options.length > 1) return;
    for (const c of state.clients) sel.add(new Option(short(c), c.name));
  }

  function render() {
    if (!state) return;
    window.Canvas.render(state, selected, select);
    renderNow(); renderBlockers(); renderFilters(); renderCards(); renderDetail(); renderGrid(); renderFeed(); renderReplayOptions();
    $('updated').textContent = 'Updated ' + pst.format(new Date(state.generated)) + ' PT';
    $('foot').textContent = `Read-only. Status folder: ${state.statusDir} · Nexus: ${state.nexusDir}`;
  }

  async function drain() {
    if (playing) return; playing = true;
    while (queue.length) { const e = queue.shift(); await window.Canvas.packet(keyOf(e.from), keyOf(e.to) || keyOf(e.from), e.kind, state.orchestrator); }
    playing = false;
  }

  // Replays the client's full logged history (messages and results; quiet section steps are skipped).
  $('replayBtn').onclick = async () => {
    const name = $('replaySel').value; if (!name || !state) return;
    const btn = $('replayBtn');
    const flash = t => { btn.textContent = t; setTimeout(() => btn.textContent = 'Play', 1500); };
    let evs = [];
    try { evs = (await (await fetch('/api/events?client=' + encodeURIComponent(name))).json()).filter(e => e.kind !== 'step'); }
    catch { return flash('Failed'); }
    if (!evs.length) return flash('No events');
    flash(`${evs.length} events`);
    queue.push(...evs); drain();
  };

  function connect() {
    const live = $('live');
    const es = new EventSource('/api/stream');
    es.addEventListener('state', m => { state = JSON.parse(m.data); render(); });
    es.addEventListener('events', m => { for (const e of JSON.parse(m.data)) queue.push(e); drain(); });
    es.onopen = () => { live.className = 'pill working'; live.innerHTML = '<span class="pulse-dot"></span>Live'; };
    es.onerror = () => { live.className = 'pill blocked'; live.textContent = 'Reconnecting…'; };
  }
  setInterval(() => state && renderNow(), 5_000); // live timers and the stale flag
  setInterval(() => state && (renderCards(), renderFeed()), 30_000); // keep "x ago" fresh
  connect();
})();
