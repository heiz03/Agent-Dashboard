// "Who's talking to whom" map (Josh on top) and the 4-hour timeline lanes.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('map');
  const COLOR = { working: '#378ADD', needs: '#E24B4A', stalled: '#E07B39', waiting: '#BA7517', done: '#639922', idle: '#6B6A65', none: '#3A3936' };
  const LABEL = { working: 'Working', needs: 'Needs you', stalled: 'Stalled', waiting: 'Waiting', done: 'Done', idle: 'Idle', none: 'Not set up' };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  let layout = null, last = null;
  const paths = {}, nodes = {};

  function buildLayout(state, W) {
    const orch = state.orchestrator;
    const others = state.agents.filter(a => a.key !== orch);
    const cols = W >= 640 ? others.length : Math.ceil(others.length / 2);
    const gap = 8, pad = 8, nw = (W - 2 * pad - (cols - 1) * gap) / cols, nh = 34;
    const L = { W, nh, josh: { x: W / 2 - 60, y: 8, w: 120 }, [orch]: { x: W / 2 - 66, y: 74, w: 132 }, report: { x: Math.min(W - pad - 96, W / 2 + 96), y: 74, w: 96 } };
    others.forEach((a, i) => { const r = Math.floor(i / cols), c = i % cols; L[a.key] = { x: pad + c * (nw + gap), y: 150 + r * 58, w: nw, agent: true }; });
    L.H = 150 + Math.ceil(others.length / cols) * 58;
    return L;
  }

  function render(state) {
    last = state;
    const W = Math.max(300, svg.parentElement.clientWidth);
    if (!layout || layout.W !== W || layout.n !== state.agents.length) { layout = buildLayout(state, W); layout.n = state.agents.length; }
    const L = layout, orch = state.orchestrator, rv = L[orch], cx = b => b.x + b.w / 2;
    svg.setAttribute('viewBox', `0 0 ${W} ${L.H}`); svg.setAttribute('height', L.H);
    svg.replaceChildren();
    const gW = el('g', {}, svg), gP = el('g', { id: 'mapPackets' }, svg), gN = el('g', {}, svg);
    for (const k of Object.keys(paths)) delete paths[k];
    const wire = (id, d, cls) => { paths[id] = el('path', { d, class: `wire ${cls || ''}` }, gW); };
    wire('josh-review', `M${cx(L.josh)} ${L.josh.y + L.nh} L${cx(rv)} ${rv.y}`);
    wire('review-report', `M${rv.x + rv.w} ${rv.y + L.nh / 2} L${L.report.x} ${rv.y + L.nh / 2}`);
    for (const a of state.agents) {
      const b = L[a.key]; if (!b || !b.agent) continue;
      const st = a.live.state, mid = (rv.y + L.nh + b.y) / 2;
      wire(`review-${a.key}`, `M${cx(rv)} ${rv.y + L.nh} C${cx(rv)} ${mid} ${cx(b)} ${mid} ${cx(b)} ${b.y}`, st === 'working' ? 'flow' : st === 'none' ? 'faint' : '');
      wire(`${a.key}-josh`, `M${cx(b)} ${b.y} C${cx(b)} ${b.y - 60} ${L.josh.x + 10} ${L.josh.y + 70} ${L.josh.x + 14} ${L.josh.y + L.nh}`, st === 'needs' ? 'alert' : 'hidden');
    }
    const needs = state.agents.some(a => a.live.state === 'needs');
    const node = (key, b, st, name, rounded) => {
      const g = el('g', { class: `mnode ${st}` }, gN);
      el('rect', { x: b.x, y: b.y, width: b.w, height: L.nh, rx: rounded ? 17 : 8, fill: st === 'idle' || st === 'none' ? 'var(--surface)' : `var(--${st}-bg)`, stroke: COLOR[st], 'stroke-dasharray': st === 'none' ? '4 4' : '' }, g);
      el('circle', { cx: b.x + 12, cy: b.y + L.nh / 2, r: 4, fill: COLOR[st], class: st === 'working' || st === 'needs' ? 'blink' : '' }, g);
      const t = el('text', { x: b.x + 22, y: b.y + L.nh / 2 + 4 }, g);
      t.textContent = name.length * 7 > b.w - 26 ? name.slice(0, Math.max(3, Math.floor((b.w - 30) / 7))) + '…' : name;
      const tip = el('title', {}, g); tip.textContent = `${name}: ${LABEL[st] || st}`;
      nodes[key] = g;
    };
    node('josh', L.josh, needs ? 'needs' : 'idle', 'Josh', true);
    node('report', L.report, 'idle', 'Report');
    for (const a of state.agents) if (L[a.key]) node(a.key, L[a.key], a.live.state, a.key === orch ? a.name : a.short || a.name);
  }

  // Moves a dot along the wires from one node to another.
  function route(from, to, orch) {
    if (from === 'josh' && to === orch) return [['josh-review', 1]];
    if (from === orch && to === 'josh') return [['josh-review', -1]];
    if (from === orch && to === 'report') return [['review-report', 1]];
    if (from === orch && paths[`review-${to}`]) return [[`review-${to}`, 1]];
    if (to === orch && paths[`review-${from}`]) return [[`review-${from}`, -1]];
    if (to === 'josh' && paths[`${from}-josh`]) return [[`${from}-josh`, 1]];
    if (paths[`review-${from}`] && paths[`review-${to}`]) return [[`review-${from}`, -1], [`review-${to}`, 1]];
    return [];
  }
  function travel(id, dir, color) {
    return new Promise(resolve => {
      const p = paths[id]; if (!p || !p.isConnected) return resolve();
      const len = p.getTotalLength(), dot = el('circle', { r: 5, fill: color, class: 'packet' }, document.getElementById('mapPackets'));
      const t0 = performance.now();
      (function frame(t) {
        const k = Math.min(1, (t - t0) / 800), pt = p.getPointAtLength(len * (dir > 0 ? k : 1 - k));
        dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
        if (k < 1) requestAnimationFrame(frame); else { dot.remove(); resolve(); }
      })(t0);
    });
  }
  async function packet(from, to, kind, orch) {
    const color = kind === 'blocked' ? '#E24B4A' : kind === 'done' ? '#639922' : '#378ADD';
    for (const [id, dir] of route(from, to, orch)) await travel(id, dir, color);
  }
  // A quick flash on a node when its agent takes a step.
  function pulse(key) {
    const g = nodes[key]; if (!g) return;
    g.classList.remove('pulse'); void g.getBBox(); g.classList.add('pulse');
  }

  // Timeline: one lane per tile, busy stretches over the last 4 hours.
  function timeline(tiles, now) {
    const lanes = tiles.filter(t => t.live.segs.length || t.kind === 'agent');
    const ticks = [4, 3, 2, 1, 0].map(h => h ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).format(new Date(now - h * 3600e3)) : 'Now');
    document.getElementById('timeline').innerHTML = lanes.map(t => `<div class="lane"><span class="lane-name" title="${esc(t.name)}">${esc(t.short || t.name)}</span><span class="lane-bar">${
      t.live.segs.map(s => `<i style="left:${s.left}%;width:${s.width}%;background:${COLOR[s.state]}" title="${LABEL[s.state]}"></i>`).join('')}<b class="now-line"></b></span></div>`).join('')
      + `<div class="lane ticks"><span></span><span class="tick-row">${ticks.map(x => `<span>${x}</span>`).join('')}</span></div>`;
    document.getElementById('tlLegend').innerHTML = ['working', 'needs', 'stalled'].map(k => `<span><i style="background:${COLOR[k]}"></i>${LABEL[k]}</span>`).join('');
  }

  let rz = null;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => last && render(last), 100); }).observe(svg.parentElement);
  window.AgentMap = { render, packet, pulse, timeline, esc, COLOR, LABEL };
})();
