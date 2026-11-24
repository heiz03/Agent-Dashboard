#!/usr/bin/env node
// Lets an agent session update its dashboard status and log messages.
// Examples:
//   node report.mjs --agent crm --state working --client EMDR --task "Number pools" --progress 9/16
//   node report.mjs --agent crm --state blocked --needs-josh "Open the Number Pools page for EMDR"
//   node report.mjs --agent crm --client EMDR --client-status done --note "Matches SOP"
//   node report.mjs --agent gtm --to review --client Cedar --message "Label matches no action" --kind message
//   node report.mjs --agent ads --client Acme --section "Goals" --detail "Reading AAM (custom)" --tab 1565248519
//   node report.mjs --agent ads --client Acme --section "Goals" --section-status issue --note "Form Fill is Secondary"
import fs from 'node:fs';
import path from 'node:path';
import { STATUS_DIR, EVENTS_FILE, loadConfig } from '../server/state.mjs';

const STATES = ['working', 'waiting', 'blocked', 'done', 'idle'];
const CLIENT_STATES = ['done', 'mistake', 'working', 'blocked', 'pending', 'skipped'];
const KINDS = ['message', 'blocked', 'done', 'status', 'step'];
const SECTION_STATES = ['ok', 'issue', 'working', 'skip'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}

function fail(msg) { console.error(`report: ${msg}`); process.exit(1); }

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig().agents.agents;
const keys = cfg.map(a => a.key);
if (!args.agent || !keys.includes(args.agent)) fail(`--agent must be one of: ${keys.join(', ')}`);
if (args.state && !STATES.includes(args.state)) fail(`--state must be one of: ${STATES.join(', ')}`);
if (args['client-status'] && !CLIENT_STATES.includes(args['client-status'])) fail(`--client-status must be one of: ${CLIENT_STATES.join(', ')}`);
if (args['client-status'] && !args.client) fail('--client-status needs --client');
if (args.kind && !KINDS.includes(args.kind)) fail(`--kind must be one of: ${KINDS.join(', ')}`);
if (args.to && args.to !== 'josh' && args.to !== 'report' && !keys.includes(args.to)) fail(`--to must be josh, report or one of: ${keys.join(', ')}`);
if (args['section-status'] && !SECTION_STATES.includes(args['section-status'])) fail(`--section-status must be one of: ${SECTION_STATES.join(', ')}`);
if (args['section-status'] && typeof args.section !== 'string') fail('--section-status needs --section');
const known = cfg.find(a => a.key === args.agent).sections || [];
if (typeof args.section === 'string' && known.length && !known.includes(args.section)) fail(`--section must be one of: ${known.join(', ')}`);

fs.mkdirSync(STATUS_DIR, { recursive: true });
const file = path.join(STATUS_DIR, `${args.agent}.json`);
let st = {};
try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first report */ }
st.agent = args.agent;
st.clients ||= {};

const prev = { client: st.client, section: st.section };
if (args.state) st.state = args.state;
// A section report means the agent is actively on it.
if (typeof args.section === 'string' && !args['section-status'] && !args.state) st.state = 'working';
if (typeof args.client === 'string' && !args['client-status'] && !args.message) {
  if (args.client !== st.client) { st.section = null; st.detail = null; }
  st.client = args.client;
}
if (typeof args.task === 'string') st.task = args.task;
if (typeof args.section === 'string' && !args['section-status']) {
  if (args.section !== st.section) { st.section = args.section; st.sectionStarted = new Date().toISOString(); }
  if (typeof args.detail !== 'string') st.detail = null;
}
if (typeof args.detail === 'string') st.detail = args.detail.slice(0, 200);
if (args.tab !== undefined) st.tab = String(args.tab).slice(0, 20);
if (['done', 'idle'].includes(args.state)) { st.section = null; st.detail = null; }
if (args.progress) {
  const m = String(args.progress).match(/^(\d+)\/(\d+)$/);
  if (!m) fail('--progress must look like 9/16');
  st.progress = { done: Number(m[1]), total: Number(m[2]) };
}
if (typeof args['needs-josh'] === 'string') st.needsJosh = args['needs-josh'];
if (args['clear-needs']) st.needsJosh = null;
if (typeof args['waiting-on'] === 'string') st.waitingOn = args['waiting-on'];
// Client entries are merged, so per-section results survive status changes.
const entry = name => (st.clients[name] ||= { status: 'pending', note: '' });
if (args['client-status']) {
  const e = entry(args.client);
  e.status = args['client-status'];
  if (typeof args.note === 'string') e.note = args.note;
}
const target = typeof args.client === 'string' ? args.client : st.client;
if (typeof args.section === 'string' && target) {
  const e = entry(target);
  e.sections ||= {};
  e.sections[args.section] = args['section-status'] || 'working';
  if (args['section-status'] === 'issue' && typeof args.note === 'string') (e.issues ||= {})[args.section] = args.note.slice(0, 300);
}
// Working on or blocked by a client marks its grid cell too, unless it already has a result.
const FINAL = ['done', 'mistake', 'skipped'];
const live = args.state || (typeof args.section === 'string' && !args['section-status'] ? 'working' : null);
if (!args['client-status'] && target && ['working', 'blocked'].includes(live) && !FINAL.includes(st.clients[target]?.status)) {
  const e = entry(target);
  e.status = live;
  e.note = st.needsJosh || st.section || st.task || '';
}
st.updated = new Date().toISOString();
writeAtomic(file, JSON.stringify(st, null, 2));

// Log a feed/canvas event for messages, blockers and client results.
const text = typeof args.message === 'string' ? args.message
  : args['client-status'] ? `${args['client-status']}${typeof args.note === 'string' ? ': ' + args.note : ''}`
  : args.state === 'blocked' ? `blocked: ${st.needsJosh || st.task || ''}`.trim()
  : args['section-status'] ? `${args.section}: ${args['section-status']}${typeof args.note === 'string' ? ' - ' + args.note : ''}`
  : st.client !== prev.client && st.client ? `started ${st.client}${st.section ? ' · ' + st.section : ''}`
  : st.section && st.section !== prev.section ? `on ${st.section}`
  : null;
// Section moves are logged as quiet "step" lines; real results keep their own kinds.
const isStep = !args.message && !args['client-status'] && args.state !== 'blocked' && args['section-status'] !== 'issue';
if (text) {
  const kind = args.kind || (args.state === 'blocked' ? 'blocked' : args['client-status'] === 'done' ? 'done' : isStep ? 'step' : 'message');
  const to = args.to || (args.state === 'blocked' && st.needsJosh ? 'josh' : args['client-status'] ? 'review' : null);
  const event = { ts: st.updated, from: args.agent, to, client: typeof args.client === 'string' ? args.client : (st.client || null), text, kind };
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
}
console.log(`report: ${args.agent} updated${text ? ' and logged' : ''}.`);
