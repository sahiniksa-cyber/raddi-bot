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
  for (const segment of ['ordered_confirmed', 'needs_verification']) {
    assert.match(campaignMarkup, new RegExp(`data-campaign-segment="${segment}"[^>]+campaignSelectSegment\\('${segment}'\\)`));
  }
  assert.doesNotMatch(campaignMarkup, /data-campaign-segment="interested_unverified"|مهتم ولم يطلب/);
  assert.match(campaignMarkup, /id="campaignSegmentDetails"/);
  assert.doesNotMatch(campaignMarkup, /campaignSignalTable|campaignUpdateSignal/);
  assert.doesNotMatch(campaignMarkup, /إدارة تصنيفات العملاء/);
});

test('audience targeting uses four clickable cards and keeps manual numbers first', () => {
  const contacts = campaignMarkup.indexOf('value="contacts"');
  const keywords = campaignMarkup.indexOf('value="keywords"');
  const conversations = campaignMarkup.indexOf('value="conversations"');
  assert.ok(contacts > 0 && contacts < keywords && keywords < conversations);
  assert.match(campaignMarkup, /id="campaignContactOptions"/);
  assert.match(campaignMarkup, /id="campaignNumbers"/);
  assert.match(campaignMarkup, /class="campaign-source-list"/);
  assert.equal((campaignMarkup.match(/class="campaign-source-option"/g) || []).length, 4);
  for (const source of ['contacts', 'keywords', 'conversations', 'all']) {
    assert.match(campaignMarkup, new RegExp(`campaignSelectSource\\('${source}'\\)`));
  }
  assert.doesNotMatch(campaignMarkup, /name="campaignSource" value="smart"|>التحديد الذكي</);
});

test('keyword targeting exposes the real recipient count', () => {
  assert.match(campaignMarkup, /id="campaignKeywordAudienceCount"/);
  assert.match(campaignMarkup, /عدد العملاء الذين ستصلهم الرسالة/);
  assert.match(js, /campaignKeywordAudienceCount/);
  assert.match(js, /textContent = String\(data\.count\)/);
  assert.match(campaignMarkup, /campaignAddKeywordFromInput\(\)/);
  assert.match(js, /\/api\/campaigns\/audience\/preview/);
});

test('conversation date range is contained inside its own clear option', () => {
  assert.match(campaignMarkup, /id="campaignConversationOptions"[^>]+data-campaign-source-panel="conversations"/);
  assert.match(campaignMarkup, /بداية الفترة/);
  assert.match(campaignMarkup, /نهاية الفترة/);
  assert.match(campaignMarkup, /يجب أن تكون البداية قبل النهاية/);
});

test('Excel targeting controls are hidden while campaign-specific numbers remain available', () => {
  const panel = campaignMarkup.split('id="campaignContactOptions"')[1].split('data-campaign-source-panel="keywords"')[0];
  assert.match(panel, /id="campaignNumbers"/);
  assert.match(panel, /id="campaignNumbersCount"/);
  assert.doesNotMatch(panel, /campaignImportFile|استيراد ملف Excel|\/api\/campaigns\/contacts\/template\.xlsx|\/api\/campaigns\/contacts\/export\.xlsx|campaignImportSummary/);
});

test('content section shows send count and a WhatsApp campaign preview', () => {
  assert.match(campaignMarkup, /id="campaignContentAudienceCount"/);
  assert.match(campaignMarkup, /عدد الرسائل التي سيتم إطلاقها/);
  assert.match(campaignMarkup, /id="campaignWhatsappMedia"/);
  assert.match(campaignMarkup, /id="campaignWhatsappMessage"/);
  assert.match(js, /campaignRefreshContentPreview/);
  assert.match(js, /\/preview/);
  assert.match(campaignMarkup, /application\/pdf/);
  assert.match(campaignMarkup, /\.pdf/);
  assert.match(campaignMarkup, /مستندات PDF/);
  assert.match(campaignMarkup, /وسيُرفع تلقائياً قبل الانتقال/);
  assert.match(js, /campaignUploadPendingMedia/);
  assert.match(js, /مرفق بانتظار الرفع/);
});

