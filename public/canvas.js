// Workflow canvas: Josh -> Agent Review -> agents -> tools, with animated packets.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('canvas');
  const gEdges = document.getElementById('edges');
  const gPackets = document.getElementById('packets');
  const gNodes = document.getElementById('nodes');
  const COLORS = { working: '#378ADD', waiting: '#BA7517', blocked: '#E24B4A', done: '#639922', idle: 'var(--border-strong)', none: 'var(--border-strong)' };
  const FILL = { working: 'var(--blue-bg)', waiting: 'var(--amber-bg)', blocked: 'var(--red-bg)', done: 'var(--green-bg)', idle: 'var(--surface)', none: 'var(--surface)' };
  const LABEL = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done', idle: 'Idle', none: 'Not set up' };

  let layout = null; // node boxes keyed by agent key, plus josh/report
  const paths = {};  // edge id -> SVGPathElement

  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const cx = b => b.x + b.w / 2;

  function buildLayout(state) {
    const others = state.agents.filter(a => a.key !== state.orchestrator);
    const step = 1172 / others.length;
    layout = {
      josh: { x: 24, y: 28, w: 150, h: 56, title: 'Josh', sub: 'You' },
      [state.orchestrator]: { x: 505, y: 22, w: 190, h: 68 },
      report: { x: 1026, y: 28, w: 150, h: 56, title: 'Report', sub: 'Excel + you' },
    };
    others.forEach((a, i) => { layout[a.key] = { x: 14 + i * step, y: 196, w: step - 12, h: 62, agent: true }; });

    gEdges.replaceChildren(); gNodes.replaceChildren();
    const rv = layout[state.orchestrator];
    edge('josh-review', `M174 56 L505 56`);
    edge('review-report', `M695 56 L1026 56`);
    for (const a of others) {
      const b = layout[a.key], x = cx(b);
      edge(`review-${a.key}`, `M${cx(rv)} 90 C${cx(rv)} 150 ${x} 140 ${x} 196`, a.state === 'none' ? 'tool' : '');
      edge(`${a.key}-josh`, `M${b.x + 16} 196 C${b.x + 16} 140 ${layout.josh.x + 40} 130 ${layout.josh.x + 40} 84`, 'alert-path');
      (a.tools || []).slice(0, 3).forEach((t, j, arr) => {
        const tx = x + (j - (arr.length - 1) / 2) * 42, ty = 326;
        edge(`${a.key}-tool${j}`, `M${x} 258 C${x} 290 ${tx} 290 ${tx} ${ty - 15}`, 'tool');
        const g = el('g', { class: 'tool', id: `tool-${a.key}-${j}` }, gNodes);
        el('circle', { cx: tx, cy: ty, r: 15 }, g);
        const t1 = el('text', { x: tx, y: ty + 4, 'text-anchor': 'middle' }, g); t1.textContent = t[0];
        const t2 = el('text', { x: tx, y: ty + 31, 'text-anchor': 'middle' }, g); t2.textContent = t;
      });
    }
  }

  function edge(id, d, cls = '') {
    paths[id] = el('path', { d, class: `edge ${cls}`, id: `edge-${id}` }, gEdges);
    if (cls === 'alert-path') paths[id].style.stroke = 'transparent';
  }

  function nodeBox(key, b, st, title, sub, selected, onClick) {
    const g = el('g', { class: `node${selected ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${title}: ${LABEL[st] || st}` }, gNodes);
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, fill: FILL[st] || 'var(--surface)', stroke: COLORS[st] || 'var(--border-strong)',
      'stroke-width': st === 'idle' || st === 'none' ? 1.2 : 2, 'stroke-dasharray': st === 'none' ? '5 4' : '' }, g);
    const t = el('text', { x: b.x + 12, y: b.y + 24, class: 'title' }, g); t.textContent = clip(title, Math.floor(b.w / 8.5));
    const s = el('text', { x: b.x + 12, y: b.y + 44, class: 'sub' }, g); s.textContent = clip(sub, Math.floor(b.w / 6.2));
    const ix = b.x + b.w - 14, iy = b.y + 14;
    if (st === 'working') el('circle', { cx: ix, cy: iy, r: 6, fill: 'none', stroke: COLORS.working, 'stroke-width': 2.2, 'stroke-dasharray': '24 14', class: 'spin' }, g);
    else if (st === 'done' || st === 'blocked' || st === 'waiting') {
      const m = el('text', { x: ix, y: iy + 5, 'text-anchor': 'middle', style: `font-size:14px;font-weight:700;fill:${COLORS[st]}` }, g);
      m.textContent = st === 'done' ? '✓' : st === 'blocked' ? '!' : '…';
    }
    if (onClick) { g.addEventListener('click', () => onClick(key)); g.addEventListener('keydown', e => { if (e.key === 'Enter') onClick(key); }); }
  }

  function render(state, selected, onClick) {
    const sig = state.agents.map(a => a.key + a.state + (a.tools || []).join()).join('|');
    if (!layout || render.sig !== sig) { buildLayout(state); render.sig = sig; }
    for (const g of [...gNodes.querySelectorAll('.node')]) g.remove();
    nodeBox('josh', layout.josh, state.agents.some(a => a.state === 'blocked') ? 'blocked' : 'idle', 'Josh', state.agents.some(a => a.needsJosh) ? 'Needed by an agent' : 'You', false);
    nodeBox('report', layout.report, 'idle', 'Report', 'Excel + you', false);
    for (const a of state.agents) {
      const step = a.section || a.task;
      const sub = a.state === 'none' ? 'Not set up' : (a.client ? `${a.client}${step ? ' · ' + step : ''}` : a.task || LABEL[a.state]);
      nodeBox(a.key, layout[a.key], a.state, a.key === state.orchestrator ? a.name : a.short || a.name, sub, selected === a.key, onClick);
      const alert = paths[`${a.key}-josh`];
      if (alert) { alert.classList.toggle('alert', a.state === 'blocked'); alert.style.stroke = a.state === 'blocked' ? '' : 'transparent'; }
    }
  }

  // Route a packet between two nodes through the edges that exist.
  function route(from, to, orch) {
    if (from === 'josh' && to === orch) return [['josh-review', 1]];
    if (from === orch && to === 'josh') return [['josh-review', -1]];
    if (from === orch && to === 'report') return [['review-report', 1]];
    if (from === orch && paths[`review-${to}`]) return [[`review-${to}`, 1]];
    if (to === orch && paths[`review-${from}`]) return [[`review-${from}`, -1]];
    if (to === 'josh' && paths[`${from}-josh`]) return [[`${from}-josh`, 1]];
    if (paths[`review-${from}`] && paths[`review-${to}`]) return [[`review-${from}`, -1], [`review-${to}`, 1]];
    if (from === 'josh' && paths[`review-${to}`]) return [['josh-review', 1], [`review-${to}`, 1]];
    return [];
  }

  function travel(id, dir, color, ms) {
    return new Promise(resolve => {
      const p = paths[id]; if (!p) return resolve();
      const len = p.getTotalLength();
      const dot = el('circle', { r: 6, fill: color }, gPackets);
      p.classList.add('hot'); p.style.stroke = color;
      const t0 = performance.now();
      (function frame(t) {
        const k = Math.min(1, (t - t0) / ms);
        const pt = p.getPointAtLength(len * (dir > 0 ? k : 1 - k));
        dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
        if (k < 1) requestAnimationFrame(frame);
        else { dot.remove(); setTimeout(() => { p.classList.remove('hot'); if (!p.classList.contains('alert')) p.style.stroke = p.classList.contains('alert-path') ? 'transparent' : ''; }, 600); resolve(); }
      })(t0);
    });
  }

  async function packet(from, to, kind, orch) {
    const color = kind === 'blocked' ? '#E24B4A' : kind === 'done' ? '#639922' : '#378ADD';
    for (const [id, dir] of route(from, to, orch)) await travel(id, dir, color, 850);
    // Light the receiving agent's tools briefly when work arrives.
    for (let j = 0; j < 3; j++) {
      const t = document.getElementById(`tool-${to}-${j}`);
      if (t) { t.classList.add('lit'); setTimeout(() => t.classList.remove('lit'), 1800); }
    }
  }

  window.Canvas = { render, packet, esc };
})();
