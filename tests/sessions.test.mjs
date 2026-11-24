// Checks the step translator and the session log reader against small synthetic logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, questionOf } from '../server/describe.mjs';
import { feed, summarize, SessionWatcher, STALL_MS } from '../server/sessions.mjs';

const T0 = Date.parse('2026-11-24T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const tool = (s, id, name, input, stop = 'tool_use') => ({ type: 'assistant', timestamp: at(s), message: { id: `m${id}`, stop_reason: stop,
  usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 20 }, content: [{ type: 'tool_use', id, name, input }] } });
const result = (s, id, extra = {}) => ({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }], ...extra }] } });
const say = (s, text) => ({ type: 'assistant', timestamp: at(s), message: { id: `t${s}`, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const prompt = (s, text) => ({ type: 'user', timestamp: at(s), message: { content: text } });
const session = entries => { const s = { file: 'x', id: 'abc', events: [], pending: new Map(), tokens: new Map(), seenMsg: new Set(), partial: '', lastTs: 0 }; feed(s, entries.map(e => JSON.stringify(e)).join('\n') + '\n'); return s; };

test('tool calls become plain steps', () => {
  assert.equal(describe('Bash', { description: 'Run tests' }).text, 'Ran: Run tests');
  assert.equal(describe('Read', { file_path: 'D:\\a\\b\\state.mjs' }).text, 'Reading state.mjs');
  assert.equal(describe('mcp__claude-in-chrome__computer', { action: 'left_click', action_summary: 'Opens the Goals page' }).text, 'Opens the Goals page');
  assert.equal(describe('mcp__claude-in-chrome__computer', { action: 'screenshot' }).text, 'Took a screenshot');
  const nav = describe('mcp__Claude_Browser__navigate', { url: 'https://ads.google.com/aw/goals?x=1' });
  assert.equal(nav.text, 'Opening ads.google.com/aw/goals');
  assert.equal(nav.url, 'ads.google.com/aw/goals');
  assert.equal(describe('mcp__nexus__nexus_save_session', { topic: 'Gray done' }).text, 'Saved to Nexus: Gray done');
  assert.equal(describe('mcp__ccd_turn__update_plan', { items: [{ content: 'Fix it', status: 'in_progress' }] }).text, 'Plan step: Fix it');
  assert.match(describe('mcp__f2f8db7c-03e8-4520-b0ca-808e3ed689f9__get_values', {}).text, /^Google Sheets: get values/);
  assert.ok(describe('Write', { file_path: 'x'.repeat(400) }).text.length <= 140);
});

test('only blocking questions count as needing Josh', () => {
  assert.equal(questionOf('AskUserQuestion', { questions: [{ question: 'Which client?' }] }), 'Which client?');
  assert.equal(questionOf('mcp__ccd_turn__wrap_up', { recap: 'Done', ask: 'Commit?' }), null);
  assert.equal(questionOf('mcp__ccd_turn__wrap_up', { recap: 'Stuck', ask: 'Reopen ep3?', blocked: true }), 'Reopen ep3?');
});

test('a session mid-step is working, then stalled when it goes quiet', () => {
  const s = session([prompt(0, 'Audit Gray'), tool(5, 'a', 'mcp__Claude_Browser__navigate', { url: 'https://ads.google.com/goals' })]);
  const w = summarize(s, T0 + 30_000);
  assert.equal(w.state, 'working');
  assert.equal(w.now, 'Opening ads.google.com/goals');
  assert.equal(w.since, T0 + 5000);
  assert.equal(w.url, 'ads.google.com/goals');
  assert.equal(summarize(s, T0 + 5000 + STALL_MS + 1000).state, 'stalled');
  assert.equal(summarize(s, T0 + 5 * 3600_000).state, 'idle'); // hours later it is history, not an alert
});

test('an open question needs Josh until he answers', () => {
  const s = session([prompt(0, 'Go'), tool(3, 'q', 'AskUserQuestion', { questions: [{ question: 'Use ep3?' }] })]);
  const n = summarize(s, T0 + 60_000);
  assert.equal(n.state, 'needs');
  assert.equal(n.now, 'Use ep3?');
  feed(s, JSON.stringify(result(90, 'q')) + '\n');
  assert.notEqual(summarize(s, T0 + 95_000).state, 'needs');
});

test('a finished turn is idle and shows its recap; tokens, errors and screenshots are tracked', () => {
  const s = session([
    prompt(0, 'Check GA4'),
    tool(2, 'a', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }),
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image', source: { media_type: 'image/png', data: 'AAAA' } }] }] } },
    tool(4, 'b', 'Bash', { description: 'Run build' }),
    result(5, 'b', { is_error: true, content: 'exit 1' }),
    tool(6, 'w', 'mcp__ccd_turn__wrap_up', { recap: 'GA4 checked.', ask: 'Commit?' }),
    result(7, 'w'),
    say(8, 'All done.'),
  ]);
  const d = summarize(s, T0 + 60_000);
  assert.equal(d.state, 'idle');
  assert.equal(d.now, 'Finished: GA4 checked. Asked: Commit?');
  assert.equal(d.shotTs, T0 + 3000);
  assert.ok(d.steps.some(e => e.kind === 'error' && /exit 1/.test(e.text)));
  assert.ok(d.steps.some(e => e.kind === 'you' && e.text === 'You: Check GA4'));
  assert.equal(d.tokensToday, 3 * 35); // three tool calls with usage, each counted once
  assert.equal(d.spark.reduce((a, b) => a + b, 0), 3);
});

test('the watcher finds an agent log by title and reads lines as they are appended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-logs-'));
  fs.mkdirSync(path.join(dir, 'proj'));
  const file = path.join(dir, 'proj', 'abc.jsonl');
  fs.writeFileSync(file, [{ type: 'custom-title', customTitle: 'Agent CRM setup' }, prompt(0, 'Start')].map(e => JSON.stringify(e)).join('\n') + '\n');
  const w = new SessionWatcher({ dir });
  const r = w.resolve([{ key: 'crm', sessionTitle: 'Agent CRM setup' }, { key: 'gtm', sessionTitle: 'Nope' }], 3600_000, T0);
  assert.equal(r.agentFile.crm, file);
  assert.equal(r.agentFile.gtm, undefined);
  assert.equal(w.poll(), false);
  fs.appendFileSync(file, JSON.stringify(tool(10, 'z', 'Read', { file_path: 'notes.md' })) + '\n');
  assert.equal(w.poll(), true);
  assert.equal(w.summary(file, T0 + 20_000).now, 'Reading notes.md');
});
