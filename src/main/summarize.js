// Meeting summaries and Q&A with Claude.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

// The system prompt and transcript block come first and don't change between
// requests, so repeated questions about the same meeting reuse the cached
// transcript instead of paying for it again.
const SYSTEM_PROMPT = `You are Sidebar, a meticulous note-taker for a law firm. You work only from the meeting transcript you are given.

Ground rules:
- Report only what is in the transcript. Never invent names, dates, amounts, rulings or commitments.
- Speaker labels come from automatic speaker detection and may be generic ("Speaker 2"). When context makes a role clear (e.g. someone addressed as "Your Honour"), you may name the role and mark it "(likely)".
- When something is ambiguous or garbled, say so, e.g. "(unclear in recording)".
- Cite timestamps as [hh:mm:ss] for key moments so the reader can check the transcript.
- Write in clear, concise professional English using Markdown. No preamble.
- Summarize; do not give legal advice or opinions on the merits.`;

const TEMPLATES = {
  court: {
    label: 'Court hearing',
    instructions: `Write hearing notes with these sections (omit any section with nothing to report):

## Overview
2-4 sentences: the type of proceeding, who appeared (if identifiable), and the outcome.

## Rulings, Orders & Directions
Everything the court decided, ordered or directed, with timestamps. Quote the decision-maker's exact words for any order.

## Submissions
A subsection per party or counsel summarizing their main arguments and any concessions.

## Undertakings & Action Items
A checklist: "- [ ] Who — what — deadline".

## Next Dates
Adjourned dates, filing deadlines, and upcoming appearances.

## Key Moments
Bulleted timeline of the most important exchanges with timestamps.`,
  },
  client: {
    label: 'Client meeting',
    instructions: `Write client meeting notes with these sections (omit any section with nothing to report):

## Overview
2-4 sentences on the purpose of the meeting and where things landed.

## Facts & Background
Key facts the client provided.

## Advice Given & Options Discussed

## Client Instructions & Decisions

## Action Items
A checklist: "- [ ] Who — what — deadline".

## Follow-ups & Open Questions`,
  },
  general: {
    label: 'General meeting',
    instructions: `Write meeting notes with these sections (omit any section with nothing to report):

## Overview
2-4 sentences.

## Key Discussion Points

## Decisions

## Action Items
A checklist: "- [ ] Who — what — deadline".

## Open Questions`,
  },
};

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatTranscript(segments, speakers) {
  return segments
    .map((s) => `[${formatTimestamp(s.start)}] ${speakers[s.speaker] || `Speaker ${s.speaker}`}: ${s.text}`)
    .join('\n');
}

function attr(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// The meeting's date and time as the user experienced it (local time), so
// relative deadlines like "within 14 days" or "next Tuesday" resolve correctly.
function localWhen(iso) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time: d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  };
}

function meetingXml(meeting, body) {
  const when = localWhen(meeting.createdAt);
  const matter = meeting.matter ? ` matter="${attr(meeting.matter)}"` : '';
  const marks = (meeting.marks || []).length
    ? `\n<flagged_moments note="Moments the user marked as important while recording.">\n${meeting.marks
        .map((m) => `[${formatTimestamp(m.t)}]${m.label ? ` ${m.label}` : ''}`)
        .join('\n')}\n</flagged_moments>`
    : '';
  return `<meeting title="${attr(meeting.title)}" date="${attr(when.date)}" started="${attr(when.time)}"${matter}>${marks}\n${body}\n</meeting>`;
}

function transcriptBlock(meeting, segments) {
  return {
    type: 'text',
    text: meetingXml(
      meeting,
      `<transcript note="Timestamps are positions in the recording; paused time is not counted.">\n${formatTranscript(segments, meeting.speakers || {})}\n</transcript>`,
    ),
    cache_control: { type: 'ephemeral' },
  };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic rejected the API key. Check it in Settings.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Claude is rate limited right now. Wait a minute and click Retry.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Could not reach Claude. Check your internet connection and click Retry.');
  }
  if (err instanceof Anthropic.APIError) {
    // The SDK puts the whole JSON body in err.message; dig out the readable part.
    const body = err.error && err.error.error ? err.error.error : err.error || {};
    const type = body.type || '';
    const detail = body.message || '';
    if (type === 'overloaded_error' || err.status === 529 || (err.status && err.status >= 500)) {
      return new Error('Claude is busy right now. Wait a minute and click Retry.');
    }
    if (/credit balance/i.test(detail)) {
      return new Error('Your Anthropic account is out of credit. Add credit, then click Retry.');
    }
    return new Error(`Claude couldn't process this${err.status ? ` (${err.status})` : ''}: ${detail || 'unknown error'}`);
  }
  return err;
}

async function askClaude({ apiKey, meeting, segments, blocks, instructions, effort, format, onUsage, maxTokens = 64000 }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to create summaries.');
  if (!blocks && !segments.length) throw new Error('The transcript is empty, so there is nothing to summarize.');
  const client = new Anthropic({ apiKey });
  try {
    const message = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: format ? { effort, format } : { effort },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [...(blocks || [transcriptBlock(meeting, segments)]), { type: 'text', text: instructions }],
          },
        ],
      })
      .finalMessage();
    if (onUsage) onUsage(message.usage);

    if (message.stop_reason === 'refusal') {
      throw new Error('Claude declined to process this transcript.');
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (message.stop_reason === 'max_tokens') {
      return `${text}\n\n_(Output was cut off because it reached the length limit.)_`;
    }
    return text;
  } catch (err) {
    throw friendlyError(err);
  }
}

