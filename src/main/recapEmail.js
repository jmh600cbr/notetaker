// The follow-up email Sidebar sends after a meeting: action items, topics and
// decisions with timestamps that open the meeting in Sidebar at that moment.
//
// Everything in it comes from the AI recap of what people said, so all text
// is escaped; the only formatting allowed through is **bold**.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function rich(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong style="color:#182033">$1</strong>');
}

function plain(s) {
  return String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1');
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function link(meeting, t) {
  return `sidebar://meeting/${encodeURIComponent(meeting.id)}${t === undefined ? '' : `?t=${Math.floor(t)}`}`;
}

// "Oct 28, 5:00 – 5:30 PM"
function when(meeting) {
  const start = new Date(meeting.createdAt);
  const end = new Date(start.getTime() + (meeting.recordedSec || meeting.durationSec || 0) * 1000);
  const day = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const t = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const [s, e] = [t(start), t(end)];
  const sameHalf = s.slice(-2) === e.slice(-2);
  return `${day}, ${sameHalf ? s.slice(0, -3) : s} – ${e}`;
}

function counts(recap) {
  const n = recap.actionItems.length;
  const m = recap.decisions.length;
  return `${n} action item${n === 1 ? '' : 's'}, ${m} decision${m === 1 ? '' : 's'}`;
}

function subject(meeting, recap) {
  const day = new Date(meeting.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `📝 ${meeting.title} on ${day} — ${counts(recap)}`;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function chip(meeting, t) {
  return `<a href="${link(meeting, t)}" style="display:inline-block;background:#f6ecd6;color:#7a5610;font-size:12px;font-weight:600;line-height:18px;padding:0 6px;border-radius:4px;text-decoration:none;font-family:${FONT}">${clock(t)}</a>`;
}

function itemRow(meeting, html, t) {
  return `<tr>
    <td valign="top" style="width:14px;padding:0 0 12px 0;color:#667089;font-size:15px;line-height:22px">•</td>
    <td valign="top" style="padding:0 12px 12px 4px;color:#3b4459;font-size:15px;line-height:22px;font-family:${FONT}">${html}</td>
    <td valign="top" align="right" style="padding:2px 0 12px 0;white-space:nowrap">${t === undefined ? '' : chip(meeting, t)}</td>
  </tr>`;
}

function list(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.join('')}</table>`;
}

function heading(text, size = 19) {
  return `<h2 style="margin:28px 0 12px;font-size:${size}px;line-height:1.3;color:#182033;font-family:${FONT}">${text}</h2>`;
}

function buildRecapHtml({ meeting, recap, footer = '' }) {
  const sections = [];

  if (meeting.timeEntry && meeting.timeEntry.description) {
    sections.push(
      `<p style="margin:20px 0 0;padding:10px 14px;background:#faf6ec;border-left:4px solid #c9993a;border-radius:6px;color:#3b4459;font-size:14px;line-height:20px;font-family:${FONT}"><strong style="color:#182033">Time entry: ${esc(meeting.timeEntry.hours.toFixed(1))} h</strong> — ${esc(meeting.timeEntry.description)}</p>`,
    );
  }

  sections.push(heading(`Action Items (${recap.actionItems.length})`));
  sections.push(
    recap.actionItems.length
      ? list(recap.actionItems.map((a) => itemRow(meeting, `<strong style="color:#182033">${esc(a.owner)}</strong> to ${rich(a.task)}${a.due ? ` <span style="color:#667089">(by ${esc(a.due)})</span>` : ''}`, a.t)))
      : `<p style="margin:0;color:#667089;font-size:15px;font-family:${FONT}">No action items.</p>`,
  );

  const marks = meeting.marks || [];
  if (marks.length) {
    sections.push(heading(`Flagged Moments (${marks.length})`));
    sections.push(list(marks.map((m) => itemRow(meeting, m.label ? esc(m.label) : '<span style="color:#667089">Marked during the call</span>', m.t))));
  }

  if (recap.topics.length) {
    sections.push(heading('Topics'));
    recap.topics.forEach((topic, i) => {
      sections.push(`<h3 style="margin:18px 0 10px;font-size:16px;line-height:1.35;color:#182033;font-family:${FONT}">${i + 1}. ${esc(topic.title)}</h3>`);
      sections.push(list(topic.points.map((p) => itemRow(meeting, rich(p.text), p.t))));
    });
  }

  sections.push(heading(`Decisions (${recap.decisions.length})`));
  sections.push(
    recap.decisions.length
      ? list(recap.decisions.map((d) => itemRow(meeting, rich(d.text), d.t)))
      : `<p style="margin:0;color:#667089;font-size:15px;font-family:${FONT}">No decisions recorded.</p>`,
  );

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meeting.title)}</title></head>
<body style="margin:0;padding:0;background:#f3f2ee">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(counts(recap))}${meeting.matter ? ` · ${esc(meeting.matter)}` : ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f2ee"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
    <tr><td style="padding:4px 8px 16px;font-family:${FONT}">
      <span style="display:inline-block;width:8px;height:20px;background:#c9993a;border-radius:2px;vertical-align:middle"></span>
      <span style="font-size:18px;font-weight:700;color:#10172a;vertical-align:middle;padding-left:6px">Sidebar</span>
    </td></tr>
    <tr><td style="background:#ffffff;border-radius:14px;padding:28px 28px 20px;font-family:${FONT}">
      <span style="display:inline-block;background:#f6ecd6;color:#7a5610;font-size:11px;font-weight:700;letter-spacing:0.6px;padding:3px 8px;border-radius:4px">MEETING NOTES</span>
      <p style="margin:14px 0 14px;color:#3b4459;font-size:15px">Here are your notes from Sidebar:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f1;border-radius:10px"><tr><td style="padding:20px">
        <div style="font-size:18px;font-weight:700;color:#182033;line-height:1.35">${esc(meeting.title)}</div>
        <div style="font-size:15px;color:#667089;margin-top:6px">${esc(when(meeting))}${meeting.matter ? ` · ${esc(meeting.matter)}` : ''}</div>
        <a href="${link(meeting)}" style="display:inline-block;margin-top:16px;background:#10172a;color:#ffffff;font-size:15px;font-weight:600;padding:10px 18px;border-radius:7px;text-decoration:none">View in Sidebar</a>
      </td></tr></table>
      ${sections.join('\n')}
    </td></tr>
    <tr><td style="padding:18px 12px;color:#8a90a0;font-size:12px;line-height:18px;text-align:center;font-family:${FONT}">
      ${footer ? `${esc(footer).replace(/\n/g, '<br>')}<br>` : ''}AI-generated notes from Sidebar. Check important details against the transcript.<br>Timestamps open the meeting in Sidebar on this computer.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function buildRecapText({ meeting, recap }) {
  const lines = [meeting.title, when(meeting) + (meeting.matter ? ` · ${meeting.matter}` : ''), ''];
  if (meeting.timeEntry && meeting.timeEntry.description) {
    lines.push(`Time entry: ${meeting.timeEntry.hours.toFixed(1)} h — ${meeting.timeEntry.description}`, '');
  }
  lines.push(`ACTION ITEMS (${recap.actionItems.length})`);
  for (const a of recap.actionItems) lines.push(`- ${a.owner} to ${plain(a.task)}${a.due ? ` (by ${a.due})` : ''} [${clock(a.t)}]`);
  lines.push('');
  if (recap.topics.length) {
    lines.push('TOPICS');
    recap.topics.forEach((tp, i) => {
      lines.push(`${i + 1}. ${tp.title}`);
      for (const p of tp.points) lines.push(`   - ${plain(p.text)} [${clock(p.t)}]`);
    });
    lines.push('');
  }
  lines.push(`DECISIONS (${recap.decisions.length})`);
  for (const d of recap.decisions) lines.push(`- ${plain(d.text)} [${clock(d.t)}]`);
  lines.push('', 'AI-generated notes from Sidebar. Check important details against the transcript.');
  return lines.join('\n');
}

function buildRecapEmail({ meeting, recap, footer }) {
  return {
    subject: subject(meeting, recap),
    html: buildRecapHtml({ meeting, recap, footer }),
    text: buildRecapText({ meeting, recap }),
  };
}

function asciiName(name) {
  return name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '') || 'notes.docx';
}

// An unsent email file. Outlook opens files marked X-Unsent as a draft ready
// to send; used when Sidebar isn't connected to Microsoft 365.
function buildEml({ to, subject: subj, html, text, attachments = [] }) {
  const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/.{76}/g, '$&\r\n');
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subj).toString('base64')}?=`;
  const alt = `alt-${Date.now().toString(36)}`;
  const mixed = `mix-${Date.now().toString(36)}`;
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${alt}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${alt}--`,
  ].join('\r\n');
  const headers = [
    ...(to ? [`To: ${to}`] : []),
    `Subject: ${encodedSubject}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
  ];
  if (!attachments.length) return [...headers, altPart, ''].join('\r\n');
  const parts = attachments.map((a) =>
    [
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${asciiName(a.name)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${asciiName(a.name)}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      '',
      b64(a.data),
    ].join('\r\n'),
  );
  return [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, altPart, ...parts, `--${mixed}--`, ''].join('\r\n');
}

module.exports = { buildRecapEmail, buildEml, clock };
