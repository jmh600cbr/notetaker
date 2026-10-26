// Cost estimates from list prices. Actual bills depend on each account's plan,
// so the UI always labels these as estimates.

// Claude Opus 5.5, US dollars per million tokens.
const CLAUDE_RATES = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };

// Deepgram Nova-3 pre-recorded with speaker diarization, pay-as-you-go, per
// minute of audio per channel. Users can change this in Settings to match
// their plan.
const DEFAULT_DEEPGRAM_PER_MINUTE = 0.0063;

function claudeCost(usage) {
  if (!usage) return 0;
  // With a fallback, every attempt is listed separately.
  const parts = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : [usage];
  let total = 0;
  for (const u of parts) {
    total +=
      ((u.input_tokens || 0) * CLAUDE_RATES.input +
        (u.output_tokens || 0) * CLAUDE_RATES.output +
        (u.cache_creation_input_tokens || 0) * CLAUDE_RATES.cacheWrite +
        (u.cache_read_input_tokens || 0) * CLAUDE_RATES.cacheRead) /
      1e6;
  }
  return total;
}

// Deepgram bills every channel of multichannel audio.
function deepgramCost(channelSeconds, perMinute = DEFAULT_DEEPGRAM_PER_MINUTE) {
  return ((channelSeconds || 0) / 60) * perMinute;
}

module.exports = { claudeCost, deepgramCost, DEFAULT_DEEPGRAM_PER_MINUTE, CLAUDE_RATES };
