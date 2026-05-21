'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OpenAIMediaAnalyzer,
  buildMediaAnalysisText,
  normalizeMediaPayload,
} = require('../src/services/ai/openai-media-analysis');

function tinyBase64(text = 'hello') {
  return Buffer.from(text).toString('base64');
}

test('normalizeMediaPayload accepts supported image payloads', () => {
  const media = normalizeMediaPayload({
    kind: 'image',
    mimeType: 'image/jpeg',
    data: tinyBase64('image-bytes'),
    caption: 'وش هذا؟',
  });

  assert.equal(media.ok, true);
  assert.equal(media.kind, 'image');
  assert.equal(media.mimeType, 'image/jpeg');
  assert.equal(media.caption, 'وش هذا؟');
  assert.equal(media.sizeBytes, Buffer.from('image-bytes').length);
});

test('normalizeMediaPayload rejects oversized media without throwing', () => {
  const media = normalizeMediaPayload({
    kind: 'audio',
    mimeType: 'audio/ogg',
    data: tinyBase64('1234567890'),
  }, { maxBytes: 4 });

  assert.equal(media.ok, false);
  assert.equal(media.reason, 'media_too_large');
});

test('normalizeMediaPayload rejects unsupported media types', () => {
  const media = normalizeMediaPayload({
    kind: 'document',
    mimeType: 'application/pdf',
    data: tinyBase64('pdf'),
  });

  assert.equal(media.ok, false);
  assert.equal(media.reason, 'unsupported_media');
});

test('OpenAIMediaAnalyzer sends images to chat completions with image_url content', async () => {
  const calls = [];
  const analyzer = new OpenAIMediaAnalyzer({
    apiKey: 'sk-test-openai-key',
    client: {
      chat: {
        completions: {
          create: async (payload) => {
            calls.push(payload);
            return { choices: [{ message: { content: 'الصورة فيها فاتورة شحن' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        },
      },
    },
  });

  const result = await analyzer.analyze({
    kind: 'image',
    mimeType: 'image/png',
    data: tinyBase64('png'),
    caption: 'حللها',
  });

  assert.equal(result.ok, true);
  assert.match(result.text, /فاتورة شحن/);
  assert.equal(calls[0].messages[0].role, 'user');
  assert.equal(calls[0].messages[0].content[0].type, 'text');
  assert.equal(calls[0].messages[0].content[1].type, 'image_url');
  assert.match(calls[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('OpenAIMediaAnalyzer sends audio to transcriptions and returns transcript', async () => {
  const calls = [];
  const analyzer = new OpenAIMediaAnalyzer({
    apiKey: 'sk-test-openai-key',
    client: {
      audio: {
        transcriptions: {
          create: async (payload) => {
            calls.push(payload);
            return { text: 'ابي اعرف سعر الاشتراك' };
          },
        },
      },
    },
  });

  const result = await analyzer.analyze({
    kind: 'audio',
    mimeType: 'audio/ogg',
    data: tinyBase64('ogg'),
  });

  assert.equal(result.ok, true);
  assert.match(result.text, /سعر الاشتراك/);
  assert.equal(calls[0].model, 'whisper-1');
  assert.equal(calls[0].file.name, 'whatsapp-audio.ogg');
});

test('OpenAIMediaAnalyzer returns fallback when OpenAI key is missing', async () => {
  const analyzer = new OpenAIMediaAnalyzer({ apiKey: '' });
  const result = await analyzer.analyze({
    kind: 'image',
    mimeType: 'image/jpeg',
    data: tinyBase64('jpg'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_openai_key');
});

test('buildMediaAnalysisText formats analyzed media for conversation history', () => {
  assert.equal(
    buildMediaAnalysisText({ kind: 'image', resultText: 'صورة لمنتج مكسور', caption: 'وصلني كذا' }),
    '[صورة من العميل: صورة لمنتج مكسور. تعليق العميل: وصلني كذا]',
  );
  assert.equal(
    buildMediaAnalysisText({ kind: 'audio', resultText: 'متى التوصيل؟' }),
    '[رسالة صوتية من العميل: متى التوصيل؟]',
  );
});
