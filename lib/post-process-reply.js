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

module.exports = { stripAvoidedContent, normalizeArabic, convertMarkdownLinks };
