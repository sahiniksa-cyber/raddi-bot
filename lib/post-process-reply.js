'use strict';

function normalizeArabic(s) {
  return String(s || '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

function stripQuotes(text) {
  let out = text;
  out = out.replace(/["«»]/g, '');
  out = out.replace(/(^|[^\d])['`](?!\d)/g, '$1');
  out = out.replace(/(?<!\d)['`]/g, '');
  return out;
}

// Arabic/Latin letter or digit — used for word-boundary detection so an avoided
// SINGLE word never gets removed from inside a larger word (production bug: avoiding
// "فريق" turned "الفريق" into "ال", shipping the broken "ويتواصل معك ال قريباً").
function isWordChar(ch) {
  return ch !== undefined && /[؀-ۿA-Za-z0-9]/.test(ch);
}

function stripPhrase(text, phrase) {
  const normalizedPhrase = normalizeArabic(phrase).toLowerCase();
  if (!normalizedPhrase) return text;
  // Multi-word phrases (they contain whitespace) are full expressions, so keep
  // the legacy substring removal. A single token must respect word boundaries:
  // only strip it when it stands alone, never when it's a fragment of a bigger word.
  const boundaryAware = !/\s/.test(normalizedPhrase);
  const lines = text.split('\n');
  return lines.map(line => {
    const normalizedLine = normalizeArabic(line).toLowerCase();
    if (!normalizedLine.includes(normalizedPhrase)) return line;
    let working = line;
    let workingNormalized = normalizedLine;
    let from = 0;
    let idx;
    while ((idx = workingNormalized.indexOf(normalizedPhrase, from)) !== -1) {
      const before = workingNormalized[idx - 1];
      const after = workingNormalized[idx + normalizedPhrase.length];
      if (boundaryAware && (isWordChar(before) || isWordChar(after))) {
        // Inside a larger word — skip this occurrence, keep scanning.
        from = idx + normalizedPhrase.length;
        continue;
      }
      working = working.slice(0, idx) + working.slice(idx + phrase.length);
      workingNormalized = workingNormalized.slice(0, idx) + workingNormalized.slice(idx + normalizedPhrase.length);
      from = idx;
    }
    return working;
  }).join('\n');
}

// Strip list/markdown formatting that looks bad in WhatsApp and that owners
// frequently ask the bot NOT to use ("لا تحط نقاط"). We remove line-leading
// bullet markers (•, -, * …) and markdown emphasis/headings, but we KEEP:
//   - WhatsApp bold *word* (single asterisk with no trailing space → not a bullet)
//   - dashes inside a line (phone numbers, ranges, "10-15")
// so real content is never damaged — only leading list decoration is removed.
function stripListMarkers(text) {
  const lines = String(text || '').split('\n').map((line) => {
    return line
      // unicode bullets at line start (optionally after whitespace)
      .replace(/^\s*[•▪‣◦·●○*]+\s+/, '')
      // markdown dash/plus bullets at line start ("- item", "+ item")
      .replace(/^\s*[-+]\s+/, '')
      // markdown headings ("## title")
      .replace(/^\s*#{1,6}\s+/, '');
  });
  return lines.join('\n')
    // markdown bold/italic emphasis → plain text (keeps the words)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1');
}

// WhatsApp does NOT render markdown links: a reply like
//   "تفضل: [أدوبي](https://prostoree.com/NAADyOm)"
// shows the literal "[..](..)" and the URL isn't tappable. Convert to a plain
// "label: url" (or just the bare URL when there's no meaningful label) so the
// link is clickable. The escalation marker "[تحويل:...]" has no "(url)" part so
// it is never matched here.
function convertMarkdownLinks(text) {
  return String(text || '').replace(
    /\[([^\]]*)\]\(\s*((?:https?:\/\/|www\.)?[^\s)]+)\s*\)/g,
    (match, label, url) => {
      const cleanLabel = String(label || '').trim();
      const cleanUrl = String(url || '').trim();
      if (!cleanUrl) return match;
      if (!cleanLabel || cleanLabel === cleanUrl) return cleanUrl;
      return `${cleanLabel}: ${cleanUrl}`;
    },
  );
}

// Mask URLs with a sentinel before the text-tidying steps run, then restore
// them afterwards. Without this, tidyWhitespace inserts a space after every "."
// and would turn "prostoree.com/NAADyOm" into "prostoree. com/NAADyOm",
// breaking the link. The sentinel "@@URL0@@" has no spaces or sentence
// punctuation, so trim/tidy/list-strip never touch it.
const URL_TOKEN_RE = /(?:https?:\/\/|www\.)[^\s)\]]+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/[^\s)\]]*/g;
function protectUrls(text) {
  const urls = [];
  const masked = String(text || '').replace(URL_TOKEN_RE, (m) => {
    urls.push(m);
    return `@@URL${urls.length - 1}@@`;
  });
  return { masked, urls };
}
function restoreUrls(text, urls) {
  return String(text || '').replace(/@@URL(\d+)@@/g, (m, i) => (urls[Number(i)] !== undefined ? urls[Number(i)] : m));
}

function tidyWhitespace(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?([،.؟!]) ?/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+\./g, '.')
    .trim();
}

function stripAvoidedContent(reply, config = {}) {
  if (reply === null || reply === undefined) return '';
  if (typeof reply !== 'string') return String(reply || '');
  const original = reply;

  // 1) Make links WhatsApp-friendly, then mask them so tidy/strip steps can't
  //    break the URL (dots/punctuation inside it).
  let cleaned = convertMarkdownLinks(reply);
  const { masked, urls } = protectUrls(cleaned);
  cleaned = stripQuotes(masked);

  const phrases = Array.isArray(config?.replyStyle?.avoidPhrases)
    ? config.replyStyle.avoidPhrases.filter(p => typeof p === 'string' && p.trim())
    : [];
  for (const phrase of phrases) {
    cleaned = stripPhrase(cleaned, phrase.trim());
  }

  cleaned = stripListMarkers(cleaned);
  cleaned = tidyWhitespace(cleaned);
  cleaned = restoreUrls(cleaned, urls);

  if (!cleaned || cleaned.length < 3) return original.trim();
  return cleaned;
}

// ── Line-break formatting ────────────────────────────────────────────────
// Merchant-controlled (dashboard → replyStyle). The PROMPT guides the model per
// mode, and these helpers ENFORCE the mechanical modes after the reply is
// generated so they are guaranteed (not just best-effort):
//   connected → leave as written (default; no enforcement)
//   sentence  → one sentence per line (enforced)
//   words     → a newline every N words (enforced)
//   topic     → normalise topic gaps; if the model ignored the setting,
//               create safe sentence/word boundaries deterministically
//   ai        → preserve good model-written lines, but repair a long single
//               block so the dashboard setting can never silently do nothing
const VALID_LINE_BREAK_MODES = ['connected', 'sentence', 'topic', 'words', 'ai'];

function resolveLineBreakSettings(replyStyle = {}) {
  const r = replyStyle || {};
  let mode = r.lineBreakMode;
  // Backward compatibility: the old boolean toggle maps to the closest mode.
  if (!mode) mode = r.multilineFormat === true ? 'ai' : 'connected';
  if (!VALID_LINE_BREAK_MODES.includes(mode)) mode = 'connected';
  // Default only when the value is missing/non-numeric — NOT when it's a valid 0
  // (a 0 must clamp to the floor, not jump to the default).
  const intOr = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
  const count = Math.min(5, Math.max(1, intOr(r.lineBreakCount, 2)));
  const words = Math.min(60, Math.max(2, intOr(r.lineBreakWords, 12)));
  return { mode, count, words };
}

// The escalation marker is still present at this stage (it is stripped later, in
// prepareEscalation). Its summary can contain ". " so it MUST be protected from
// sentence/word splitting — same treatment as URLs.
const ESC_MARKER_TOKEN_RE = /\[تحويل:[^\]]*\]/g;

function breakBySentence(text) {
  // A sentence ends at . ؟ ! … followed by whitespace. Keep the terminator,
  // replace the following whitespace with a single newline. A terminator NOT
  // followed by whitespace (e.g. a decimal "5.2") is left alone.
  return String(text)
    .replace(/([.؟!…]+)[ \t]+/g, '$1\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

function breakByWords(text, n) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  for (let i = 0; i < tokens.length; i += n) {
    lines.push(tokens.slice(i, i + n).join(' '));
  }
  return lines.join('\n');
}

function normalizeTopicGaps(text, count) {
  // In topic mode every existing line boundary represents a model-selected
  // idea boundary, so make its gap exactly the merchant-selected size.
  return String(text).replace(/(?:[ \t]*\n[ \t]*)+/g, '\n'.repeat(count));
}

function ensureNaturalMultiline(text, words) {
  const input = String(text || '').trim();
  if (!input || input.includes('\n')) return input;
  const bySentence = breakBySentence(input);
  if (bySentence.includes('\n')) return bySentence;
  const tokens = input.split(/\s+/).filter(Boolean);
  // A truly short WhatsApp reply belongs on one line. Only use the word-count
  // fallback when the reply is large enough to look like an ignored setting.
  if (tokens.length > Math.max(6, words)) return breakByWords(input, words);
  return input;
}

function applyLineBreakFormat(text, config = {}) {
  if (typeof text !== 'string' || !text.trim()) return text;
  const { mode, count, words } = resolveLineBreakSettings(config?.replyStyle || {});
  if (mode === 'connected') return text;

  // Protect the escalation marker and URLs from being split mid-token.
  const markers = [];
  let masked = text.replace(ESC_MARKER_TOKEN_RE, (m) => {
    markers.push(m);
    return `@@ESC${markers.length - 1}@@`;
  });
  const protectedUrls = protectUrls(masked);
  masked = protectedUrls.masked;

  let out = masked;
  if (mode === 'sentence') {
    out = breakBySentence(masked);
    // Some merchants disable sentence-ending periods. In that configuration
    // the validator removes punctuation before this formatter runs, leaving no
    // detectable sentence boundary. The sentence mode must still visibly do
    // something, so fall back to a conservative six-word line for unpunctuated
    // text instead of silently returning one long line.
    if (!out.includes('\n')) out = ensureNaturalMultiline(out, Math.min(words, 6));
  }
  else if (mode === 'words') out = breakByWords(masked, words);
  else if (mode === 'topic') {
    out = ensureNaturalMultiline(masked, words);
    out = normalizeTopicGaps(out, count);
  }
  else if (mode === 'ai') out = ensureNaturalMultiline(masked, words);

  out = restoreUrls(out, protectedUrls.urls);
  out = out.replace(/@@ESC(\d+)@@/g, (m, i) => (markers[Number(i)] !== undefined ? markers[Number(i)] : m));
  return out;
}

module.exports = {
  stripAvoidedContent,
  normalizeArabic,
  convertMarkdownLinks,
  resolveLineBreakSettings,
  applyLineBreakFormat,
};
