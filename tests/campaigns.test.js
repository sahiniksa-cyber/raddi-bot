'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyConversationDeterministic,
  detectOrderEvidence,
  mergeSignals,
  validateAiSignals,
} = require('../src/services/campaigns/smart-segmentation');
const {
  canonicalize,
  createCampaignService,
  normalizeAudienceRules,
  normalizeCampaignMessage,
  normalizePhone,
  resolveAudience,
  snapshotHash,
} = require('../src/services/campaigns/campaign-service');
const {
  processCampaignSegmentation,
  randomDelayMs,
  recoverCampaignDeliveries,
  recipientMatchesKeywordAudience,
  scheduleNextRecipient,
  sendCampaignText,
} = require('../src/workers/campaign-worker');
const { hasValidSignature } = require('../src/services/campaigns/media-store');
const AIClient = require('../lib/ai-client');
const ExcelJS = require('exceljs');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');

test('smart segmentation never confirms an order claim without a concrete reference', () => {
  const claim = detectOrderEvidence('أنا طلبت المنتج ودفعت');
  assert.equal(claim.state, 'needs_verification');
  assert.equal(claim.orderReference, '');

  const proven = detectOrderEvidence('رقم الطلب AB-12345');
  assert.equal(proven.state, 'ordered_confirmed');
  assert.equal(proven.orderReference, 'AB-12345');
});

test('AI order signal is downgraded when its evidence has no order reference', () => {
  const signals = validateAiSignals({
    config: { products: [{ name: 'منتج تجريبي', price: '10' }] },
    messages: [{ id: 'm1', direction: 'inbound', role: 'user', content: 'طلبت منتج تجريبي ودفعت' }],
    signals: [{
      productName: 'منتج تجريبي',
      state: 'ordered_confirmed',
      confidence: 0.99,
      evidenceText: 'طلبت منتج تجريبي ودفعت',
    }],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].state, 'needs_verification');
  assert.equal(signals[0].orderReference, null);
});

test('campaign AI classifier requests structured signals and records usage', async () => {
  const usage = [];
  const ai = new AIClient({}, { error() {} }, { record: async (...args) => usage.push(args) });
  ai.buildClient = () => ({
    model: 'test-model',
    openai: { chat: { completions: { create: async request => ({
      choices: [{ message: { content: '{"signals":[{"productName":"منتج تجريبي","state":"interested_unverified","confidence":0.8,"evidenceText":"كم سعر منتج تجريبي؟","orderReference":null}]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      request,
    }) } } },
  });
  const signals = await ai.classifyCampaignCustomer({
    products: [{ name: 'منتج تجريبي' }],
    messages: [{ direction: 'inbound', role: 'user', content: 'كم سعر منتج تجريبي؟' }],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].productName, 'منتج تجريبي');
  assert.deepEqual(usage[0], ['test-model', 10, 5]);
});

test('confirmed signal cannot be weakened by a later interest signal', () => {
  const merged = mergeSignals(
    [{ productKey: 'x', state: 'ordered_confirmed', confidence: 0.95 }],
    [{ productKey: 'x', state: 'interested_unverified', confidence: 0.99 }],
  );
  assert.equal(merged[0].state, 'ordered_confirmed');
});

test('a later order message without a product name upgrades the recently discussed product', () => {
  const signals = classifyConversationDeterministic({
    config: { products: [{ name: 'منتج تجريبي', price: '10' }] },
    messages: [
      { id: 'm1', direction: 'inbound', role: 'user', content: 'كم سعر منتج تجريبي؟', created_at: '2026-07-14T10:00:00Z' },
      { id: 'm2', direction: 'inbound', role: 'user', content: 'تم الطلب رقم AB-12345', created_at: '2026-07-16T10:00:00Z' },
    ],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].state, 'ordered_confirmed');
  assert.equal(signals[0].orderReference, 'AB-12345');
  assert.equal(signals[0].evidenceMessageId, 'm2');
});

test('live segmentation worker persists a refreshed customer state', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM messages/.test(sql)) return { rows: [
        { id: 'm1', direction: 'inbound', role: 'user', content: 'كم سعر منتج تجريبي؟', created_at: new Date() },
      ] };
      if (/INSERT INTO customer_product_signals/.test(sql)) return { rows: [{ id: 'signal-1' }] };
      return { rows: [] };
    },
  };
  const result = await processCampaignSegmentation(
    { data: { userId: 'user-1', conversationId: 'conv-1', sender: '9665@s.whatsapp.net' } },
    { database, getUserBot: async () => ({ config: { products: [{ name: 'منتج تجريبي', price: '10' }] } }) },
  );
  assert.equal(result.updated, 1);
  assert.ok(calls.some(call => /INSERT INTO customer_product_signals/.test(call.sql)));
});

