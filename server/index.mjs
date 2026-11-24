// Local, read-only server for the Agents Dashboard. Serves public/ and pushes
// state changes to the page over Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATUS_DIR, buildState, readEvents, readNexusHandoffs, clientEvents } from './state.mjs';

const PORT = Number(process.env.PORT || 4327);
const HOST = '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const NEXUS_POLL_MS = 30_000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

fs.mkdirSync(STATUS_DIR, { recursive: true });

let nexus = readNexusHandoffs();
let state = buildState(nexus);
// The log is read as a capped tail, so track the last line seen rather than a count.
const sig = e => e && `${e.ts}|${e.from}|${e.text}`;
let lastSig = sig(readEvents().at(-1));
const clients = new Set();

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const res of clients) send(res, event, data); }

function refresh(reason) {
  const events = readEvents();
  // New log lines become live packets on the canvas.
  const at = lastSig ? events.findLastIndex(e => sig(e) === lastSig) : -1;
  const fresh = at >= 0 ? events.slice(at + 1) : (lastSig ? events.slice(-5) : events);
  lastSig = sig(events.at(-1)) || lastSig;
  state = buildState(nexus);
  broadcast('state', state);
  if (fresh.length) broadcast('events', fresh);
  if (reason) console.log(`[${new Date().toLocaleTimeString()}] refreshed (${reason})`);
}

let timer = null;
fs.watch(STATUS_DIR, () => { clearTimeout(timer); timer = setTimeout(() => refresh('status'), 250); });
setInterval(() => {
  const next = readNexusHandoffs();
  if (next.length !== nexus.length || next[0]?.id !== nexus[0]?.id) { nexus = next; refresh('nexus'); }
}, NEXUS_POLL_MS);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state));
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    clients.add(res);
    send(res, 'state', state);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/events') {
    // Full logged history for one client, used by Replay.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(clientEvents(url.searchParams.get('client') || '')));
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
  console.log(`Agents Dashboard: http://${HOST}:${PORT}`);
  console.log(`Status folder: ${STATUS_DIR}`);
});
