# Agent Command Center

A local, read-only command center that shows what every agent and Claude session is doing, as it happens.

- **Top bar:** how many are working, need you or look stalled, steps per minute, tokens today, live sessions, and Pacific and Philippine clocks.
- **Alerts:** an agent waiting on your answer (red) or mid-task but silent for 4 minutes (orange), with an Open session button.
- **Tiles:** one per configured agent plus every Claude session active in the last 3 hours. Each shows the step it is on right now in plain words, how long it has been on it, its latest browser screenshot, a 30-minute activity sparkline and tokens today. Active tiles come first. Click a tile for details: recent steps, a larger screenshot and the client checklist.
- **Live log:** every step from every session, newest first, with filters and pause.
- **Who's talking to whom:** Josh on top, Agent Review, then the agents. Wires animate for working agents; a red wire shows who is waiting on you. Replay plays a client's logged messages.
- **Last 4 hours:** one lane per tile showing busy stretches, waits and stalls.
- **Client results:** the per-client grid from agent reports (collapsed).

Times show in Pacific time. Requires Node.js 24 or newer. No npm packages.

## Run

```powershell
Set-Location 'D:\Files\Work Files\Workspace\Agents\agents-dashboard'
npm start
```

Open http://127.0.0.1:4327. Ctrl+C stops it. `node server/index.mjs --port 4328` runs a second copy beside it.

Or start it hidden and open its own Edge window:

```powershell
& 'D:\Files\Work Files\Workspace\Agents\agents-dashboard\scripts\Start-Dashboard.ps1'
```

Desktop and Start menu shortcut (preview first, then apply):

```powershell
& 'D:\Files\Work Files\Workspace\Agents\agents-dashboard\scripts\Install-Shortcut.ps1'
& 'D:\Files\Work Files\Workspace\Agents\agents-dashboard\scripts\Install-Shortcut.ps1' -Apply
```

## Where the data comes from

1. **Claude session logs (live):** every Claude Code session writes its steps to `%USERPROFILE%\.claude\projects\<folder>\<id>.jsonl`. The server reads new lines every second, so tiles and the log update within about a second. Each configured agent is matched to its newest log by its session title (`sessionTitle` in `config\agents.json`); any other log written in the last `liveWindowHours` (default 3) gets its own tile. Screenshots come from the same logs and are served only to this PC.
2. **Agent status files:** `D:\Files\Work Files\Workspace\Agents\status\`, written by `scripts\report.mjs` (see [docs/status-protocol.md](docs/status-protocol.md)). They add the client, section, checklist and progress. A report older than 12 hours no longer drives the live view.
3. **Nexus saves:** the last 4 days of handoffs, matched to agents by topic (`topicPattern`).

How a state is decided from a log: **working** = mid-turn with a step in the last 4 minutes; **stalled** = mid-turn and silent longer than that (for up to 2 hours); **needs you** = an open question, or a wrap-up marked blocked (for up to 12 hours); **idle** = the turn finished.

The server answers only requests addressed to `127.0.0.1` or `localhost` on its own port, so other websites can't read session content.

## Configure

- `config\agents.json`: agents, roles, tools, desktop session IDs (for "Open session"), `sessionTitle` (to find each agent's log), Nexus topic patterns and `liveWindowHours`.
- `config\clients.json`: GHL clients and their Google Ads List.xlsx rows. Private and git-ignored: copy `config\clients.example.json` to start; without it the example list is used.
- Environment overrides: `PORT`, `AGENTS_STATUS_DIR`, `NEXUS_DIR`, `CLAUDE_PROJECTS_DIR`.

## Test

```powershell
npm test
```

## Files

| Path | Purpose |
|---|---|
| `server\index.mjs` | HTTP server, log polling, live updates over Server-Sent Events, screenshots |
| `server\sessions.mjs` | Finds and follows Claude session logs; works out each session's live state |
| `server\describe.mjs` | Turns tool calls into plain-English steps |
| `server\state.mjs` | Merges session logs, status files and Nexus saves into one picture |
| `public\app.js` | Top bar, alerts, tiles, live log, details panel, client results |
| `public\map.js` | Who's-talking map, packets and the 4-hour timeline |
| `scripts\report.mjs` | Command agents run to report status |
| `scripts\Start-Dashboard.ps1` | Starts the server hidden and opens Edge |
| `scripts\Install-Shortcut.ps1` | Adds or removes the shortcut |
