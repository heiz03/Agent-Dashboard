// Local, read-only server for the Agent command center. Follows Claude session logs and
// agent status files, and pushes the live picture to the page over Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATUS_DIR, buildState, readEvents, readNexusHandoffs, clientEvents, loadConfig } from './state.mjs';
import { SessionWatcher } from './sessions.mjs';

// --port wins over PORT, so a second copy (e.g. the Claude preview pane) can run beside the main one.
const argPort = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : null;
const PORT = Number(argPort || process.env.PORT || 4327);
const HOST = '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const NEXUS_POLL_MS = 30_000, RESOLVE_MS = 15_000, POLL_MS = 1_000, TICK_MS = 10_000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
// Only answer requests addressed to this machine, so other websites can't read session data.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

fs.mkdirSync(STATUS_DIR, { recursive: true });

const watcher = new SessionWatcher();
let map = { agentFile: {}, live: [] };
function resolveSessions() {
  const cfg = loadConfig().agents;
  map = watcher.resolve(cfg.agents, (cfg.liveWindowHours || 3) * 3600_000);
}
function liveSummaries() {
  const now = Date.now(), agents = {};
  for (const [k, f] of Object.entries(map.agentFile)) agents[k] = watcher.summary(f, now);
  const sessions = map.live.map(f => watcher.summary(f, now)).filter(Boolean).sort((a, b) => b.lastTs - a.lastTs);
  return { agents, sessions };
}

let nexus = readNexusHandoffs();
resolveSessions();
let state = buildState(nexus, liveSummaries());
// The status log is read as a capped tail, so track the last line seen rather than a count.
const sig = e => e && `${e.ts}|${e.from}|${e.text}`;
let lastSig = sig(readEvents().at(-1));
const clients = new Set();

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const res of clients) send(res, event, data); }

function refresh(reason) {
  const events = readEvents();
  // New status-log lines become packets on the map.
  const at = lastSig ? events.findLastIndex(e => sig(e) === lastSig) : -1;
  const fresh = at >= 0 ? events.slice(at + 1) : (lastSig ? events.slice(-5) : events);
  lastSig = sig(events.at(-1)) || lastSig;
  state = buildState(nexus, liveSummaries());
  broadcast('state', state);
  if (fresh.length) broadcast('events', fresh);
  if (reason && reason !== 'log' && reason !== 'tick') console.log(`[${new Date().toLocaleTimeString()}] refreshed (${reason})`);
}

// Coalesce bursts (an agent writes several log lines per step) into one push.
let pending = null;
const soon = reason => { if (!pending) pending = setTimeout(() => { pending = null; refresh(reason); }, 300); };

try { fs.watch(STATUS_DIR, () => soon('status')); } catch (e) { console.error('Status folder watch failed:', e.message); }
setInterval(() => { try { if (watcher.poll()) soon('log'); } catch (e) { console.error('Log poll failed:', e.message); } }, POLL_MS);
setInterval(() => { try { resolveSessions(); soon('log'); } catch (e) { console.error('Session scan failed:', e.message); } }, RESOLVE_MS);
setInterval(() => soon('tick'), TICK_MS); // states like "stalled" change with time alone
setInterval(() => {
  try {
    const next = readNexusHandoffs();
    if (next.length !== nexus.length || next[0]?.id !== nexus[0]?.id) { nexus = next; refresh('nexus'); }
  } catch (e) { console.error('Nexus read failed:', e.message); }
}, NEXUS_POLL_MS);

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) { res.writeHead(403); return res.end('Forbidden'); }
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname === '/api/state') return json(res, state);
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    clients.add(res);
    send(res, 'state', state);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/events') return json(res, clientEvents(url.searchParams.get('client') || '')); // Replay history
  if (url.pathname.startsWith('/api/shot/')) {
    // Latest screenshot an agent or session took, straight from its log.
    const key = decodeURIComponent(url.pathname.slice('/api/shot/'.length));
    const file = key.startsWith('s-') ? map.live.find(f => path.basename(f, '.jsonl') === key.slice(2)) : map.agentFile[key];
    const shot = file && watcher.shot(file);
    if (!shot) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': shot.media, 'Cache-Control': 'no-store' });
    return res.end(Buffer.from(shot.data, 'base64'));
  }
  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
  catch { res.writeHead(400); return res.end('Bad request'); } // malformed %-escape must not crash the server
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Agent command center: http://${HOST}:${PORT}`);
  console.log(`Status folder: ${STATUS_DIR}`);
  console.log(`Following ${Object.keys(map.agentFile).length} agent logs and ${map.live.length} recent sessions`);
});
