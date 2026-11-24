// Builds the dashboard state from agent status files, the shared event log
// and (as a fallback) recent Nexus session handoffs. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const STATUS_DIR = process.env.AGENTS_STATUS_DIR || path.resolve(ROOT, '..', 'status');
export const NEXUS_DIR = process.env.NEXUS_DIR || path.resolve(ROOT, '..', '..', 'Nexus');
export const EVENTS_FILE = path.join(STATUS_DIR, 'events.jsonl');

const STATES = new Set(['working', 'waiting', 'blocked', 'done', 'idle']);
const CLIENT_STATES = new Set(['done', 'mistake', 'working', 'blocked', 'pending', 'skipped']);
const SECTION_STATES = new Set(['ok', 'issue', 'working', 'skip']);
const NEXUS_DAYS = 4;
const MAX_EVENTS = 500;
const FEED_STEPS = 15; // section moves shown in the feed, so results aren't buried

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch { return fallback; }
}

export function loadConfig() {
  return {
    agents: readJson(path.join(ROOT, 'config', 'agents.json'), { agents: [] }),
    // clients.json is private (git-ignored); fall back to the example list on a fresh clone.
    clients: (readJson(path.join(ROOT, 'config', 'clients.json'), null)
      ?? readJson(path.join(ROOT, 'config', 'clients.example.json'), { clients: [] })).clients,
  };
}

// One status file per agent: status/<key>.json. Invalid fields are dropped, not trusted.
export function readStatus(key) {
  const raw = readJson(path.join(STATUS_DIR, `${key}.json`), null);
  if (!raw || typeof raw !== 'object') return null;
  const clients = {};
  for (const [name, v] of Object.entries(raw.clients || {})) {
    const s = typeof v === 'string' ? v : v?.status;
    if (!CLIENT_STATES.has(s)) continue;
    const sections = {}, issues = {};
    for (const [k, sv] of Object.entries(v?.sections || {})) if (SECTION_STATES.has(sv)) sections[String(k).slice(0, 60)] = sv;
    for (const [k, iv] of Object.entries(v?.issues || {})) if (sections[k] === 'issue') issues[k] = String(iv).slice(0, 300);
    clients[name] = { status: s, note: String(v?.note || '').slice(0, 400), sections, issues };
  }
  return {
    state: STATES.has(raw.state) ? raw.state : 'idle',
    client: raw.client ? String(raw.client) : null,
    task: raw.task ? String(raw.task).slice(0, 200) : null,
    section: raw.section ? String(raw.section).slice(0, 60) : null,
    sectionStarted: raw.sectionStarted || null,
    detail: raw.detail ? String(raw.detail).slice(0, 200) : null,
    tab: raw.tab ? String(raw.tab).slice(0, 20) : null,
    needsJosh: raw.needsJosh ? String(raw.needsJosh).slice(0, 300) : null,
    waitingOn: raw.waitingOn ? String(raw.waitingOn) : null,
    progress: raw.progress && Number.isFinite(raw.progress.done)
      ? { done: raw.progress.done, total: raw.progress.total || 0 } : null,
    updated: raw.updated || null,
    clients,
  };
}

export function readEvents(limit = MAX_EVENTS) {
  let text = '';
  try { text = fs.readFileSync(EVENTS_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.from && e.text) out.push({
        ts: e.ts || null, from: String(e.from), to: e.to ? String(e.to) : null,
        client: e.client ? String(e.client) : null, text: String(e.text).slice(0, 300),
        kind: e.kind || 'message', source: 'status',
      });
    } catch { /* skip a malformed line */ }
  }
  return limit ? out.slice(-limit) : out;
}

