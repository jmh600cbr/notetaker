#!/usr/bin/env node
// Sidebar for Claude: a read-only MCP server that lets Claude look up your
// Sidebar meetings (notes, transcripts, matters and time entries).
//
// It reads Sidebar's local data folder directly, so Sidebar doesn't need to
// be running. It only answers when "Let Claude read my meetings" is turned on
// in Sidebar's Settings, and never while Sidebar is locked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const MAX_TRANSCRIPT_CHARS = 300000;

function dataDir() {
  if (process.env.SIDEBAR_DATA_DIR) return process.env.SIDEBAR_DATA_DIR;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Sidebar');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Sidebar');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Sidebar');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Returns an error message if Claude isn't allowed to read meetings right now.
function accessProblem() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) return `Sidebar's data wasn't found at ${dir}. Is Sidebar installed on this computer?`;
  const settings = readJson(path.join(dir, 'settings.json'), {});
  if (!settings.claudeAccess) {
    return 'Access is turned off. In Sidebar, open Settings → Claude and turn on "Let Claude read my meetings".';
  }
  if (fs.existsSync(path.join(dir, 'locked'))) return 'Sidebar is locked. Unlock Sidebar, then try again.';
  return null;
}

function meetings() {
  const dir = path.join(dataDir(), 'meetings');
  let ids = [];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return ids
    .filter((id) => /^[\w-]+$/.test(id))
    .map((id) => readJson(path.join(dir, id, 'meeting.json'), null))
    .filter((m) => m && m.id && m.status !== 'recording')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function transcript(id) {
  if (!/^[\w-]+$/.test(id)) return [];
  return readJson(path.join(dataDir(), 'meetings', id, 'transcript.json'), []);
}

function ts(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function summaryLine(m) {
  return [
    `- **${m.title}** (id: ${m.id})`,
    localDate(m.createdAt),
    m.matter ? `matter: ${m.matter}` : null,
    `${Math.max(1, Math.round((m.durationSec || 0) / 60))} min`,
    m.status === 'ready' ? null : m.status,
  ]
    .filter(Boolean)
    .join(' · ');
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

function guarded(fn) {
  return async (args) => {
    const problem = accessProblem();
    if (problem) return fail(problem);
    try {
      return await fn(args || {});
    } catch (err) {
      return fail(`Sidebar couldn't do that: ${err.message}`);
    }
  };
}

const server = new McpServer({ name: 'sidebar', version: '0.1.0' });
const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  'list_meetings',
  {
    title: 'List meetings',
    description: 'List recorded meetings (newest first), optionally only those in a matter or since a date. Returns titles, ids, dates, matters and durations.',
    inputSchema: {
      matter: z.string().optional().describe('Only meetings filed under this matter (exact name, see list_matters)'),
      since: z.string().optional().describe('Only meetings on or after this date, YYYY-MM-DD'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of meetings (default 25)'),
    },
    annotations: readOnly,
  },
  guarded(({ matter, since, limit = 25 }) => {
    const list = meetings()
      .filter((m) => !matter || m.matter === matter)
      .filter((m) => !since || localDate(m.createdAt) >= since)
      .slice(0, limit);
    if (!list.length) return text('No meetings found.');
    return text(list.map(summaryLine).join('\n'));
  }),
);

server.registerTool(
  'search_meetings',
  {
    title: 'Search meetings',
    description: 'Search meeting titles, matters, notes and full transcripts for words or a phrase. Returns matching meetings with the matching lines and timestamps.',
    inputSchema: {
      query: z.string().min(2).describe('Words or phrase to find'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum number of meetings (default 10)'),
    },
    annotations: readOnly,
  },
  guarded(({ query, limit = 10 }) => {
    const q = query.toLowerCase();
    const results = [];
    for (const m of meetings()) {
      const hits = [];
      if ([m.title, m.matter].join(' ').toLowerCase().includes(q)) hits.push('(title or matter)');
      for (const line of (m.summary || '').split('\n')) {
        if (line.toLowerCase().includes(q)) hits.push(`notes: ${line.trim().slice(0, 200)}`);
      }
      const speakers = m.speakers || {};
      for (const seg of transcript(m.id)) {
        if (seg.text.toLowerCase().includes(q)) {
          hits.push(`[${ts(seg.start)}] ${speakers[seg.speaker] || `Speaker ${seg.speaker}`}: ${seg.text.slice(0, 240)}`);
        }
      }
      if (hits.length) results.push(`${summaryLine(m)}\n${hits.slice(0, 5).map((h) => `    ${h}`).join('\n')}`);
      if (results.length >= limit) break;
    }
    return text(results.length ? results.join('\n\n') : `Nothing matched "${query}".`);
  }),
);

server.registerTool(
  'get_meeting',
  {
    title: 'Get meeting',
    description: 'Get one meeting: its notes, time entry, flagged moments and speakers, and optionally the full transcript with timestamps.',
    inputSchema: {
      id: z.string().describe('Meeting id from list_meetings or search_meetings'),
      include_transcript: z.boolean().optional().describe('Include the full transcript (can be long). Default false.'),
    },
    annotations: readOnly,
  },
  guarded(({ id, include_transcript = false }) => {
    const m = meetings().find((x) => x.id === id);
    if (!m) return fail(`No meeting with id ${id}.`);
    const speakers = m.speakers || {};
    const parts = [
      `# ${m.title}`,
      `Date: ${new Date(m.createdAt).toLocaleString('en-CA')}${m.matter ? ` · Matter: ${m.matter}` : ''} · ${Math.max(1, Math.round((m.durationSec || 0) / 60))} min`,
    ];
    if (Object.keys(speakers).length) parts.push(`Speakers: ${Object.values(speakers).join(', ')}`);
    if (m.timeEntry && m.timeEntry.description) parts.push(`Time entry: ${m.timeEntry.hours.toFixed(1)} h — ${m.timeEntry.description}`);
    if ((m.marks || []).length) {
      parts.push(`Flagged moments:\n${m.marks.map((k) => `- [${ts(k.t)}]${k.label ? ` ${k.label}` : ''}`).join('\n')}`);
    }
    parts.push('', '## Notes', m.summary || '(No notes yet.)');
    if (include_transcript) {
      const lines = transcript(m.id).map((s) => `[${ts(s.start)}] ${speakers[s.speaker] || `Speaker ${s.speaker}`}: ${s.text}`);
      let body = lines.join('\n');
      if (!lines.length) body = m.transcriptDeleted ? '(The transcript was deleted by the retention setting.)' : '(No transcript.)';
      if (body.length > MAX_TRANSCRIPT_CHARS) body = `${body.slice(0, MAX_TRANSCRIPT_CHARS)}\n…(transcript truncated)`;
      parts.push('', '## Transcript', body);
    }
    return text(parts.join('\n'));
  }),
);

server.registerTool(
  'list_matters',
  {
    title: 'List matters',
    description: 'List the matters meetings are filed under, with how many meetings each has and the date range.',
    inputSchema: {},
    annotations: readOnly,
  },
  guarded(() => {
    const byMatter = new Map();
    for (const m of meetings()) {
      if (!m.matter) continue;
      const row = byMatter.get(m.matter) || { count: 0, first: m.createdAt, last: m.createdAt };
      row.count += 1;
      if (m.createdAt < row.first) row.first = m.createdAt;
      if (m.createdAt > row.last) row.last = m.createdAt;
      byMatter.set(m.matter, row);
    }
    if (!byMatter.size) return text('No meetings have been filed under a matter yet.');
    return text(
      [...byMatter.entries()]
        .map(([name, r]) => `- ${name}: ${r.count} meeting${r.count === 1 ? '' : 's'} (${localDate(r.first)} to ${localDate(r.last)})`)
        .join('\n'),
    );
  }),
);

server.registerTool(
  'get_time_entries',
  {
    title: 'Get time entries',
    description: 'Get the drafted time entries (hours and narrative) for meetings in a date range and/or matter, with the total hours. Useful for billing.',
    inputSchema: {
      from: z.string().optional().describe('Start date, YYYY-MM-DD (inclusive)'),
      to: z.string().optional().describe('End date, YYYY-MM-DD (inclusive)'),
      matter: z.string().optional().describe('Only this matter'),
    },
    annotations: readOnly,
  },
  guarded(({ from, to, matter }) => {
    const rows = meetings()
      .filter((m) => m.timeEntry && m.timeEntry.description)
      .filter((m) => !matter || m.matter === matter)
      .filter((m) => (!from || localDate(m.createdAt) >= from) && (!to || localDate(m.createdAt) <= to))
      .reverse();
    if (!rows.length) return text('No time entries in that range.');
    const total = rows.reduce((t, m) => t + m.timeEntry.hours, 0);
    return text(
      [
        '| Date | Matter | Hours | Description |',
        '|---|---|---|---|',
        ...rows.map((m) => `| ${localDate(m.createdAt)} | ${m.matter || ''} | ${m.timeEntry.hours.toFixed(1)} | ${m.timeEntry.description.replace(/\|/g, '/')} |`),
        '',
        `Total: ${total.toFixed(1)} h`,
      ].join('\n'),
    );
  }),
);

server.connect(new StdioServerTransport()).catch((err) => {
  console.error('Sidebar MCP server failed to start:', err);
  process.exit(1);
});