test('campaign review shows live sent and remaining recipient counters', () => {
  for (const id of [
    'campaignDeliveryProgress',
    'campaignProgressSent',
    'campaignProgressRemaining',
    'campaignProgressNotSent',
    'campaignProgressTotal',
    'campaignProgressBar',
  ]) {
    assert.match(campaignMarkup, new RegExp(`id="${id}"`));
  }
  assert.match(campaignMarkup, /شخص وصلته الرسالة/);
  assert.match(campaignMarkup, /شخص باقي له الإرسال/);
  assert.match(js, /campaignRefreshDeliveryProgress/);
  assert.match(js, /window\.setInterval[\s\S]*3000/);
  assert.match(js, /delivery_progress/);
});

test('campaign progress separates delivered, remaining and terminal non-deliveries', () => {
  const nodes = Object.fromEntries([
    'campaignDeliveryProgress',
    'campaignProgressStatus',
    'campaignProgressSent',
    'campaignProgressRemaining',
    'campaignProgressNotSent',
    'campaignProgressTotal',
    'campaignProgressDetails',
    'campaignProgressBar',
  ].map(id => [id, { id, hidden: true, textContent: '', style: {} }]));
  const context = vm.createContext({
    document: {
      getElementById: id => nodes[id] || null,
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: { setTimeout() {}, scrollTo() {} },
    fetch: async () => { throw new Error('unexpected fetch'); },
    console,
  });
  new vm.Script(js, { filename: 'dashboard/campaigns.js' }).runInContext(context);
  vm.runInContext(`
    campaignCurrent = {
      id: 'campaign-1',
      status: 'sending',
      delivery_progress: { total: 10, sent: 4, remaining: 3, failed: 1, skipped: 1, canceled: 1 }
    };
    campaignRenderDeliveryProgress();
  `, context);
  assert.equal(nodes.campaignDeliveryProgress.hidden, false);
  assert.equal(nodes.campaignProgressSent.textContent, '٤');
  assert.equal(nodes.campaignProgressRemaining.textContent, '٣');
  assert.equal(nodes.campaignProgressNotSent.textContent, '٣');
  assert.equal(nodes.campaignProgressTotal.textContent, '١٠');
  assert.equal(nodes.campaignProgressBar.style.width, '40%');
  assert.match(nodes.campaignProgressDetails.textContent, /فشل: ١/);
});

test('saving campaign content uploads pending media before moving to the next step', async () => {
  const events = [];
  const flash = { style: {}, textContent: '' };
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (id === 'campaignFlash') return flash;
        if (id === 'campaignMedia') return { files: [{ name: 'offer.pdf' }], value: 'offer.pdf' };
        return null;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: { setTimeout() {}, scrollTo() {} },
    fetch: async () => { throw new Error('unexpected fetch'); },
    FormData: class {},
    console,
    events,
  });
  new vm.Script(js, { filename: 'dashboard/campaigns.js' }).runInContext(context);
  vm.runInContext(`
    campaignSave = async () => { events.push('save'); };
    campaignUploadPendingMedia = async () => { events.push('upload'); return 1; };
    campaignGoStep = step => { events.push('go:' + step); };
  `, context);

  await vm.runInContext("campaignSaveAndNext('timing')", context);

  assert.deepEqual(events, ['save', 'upload', 'go:timing']);
  assert.match(flash.textContent, /رفع 1 مرفق بنجاح/);
});

test('saved campaigns are explained below the campaign workflow', () => {
  const savedIndex = campaignMarkup.indexOf('class="campaign-saved-card"');
  const workflowStart = campaignMarkup.indexOf('class="campaign-card"');
  const workflowEnd = campaignMarkup.indexOf('</main>', workflowStart);
  assert.ok(savedIndex > workflowEnd);
  assert.match(campaignMarkup, /افتح حملة سابقة لإكمالها أو تعديلها/);
  assert.equal((campaignMarkup.match(/id="campaignPicker"/g) || []).length, 1);
  assert.match(campaignMarkup, /campaign-saved-actions\{display:grid/);
  assert.match(campaignMarkup, /campaign-saved-card\{margin:16px 236px 0 0/);
});

test('campaign archive shows outcomes and paginated customer numbers', () => {
  for (const id of [
    'campaignBuilderWorkspace',
    'campaignArchiveWorkspace',
    'campaignArchiveList',
    'campaignArchiveDetail',
    'campaignArchiveCount',
  ]) {
    assert.match(campaignMarkup, new RegExp(`id="${id}"`));
  }
  assert.match(campaignMarkup, /الحملات السابقة/);
  assert.match(campaignMarkup, /اختر حملة لعرض ما حدث وأرقام العملاء/);
  assert.match(js, /\/api\/campaigns\/archive/);
  assert.match(js, /\/api\/campaigns\/\$\{campaignId\}\/recipients/);
  assert.match(js, /تم الإرسال لهم/);
  assert.match(js, /فشل الإرسال/);
  assert.match(js, /campaignLoadArchiveRecipients/);
  assert.match(js, /campaignArchivePage/);
  assert.match(js, /campaignSyncArchivePolling/);
});

test('campaign archive APIs are mounted before the campaign id detail route', () => {
  const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'campaign.routes.js'), 'utf8');
  const archiveRoute = routes.indexOf("router.get('/api/campaigns/archive'");
  const recipientsRoute = routes.indexOf("router.get('/api/campaigns/:id/recipients'");
  const detailRoute = routes.indexOf("router.get('/api/campaigns/:id'");
  assert.ok(archiveRoute > 0 && archiveRoute < detailRoute);
  assert.ok(recipientsRoute > 0 && recipientsRoute < detailRoute);
});

