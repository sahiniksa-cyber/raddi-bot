'use strict';

const OpenAI = require('openai');

const DEFAULT_MAX_MEDIA_BYTES = parseInt(process.env.MEDIA_ANALYSIS_MAX_BYTES || `${8 * 1024 * 1024}`, 10);
const DEFAULT_IMAGE_MODEL = process.env.OPENAI_MEDIA_IMAGE_MODEL || 'gpt-4o-mini';
const DEFAULT_AUDIO_MODEL = process.env.OPENAI_MEDIA_AUDIO_MODEL || 'whisper-1';

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SUPPORTED_AUDIO_TYPES = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/x-m4a']);

function estimateBase64Bytes(data) {
  const value = String(data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function normalizeMimeType(mimeType) {
  const value = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (value === 'audio/oga') return 'audio/ogg';
  if (value === 'audio/m4a') return 'audio/x-m4a';
  return value;
}

function inferKind(kind, mimeType) {
  const raw = String(kind || '').toLowerCase();
  if (raw.includes('image')) return 'image';
  if (raw.includes('audio') || raw.includes('ptt') || raw.includes('voice')) return 'audio';
  if (String(mimeType || '').startsWith('image/')) return 'image';
  if (String(mimeType || '').startsWith('audio/')) return 'audio';
  return raw || null;
}

function normalizeMediaPayload(media = {}, options = {}) {
  const mimeType = normalizeMimeType(media.mimeType || media.mimetype);
  const kind = inferKind(media.kind || media.type, mimeType);
  const data = String(media.data || media.base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const sizeBytes = Number(media.sizeBytes) || estimateBase64Bytes(data);
  const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_MEDIA_BYTES;

  if (!data) return { ok: false, reason: 'empty_media' };
  if (sizeBytes > maxBytes) return { ok: false, reason: 'media_too_large', kind, mimeType, sizeBytes, maxBytes };
  if (kind === 'image' && SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    return { ok: true, kind, mimeType, data, caption: String(media.caption || '').trim(), sizeBytes };
  }
  if (kind === 'audio' && SUPPORTED_AUDIO_TYPES.has(mimeType)) {
    return { ok: true, kind, mimeType, data, caption: String(media.caption || '').trim(), sizeBytes };
  }
  return { ok: false, reason: 'unsupported_media', kind, mimeType, sizeBytes };
}

function buildMediaAnalysisText({ kind, resultText, caption }) {
  const text = String(resultText || '').trim();
  const note = String(caption || '').trim();
  if (kind === 'audio') return `[رسالة صوتية من العميل: ${text || 'لم يتم استخراج نص واضح'}]`;
  const suffix = note ? `. تعليق العميل: ${note}` : '';
  return `[صورة من العميل: ${text || 'لم يتم استخراج وصف واضح'}${suffix}]`;
}

function extensionFromMime(mimeType) {
  const map = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/x-m4a': 'm4a',
  };
  return map[mimeType] || 'ogg';
}

class OpenAIMediaAnalyzer {
  constructor({
    apiKey,
    client = null,
    imageModel = DEFAULT_IMAGE_MODEL,
    audioModel = DEFAULT_AUDIO_MODEL,
    logger = console,
    maxBytes = DEFAULT_MAX_MEDIA_BYTES,
  } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || '';
    this.client = client;
    this.imageModel = imageModel;
    this.audioModel = audioModel;
    this.logger = logger;
    this.maxBytes = maxBytes;
  }

  getClient() {
    if (this.client) return this.client;
    if (!this.apiKey || this.apiKey.trim().length < 10) return null;
    this.client = new OpenAI({ apiKey: this.apiKey.trim() });
    return this.client;
  }

  async analyze(rawMedia, context = {}) {
    const media = normalizeMediaPayload(rawMedia, { maxBytes: this.maxBytes });
    if (!media.ok) return media;
    const client = this.getClient();
    if (!client) return { ok: false, reason: 'missing_openai_key', kind: media.kind };

    try {
      if (media.kind === 'image') return await this.analyzeImage(client, media, context);
      if (media.kind === 'audio') return await this.transcribeAudio(client, media);
      return { ok: false, reason: 'unsupported_media', kind: media.kind };
    } catch (err) {
      this.logger.warn?.('ai', `media analysis failed: ${err.message}`);
      return { ok: false, reason: 'analysis_failed', error: err.message, kind: media.kind };
    }
  }

  async analyzeImage(client, media, context = {}) {
    const caption = media.caption ? `\nتعليق العميل على الصورة: ${media.caption}` : '';
    const prompt = [
      'حلل صورة عميل واتساب لخدمة العملاء.',
      'اكتب وصفا مختصرا ودقيقا بالعربية لما يظهر، وأي نص واضح داخل الصورة، وما الذي قد يحتاجه العميل.',
      'لا تخترع معلومات غير ظاهرة في الصورة.',
      context.customerText ? `رسالة العميل النصية: ${context.customerText}` : '',
      caption,
    ].filter(Boolean).join('\n');

    const response = await client.chat.completions.create({
      model: this.imageModel,
      max_tokens: 350,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${media.mimeType};base64,${media.data}`, detail: 'low' } },
        ],
      }],
    }, { timeout: 30000 });

    return {
      ok: true,
      kind: media.kind,
      model: this.imageModel,
      text: String(response.choices?.[0]?.message?.content || '').trim(),
      usage: response.usage || null,
    };
  }

  async transcribeAudio(client, media) {
    const bytes = Buffer.from(media.data, 'base64');
    const ext = extensionFromMime(media.mimeType);
    const file = await OpenAI.toFile(bytes, `whatsapp-audio.${ext}`, { type: media.mimeType });
    const response = await client.audio.transcriptions.create({
      model: this.audioModel,
      file,
      language: 'ar',
    }, { timeout: 30000 });

    return {
      ok: true,
      kind: media.kind,
      model: this.audioModel,
      text: String(response.text || '').trim(),
      usage: response.usage || null,
    };
  }
}

module.exports = {
  OpenAIMediaAnalyzer,
  buildMediaAnalysisText,
  normalizeMediaPayload,
};