const FLAGGED_INSTRUCTIONS = `

## Flagged Moments
The user marked the moments listed in <flagged_moments> while recording. For each one, in time order: its timestamp, what was said in the minute or so around it (quote the key words), and why it likely matters. Put this section right after the Overview.`;

function summarize({ apiKey, meeting, segments, onUsage }) {
  const template = TEMPLATES[meeting.template] || TEMPLATES.general;
  const instructions = template.instructions + ((meeting.marks || []).length ? FLAGGED_INSTRUCTIONS : '');
  return askClaude({ apiKey, meeting, segments, instructions, effort: 'high', onUsage });
}

const TIME_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'One-sentence time entry narrative.' },
  },
  required: ['description'],
  additionalProperties: false,
};

// Billing increments of 0.1 h (6 minutes), rounded up.
function billableHours(seconds) {
  return Math.max(0.1, Math.ceil((seconds || 0) / 360) / 10);
}

// A ready-to-paste docket/time entry for the meeting.
async function draftTimeEntry({ apiKey, meeting, segments, onUsage }) {
  const instructions = `Write the narrative for a lawyer's time entry for this meeting: one sentence, past tense, starting with a verb (e.g. "Attended…", "Conference with client re…"), naming the matter or proceeding and the main subject. Keep it factual and suitable for a client invoice: no privileged detail, no opinions, at most 30 words.`;
  const text = await askClaude({
    apiKey,
    meeting,
    segments,
    onUsage,
    instructions,
    effort: 'low',
    maxTokens: 4000,
    format: { type: 'json_schema', schema: TIME_ENTRY_SCHEMA },
  });
  const seconds = meeting.recordedSec || meeting.durationSec;
  return { hours: billableHours(seconds), description: JSON.parse(text).description.trim() };
}

const SPEAKER_SCHEMA = {
  type: 'object',
  properties: {
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The speaker label exactly as it appears in the transcript.' },
          name: { type: 'string', description: 'Name and/or role, e.g. "Justice Okafor", "Opposing counsel (Ms. Patel)", "Court clerk".' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['label', 'name', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['speakers'],
  additionalProperties: false,
};

// The bot never joins the call, so there is no participant list. Instead, work
// out who each voice is from what's said ("Thank you, Your Honour", "Ms. Patel
// for the respondent"). Returns { speakerKey: name } for confident guesses.
async function identifySpeakers({ apiKey, meeting, segments, onUsage }) {
  const labels = meeting.speakers || {};
  const hints = (meeting.keyterms || []).length
    ? `\n\nNames the user expected in this meeting: ${meeting.keyterms.join(', ')}.`
    : '';
  const instructions = `Identify who each speaker label in the transcript is, using only evidence in the transcript: how people are addressed, introductions, appearances entered for the record, and the role their words imply (e.g. the person giving rulings is the judge). "You" is the person who recorded the meeting; leave that label out.

For each other label give a short name and/or role. Use "high" confidence only when the transcript states it directly, "medium" when strongly implied, and "low" when it is a guess.${hints}`;
  const text = await askClaude({
    apiKey,
    meeting,
    segments,
    onUsage,
    instructions,
    effort: 'medium',
    format: { type: 'json_schema', schema: SPEAKER_SCHEMA },
  });
  const byLabel = Object.fromEntries(Object.entries(labels).map(([key, label]) => [label, key]));
  const names = {};
  for (const guess of JSON.parse(text).speakers || []) {
    const key = byLabel[guess.label];
    if (!key || labels[key] === 'You' || guess.confidence === 'low' || !guess.name.trim()) continue;
    names[key] = guess.confidence === 'high' ? guess.name.trim() : `${guess.name.trim()} (?)`;
  }
  return names;
}

// About 4 characters per token; leave plenty of the 1M-token context free.
const MATTER_CHAR_BUDGET = 2400000;

// Questions across every meeting in a matter. Uses full transcripts, falling
// back to the notes for the oldest meetings if the matter is very large.
function answerMatterQuestion({ apiKey, matter, items, question, onUsage }) {
  const sorted = [...items].sort((a, b) => a.meeting.createdAt.localeCompare(b.meeting.createdAt));
  let budget = MATTER_CHAR_BUDGET;
  const parts = [];
  for (const { meeting, segments } of [...sorted].reverse()) {
    const transcript = formatTranscript(segments, meeting.speakers || {});
    const body =
      transcript && transcript.length < budget
        ? `<transcript>\n${transcript}\n</transcript>`
        : `<notes note="Transcript omitted for length; these are the meeting notes.">\n${meeting.summary || ''}\n</notes>`;
    budget -= body.length;
    parts.unshift(meetingXml(meeting, body));
  }
  if (!parts.length) throw new Error('There are no meetings with transcripts in this matter yet.');
  const blocks = [{ type: 'text', text: `<matter name="${attr(matter)}">\n${parts.join('\n\n')}\n</matter>`, cache_control: { type: 'ephemeral' } }];
  const instructions = `Answer this question using all the meetings in the matter. Be direct, say which meeting (date and title) each point comes from with timestamps, and say plainly if the meetings don't answer it.\n\nQuestion: ${question}`;
  return askClaude({ apiKey, blocks, instructions, effort: 'medium', onUsage });
}

function answerQuestion({ apiKey, meeting, segments, question, onUsage }) {
  const instructions = `Answer this question about the meeting. Be direct, cite timestamps, and say plainly if the transcript does not answer it.\n\nQuestion: ${question}`;
  return askClaude({ apiKey, meeting, segments, instructions, effort: 'medium', onUsage });
}

module.exports = {
  summarize,
  answerQuestion,
  answerMatterQuestion,
  identifySpeakers,
  draftTimeEntry,
  billableHours,
  formatTranscript,
  formatTimestamp,
  transcriptBlock,
  TEMPLATES,
};
