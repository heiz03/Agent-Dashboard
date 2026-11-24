# Agents Dashboard

A local, read-only dashboard that shows what each agent session is doing: Review, Google Ads, CRM, GTM, GA4, Enhanced Conversion, Developer, A2P and GSC.

- **Canvas (top):** Josh → Agent Review → each agent → its tools. A dot travels along a wire when one agent messages another. Nodes spin while working, turn green when done, and turn red when blocked, with a red wire to Josh.
- **Below the canvas:** a "Waiting on you" bar, agent cards with progress and an "Open session" link, a client-by-agent grid (click a row for details) and an activity feed.
- **Replay:** pick a client at the top and press Play to replay its logged messages on the canvas.

Times show in Pacific time. Requires Node.js 24 or newer. No npm packages.

## Run

```powershell
Set-Location 'D:\Files\Work Files\Workspace\Agents\agents-dashboard'
npm start
```

Open http://127.0.0.1:4327. Ctrl+C stops it.

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

1. **Agent status files:** `D:\Files\Work Files\Workspace\Agents\status\`. Agents update them with `scripts\report.mjs`. See [docs/status-protocol.md](docs/status-protocol.md).
2. **Nexus saves (fallback):** the last 4 days of handoffs in `D:\Files\Work Files\Workspace\Nexus\sessions\`, matched to agents by topic (`config\agents.json`, `topicPattern`). Re-read every 30 seconds.

Status file changes show up within about a second. Superseded Nexus saves are ignored.

## Configure

- `config\agents.json`: agents, roles, tools, session IDs (for "Open session") and Nexus topic patterns.
- `config\clients.json`: GHL clients and their Google Ads List.xlsx rows. Private and git-ignored: copy `config\clients.example.json` to start; without it the example list is used.
- Environment overrides: `PORT`, `AGENTS_STATUS_DIR`, `NEXUS_DIR`.

## Test

```powershell
npm test
```

## Files

| Path | Purpose |
|---|---|
| `server\index.mjs` | HTTP server, live updates over Server-Sent Events |
| `server\state.mjs` | Reads status files, the event log and Nexus saves |
| `public\canvas.js` | Workflow canvas and moving dots |
| `public\app.js` | Cards, grid, blockers, feed, replay |
| `scripts\report.mjs` | Command agents run to report status |
| `scripts\Start-Dashboard.ps1` | Starts the server hidden and opens Edge |
| `scripts\Install-Shortcut.ps1` | Adds or removes the shortcut |
