// Meeting summaries and Q&A with Claude.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

// Kept identical for summaries and questions so the transcript prefix is
// cached once and reused when someone asks follow-up questions.
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

function transcriptBlock(meeting, segments) {
  return {
    type: 'text',
    text: `<meeting title="${meeting.title.replace(/"/g, "'")}" date="${meeting.createdAt.slice(0, 10)}">\n<transcript>\n${formatTranscript(segments, meeting.speakers || {})}\n</transcript>\n</meeting>`,
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
    return new Error(`Claude returned an error (${err.status}): ${err.message}`);
  }
  return err;
}

async function askClaude({ apiKey, meeting, segments, instructions, effort, format }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to create summaries.');
  if (!segments.length) throw new Error('The transcript is empty, so there is nothing to summarize.');
  const client = new Anthropic({ apiKey });
  try {
    const message = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: format ? { effort, format } : { effort },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [transcriptBlock(meeting, segments), { type: 'text', text: instructions }],
          },
        ],
      })
      .finalMessage();

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

function summarize({ apiKey, meeting, segments }) {
  const template = TEMPLATES[meeting.template] || TEMPLATES.general;
  return askClaude({ apiKey, meeting, segments, instructions: template.instructions, effort: 'high' });
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
async function identifySpeakers({ apiKey, meeting, segments }) {
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

function answerQuestion({ apiKey, meeting, segments, question }) {
  const instructions = `Answer this question about the meeting. Be direct, cite timestamps, and say plainly if the transcript does not answer it.\n\nQuestion: ${question}`;
  return askClaude({ apiKey, meeting, segments, instructions, effort: 'medium' });
}

module.exports = { summarize, answerQuestion, identifySpeakers, formatTranscript, formatTimestamp, TEMPLATES };
