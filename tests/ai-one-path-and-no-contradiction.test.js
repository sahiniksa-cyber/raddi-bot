'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { enforceEscalationTag } = require('../src/services/ai/reply-validator');

const CONFIG = { escalationContacts: [{ name: 'المالك', phone: '966500000000' }] };

// ---- A2: don't auto-escalate while the bot is collecting info from the customer ----

test('A2: a reply that asks the customer for the email does NOT get an auto escalation tag', () => {
  // bot fix-promise + asking for email, customer did NOT explicitly ask for a human
  const reply = 'ما يهون علينا، بنحل لك المشكلة. أعطني الإيميل اللي تبي عليه الحساب؟';
  const out = enforceEscalationTag(reply, CONFIG, 'الحساب توقف وأبي حساب ضروري يشتغل');
  assert.doesNotMatch(out, /\[تحويل:/, 'must not escalate while asking the customer for info');
});

test('A2: an EXPLICIT customer request for a human still escalates even while asking info', () => {
  const reply = 'تمام، أعطني الإيميل؟';
  const out = enforceEscalationTag(reply, CONFIG, 'ابغى اكلم موظف بشري');
  assert.match(out, /\[تحويل:/, 'explicit customer escalation request must still escalate');
});

test('A2: a bot fix-promise WITHOUT asking the customer for info still escalates (unchanged)', () => {
  const reply = 'ما يهون علينا، بنحل لك المشكلة وبأقرب وقت.';
  const out = enforceEscalationTag(reply, CONFIG, 'الحساب توقف');
  assert.match(out, /\[تحويل:/, 'fix-promise with no info-request keeps auto-escalation');
});

test('A2: an ordinary answer (no transfer signal, no request) is untouched', () => {
  const reply = 'السعر 250 ريال شامل التوصيل.';
  const out = enforceEscalationTag(reply, CONFIG, 'كم السعر؟');
  assert.equal(out, reply);
});

// ---- A1 + A4: prompt-level one-path / intent-first ----

const aiClientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');
const aiWorkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');

test('A1: runtime prompt enforces understand-intent-first + single path', () => {
  assert.match(aiClientSrc, /افهم نية العميل من رسالته كاملة أولاً/);
  assert.match(aiClientSrc, /ممنوع أن تجمع في رسالة واحدة بين طلب معلومة من العميل ووعدٍ بالتحويل/);
});

test('A4: batched-messages directive no longer says "answer them all" and asks for one coherent reply', () => {
  assert.doesNotMatch(aiWorkerSrc, /أجب عليها كلها في رد واحد واضح/);
  assert.match(aiWorkerSrc, /تعبّر غالباً عن نية واحدة/);
});