test('every accepted inbound message schedules a non-blocking smart-segmentation refresh', async () => {
  const scheduled = [];
  const database = {
    isConfigured: () => true,
    transaction: async fn => fn({
      query: async sql => {
        if (/RETURNING id, phone_number/.test(sql)) return { rows: [{ id: 'conv-1', phone_number: '966551234567' }] };
        if (/INSERT INTO messages/.test(sql)) return { rows: [{ id: 'msg-1' }] };
        return { rows: [] };
      },
    }),
  };
  const service = new MessageIngestService({
    database,
    logger: { info() {}, warn() {} },
    configLoader: async () => ({}),
    queue: { enqueueAiReply: async () => {} },
    campaignSegmentation: async payload => scheduled.push(payload),
  });
  await service.ingestWhatsappMessage({
    userId: 'user-1',
    msg: { id: { id: 'wa-1' }, from: '966551234567@s.whatsapp.net', body: 'كم سعر منتج تجريبي؟' },
  });
  assert.deepEqual(scheduled[0], {
    userId: 'user-1', conversationId: 'conv-1', sender: '966551234567@s.whatsapp.net', messageId: 'msg-1',
  });
});

test('manual campaign phone normalization supports Saudi local and international formats', () => {
  assert.equal(normalizePhone('055 123 4567'), '966551234567');
  assert.equal(normalizePhone('+966551234567'), '966551234567');
  assert.equal(normalizePhone('00966551234567'), '966551234567');
  assert.equal(normalizePhone('abc'), '');
});

test('manual numbers are stored as an exact deduplicated audience for one campaign', async () => {
  const rules = normalizeAudienceRules({
    source: 'contacts',
    numbers: ['055 123 4567', '+966551234567', '0559999999'],
  });
  assert.deepEqual(rules.numbers, ['966551234567', '966559999999']);
  const database = { query: async () => { throw new Error('global contacts must not be queried'); } };
  const recipients = await resolveAudience(database, 'user-1', rules);
  assert.deepEqual(recipients.map(row => row.sender), [
    '966551234567@s.whatsapp.net',
    '966559999999@s.whatsapp.net',
  ]);
  assert.ok(recipients.every(row => row.source === 'campaign_numbers'));
});

test('manual number audience refuses an empty or invalid selection', () => {
  assert.throws(
    () => normalizeAudienceRules({ source: 'contacts', numbers: ['not-a-phone'] }),
    /أضف رقم جوال صحيحاً واحداً على الأقل/,
  );
  assert.throws(
    () => normalizeAudienceRules({ source: 'contacts', numbers: ['0551234567', 'wrong'] }),
    /يوجد 1 رقم غير صالح/,
  );
});

test('campaign text delivery uses the live WhatsApp client with the correct engine address', async () => {
  const sent = [];
  const client = { sendMessage: async (...args) => { sent.push(args); return { key: { id: 'wa-1' } }; } };
  await sendCampaignText({ whatsappEngine: 'baileys', client }, '966551234567@s.whatsapp.net', 'عرض اليوم');
  await sendCampaignText({ whatsappEngine: 'baileys', client }, '278571713060916@lid', 'عرض لعميل LID');
  await sendCampaignText({ whatsappEngine: 'whatsapp-web', client }, '966551234567@s.whatsapp.net', 'عرض آخر');
  assert.deepEqual(sent, [
    ['966551234567@s.whatsapp.net', 'عرض اليوم'],
    ['278571713060916@lid', 'عرض لعميل LID'],
    ['966551234567@c.us', 'عرض آخر'],
  ]);
});

