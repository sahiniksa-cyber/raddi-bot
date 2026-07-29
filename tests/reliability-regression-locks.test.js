'use strict';

// أقفال حماية (Regression locks) — المرحلة 0 من نظام الموثوقية.
//
// كل اختبار هنا يثبّت سلوكاً حرجاً أصلح عطلاً حقيقياً سابقاً. لو عدّل أحد
// هالسلوك بالغلط، الاختبار يفشل ويمنع النشر (مع بوابة CI). نفس أسلوب الفحص
// الثابت المستخدم في باقي المشروع (قراءة المصدر + مطابقة الأنماط) — لا يحتاج
// قاعدة بيانات ولا شبكة.
//
// راجع: docs/vault/الاتصال-بواتساب/قصة-مشكلة-الباركود.md
//       docs/vault/الاتصال-بواتساب/مشاكل-معروفة-وحلولها.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// [QR1] نسخة WA Web لازم تُحل عبر fetchLatestWaWebVersion (النسخة الحيّة)
// مع fallback مثبّت عبر WA_WEB_VERSION — لا العودة لـ fetchLatestBaileysVersion
// القديمة التي يرفضها واتساب للربط.
test('قفل QR1: نسخة واتساب عبر fetchLatestWaWebVersion + fallback مثبّت', () => {
  const src = read('src/services/whatsapp/baileys-connection-manager.js');
  assert.match(src, /await\s+fetchLatestWaWebVersion\s*\(\s*\)/);
  assert.match(src, /WA_WEB_VERSION/);
});

// [QR2] إغلاق 428 أثناء انتظار مسح الباركود لازم يجدّد الباركود فوراً حتى لا
// يبقى الباركود المعروض ميتاً.
test('قفل QR2: إغلاق 428 وحالة qr_ready يجدّد الباركود فوراً', () => {
  const src = read('src/services/whatsapp/baileys-connection-manager.js');
  assert.match(src, /DisconnectReason\.connectionClosed\s*&&\s*this\.status === 'qr_ready'/);
  assert.match(src, /refreshing QR immediately/);
});

// [QR3] عند الإقلاع، لازم استرجاع تلقائي للجلسات المربوطة فقط — لمنع عاصفة
// سوكِتات الربط المتزامنة التي يخنقها واتساب.
test('قفل QR3: shouldAutoRecoverSession يقيّد الاسترجاع التلقائي على الجلسات المربوطة', () => {
  const src = read('src/services/bot/runtime-bot.js');
  assert.match(src, /function shouldAutoRecoverSession/);
  assert.match(src, /module\.exports[^\n]*shouldAutoRecoverSession/);
});

// [I1] نقطة البداية لازم تشغّل مشرف العمليات (web + ai-worker) — لا الخادم وحده،
// وإلا عامل الذكاء الاصطناعي ما يشتغل.
test('قفل I1: npm start يشغّل مشرف start-all (عامل الذكاء يقلع دائماً)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.start, /start-all/);
});

// [I2] كل رد من الذكاء الاصطناعي لازم provider_message_id فريد لكل رد، وإلا
// يفشل قيد التفرّد (idx_messages_user_provider_message_unique).
test('قفل I2: provider_message_id لكل رد يتضمّن UUID فريد', () => {
  const src = read('src/workers/ai-worker.js');
  assert.match(src, /crypto\.randomUUID\(\)/);
  assert.match(src, /ai-worker:\$\{jobId\}:\$\{crypto\.randomUUID\(\)\}/);
});

// [I11] مهمة BullMQ عالقة في حالة active لازم تُزال بعد ضعف مدة القفل، وإلا
// تمنع معالجة رسائل جديدة لنفس المحادثة.
test('قفل I11: إزالة مهام AI العالقة (active) بعد ضعف مدة القفل', () => {
  const src = read('src/queues/message-queue.js');
  assert.match(src, /STALE_ACTIVE_JOB_MS/);
  assert.match(src, /Date\.now\(\)\s*-\s*processedOn\s*>\s*STALE_ACTIVE_JOB_MS/);
});