// Parses a Nexus handoff: frontmatter fields plus the "Next action" section.
export function parseHandoff(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const next = text.match(/## Next action\r?\n+([\s\S]*?)(\r?\n## |$)/);
  return {
    id: fm.id, topic: fm.topic || '', recorded: fm.recorded || null,
    app: fm.app, supersedes: fm.supersedes || null,
    next: next ? next[1].trim().split(/\r?\n/)[0].slice(0, 300) : null,
  };
}

function recentDayDirs() {
  const dirs = [];
  const sessions = path.join(NEXUS_DIR, 'sessions');
  let banks = [];
  try { banks = fs.readdirSync(sessions, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return dirs; }
  const days = [];
  for (let i = 0; i < NEXUS_DAYS; i++) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  for (const b of banks) for (const d of days) {
    const dir = path.join(sessions, b.name, d.slice(0, 7), d);
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

// Newest handoffs from the last few days, minus ones a later save superseded.
export function readNexusHandoffs() {
  const list = [];
  for (const dir of recentDayDirs()) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const h = parseHandoff(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (h && h.recorded) list.push(h);
      } catch { /* unreadable file: skip */ }
    }
  }
  const superseded = new Set(list.map(h => h.supersedes).filter(Boolean));
  return list.filter(h => !superseded.has(h.id))
    .sort((a, b) => Date.parse(b.recorded) - Date.parse(a.recorded));
}

// Maps whatever name an agent used ("NBH", "Northwind", "Summit") to the
// configured client name. Exact name/short match wins, then a prefix match either way.
export function canonicalClient(name, clients) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  if (!n) return null;
  const exact = clients.find(c => norm(c.name) === n || norm(c.short) === n);
  if (exact) return exact.name;
  const pre = clients.filter(c => [c.name, c.short].some(v => v && (norm(v).startsWith(n) || n.startsWith(norm(v)))));
  return pre.length === 1 ? pre[0].name : name;
}

// Every logged event for one client (any spelling agents used), oldest first.
export function clientEvents(name) {
  const { clients } = loadConfig();
  const want = canonicalClient(name, clients);
  if (!want) return [];
  return readEvents(0).filter(e => e.client && canonicalClient(e.client, clients) === want)
    .map(e => ({ ...e, client: want }));
}

function canonicalClients(map, clients) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) out[canonicalClient(k, clients)] = v;
  return out;
}

export function buildState(nexus = readNexusHandoffs()) {
  const { agents: cfg, clients } = loadConfig();
  // One spelling per client, so the detail panel and feed group "NPABA" with its full name.
  const events = readEvents().map(e => e.client ? { ...e, client: canonicalClient(e.client, clients) } : e);
  const agents = cfg.agents.map(a => {
    const re = a.topicPattern ? new RegExp(a.topicPattern, 'i') : null;
    const handoffs = re ? nexus.filter(h => re.test(h.topic)) : [];
    const last = handoffs[0] || null;
    const status = readStatus(a.key);
    if (status) {
      status.clients = canonicalClients(status.clients, clients);
      status.clientKey = status.client ? canonicalClient(status.client, clients) : null; // matches grid rows
    }
    const base = status || {
      state: a.sessionId || last ? 'idle' : 'none', client: null, task: last ? last.topic : null,
      section: null, sectionStarted: null, detail: null, tab: null,
      needsJosh: null, waitingOn: null, progress: null, updated: last ? last.recorded : null, clients: {},
    };
    return { ...a, ...base, source: status ? 'status' : (last ? 'nexus' : 'none'),
      lastHandoff: last, handoffs: handoffs.slice(0, 5) };
  });

  // Nexus saves join the feed so it isn't empty before agents report.
  const nexusEvents = [];
  for (const a of agents) for (const h of a.handoffs) {
    nexusEvents.push({ ts: h.recorded, from: a.key, to: null, client: null, text: h.topic, kind: 'nexus', source: 'nexus' });
  }
  const steps = events.filter(e => e.kind === 'step').slice(-FEED_STEPS);
  const feed = [...events.filter(e => e.kind !== 'step'), ...steps, ...nexusEvents]
    .sort((x, y) => Date.parse(y.ts || 0) - Date.parse(x.ts || 0)).slice(0, 60);

  return { generated: new Date().toISOString(), orchestrator: cfg.orchestrator, agents, clients, feed,
    statusDir: STATUS_DIR, nexusDir: NEXUS_DIR };
}
