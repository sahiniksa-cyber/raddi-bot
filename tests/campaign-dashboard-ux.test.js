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
