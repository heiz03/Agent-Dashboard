// Checks the status reader, event log and Nexus handoff parser against a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-dash-'));
process.env.AGENTS_STATUS_DIR = path.join(tmp, 'status');
process.env.NEXUS_DIR = path.join(tmp, 'nexus');
fs.mkdirSync(process.env.AGENTS_STATUS_DIR, { recursive: true });
const { readStatus, readEvents, parseHandoff, buildState } = await import('../server/state.mjs');

test('status file is read and invalid values are dropped', () => {
  fs.writeFileSync(path.join(process.env.AGENTS_STATUS_DIR, 'crm.json'), JSON.stringify({
    state: 'blocked', client: 'EMDR', needsJosh: 'Open pools', progress: { done: 3, total: 16 },
    clients: { EMDR: { status: 'blocked', note: 'pools' }, Acme: { status: 'bogus' } },
  }));
  const s = readStatus('crm');
  assert.equal(s.state, 'blocked');
  assert.equal(s.needsJosh, 'Open pools');
  assert.deepEqual(Object.keys(s.clients), ['EMDR']);
  fs.writeFileSync(path.join(process.env.AGENTS_STATUS_DIR, 'gtm.json'), JSON.stringify({ state: 'exploded' }));
  assert.equal(readStatus('gtm').state, 'idle');
});

test('event log skips malformed lines', () => {
  fs.writeFileSync(path.join(process.env.AGENTS_STATUS_DIR, 'events.jsonl'),
    '{"ts":"2026-11-11T01:00:00Z","from":"ads","to":"gtm","text":"Tag ID"}\nnot json\n{"from":"x"}\n');
  const e = readEvents();
  assert.equal(e.length, 1);
  assert.equal(e[0].to, 'gtm');
});

test('handoff parser reads topic and next action', () => {
  const h = parseHandoff('---\nid: abc\nrecorded: 2026-11-11T09:00:00+08:00\ntopic: Agent GA4 DONE: 16 clients\nsupersedes: old\n---\n\n## Goal\nx\n\n## Next action\nWait for Josh.\n');
  assert.equal(h.topic, 'Agent GA4 DONE: 16 clients');
  assert.equal(h.next, 'Wait for Josh.');
  assert.equal(h.supersedes, 'old');
});

test('client names agents use are mapped to configured names', async () => {
  const { canonicalClient } = await import('../server/state.mjs');
  const clients = [
    { name: 'Northwind Behavioral Health', short: 'NBH' },
    { name: 'Summit Peak Counseling', short: 'Summit' },
    { name: 'Cedar Counseling Group', short: 'Cedar' },
  ];
  assert.equal(canonicalClient('Northwind', clients), 'Northwind Behavioral Health');
  assert.equal(canonicalClient('NBH', clients), 'Northwind Behavioral Health');
  assert.equal(canonicalClient('Summit', clients), 'Summit Peak Counseling');
  assert.equal(canonicalClient('cedar', clients), 'Cedar Counseling Group');
  assert.equal(canonicalClient('Unknown Co', clients), 'Unknown Co');
});

test('section progress is read and bad section values are dropped', () => {
  fs.writeFileSync(path.join(process.env.AGENTS_STATUS_DIR, 'ads.json'), JSON.stringify({
    state: 'working', client: 'Acme Counseling', section: 'Goals', detail: 'Reading AAM (custom)', tab: '1565248519',
    clients: { 'Acme Counseling': { status: 'working', sections: { 'Conversion actions': 'issue', Goals: 'working', Networks: 'bogus' },
      issues: { 'Conversion actions': 'Form Fill has $1 value', Goals: 'not an issue' } } },
  }));
  const s = readStatus('ads');
  assert.equal(s.section, 'Goals');
  assert.equal(s.tab, '1565248519');
  const g = s.clients['Acme Counseling'];
  assert.deepEqual(g.sections, { 'Conversion actions': 'issue', Goals: 'working' });
  assert.deepEqual(Object.keys(g.issues), ['Conversion actions']);
  const ads = buildState([]).agents.find(a => a.key === 'ads');
  assert.equal(ads.clientKey, 'Acme Counseling');
  assert.ok(ads.sections.includes('Goals'));
});

test('report.mjs records sections, keeps them across client results and logs quiet steps', async () => {
  const { execFileSync } = await import('node:child_process');
  const run = (...a) => execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'report.mjs'), '--agent', 'crm', ...a],
    { env: process.env, encoding: 'utf8' });
  fs.rmSync(path.join(process.env.AGENTS_STATUS_DIR, 'crm.json'), { force: true });
  run('--state', 'working', '--client', 'EMDR', '--tab', '42');
  run('--client', 'EMDR', '--section', 'Forms', '--detail', 'Reading form');
  run('--client', 'EMDR', '--section', 'Forms', '--section-status', 'issue', '--note', 'No consent box');
  run('--client', 'EMDR', '--section', 'Calendars');
  run('--client', 'EMDR', '--client-status', 'mistake', '--note', 'Forms');
  const s = readStatus('crm');
  assert.equal(s.section, 'Calendars');
  assert.equal(s.detail, null);
  assert.equal(s.tab, '42');
  assert.equal(s.clients.EMDR.status, 'mistake');
  assert.deepEqual(s.clients.EMDR.sections, { Forms: 'issue', Calendars: 'working' });
  assert.equal(s.clients.EMDR.issues.Forms, 'No consent box');
  assert.throws(() => run('--section', 'Not a section'));
  const kinds = readEvents().filter(e => e.from === 'crm').map(e => e.kind);
  assert.ok(kinds.includes('step'));
  assert.ok(kinds.includes('message')); // the issue is a real message, not a quiet step
});

test('state merges status files with Nexus fallback', () => {
  const nexus = [{ id: 'n1', topic: 'Agent GA4 DONE: all', recorded: new Date().toISOString(), handoffs: [] }];
  const st = buildState(nexus);
  const ga4 = st.agents.find(a => a.key === 'ga4');
  const crm = st.agents.find(a => a.key === 'crm');
  const gsc = st.agents.find(a => a.key === 'gsc');
  assert.equal(ga4.source, 'nexus');
  assert.equal(crm.source, 'status');
  assert.equal(gsc.state, 'none');
  assert.ok(st.feed.some(f => f.source === 'nexus'));
});
