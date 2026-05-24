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

function stripPhrase(text, phrase) {
  const normalizedPhrase = normalizeArabic(phrase).toLowerCase();
  if (!normalizedPhrase) return text;
  const lines = text.split('\n');
  return lines.map(line => {
    const normalizedLine = normalizeArabic(line).toLowerCase();
    if (!normalizedLine.includes(normalizedPhrase)) return line;
    let working = line;
    let workingNormalized = normalizedLine;
    let idx;
    while ((idx = workingNormalized.indexOf(normalizedPhrase)) !== -1) {
      working = working.slice(0, idx) + working.slice(idx + phrase.length);
      workingNormalized = workingNormalized.slice(0, idx) + workingNormalized.slice(idx + normalizedPhrase.length);
    }
    return working;
  }).join('\n');
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
  let cleaned = stripQuotes(reply);

  const phrases = Array.isArray(config?.replyStyle?.avoidPhrases)
    ? config.replyStyle.avoidPhrases.filter(p => typeof p === 'string' && p.trim())
    : [];
  for (const phrase of phrases) {
    cleaned = stripPhrase(cleaned, phrase.trim());
  }

  cleaned = tidyWhitespace(cleaned);

  if (!cleaned || cleaned.length < 3) return original.trim();
  return cleaned;
}

module.exports = { stripAvoidedContent };
