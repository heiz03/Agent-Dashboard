// Turns a raw tool call from a session log into one plain-English step line,
// plus the page URL it touched (for the screenshot frame). Pure functions.

const MAX = 140;
const clip = s => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > MAX ? s.slice(0, MAX - 1) + '…' : s; };
const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || 'a file';
export function shortUrl(u) {
  try { const x = new URL(u); return (x.host.replace(/^www\./, '') + x.pathname).replace(/\/$/, ''); } catch { return null; }
}

// Friendly names for MCP servers whose ids are opaque.
const SERVERS = {
  'claude-in-chrome': 'Chrome', Claude_Browser: 'Browser pane', nexus: 'Nexus', 'seo-sentinel': 'SEO Sentinel',
  ccd_session_mgmt: 'Sessions', ccd_session: 'Sessions', visualize: 'Visual', terminal: 'Terminal', rea: 'REA',
  '4dc4aa8f-e719-4562-b0ed-afed2dc8ce04': 'Google Chat', 'f2ca4736-ccd2-4345-9aa1-e6b99fa20d55': 'Google Drive',
  'f2f8db7c-03e8-4520-b0ca-808e3ed689f9': 'Google Sheets', 'b782402d-7b22-46ac-85ef-476ac3233b21': 'Gmail',
  'a3986d68-3ade-474f-bb70-9ca4d20f2857': 'Calendar', '06b16171-c0af-4b3a-a15e-379a508418a6': 'Google Docs',
};
const words = s => String(s).replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase());

function browserAction(i, where) {
  const a = i.action;
  if (i.action_summary) return i.action_summary;
  if (a === 'screenshot') return `Took a screenshot${where}`;
  if (a === 'scroll' || a === 'scroll_to') return `Scrolled the page${where}`;
  if (a === 'type') return `Typed text${where}`;
  if (a === 'key') return `Pressed ${i.text || 'a key'}${where}`;
  if (a === 'wait') return `Waiting for the page${where}`;
  if (a === 'zoom') return `Zoomed in to read${where}`;
  if (/click/.test(a || '')) return `Clicked on the page${where}`;
  return `${words(a || 'Browser step')}${where}`;
}

// Returns { text, url } for one tool_use block.
export function describe(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const parts = String(name || '').split('__');
  const tool = parts.length >= 3 ? parts.slice(2).join('__') : name;
  const server = parts.length >= 3 ? parts[1] : null;
  const url = i.url ? shortUrl(i.url) : null;
  const where = i.browser ? ` (${i.browser})` : '';
  let text;
  switch (tool) {
    case 'Bash': case 'PowerShell': text = i.description ? `Ran: ${i.description}` : 'Ran a command'; break;
    case 'Read': text = `Reading ${base(i.file_path)}`; break;
    case 'Write': text = `Writing ${base(i.file_path)}`; break;
    case 'Edit': case 'NotebookEdit': text = `Editing ${base(i.file_path || i.notebook_path)}`; break;
    case 'Grep': text = `Searching files for "${i.pattern}"`; break;
    case 'Glob': text = `Finding files ${i.pattern || ''}`; break;
    case 'WebFetch': text = `Reading ${url || 'a web page'}`; break;
    case 'WebSearch': text = `Searching the web: ${i.query || ''}`; break;
    case 'Agent': case 'Task': text = `Started a helper: ${i.description || 'subtask'}`; break;
    case 'AskUserQuestion': text = `Asked you: ${i.questions?.[0]?.question || 'a question'}`; break;
    case 'Skill': text = `Using the ${i.skill} skill`; break;
    case 'ToolSearch': text = 'Loading tools'; break;
    case 'TodoWrite': text = 'Updated its task list'; break;
    case 'update_plan': {
      const cur = Array.isArray(i.items) ? i.items.find(x => x.status === 'in_progress') : null;
      text = cur ? `Plan step: ${cur.content}` : i.advance ? 'Moved to the next plan step' : 'Updated its plan';
      break;
    }
    case 'wrap_up': text = `Wrapped up: ${i.recap || ''}`; break;
    case 'nexus_save_session': text = `Saved to Nexus: ${i.topic || 'session handoff'}`; break;
    case 'nexus_search': text = `Searching Nexus: ${i.query || ''}`; break;
    case 'nexus_read': text = `Reading a Nexus note`; break;
    case 'nexus_browser_command': {
      const target = i.url ? ` ${shortUrl(i.url) || ''}` : i.group ? ` "${i.group}"` : '';
      text = i.action === 'screenshot' ? `Took a screenshot${where}` : `Browser ${words(i.action || 'command').toLowerCase()}${target}${where}`;
      break;
    }
    case 'navigate': text = url ? `Opening ${url}` : `Going ${i.url || 'to a page'}`; break;
    case 'computer': text = browserAction(i, where); break;
    case 'browser_batch': {
      const acts = Array.isArray(i.actions) ? i.actions : [];
      const nav = acts.find(a => a.input?.url);
      const sum = acts.map(a => a.input?.action_summary).find(Boolean);
      text = sum || (nav ? `Opening ${shortUrl(nav.input.url)}` : `Ran ${acts.length} browser steps`);
      if (nav && !url) return { text: clip(text), url: shortUrl(nav.input.url) };
      break;
    }
    case 'form_input': text = i.action_summary || 'Filling in a form field'; break;
    case 'find': text = `Looking for "${i.query || ''}" on the page`; break;
    case 'read_page': case 'get_page_text': text = 'Reading the page'; break;
    case 'javascript_tool': text = 'Running a check on the page'; break;
    case 'Artifact': text = i.action === 'read' ? 'Reading a published page' : 'Publishing a page'; break;
    case 'SendMessage': text = `Messaged ${i.to || 'another session'}`; break;
    default: {
      const label = server ? (SERVERS[server] || words(server)) : null;
      const detail = i.description || i.summary || i.action_summary || i.query || i.topic || '';
      text = `${label ? label + ': ' : ''}${words(tool).toLowerCase()}${detail ? ' · ' + detail : ''}`;
    }
  }
  return { text: clip(text), url };
}

// A question that blocks the session until the user answers: an open AskUserQuestion, or a
// wrap_up marked blocked. A plain end-of-turn "ask" (like "Commit?") is not treated as blocking.
export function questionOf(name, input = {}) {
  const tool = String(name || '').split('__').pop();
  if (tool === 'AskUserQuestion') return clip(input?.questions?.[0]?.question || 'Asked you a question');
  if (tool === 'wrap_up' && input?.blocked) return clip(input.ask || input.recap || 'Waiting on you');
  return null;
}
