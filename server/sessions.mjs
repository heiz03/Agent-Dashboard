// Follows Claude session logs (~/.claude/projects/<folder>/<id>.jsonl) as they are written and
// keeps a live summary per session: current step, state, question, screenshot, tokens, activity.
// Read-only: it never writes to the logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, questionOf } from './describe.mjs';

export const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const FIRST_READ = 6 * 1024 * 1024;   // on first sight, read only the newest 6 MB of a log
const TITLE_TAIL = 256 * 1024;        // titles are re-logged often, so the tail has the latest
const TITLE_MAX_AGE = 45 * 864e5;     // only look up titles of logs touched in the last 45 days
const KEEP_EVENTS = 300;
export const STALL_MS = 4 * 60_000;   // mid-turn and silent this long = stalled
const STALE_MS = 2 * 3600_000;        // older than this, a stalled or waiting turn is just history
const NEEDS_MS = 12 * 3600_000;       // an unanswered question older than this stops alerting
const WINDOW_MS = 4 * 3600_000;       // timeline span
const GAP_MS = 3 * 60_000;            // steps closer than this belong to one busy stretch

const dayPT = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ts));
const clip = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function newSession(file) {
  return { file, id: path.basename(file, '.jsonl'), title: null, cwd: null, offset: 0, partial: '',
    events: [], pending: new Map(), lastTs: 0, active: false, endedAt: 0, question: null, questionAt: 0,
    recap: null, lastText: null, shot: null, url: null, tokens: new Map(), seenMsg: new Set() };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join(' ');
  return '';
}

// Applies one log entry to a session summary.
export function applyEntry(s, e) {
  if (!e || typeof e !== 'object' || e.isSidechain) return;
  const ts = Date.parse(e.timestamp) || 0;
  if (e.type === 'custom-title' && e.customTitle) s.title = e.customTitle;
  if (e.type === 'agent-name' && e.agentName && !s.title) s.title = e.agentName;
  if (e.cwd) s.cwd = e.cwd;
  const push = (kind, text) => { s.events.push({ ts, kind, text: clip(text) }); if (s.events.length > KEEP_EVENTS) s.events.shift(); };

  if (e.type === 'assistant' && e.message) {
    const m = e.message;
    if (m.id && m.usage && !s.seenMsg.has(m.id)) {
      s.seenMsg.add(m.id);
      const u = m.usage, day = dayPT(ts || Date.now());
      s.tokens.set(day, (s.tokens.get(day) || 0) + (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0));
    }
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === 'tool_use') {
        const d = describe(c.name, c.input);
        push('step', d.text);
        s.pending.set(c.id, { name: c.name, ts });
        if (d.url) s.url = d.url;
        const q = questionOf(c.name, c.input);
        if (q) { s.question = q; s.questionAt = ts; }
        if (String(c.name).endsWith('wrap_up') && c.input?.recap) {
          s.recap = clip(c.input.recap + (c.input.ask && !c.input.blocked ? ` Asked: ${c.input.ask}` : ''), 240);
        }
      } else if (c.type === 'text' && c.text && c.text.trim()) {
        s.lastText = clip(c.text, 240);
        push('message', c.text);
      }
    }
    if (m.stop_reason === 'end_turn') { s.active = false; s.endedAt = ts; }
    else if (m.stop_reason === 'tool_use') s.active = true;
  } else if (e.type === 'user' && e.message) {
    const content = e.message.content;
    const results = Array.isArray(content) ? content.filter(c => c.type === 'tool_result') : [];
    for (const r of results) {
      const p = s.pending.get(r.tool_use_id);
      s.pending.delete(r.tool_use_id);
      if (p && String(p.name).endsWith('AskUserQuestion')) s.question = null; // answered
      if (r.is_error) push('error', `Error: ${textOf(r.content) || 'a step failed'}`);
      for (const c of Array.isArray(r.content) ? r.content : []) {
        if (c.type === 'image' && c.source?.data) s.shot = { ts, media: c.source.media_type || 'image/png', data: c.source.data };
      }
    }
    if (!results.length && !e.isMeta) {
      const t = textOf(content).trim();
      if (t && !t.startsWith('<')) { push('you', `You: ${t}`); s.active = true; s.question = null; s.recap = null; }
    }
  }
  if (ts > s.lastTs) s.lastTs = ts;
}

// Feeds a chunk of log text (may end mid-line) into a session.
export function feed(s, chunk) {
  const text = s.partial + chunk;
  const lines = text.split('\n');
  s.partial = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { applyEntry(s, JSON.parse(line)); } catch { /* skip a malformed line */ }
  }
}

const dur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

