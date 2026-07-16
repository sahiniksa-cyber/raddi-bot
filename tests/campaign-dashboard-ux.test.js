'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dashboard', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'dashboard', 'campaigns.js'), 'utf8');
const campaignMarkup = html.split('id="view-campaigns"')[1].split('id="view-pricing"')[0];

test('campaign sections are descriptive and remain directly clickable', () => {
  for (const step of ['audience', 'content', 'timing', 'review']) {
    assert.match(campaignMarkup, new RegExp(`data-campaign-step="${step}"[^>]+onclick="campaignGoStep\\('${step}'\\)"`));
  }
  assert.match(campaignMarkup, /class="campaign-step-copy"/);
});

test('customer categories open clear read-only details without classification management', () => {
  for (const segment of ['interested_unverified', 'ordered_confirmed', 'needs_verification']) {
    assert.match(campaignMarkup, new RegExp(`data-campaign-segment="${segment}"[^>]+campaignSelectSegment\\('${segment}'\\)`));
  }
  assert.match(campaignMarkup, /id="campaignSegmentDetails"/);
  assert.doesNotMatch(campaignMarkup, /campaignSignalTable|campaignUpdateSignal/);
  assert.doesNotMatch(campaignMarkup, /إدارة تصنيفات العملاء/);
});

test('audience targeting puts numbers and Excel first and removes smart selection', () => {
  const contacts = campaignMarkup.indexOf('value="contacts"');
  const keywords = campaignMarkup.indexOf('value="keywords"');
  const conversations = campaignMarkup.indexOf('value="conversations"');
  assert.ok(contacts > 0 && contacts < keywords && keywords < conversations);
  assert.match(campaignMarkup, /id="campaignContactOptions"/);
  assert.match(campaignMarkup, /id="campaignNumbers"/);
  assert.match(campaignMarkup, /id="campaignImportFile"/);
  assert.doesNotMatch(campaignMarkup, /name="campaignSource" value="smart"|>التحديد الذكي</);
});

test('keyword targeting exposes the real recipient count', () => {
  assert.match(campaignMarkup, /id="campaignKeywordAudienceCount"/);
  assert.match(campaignMarkup, /عدد العملاء الذين ستصلهم الرسالة/);
  assert.match(js, /campaignKeywordAudienceCount/);
  assert.match(js, /textContent = String\(data\.count\)/);
});

test('conversation date range is contained inside its own clear option', () => {
  assert.match(campaignMarkup, /id="campaignConversationOptions"[^>]+data-campaign-source-panel="conversations"/);
  assert.match(campaignMarkup, /بداية الفترة/);
  assert.match(campaignMarkup, /نهاية الفترة/);
  assert.match(campaignMarkup, /يجب أن تكون البداية قبل النهاية/);
});

test('Excel targeting offers template, export and import in the same panel', () => {
  const panel = campaignMarkup.split('id="campaignContactOptions"')[1].split('data-campaign-source-panel="keywords"')[0];
  assert.match(panel, /id="campaignImportFile"/);
  assert.match(panel, /\/api\/campaigns\/contacts\/template\.xlsx/);
  assert.match(panel, /\/api\/campaigns\/contacts\/export\.xlsx/);
  assert.match(panel, /id="campaignImportSummary"/);
});

test('content section shows send count and a WhatsApp campaign preview', () => {
  assert.match(campaignMarkup, /id="campaignContentAudienceCount"/);
  assert.match(campaignMarkup, /عدد الرسائل التي سيتم إطلاقها/);
  assert.match(campaignMarkup, /id="campaignWhatsappMedia"/);
  assert.match(campaignMarkup, /id="campaignWhatsappMessage"/);
  assert.match(js, /campaignRefreshContentPreview/);
  assert.match(js, /\/preview/);
});

test('saved campaigns are explained below the campaign workflow', () => {
  const savedIndex = campaignMarkup.indexOf('class="campaign-saved-card"');
  const workflowEnd = campaignMarkup.lastIndexOf('</main>');
  assert.ok(savedIndex > workflowEnd);
  assert.match(campaignMarkup, /افتح حملة سابقة لإكمالها أو تعديلها/);
  assert.equal((campaignMarkup.match(/id="campaignPicker"/g) || []).length, 1);
});

test('campaign dashboard script remains syntactically valid', () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'dashboard/campaigns.js' }));
});
