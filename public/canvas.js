// Workflow canvas: Josh (top) -> Agent Review -> agents -> tools, with animated packets.
// Nodes are HTML cards raised off a tilted board (CSS 3D); wires and packets live on the
// board as SVG. The layout is recomputed from the container width, so it fits any screen.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const wrap = document.getElementById('stageWrap');
  const stage = document.getElementById('stage');
  const svg = document.getElementById('wires');
  const gEdges = document.getElementById('edges');
  const gPackets = document.getElementById('packets');
  const nodesEl = document.getElementById('nodes');
  const toggle = document.getElementById('view3d');
  const LABEL = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done', idle: 'Idle', none: 'Not set up' };
  const MARK = { done: '✓', blocked: '!', waiting: '…' };
  const PAD = 16, GAP = 12, NODE_H = 60, TOOLS_H = 74, ROW_GAP = 22;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let layout = null, layoutSig = '', last = null; // last = [state, selected, onClick]
  const paths = {}; // edge id -> SVGPathElement

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  const cx = b => b.x + b.w / 2;

  // Agents per row by width: 8 on desktop, 4 on tablets, 2 on phones.
  function columns(W, n) { return Math.max(1, Math.min(n, W >= 1000 ? 8 : W >= 560 ? 4 : 2)); }

  function buildLayout(state, W) {
    const orch = state.orchestrator;
    const others = state.agents.filter(a => a.key !== orch);
    const cols = columns(W, others.length);
    const nodeW = (W - 2 * PAD - (cols - 1) * GAP) / cols;
    const L = {};
    // Row 1: Josh, centered at the top.
    const topW = Math.min(220, W - 2 * PAD);
    L.josh = { x: (W - topW) / 2, y: 18, w: topW, h: NODE_H };
    // Row 2: Agent Review centered, Report at the right edge (side by side when narrow).
    const y2 = L.josh.y + NODE_H + 40;
    if (W >= 700) {
      L[orch] = { x: (W - topW) / 2, y: y2, w: topW, h: NODE_H };
      L.report = { x: W - PAD - 180, y: y2, w: 180, h: NODE_H };
    } else {
      const half = (W - 2 * PAD - GAP) / 2;
      L[orch] = { x: PAD, y: y2, w: half, h: NODE_H };
      L.report = { x: PAD + half + GAP, y: y2, w: half, h: NODE_H };
    }
    // Agent rows, each with its tools underneath.
    const y3 = y2 + NODE_H + 64;
    others.forEach((a, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      L[a.key] = { x: PAD + c * (nodeW + GAP), y: y3 + r * (NODE_H + TOOLS_H + ROW_GAP), w: nodeW, h: NODE_H, agent: true };
    });
    const rows = Math.ceil(others.length / cols);
    L.height = y3 + rows * (NODE_H + TOOLS_H + ROW_GAP) - ROW_GAP + 8;
    L.width = W;
    L.tilt = W >= 1000 ? 18 : W >= 560 ? 12 : 8; // taller boards get less tilt, so the top doesn't sink away
    return L;
  }

  function edge(id, d, cls = '') {
    paths[id] = el('path', { d, class: `edge ${cls}`, id: `edge-${id}` }, gEdges);
  }

  function drawEdges(state) {
    const orch = state.orchestrator, L = layout, rv = L[orch];
    gEdges.replaceChildren();
    for (const k of Object.keys(paths)) delete paths[k];
    const jm = (L.josh.y + NODE_H + rv.y) / 2; // curves to Review when narrow screens put it off-center
    edge('josh-review', `M${cx(L.josh)} ${L.josh.y + NODE_H} C${cx(L.josh)} ${jm} ${cx(rv)} ${jm} ${cx(rv)} ${rv.y}`);
    edge('review-report', `M${rv.x + rv.w} ${rv.y + NODE_H / 2} L${L.report.x} ${rv.y + NODE_H / 2}`);
    for (const a of state.agents) {
      const b = L[a.key]; if (!b || !b.agent) continue;
      const x = cx(b), top = b.y, mid = (rv.y + NODE_H + top) / 2;
      edge(`review-${a.key}`, `M${cx(rv)} ${rv.y + NODE_H} C${cx(rv)} ${mid} ${x} ${mid} ${x} ${top}`, a.state === 'none' ? 'tool' : '');
      // Alert wire to Josh, drawn only while the agent is blocked.
      const jx = L.josh.x + 24, side = x < cx(L.josh) ? -1 : 1;
      edge(`${a.key}-josh`, `M${b.x + 20} ${top} C${b.x + 20} ${top - 70} ${jx + side * 60} ${L.josh.y + NODE_H + 30} ${jx} ${L.josh.y + NODE_H}`, 'alert-path');
      (a.tools || []).slice(0, 3).forEach((t, j, arr) => {
        const tx = toolX(b, j, arr.length), ty = b.y + NODE_H + 30;
        edge(`${a.key}-tool${j}`, `M${x} ${b.y + NODE_H} C${x} ${ty - 8} ${tx} ${ty - 8} ${tx} ${ty - 14}`, 'tool');
      });
    }
  }

  const toolX = (b, j, n) => cx(b) + (j - (n - 1) / 2) * Math.min(52, b.w / Math.max(n, 1));

  function card(key, b, st, title, sub, selected, onClick, extra = '') {
    const n = document.createElement(onClick ? 'button' : 'div');
    if (onClick) { n.type = 'button'; n.addEventListener('click', () => onClick(key)); }
    n.className = `node3d ${st}${selected ? ' sel' : ''}${extra}`;
    n.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
    n.setAttribute('aria-label', `${title}: ${LABEL[st] || st}${sub ? ', ' + sub : ''}`);
    const mark = st === 'working' ? '<span class="spin-ring" aria-hidden="true"></span>' : MARK[st] ? `<span class="mark" aria-hidden="true">${MARK[st]}</span>` : '';
    n.innerHTML = `<span class="face"><span class="t-row"><span class="title">${esc(title)}</span>${mark}</span><span class="sub">${esc(sub)}</span></span>`;
    nodesEl.appendChild(n);
  }

  function render(state, selected, onClick) {
    last = [state, selected, onClick];
    const W = Math.max(300, wrap.clientWidth);
    const sig = W + '|' + state.agents.map(a => a.key + (a.state === 'none') + (a.tools || []).join()).join('|');
    if (!layout || layoutSig !== sig) {
      layout = buildLayout(state, W); layoutSig = sig;
      stage.style.width = W + 'px'; stage.style.height = layout.height + 'px';
      wrap.style.height = layout.height + 'px';
      stage.style.setProperty('--rx-base', layout.tilt + 'deg');
      svg.setAttribute('viewBox', `0 0 ${W} ${layout.height}`);
      svg.setAttribute('width', W); svg.setAttribute('height', layout.height);
      drawEdges(state);
    }
    nodesEl.replaceChildren();
    const L = layout, orch = state.orchestrator;
    const needed = state.agents.some(a => a.needsJosh), blocked = state.agents.some(a => a.state === 'blocked');
    card('josh', L.josh, blocked ? 'blocked' : 'idle', 'Josh', needed ? 'Needed by an agent' : 'You', false, null, ' person');
    card('report', L.report, 'idle', 'Report', 'Excel and you', false, null);
    for (const a of state.agents) {
      const b = L[a.key]; if (!b) continue;
      const step = a.section || a.task;
      const sub = a.state === 'none' ? 'Not set up' : (a.client ? `${a.client}${step ? ' · ' + step : ''}` : a.task || LABEL[a.state]);
      card(a.key, b, a.state, a.key === orch ? a.name : a.short || a.name, sub, selected === a.key, onClick);
      if (b.agent) (a.tools || []).slice(0, 3).forEach((t, j, arr) => {
        const d = document.createElement('div');
        d.className = 'tool3d'; d.id = `tool-${a.key}-${j}`;
        d.style.cssText = `left:${toolX(b, j, arr.length) - 14}px;top:${b.y + NODE_H + 16}px`;
        d.innerHTML = `<span class="disc" aria-hidden="true">${esc(t[0])}</span><span class="tool-name">${esc(t)}</span>`;
        nodesEl.appendChild(d);
      });
      const alert = paths[`${a.key}-josh`];
      if (alert) alert.classList.toggle('alert', a.state === 'blocked');
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
      const p = paths[id]; if (!p || !p.isConnected) return resolve();
      const len = p.getTotalLength();
      const dot = el('circle', { r: 6, fill: color, class: 'packet' }, gPackets);
      p.classList.add('hot'); p.style.setProperty('--hot', color);
      const t0 = performance.now();
      (function frame(t) {
        const k = Math.min(1, (t - t0) / ms);
        const pt = p.getPointAtLength(len * (dir > 0 ? k : 1 - k));
        dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
        if (k < 1) requestAnimationFrame(frame);
        else { dot.remove(); setTimeout(() => p.classList.remove('hot'), 600); resolve(); }
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

  // 3D on/off (remembered per browser) and a gentle tilt that follows the pointer.
  function set3d(on) {
    document.body.classList.toggle('flat', !on);
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = on ? '3D view: on' : '3D view: off';
    try { localStorage.setItem('agents3d', on ? '1' : '0'); } catch { /* storage blocked */ }
  }
  let on3d = true;
  try { on3d = localStorage.getItem('agents3d') !== '0'; } catch { /* storage blocked */ }
  set3d(on3d);
  toggle.addEventListener('click', () => { on3d = !on3d; set3d(on3d); stage.style.removeProperty('--ry'); stage.style.removeProperty('--rx'); });
  wrap.addEventListener('pointermove', e => {
    if (!on3d || reduced.matches || e.pointerType !== 'mouse') return;
    const r = wrap.getBoundingClientRect();
    stage.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * 6}deg`);
    stage.style.setProperty('--rx', `${(layout ? layout.tilt : 18) - ((e.clientY - r.top) / r.height - 0.5) * 6}deg`);
  });
  wrap.addEventListener('pointerleave', () => { stage.style.removeProperty('--ry'); stage.style.removeProperty('--rx'); });

  // Re-lay out when the canvas width changes.
  let rz = null;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => last && render(...last), 80); }).observe(wrap);

  window.Canvas = { render, packet, esc };
})();