test('every inline campaign control points to an implemented function', () => {
  const handlers = [...campaignMarkup.matchAll(/on(?:click|change)="(campaign[A-Za-z0-9_]+)\(/g)].map(match => match[1]);
  assert.ok(handlers.length > 15);
  for (const handler of new Set(handlers)) assert.match(js, new RegExp(`function\\s+${handler}\\s*\\(`), handler);
});

test('keyword controls bind and source cards open even when background loading fails', async () => {
  const listeners = new Map();
  const node = (id, extra = {}) => ({
    id, value: '', checked: false, hidden: false, style: {}, textContent: '', innerHTML: '', files: [],
    classList: { toggle() {}, remove() {} },
    addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
    ...extra,
  });
  const sources = ['contacts', 'keywords', 'conversations', 'all'].map(value => node(`source-${value}`, { value, checked: value === 'contacts' }));
  const panels = sources.map(source => node(`panel-${source.value}`, { dataset: { campaignSourcePanel: source.value } }));
  const nodes = {
    campaignFlash: node('campaignFlash'),
    campaignKeywordInput: node('campaignKeywordInput'),
    campaignKeywordTags: node('campaignKeywordTags'),
    campaignKeywordAudienceCount: node('campaignKeywordAudienceCount'),
    campaignKeywordPreview: node('campaignKeywordPreview'),
    campaignMessage: node('campaignMessage'),
    campaignMedia: node('campaignMedia'),
    campaignNumbers: node('campaignNumbers'),
  };
  const document = {
    getElementById: id => nodes[id] || null,
    querySelector(selector) {
      const value = selector.match(/value="([^"]+)"/)?.[1];
      if (value) return sources.find(source => source.value === value) || null;
      if (selector === 'input[name="campaignSource"]:checked') return sources.find(source => source.checked) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-campaign-source-panel]') return panels;
      if (selector === 'input[name="campaignSource"]') return sources;
      if (selector.startsWith('#view-campaigns ')) return [nodes.campaignKeywordInput, nodes.campaignMessage, nodes.campaignMedia, nodes.campaignNumbers];
      return [];
    },
  };
  const context = vm.createContext({
    document,
    fetch: async () => { throw new Error('background unavailable'); },
    window: { setTimeout() {}, scrollTo() {} },
    console,
  });
  new vm.Script(js, { filename: 'dashboard/campaigns.js' }).runInContext(context);
  vm.runInContext("campaignSelectSource('keywords')", context);
  assert.equal(sources.find(source => source.value === 'keywords').checked, true);
  assert.equal(panels.find(panel => panel.dataset.campaignSourcePanel === 'keywords').hidden, false);
  await vm.runInContext('campaignOnTab()', context);
  assert.equal(typeof listeners.get('campaignKeywordInput:keydown'), 'function');
  nodes.campaignKeywordInput.value = 'عدسات طبية';
  vm.runInContext('campaignAddKeywordFromInput()', context);
  assert.equal(nodes.campaignKeywordInput.value, '');
  assert.match(nodes.campaignKeywordTags.innerHTML, /عدسات طبية/);
});

test('campaign dashboard script remains syntactically valid', () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'dashboard/campaigns.js' }));
});

test('campaign API surfaces the production error reference instead of a blank generic failure', () => {
  assert.match(js, /رمز الخطأ: \$\{data\.code\}/);
});