test('campaign start refuses immediately when WhatsApp is not connected', async () => {
  const campaign = {
    id: 'campaign-1', user_id: 'user-1', status: 'approved',
    approved_at: new Date(), approved_snapshot_hash: 'approved-hash',
  };
  const database = { query: async () => ({ rows: [campaign] }) };
  const service = createCampaignService({
    database,
    getUserBot: async () => ({ client: { sendMessage: async () => {} }, connection: { ready: false, status: 'reconnecting' } }),
  });
  await assert.rejects(
    () => service.start('user-1', 'campaign-1'),
    error => error.code === 'WHATSAPP_NOT_CONNECTED' && /واتساب غير متصل/.test(error.message),
  );
});

test('approved campaign start queues the reviewed audience without sending inside the request', async () => {
  const scheduled = [];
  let directSends = 0;
  const campaign = {
    id: 'campaign-approved',
    user_id: 'user-1',
    status: 'approved',
    approved_at: new Date(),
    approved_snapshot_hash: 'reviewed-hash',
    scheduled_at: null,
  };
  const database = {
    query: async sql => {
      if (sql.includes('SELECT * FROM campaigns')) return { rows: [campaign] };
      if (sql.includes('FROM whatsapp_history_imports')) return { rows: [{ count: 0 }] };
      if (sql.includes('FROM campaign_recipients')) return { rows: [{ count: 2 }] };
      if (sql.includes('FROM billing_accounts')) {
        return { rows: [{ messages_remaining: 100, quota_expires_at: null, expire_resets_quota: false }] };
      }
      if (sql.includes("UPDATE campaigns SET status = $3")) return { rows: [{ id: campaign.id }] };
      if (sql.includes('INSERT INTO campaign_events')) return { rows: [] };
      return { rows: [] };
    },
  };
  const service = createCampaignService({
    database,
    getUserBot: async () => ({
      client: { sendMessage: async () => { directSends += 1; } },
      connection: { ready: true, status: 'connected' },
    }),
    scheduleCampaignRecipient: async (campaignId, options) => {
      scheduled.push({ campaignId, options });
    },
  });
  const result = await service.start('user-1', campaign.id);
  assert.equal(result.id, campaign.id);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].campaignId, campaign.id);
  assert.equal(directSends, 0);
});

test('approval snapshot hash is stable across object key order and changes with recipients', () => {
  assert.deepEqual(canonicalize({ b: 1, a: { d: 2, c: 3 } }), { a: { c: 3, d: 2 }, b: 1 });
  const first = snapshotHash({ message: 'x', rules: { b: 2, a: 1 }, recipients: ['1'] });
  const reordered = snapshotHash({ recipients: ['1'], rules: { a: 1, b: 2 }, message: 'x' });
  const changed = snapshotHash({ message: 'x', rules: { a: 1, b: 2 }, recipients: ['1', '2'] });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test('approval trusts the reviewed recipient snapshot and purges imported message evidence', async () => {
  const campaignId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const campaign = {
    id: campaignId,
    user_id: userId,
    status: 'ready_for_approval',
    message_text: 'عرض العدسات',
    audience_rules: { source: 'keywords', searchTerms: ['عدسات'], states: [], productKeys: [], dateFrom: null, dateTo: null },
    interval_min_seconds: 30,
    interval_max_seconds: 60,
    scheduled_at: null,
    content_version: 1,
    audience_count: 2,
  };
  const recipients = [{ sender: '12345@lid' }, { sender: '966500000001@s.whatsapp.net' }];
  const approvedHash = snapshotHash({
    campaignId,
    contentVersion: 1,
    messageText: campaign.message_text,
    audienceRules: campaign.audience_rules,
    intervalMinSeconds: 30,
    intervalMaxSeconds: 60,
    scheduledAt: null,
    media: [],
    recipients: recipients.map(row => row.sender).sort(),
  });
  campaign.approved_snapshot_hash = approvedHash;
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM campaigns')) return { rows: [campaign] };
      if (sql.includes('SELECT sender FROM campaign_recipients')) return { rows: recipients };
      if (sql.includes('SELECT id, kind, sha256')) return { rows: [] };
      if (sql.includes("UPDATE campaigns SET status = 'approved'")) {
        return { rows: [{ ...campaign, status: 'approved', approved_at: new Date() }] };
      }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ present: true }] };
      if (sql.includes('DELETE FROM whatsapp_history_messages')) return { rows: [{ count: 8 }] };
      if (sql.includes('DELETE FROM whatsapp_history_conversations')) return { rows: [{ count: 2 }] };
      return { rows: [] };
    },
  };
  const database = { transaction: async fn => fn(client) };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  const result = await service.approve(userId, campaignId, { snapshotHash: approvedHash, audienceCount: 2 });
  assert.equal(result.status, 'approved');
  assert.equal(calls.some(call => /SELECT[\s\S]+FROM whatsapp_history_messages WHERE/.test(call.sql)), false);
  assert.equal(calls.some(call => call.sql.includes("source = 'saved_history_number'")), true);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM whatsapp_history_messages')), true);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM whatsapp_history_conversations')), true);
});

test('a new campaign can reuse an approved saved audience without searching messages', async () => {
  const sourceCampaignId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM campaigns')) {
        return { rows: [{
          id: sourceCampaignId,
          user_id: userId,
          name: 'حملة سابقة',
          goal: '',
          message_text: 'النص',
          approved_at: new Date(),
          interval_min_seconds: 30,
          interval_max_seconds: 60,
        }] };
      }
      if (sql.includes('SELECT COUNT(*)::int AS count FROM campaign_recipients')) return { rows: [{ count: 3 }] };
      if (sql.includes('INSERT INTO campaigns')) {
        return { rows: [{
          id: '33333333-3333-4333-8333-333333333333',
          user_id: userId,
          status: 'draft',
          name: params[1],
          audience_rules: JSON.parse(params[4]),
        }] };
      }
      return { rows: [] };
    },
  };
  const database = { transaction: async fn => fn(client) };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  const copy = await service.reuseAudience(userId, sourceCampaignId);
  assert.equal(copy.status, 'draft');
  assert.equal(copy.audience_rules.source, 'saved_campaign');
  assert.equal(copy.audience_rules.sourceCampaignId, sourceCampaignId);
  assert.equal(calls.some(call => call.sql.includes('FROM messages')), false);
  assert.equal(calls.some(call => call.sql.includes('FROM whatsapp_history_messages')), false);
});

test('campaign interval jitter always stays inside the configured range', () => {
  for (let index = 0; index < 100; index += 1) {
    const delay = randomDelayMs({ interval_min_seconds: 5, interval_max_seconds: 60 });
    assert.ok(delay >= 30000);
    assert.ok(delay <= 60000);
    assert.equal(delay % 1000, 0);
  }
});

test('campaign scheduler never queues a second recipient while one is in flight', async () => {
  const added = [];
  const client = { query: async sql => {
    if (/SELECT \* FROM campaigns/.test(sql)) return { rows: [{ id: 'campaign-1', status: 'sending' }] };
    if (/status IN \('queued','sending'\)/.test(sql)) return { rows: [{ count: 1 }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const database = { transaction: async fn => fn(client) };
  const result = await scheduleNextRecipient('campaign-1', {
    database,
    campaignQueue: { add: async (...args) => added.push(args) },
  });
  assert.equal(result, null);
  assert.equal(added.length, 0);
});

test('campaign recovery restores a queued recipient whose Redis job disappeared', async () => {
  const added = [];
  const queue = {
    getJob: async () => null,
    add: async (name, data, options) => { added.push({ name, data, options }); return { id: options.jobId }; },
  };
  const database = {
    query: async (sql) => {
      if (/UPDATE campaign_recipients r SET/.test(sql)) return { rows: [] };
      if (/SELECT r\.id, r\.campaign_id/.test(sql)) return { rows: [{ id: 'recipient-1', campaign_id: 'campaign-1' }] };
      if (/recovered_missing_queue_job/.test(sql)) return { rows: [{ id: 'recipient-1' }] };
      if (/SELECT id, status, scheduled_at FROM campaigns/.test(sql)) return { rows: [{ id: 'campaign-1', status: 'sending', scheduled_at: null }] };
      throw new Error(`unexpected outer query: ${sql}`);
    },
    transaction: async fn => fn({ query: async sql => {
      if (/SELECT \* FROM campaigns/.test(sql)) return { rows: [{ id: 'campaign-1', status: 'sending' }] };
      if (/status IN \('queued','sending'\)/.test(sql)) return { rows: [{ count: 0 }] };
      if (/status = 'pending'/.test(sql)) return { rows: [{ id: 'recipient-1' }] };
      if (/UPDATE campaign_recipients SET status = 'queued'/.test(sql)) return { rows: [] };
      throw new Error(`unexpected transaction query: ${sql}`);
    } }),
  };
  const result = await recoverCampaignDeliveries({ database, campaignQueue: queue, staleMs: 120000 });
  assert.deepEqual(result, { staleSending: 0, missingJobs: 1, scheduled: 1 });
  assert.equal(added.length, 1);
  assert.equal(added[0].options.jobId, 'campaign-recipient-1');
});

test('campaign service clamps merchant intervals below 30 seconds', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO campaigns/.test(sql)) return { rows: [{ id: 'campaign-1', user_id: 'user-1', name: 'اختبار', audience_rules: {}, interval_min_seconds: params[5], interval_max_seconds: params[6] }] };
      return { rows: [] };
    },
  };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  await service.create('user-1', { name: 'اختبار', intervalMinSeconds: 1, intervalMaxSeconds: 5 });
  const insert = calls.find(call => /INSERT INTO campaigns/.test(call.sql));
  assert.equal(insert.params[5], 30);
  assert.equal(insert.params[6], 30);
});

test('campaign message preserves links, intentional lines and emoji', () => {
  const message = 'شاهد العرض 👇\nhttps://example.com/product?id=7\nينتهي غداً ✨';
  assert.equal(normalizeCampaignMessage(`  ${message}  `), message);
});

test('keyword audience keeps up to 50 unique Enter-style search terms and requires at least one', () => {
  const rules = normalizeAudienceRules({
    source: 'keywords',
    searchTerms: ['  عدسات لاصقة  ', 'عدسات لاصقة', 'LENS', 'lens', 'أ'],
  });
  assert.deepEqual(rules.searchTerms, ['عدسات لاصقة', 'LENS']);
  assert.throws(
    () => normalizeAudienceRules({ source: 'keywords', searchTerms: [] }),
    /أضف كلمة بحث واحدة على الأقل/,
  );
});

test('keyword audience searches inbound customer messages and removes duplicate recipients', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [
        { conversation_id: 'c1', sender: '96651@s.whatsapp.net', product_name: 'عدسات', evidence_text: 'كم سعر العدسات؟', source: 'keyword_search' },
        { conversation_id: 'c1', sender: '96651@s.whatsapp.net', product_name: 'طبية', evidence_text: 'أبغى عدسات طبية', source: 'keyword_search' },
      ] };
    },
  };
  const recipients = await resolveAudience(database, 'user-1', { source: 'keywords', searchTerms: ['عدسات', 'طبية'] });
  assert.equal(recipients.length, 1);
  assert.match(calls[0].sql, /m\.direction = 'inbound'/);
  assert.match(calls[0].sql, /unnest\(\$2::text\[\]\)/);
  assert.deepEqual(calls[0].params[1], ['عدسات', 'طبية']);
});

test('keyword audience includes WhatsApp LID conversations instead of silently dropping them', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{
        conversation_id: 'c-lid',
        sender: '278571713060916@lid',
        normalized_phone: null,
        product_name: 'عدسات',
        evidence_text: 'أريد عدسات',
        source: 'keyword_search',
      }] };
    },
  };
  const recipients = await resolveAudience(database, 'user-1', { source: 'keywords', searchTerms: ['عدسات'] });
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].sender, '278571713060916@lid');
  assert.doesNotMatch(calls[0].sql, /c\.sender NOT LIKE '%@lid'/);
});

test('all-conversations audience includes WhatsApp LID conversations', async () => {
  let call = 0;
  const database = { query: async sql => {
    call += 1;
    if (call === 1) {
      assert.doesNotMatch(sql, /sender NOT LIKE '%@lid'/);
      return { rows: [{ conversation_id: 'c-lid', sender: '278571713060916@lid', normalized_phone: null, source: 'conversation' }] };
    }
    return { rows: [] };
  } };
  const recipients = await resolveAudience(database, 'user-1', { source: 'all' });
  assert.deepEqual(recipients.map(row => row.sender), ['278571713060916@lid']);
});

test('keyword audience can be previewed before a campaign is saved', async () => {
  const database = { query: async () => ({ rows: [
    { conversation_id: 'c1', sender: '96651@s.whatsapp.net', product_name: 'عدسات', evidence_text: 'أريد عدسات', source: 'keyword_search' },
  ] }) };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  const result = await service.previewAudience('user-1', { source: 'keywords', searchTerms: ['عدسات'] });
  assert.equal(result.count, 1);
  assert.equal(result.recipients[0].sender, '96651@s.whatsapp.net');
});

test('campaign worker rechecks keyword evidence immediately before delivery', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ exists: 1 }] };
    },
  };
  const matches = await recipientMatchesKeywordAudience(
    database,
    { user_id: 'user-1' },
    { conversation_id: 'conv-1' },
    { source: 'keywords', searchTerms: ['منتج أ'], dateFrom: '2026-07-01' },
  );
  assert.equal(matches, true);
  assert.match(calls[0].sql, /direction = 'inbound'/);
  assert.deepEqual(calls[0].params.slice(0, 3), ['user-1', 'conv-1', ['منتج أ']]);
});

test('Excel export is generated live with a separate sheet for every customer state', async () => {
  const rows = [
    { signal_id: '1', sender: '96651@s.whatsapp.net', product_name: 'أ', customer_state: 'interested_unverified', confidence: 0.8, evidence_text: 'سأل', source: 'conversation', last_detected_at: new Date() },
    { signal_id: '2', sender: '96652@s.whatsapp.net', product_name: 'ب', customer_state: 'ordered_confirmed', order_reference: 'AB-12', confidence: 1, evidence_text: 'طلب', source: 'merchant_manual', last_detected_at: new Date() },
  ];
  const service = createCampaignService({ database: { query: async () => ({ rows }) }, getUserBot: async () => ({}) });
  const buffer = await service.exportSignals('user-1');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['مهتمون بلا طلب مؤكد', 'الطلبات المؤكدة', 'يحتاجون تحقق']);
  assert.equal(workbook.getWorksheet('الطلبات المؤكدة').getCell('E2').value, 'AB-12');
});

test('merchant can manually move a customer into the confirmed-orders database with an audit event', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT \* FROM customer_product_signals/.test(sql)) return { rows: [{ id: 'signal-1', state: 'interested_unverified' }] };
      if (/UPDATE customer_product_signals/.test(sql)) return { rows: [{ id: 'signal-1', state: 'ordered_confirmed', order_reference: 'AB-77' }] };
      return { rows: [] };
    },
  };
  const database = { transaction: async fn => fn(client) };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  const signal = await service.updateSignal('user-1', 'signal-1', { state: 'ordered_confirmed', orderReference: 'AB-77', note: 'تأكد من المتجر' });
  assert.equal(signal.state, 'ordered_confirmed');
  assert.ok(calls.some(call => /INSERT INTO customer_product_signal_events/.test(call.sql)));
});

test('an edited exported Excel sheet can be re-imported to update the customer classification', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الطلبات المؤكدة');
  sheet.addRow(['رقم العميل', 'اسم العميل', 'المنتج', 'التصنيف', 'رقم الطلب']);
  sheet.addRow(['966551234567', 'عميل', 'منتج تجريبي', 'ordered_confirmed', 'AB-88']);
  const buffer = await workbook.xlsx.writeBuffer();
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO customer_product_signals/.test(sql)) return { rows: [{ id: 'signal-1' }] };
      return { rows: [] };
    },
  };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  const result = await service.importContacts('user-1', buffer, 'edited.xlsx');
  assert.equal(result.added, 1);
  const signalInsert = calls.find(call => /INSERT INTO customer_product_signals/.test(call.sql));
  assert.equal(signalInsert.params[5], 'ordered_confirmed');
  assert.equal(signalInsert.params[9], 'AB-88');
});

test('legacy smart audience is retired and automatically becomes Excel or manual contacts', () => {
  const rules = normalizeAudienceRules({ source: 'smart', states: ['interested_unverified'] });
  assert.equal(rules.source, 'contacts');
  assert.deepEqual(rules.states, ['interested_unverified']);
});

test('campaign audience never sends twice when a phone exists in conversations and Excel contacts', async () => {
  let call = 0;
  const database = { query: async () => {
    call += 1;
    if (call === 1) return { rows: [{ conversation_id: 'c1', sender: '966551234567@s.whatsapp.net', normalized_phone: '966551234567', source: 'conversation' }] };
    return { rows: [
      { conversation_id: null, sender: '966551234567@s.whatsapp.net', normalized_phone: '966551234567', source: 'import' },
      { conversation_id: null, sender: '966559999999@s.whatsapp.net', normalized_phone: '966559999999', source: 'import' },
    ] };
  } };
  const recipients = await resolveAudience(database, 'user-1', { source: 'all' });
  assert.equal(recipients.length, 2);
  assert.equal(recipients.filter(item => item.sender === '966551234567@s.whatsapp.net').length, 1);
});

test('Excel audience import stores orders and subscription dates while merging duplicate phones', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('العملاء');
  sheet.addRow(['رقم الجوال', 'اسم العميل', 'نوع السجل', 'المنتج أو الاشتراك', 'رقم الطلب', 'تاريخ الطلب', 'بداية الاشتراك', 'نهاية الاشتراك']);
  sheet.addRow(['0551234567', 'عميل واحد', 'طلب', 'منتج أ', 'ORD-7', '2026-07-16', '', '']);
  sheet.addRow(['+966551234567', 'عميل واحد', 'اشتراك', 'اشتراك سنوي', '', '', '2026-07-01', '2027-06-30']);
  const buffer = await workbook.xlsx.writeBuffer();
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO customer_product_signals/.test(sql)) return { rows: [{ id: 'signal-1' }] };
      return { rows: [] };
    },
  };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  const result = await service.importContacts('user-1', buffer, 'audience.xlsx');
  assert.deepEqual({ added: result.added, duplicates: result.duplicates, ordered: result.ordered, subscriptions: result.subscriptions }, {
    added: 1, duplicates: 1, ordered: 1, subscriptions: 1,
  });
  assert.equal(result.invalid.length, 0);
  const contactCalls = calls.filter(call => /INSERT INTO campaign_contacts/.test(call.sql));
  assert.equal(contactCalls.length, 2);
  assert.match(contactCalls[0].sql, /ON CONFLICT \(user_id, normalized_phone\) DO UPDATE/);
  assert.equal(contactCalls[0].params[5], 'ordered');
  assert.equal(contactCalls[0].params[8], '2026-07-16');
  assert.equal(contactCalls[1].params[5], 'subscription');
  assert.equal(contactCalls[1].params[9], '2026-07-01');
  assert.equal(contactCalls[1].params[10], '2027-06-30');
});

test('Excel audience import rejects unclear or reversed subscription dates', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('العملاء');
  sheet.addRow(['رقم الجوال', 'نوع السجل', 'بداية الاشتراك', 'نهاية الاشتراك']);
  sheet.addRow(['0551234567', 'اشتراك', '2027-01-01', '2026-01-01']);
  const buffer = await workbook.xlsx.writeBuffer();
  const calls = [];
  const service = createCampaignService({ database: { query: async (...args) => { calls.push(args); return { rows: [] }; } }, getUserBot: async () => ({}) });
  const result = await service.importContacts('user-1', buffer, 'bad-dates.xlsx');
  assert.equal(result.added, 0);
  assert.equal(result.invalid.length, 1);
  assert.match(result.invalid[0].reason, /بداية الاشتراك/);
  assert.equal(calls.length, 0);
});

test('campaign contact template and database export expose order and subscription fields', async () => {
  const database = { query: async () => ({ rows: [{
    normalized_phone: '966551234567', name: 'عميل', customer_status: 'subscription', product_name: 'اشتراك سنوي',
    order_reference: null, order_date: null, subscription_start_date: '2026-07-01', subscription_end_date: '2027-06-30',
    source: 'import', updated_at: '2026-07-16T00:00:00Z',
  }] }) };
  const service = createCampaignService({ database, getUserBot: async () => ({}) });
  const template = new ExcelJS.Workbook();
  await template.xlsx.load(await service.exportContactTemplate());
  assert.deepEqual(template.getWorksheet('نموذج الاستهداف').getRow(1).values.slice(1), [
    'رقم الجوال', 'اسم العميل', 'نوع السجل', 'المنتج أو الاشتراك', 'رقم الطلب', 'تاريخ الطلب', 'بداية الاشتراك', 'نهاية الاشتراك',
  ]);
  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(await service.exportContacts('user-1'));
  const row = exported.getWorksheet('قاعدة العملاء').getRow(2).values;
  assert.equal(row[3], 'اشتراك');
  assert.equal(row[7], '2026-07-01');
  assert.equal(row[8], '2027-06-30');
});

test('campaign media validation checks file contents, not only the browser MIME type', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(hasValidSignature(png, 'image/png'), true);
  assert.equal(hasValidSignature(Buffer.from('not really an image'), 'image/png'), false);
});

test('campaign UI exposes wizard, multi-media and explicit approval without store integration', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'campaigns.js'), 'utf8');
  assert.ok(html.includes('id="tab-campaigns"'));
  assert.ok(html.includes('id="view-campaigns"'));
  assert.ok(html.includes('data-campaign-step="audience"'));
  assert.ok(html.includes('data-campaign-step="review"'));
  assert.ok(html.includes('name="campaignSource" value="all"'));
  assert.ok(html.includes('name="campaignSource" value="conversations"'));
  assert.ok(html.includes('name="campaignSource" value="keywords"'));
  assert.ok(html.includes('class="campaign-source-list"'));
  assert.ok(html.includes('id="campaignNumbersCount"'));
  assert.ok(html.includes('id="campaignKeywordInput"'));
  assert.ok(html.includes('id="campaignKeywordPreview"'));
  assert.ok(html.includes('id="campaignMedia" type="file" multiple'));
  assert.ok(html.includes('id="campaignApproveBtn"'));
  assert.ok(html.includes('id="campaignStartBtn"'));
  assert.ok(html.includes('min="30"'));
  assert.ok(html.includes('id="campaignSegmentDetails"'));
  assert.ok(html.includes('id="campaignWhatsappMessage"'));
  assert.ok(html.includes('id="campaignContentAudienceCount"'));
  assert.ok(js.includes('/prepare-approval'));
  assert.ok(js.includes('/approve'));
  assert.ok(js.includes('campaignAddKeyword'));
  assert.ok(js.includes('campaignPreviewKeywords'));
  assert.ok(js.includes("window.confirm('هل تريد بدء إرسال الحملة المعتمدة الآن؟')"));
  const campaignMarkup = html.split('id="view-campaigns"')[1].split('id="view-pricing"')[0];
  assert.doesNotMatch(campaignMarkup, /campaignImportFile|استيراد ملف Excel|مهتم ولم يطلب/);
  assert.doesNotMatch(`${campaignMarkup}\n${js}`, /salla|(?:^|\s)سلة(?:\s|$)/i);
});

test('campaign backend is mounted with a dedicated queue and worker', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');
  const queue = fs.readFileSync(path.join(__dirname, '..', 'src', 'queues', 'campaign-queue.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'campaign-worker.js'), 'utf8');
  assert.ok(server.includes('createCampaignRoutes'));
  assert.ok(server.includes('createCampaignWorker'));
  assert.ok(routes.includes('/api/campaigns/contacts/template.xlsx'));
  assert.ok(routes.includes('/api/campaigns/contacts/export.xlsx'));
  assert.ok(routes.includes('/api/campaigns/audience/preview'));
  assert.ok(queue.includes("'campaign-deliveries'"));
  assert.ok(queue.includes('refresh-campaign-segmentation'));
  assert.ok(worker.includes('concurrency: 1'));
  assert.ok(worker.includes('quota_decremented'));
  assert.ok(worker.includes('media_cursor'));
  assert.ok(worker.includes('smart_segment_changed'));
  assert.ok(worker.includes("worker.on('error'"));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'message-ingest.service.js'), 'utf8').includes('campaignSegmentation'));
});

test('campaign migration contains durable approval and recipient progress fields', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS campaigns'));
  assert.ok(migration.includes('approved_snapshot_hash'));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS campaign_recipients'));
  assert.ok(migration.includes('text_sent BOOLEAN'));
  assert.ok(migration.includes('quota_decremented BOOLEAN'));
  assert.ok(migration.includes('customer_product_signal_events'));
  assert.ok(migration.includes('subscription_start_date'));
  assert.ok(migration.includes('subscription_end_date'));
  assert.ok(migration.includes('interval_min_seconds BETWEEN 30 AND 3600'));
});