// The live picture of one session at time `now`.
export function summarize(s, now = Date.now()) {
  const steps = s.events.filter(e => e.kind === 'step');
  const lastStep = steps.at(-1) || null;
  const age = now - s.lastTs;
  let state, text, since;
  if (s.question && now - (s.questionAt || s.lastTs) < NEEDS_MS && (!s.active || s.pending.size)) {
    state = 'needs'; text = s.question; since = s.questionAt || s.endedAt || s.lastTs;
  } else if (s.active && age < STALL_MS) {
    state = 'working'; text = lastStep ? lastStep.text : 'Thinking'; since = lastStep ? lastStep.ts : s.lastTs;
  } else if (s.active && age < STALE_MS) {
    state = 'stalled'; text = lastStep ? lastStep.text : 'No progress'; since = s.lastTs;
  } else {
    state = 'idle'; since = s.endedAt || s.lastTs;
    text = s.active ? `Stopped mid-task ${dur(age)} ago` : s.recap ? `Finished: ${s.recap}` : s.lastText || (lastStep ? lastStep.text : 'No activity yet');
  }
  // Steps per minute over the last 30 minutes.
  const spark = new Array(30).fill(0);
  for (const e of steps) { const k = Math.floor((now - e.ts) / 60000); if (k >= 0 && k < 30) spark[29 - k]++; }
  // Busy stretches over the last 4 hours, as % of the window.
  const segs = [], t0 = now - WINDOW_MS;
  let a = null, b = null;
  for (const e of s.events) {
    if (e.ts < t0) continue;
    if (a === null) { a = b = e.ts; continue; }
    if (e.ts - b <= GAP_MS) b = e.ts; else { segs.push([a, b + 60000, 'working']); a = b = e.ts; }
  }
  if (a !== null) segs.push([a, Math.min(now, b + 60000), 'working']);
  if (state === 'needs' || state === 'stalled') segs.push([Math.max(t0, since), now, state]);
  const pct = x => Math.max(0, Math.min(100, (x - t0) / WINDOW_MS * 100));
  return {
    id: s.id, title: s.title, cwd: s.cwd, state, now: text, since, lastTs: s.lastTs, question: s.question,
    steps: s.events.slice(-15).reverse(), spark, url: s.url,
    segs: segs.map(([x, y, st]) => ({ left: +pct(x).toFixed(2), width: +Math.max(0.4, pct(y) - pct(x)).toFixed(2), state: st })),
    tokensToday: s.tokens.get(dayPT(now)) || 0, shotTs: s.shot ? s.shot.ts : null,
  };
}

// Finds logs, follows the ones that matter, and reads new lines as they arrive.
export class SessionWatcher {
  constructor({ dir = PROJECTS_DIR } = {}) {
    this.dir = dir; this.files = []; this.sessions = new Map(); this.titles = new Map();
  }

  scan() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { this.files = []; return; }
    for (const d of dirs) {
      const full = path.join(this.dir, d.name);
      let names = [];
      try { names = fs.readdirSync(full); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        try { const st = fs.statSync(path.join(full, n)); out.push({ file: path.join(full, n), mtime: st.mtimeMs, size: st.size }); } catch { /* gone */ }
      }
    }
    this.files = out;
  }

  titleOf(f) {
    const hit = this.titles.get(f.file);
    if (hit && hit.mtime === f.mtime) return hit.title;
    let title = null;
    try {
      const fd = fs.openSync(f.file, 'r');
      const len = Math.min(TITLE_TAIL, f.size), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, f.size - len); fs.closeSync(fd);
      const all = [...buf.toString('utf8').matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)];
      if (all.length) title = JSON.parse(`"${all.at(-1)[1]}"`);
    } catch { /* unreadable */ }
    this.titles.set(f.file, { mtime: f.mtime, title });
    return title;
  }

  // Picks each agent's newest log by session title, plus every log active within windowMs.
  resolve(agents, windowMs, now = Date.now()) {
    this.scan();
    const recent = this.files.filter(f => now - f.mtime < TITLE_MAX_AGE);
    const agentFile = {};
    for (const a of agents) {
      if (!a.sessionTitle) continue;
      const hits = recent.filter(f => this.titleOf(f) === a.sessionTitle).sort((x, y) => y.mtime - x.mtime);
      if (hits[0]) agentFile[a.key] = hits[0].file;
    }
    const taken = new Set(Object.values(agentFile));
    const live = this.files.filter(f => now - f.mtime < windowMs && !taken.has(f.file)).map(f => f.file);
    const keep = new Set([...taken, ...live]);
    for (const f of keep) this.track(f);
    for (const f of [...this.sessions.keys()]) if (!keep.has(f)) this.sessions.delete(f);
    return { agentFile, live };
  }

  track(file) {
    if (this.sessions.has(file)) return;
    const s = newSession(file);
    this.sessions.set(file, s);
    try {
      const size = fs.statSync(file).size, start = Math.max(0, size - FIRST_READ);
      this.read(s, start, size); // a first line cut mid-way fails to parse and is skipped
    } catch { /* unreadable */ }
  }

  read(s, from, to) {
    if (to <= from) return;
    const fd = fs.openSync(s.file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      feed(s, buf.toString('utf8'));
      s.offset = to;
    } finally { fs.closeSync(fd); }
  }

  // Reads whatever was appended since last time. Returns true if anything changed.
  poll() {
    let changed = false;
    for (const s of this.sessions.values()) {
      let size;
      try { size = fs.statSync(s.file).size; } catch { continue; }
      if (size < s.offset) { s.offset = 0; s.partial = ''; }
      if (size > s.offset) { try { this.read(s, s.offset, size); changed = true; } catch { /* locked mid-write: retry next poll */ } }
    }
    return changed;
  }

  summary(file, now) { const s = this.sessions.get(file); return s ? summarize(s, now) : null; }
  shot(file) { return this.sessions.get(file)?.shot || null; }
}
