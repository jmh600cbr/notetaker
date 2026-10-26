// Builds a Word document (.docx) from a meeting's notes and transcript.
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Header,
  Footer,
  AlignmentType,
  PageNumber,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} = require('docx');
const { formatTimestamp } = require('./summarize');

const FONT = 'Calibri';

// Inline markdown tokens -> text runs (bold, italic, code; links become text).
function runs(tokens, style = {}) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'strong':
        out.push(...runs(t.tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...runs(t.tokens, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...runs(t.tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push(new TextRun({ text: decode(t.text), font: 'Consolas', ...style }));
        break;
      case 'br':
        out.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'link':
      case 'text':
        if (t.tokens && t.tokens.length) out.push(...runs(t.tokens, style));
        else out.push(new TextRun({ text: decode(t.text), ...style }));
        break;
      case 'checkbox':
        break; // rendered by the list item
      case 'html':
        // AI output is untrusted: keep only the text of any HTML.
        if (stripTags(t.text)) out.push(new TextRun({ text: decode(stripTags(t.text)), ...style }));
        break;
      default:
        if (t.text) out.push(new TextRun({ text: decode(t.text), ...style }));
    }
  }
  return out;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];

// Block markdown tokens -> paragraphs and tables.
function blocks(tokens, level = 0) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[Math.min(t.depth, 4) - 1], children: runs(t.tokens) }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: runs(t.tokens), spacing: { after: 120 } }));
        break;
      case 'list':
        t.items.forEach((item, i) => {
          const toks = item.tokens.filter((x) => x.type !== 'checkbox');
          const [first, ...rest] = toks;
          const inline = first && (first.type === 'text' || first.type === 'paragraph') ? first.tokens || [first] : [];
          const indent = { left: 360 * (level + 1), hanging: 360 };
          let para;
          if (item.task) {
            para = new Paragraph({ children: [new TextRun(item.checked ? '☑  ' : '☐  '), ...runs(inline)], indent });
          } else if (t.ordered) {
            para = new Paragraph({ children: [new TextRun(`${(t.start || 1) + i}. `), ...runs(inline)], indent });
          } else {
            para = new Paragraph({ children: runs(inline), bullet: { level: Math.min(level, 8) } });
          }
          out.push(para);
          out.push(...blocks(inline.length ? rest : toks, level + 1));
        });
        break;
      case 'html':
        if (stripTags(t.text).trim()) out.push(new Paragraph({ children: [new TextRun(decode(stripTags(t.text)))] }));
        break;
      case 'blockquote':
        for (const p of blocks(t.tokens, level)) out.push(p);
        break;
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } } }));
        break;
      case 'table':
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: t.header.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c.tokens, { bold: true }) })] })),
              }),
              ...t.rows.map(
                (row) => new TableRow({ children: row.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c.tokens) })] })) }),
              ),
            ],
          }),
        );
        break;
      case 'code':
        out.push(new Paragraph({ children: [new TextRun({ text: t.text, font: 'Consolas' })] }));
        break;
      case 'space':
        break;
      default:
        if (t.text) out.push(new Paragraph({ children: [new TextRun(decode(t.text))] }));
    }
  }
  return out;
}

function imageType(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpg' : null;
}

function header({ headerText, logoPath }) {
  const children = [];
  if (logoPath && imageType(logoPath)) {
    try {
      children.push(
        new Paragraph({
          children: [new ImageRun({ type: imageType(logoPath), data: fs.readFileSync(logoPath), transformation: { width: 140, height: 46 } })],
        }),
      );
    } catch {
      // logo missing: skip it
    }
  }
  if (headerText) {
    for (const line of headerText.split('\n')) {
      children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: line, size: 18, color: '666666' })] }));
    }
  }
  return children.length ? new Header({ children }) : undefined;
}

async function buildDocx({ meeting, segments, headerText = '', logoPath = '' }) {
  const date = new Date(meeting.createdAt);
  const minutes = Math.max(1, Math.round((meeting.durationSec || 0) / 60));
  const speakers = meeting.speakers || {};
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(meeting.title)] }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: [
            date.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
            date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }),
            `${minutes} min`,
            meeting.matter ? `Matter: ${meeting.matter}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          color: '666666',
        }),
      ],
    }),
  ];

  if (meeting.timeEntry && meeting.timeEntry.description) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Time Entry')] }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({ text: `${meeting.timeEntry.hours.toFixed(1)} h — `, bold: true }), new TextRun(meeting.timeEntry.description)],
      }),
    );
  }

  children.push(...blocks(marked.lexer(meeting.summary || '_No notes yet._')));

  if (segments.length) {
    children.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, children: [new TextRun('Transcript')] }));
    for (const s of segments) {
      children.push(
        new Paragraph({
          spacing: { after: 100 },
          children: [
            new TextRun({ text: `[${formatTimestamp(s.start)}] `, color: '888888' }),
            new TextRun({ text: `${speakers[s.speaker] || `Speaker ${s.speaker}`}: `, bold: true }),
            new TextRun(s.text),
          ],
        }),
      );
    }
  }

  const doc = new Document({
    creator: 'Sidebar',
    title: meeting.title,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [
      {
        headers: { default: header({ headerText, logoPath }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: 'AI-generated notes. Check important details against the transcript. · Page ', size: 16, color: '888888' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '888888' }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };
