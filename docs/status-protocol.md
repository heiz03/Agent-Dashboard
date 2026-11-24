# Agent status protocol

Each agent session reports to the Agents Dashboard with one command. The dashboard only reads these files, so it can't change anything.

**Where the files live:** `D:\Files\Work Files\Workspace\Agents\status\`
- `<agent>.json`: the agent's current state (one file per agent).
- `events.jsonl`: one line per message or result. These lines drive the moving dots on the canvas and the activity feed.

**Agent keys:** `review`, `ads`, `crm`, `gtm`, `ga4`, `ec`, `dev`, `a2p`, `gsc`

## Commands

Run them from any folder. In PowerShell:

```powershell
$r = "D:\Files\Work Files\Workspace\Agents\agents-dashboard\scripts\report.mjs"
```

| When | Command |
|---|---|
| Starting a client | `node $r --agent crm --state working --client EMDR --progress 3/18 --tab 1565248432` |
| **Moving to a section (every time)** | `node $r --agent crm --client EMDR --section "Forms" --detail "Reading the Contact Us form fields"` |
| Section checked | `node $r --agent crm --client EMDR --section "Forms" --section-status ok` |
| Section has an issue | `node $r --agent crm --client EMDR --section "Forms" --section-status issue --note "No Text Message Consent checkbox"` |
| Finished a client (result for Agent Review) | `node $r --agent crm --client EMDR --client-status done --note "Matches SOP"` |
| Found a mistake | `node $r --agent gtm --client Cedar --client-status mistake --note "Label oeF6... matches no action"` |
| Messaging another agent | `node $r --agent ads --to gtm --client Delta --message "Google Tag ID is AW-..."` |
| Blocked and needs Josh | `node $r --agent crm --state blocked --client EMDR --needs-josh "Open the Number Pools page in the Agent CRM group"` |
| Unblocked | `node $r --agent crm --state working --clear-needs` |
| Waiting on another agent | `node $r --agent review --state waiting --waiting-on ga4 --client Birch` |
| All clients finished | `node $r --agent gtm --state done --progress 16/16` |

**Sections:** each agent's list is in `config\agents.json` (`sections`). Use those exact names; `report.mjs` rejects others.
- `review`: Collect results, Cross-check SOP, Report
- `ads`: Conversion actions, Goals, Campaign goals, Values and settings, Networks, Call assets
- `crm`: Forms, Calendars, Workflows, Numbers, Number pool
- `gtm`: Container, Google tag, Conversion Linker, Click to call, Form fill, Calendar booking, Live site
- `ga4`: Data stream, Key events, Ads link
- `ec`: Ads EC setting, EC for leads, Tag user data

**Live view rule:** report `--section` every time you move to a new section or client, before you start reading it. The Live now panel shows it within a second. A working agent with no report for 5 minutes is flagged "No update".

**Values:**
- `--section-status`: `ok`, `issue`, `working`, `skip`
- `--detail`: what you are reading right now (one short line)
- `--tab`: the one ep3 tab ID you are using
- `--state`: `working`, `waiting`, `blocked`, `done`, `idle`
- `--client-status`: `done`, `mistake`, `working`, `blocked`, `pending`, `skipped`
- `--to`: `josh`, `report` or an agent key
- `--kind` (optional): `message`, `blocked`, `done`, `status`

**Client names:** use the short names from `config\clients.json` (for example Acme, Birch, Cedar) or the full names. Both work.

## Text to give each agent

Paste this into an agent's session, changing the key:

> From now on, report your progress to the Agents Dashboard. Your agent key is `crm`. Use the commands in `D:\Files\Work Files\Workspace\Agents\agents-dashboard\docs\status-protocol.md`: set your state when you start, finish or get blocked, report `--section` every time you move to a new section or client, record each section with `--section-status`, record each client's result with `--client-status`, and log every message you send another agent with `--to`. Never put passwords, API keys or client personal data in a status.

The Review column is worked out automatically: a client shows **Ready** once Google Ads, CRM, GTM, GA4 and Enhanced Conversion all have `done`, `mistake` or `skipped` for it. When Agent Review records its own result for that client, the column shows that result instead.

If an agent never reports, its card still shows its latest Nexus save, labeled "from Nexus save".
