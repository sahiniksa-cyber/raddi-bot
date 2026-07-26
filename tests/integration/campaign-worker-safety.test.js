'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createCampaignSendGateway,
  decrementCampaignRecipientQuota,
  processCampaignRecipient,
  recoverCampaignDeliveries,
} = require('../../src/workers/campaign-worker');
const {
  CampaignWorkerRepository,
  DeterministicCampaignQueue,
  DurableCampaignTransport,
} = require('../helpers/campaign-worker-runtime');
const { policy } = require('../helpers/send-gateway-harness');

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

test('quota debit rolls back with the recipient marker crash and retries exactly once', async () => {
  const database = new CampaignWorkerRepository({
    quotas: {
      'merchant-a': { messages_remaining: 2, messages_used: 0 },
    },
    recipients: {
      'recipient-a1': {
        id: 'recipient-a1',
        user_id: 'merchant-a',
        quota_decremented: false,
      },
    },
  });
  database.failOnRecipientMarkerOnce = true;

  await assert.rejects(
    decrementCampaignRecipientQuota({
      database,
      userId: 'merchant-a',
      recipientId: 'recipient-a1',
    }),
    /INJECTED_CRASH_BEFORE_RECIPIENT_MARKER/,
  );
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 2,
    messages_used: 0,
  });
  assert.equal(database.state.recipients['recipient-a1'].quota_decremented, false);

  assert.deepEqual(
    await decrementCampaignRecipientQuota({
      database,
      userId: 'merchant-a',
      recipientId: 'recipient-a1',
    }),
    { success: true, remaining: 1, alreadyDebited: false },
  );
  assert.deepEqual(
    await decrementCampaignRecipientQuota({
      database,
      userId: 'merchant-a',
      recipientId: 'recipient-a1',
    }),
    { success: true, remaining: 1, alreadyDebited: true },
  );
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 1,
    messages_used: 1,
  });
  assert.equal(database.state.recipients['recipient-a1'].quota_decremented, true);
});

test('campaign worker rolls back its quota debit when the recipient marker crashes', async () => {
  const database = new CampaignWorkerRepository({
    campaigns: {
      'campaign-a': {
        id: 'campaign-a',
        user_id: 'merchant-a',
        status: 'sending',
        approved_at: '2026-07-26T00:00:00.000Z',
        message_text: 'exact bytes already sent',
        audience_rules: { source: 'manual' },
        interval_min_seconds: 30,
        interval_max_seconds: 30,
      },
    },
    policies: {
      'merchant-a': policy().policy,
    },
    quotas: {
      'merchant-a': { messages_remaining: 2, messages_used: 0 },
    },
    recipients: {
      'recipient-a1': {
        id: 'recipient-a1',
        campaign_id: 'campaign-a',
        user_id: 'merchant-a',
        sender: '966500000001@s.whatsapp.net',
        status: 'queued',
        attempts: 0,
        text_sent: true,
        quota_decremented: false,
        media_cursor: 0,
        provider_message_ids: ['provider-text-a1'],
      },
    },
  });
  database.failOnRecipientMarkerOnce = true;
  const job = {
    data: { campaignId: 'campaign-a', recipientId: 'recipient-a1' },
    opts: { attempts: 2 },
    attemptsMade: 0,
  };

  await assert.rejects(
    processCampaignRecipient(job, {
      database,
      getUserBot: async () => ({
        client: {},
        connection: { ready: true, status: 'connected' },
      }),
      gatewayFactory: () => ({
        send: async () => {
          throw new Error('transport must not run in the quota crash fixture');
        },
      }),
    }),
    /INJECTED_CRASH_BEFORE_RECIPIENT_MARKER/,
  );
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 2,
    messages_used: 0,
  });
  assert.equal(database.state.recipients['recipient-a1'].quota_decremented, false);
  assert.equal(database.state.recipients['recipient-a1'].status, 'queued');
});

for (const stoppedStatus of ['paused', 'canceled']) {
  test(`campaign worker fences ${stoppedStatus} after its initial lock and before text transport`, async () => {
    const exactMessage = 'سطر أول\nhttps://example.test/path?q=1\n✨ نهاية';
    const database = new CampaignWorkerRepository({
      campaigns: {
        'campaign-a': {
          id: 'campaign-a',
          user_id: 'merchant-a',
          status: 'sending',
          approved_at: '2026-07-26T00:00:00.000Z',
          message_text: exactMessage,
          audience_rules: { source: 'manual' },
          interval_min_seconds: 30,
          interval_max_seconds: 30,
          sent_count: 0,
        },
      },
      policies: {
        'merchant-a': policy().policy,
      },
      quotas: {
        'merchant-a': { messages_remaining: 3, messages_used: 0 },
      },
      recipients: {
        'recipient-a1': {
          id: 'recipient-a1',
          campaign_id: 'campaign-a',
          user_id: 'merchant-a',
          sender: '966500000001@s.whatsapp.net',
          status: 'queued',
          attempts: 0,
          text_sent: false,
          quota_decremented: false,
          media_cursor: 0,
          provider_message_ids: [],
        },
      },
    });
    const sends = [];

    const result = await processCampaignRecipient({
      data: { campaignId: 'campaign-a', recipientId: 'recipient-a1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    }, {
      database,
      getUserBot: async () => ({
        client: {},
        connection: { ready: true, status: 'connected' },
      }),
      gatewayFactory: () => {
        database.state.campaigns['campaign-a'].status = stoppedStatus;
        return {
          send: async request => {
            sends.push(request);
            return {
              decision: 'sent',
              provider: { providerMessageId: 'provider-text-a1' },
            };
          },
        };
      },
    });

    assert.deepEqual(result, { stopped: true, reason: stoppedStatus });
    assert.deepEqual(sends, []);
    assert.equal(
      database.state.recipients['recipient-a1'].status,
      stoppedStatus === 'paused' ? 'pending' : 'canceled',
    );
    assert.equal(database.state.recipients['recipient-a1'].text_sent, false);
    assert.deepEqual(database.state.quotas['merchant-a'], {
      messages_remaining: 3,
      messages_used: 0,
    });
    assert.equal(database.state.campaigns['campaign-a'].sent_count, 0);
  });
}

for (const stoppedStatus of ['paused', 'canceled']) {
  test(`${stoppedStatus} cannot commit after the final decision lock but before transport`, async () => {
    const database = new CampaignWorkerRepository({
      campaigns: {
        'campaign-a': {
          id: 'campaign-a',
          user_id: 'merchant-a',
          status: 'sending',
          approved_at: '2026-07-26T00:00:00.000Z',
          message_text: 'locked transport',
          audience_rules: { source: 'manual' },
          interval_min_seconds: 30,
          interval_max_seconds: 30,
          sent_count: 0,
        },
      },
      policies: { 'merchant-a': policy().policy },
      quotas: { 'merchant-a': { messages_remaining: 2, messages_used: 0 } },
      recipients: {
        'recipient-a1': {
          id: 'recipient-a1',
          campaign_id: 'campaign-a',
          user_id: 'merchant-a',
          sender: '966500000001@s.whatsapp.net',
          status: 'queued',
          attempts: 0,
          text_sent: false,
          quota_decremented: false,
          media_cursor: 0,
          provider_message_ids: [],
        },
      },
    });
    const transportEntered = deferred();
    const releaseTransport = deferred();
    let sends = 0;
    const workerPromise = processCampaignRecipient({
      data: { campaignId: 'campaign-a', recipientId: 'recipient-a1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    }, {
      database,
      getUserBot: async () => ({
        client: {},
        connection: { ready: true, status: 'connected' },
      }),
      gatewayFactory: () => ({
        async send() {
          sends += 1;
          transportEntered.resolve();
          await releaseTransport.promise;
          return {
            decision: 'sent',
            provider: { providerMessageId: 'provider-a1' },
          };
        },
      }),
    });
    await transportEntered.promise;

    let stopCommitted = false;
    const stopPromise = database.transaction(async client => {
      await client.query(`SELECT * FROM campaigns WHERE id = $1 FOR UPDATE`, ['campaign-a']);
      await client.query(
        `UPDATE campaigns SET status = $3, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        ['campaign-a', 'merchant-a', stoppedStatus],
      );
    }).then(() => {
      stopCommitted = true;
    });

    try {
      await waitUntil(() => stopCommitted || database.transactionWaiters > 0);
      assert.equal(stopCommitted, false, 'stop must wait until the locked transport decision finishes');
    } finally {
      releaseTransport.resolve();
      await Promise.allSettled([workerPromise, stopPromise]);
    }

    assert.equal(sends, 1);
    assert.equal(stopCommitted, true);
    assert.equal(database.state.campaigns['campaign-a'].status, stoppedStatus);
    assert.equal(database.state.recipients['recipient-a1'].status, 'sent');
    assert.equal(database.state.campaigns['campaign-a'].sent_count, 1);
  });
}

test('overlapping campaigns reserve shared quota before either network send', async () => {
  const campaigns = {};
  const recipients = {};
  for (const suffix of ['1', '2']) {
    campaigns[`campaign-${suffix}`] = {
      id: `campaign-${suffix}`,
      user_id: 'merchant-a',
      status: 'sending',
      approved_at: '2026-07-26T00:00:00.000Z',
      message_text: `message-${suffix}`,
      audience_rules: { source: 'manual' },
      interval_min_seconds: 30,
      interval_max_seconds: 30,
      sent_count: 0,
    };
    recipients[`recipient-${suffix}`] = {
      id: `recipient-${suffix}`,
      campaign_id: `campaign-${suffix}`,
      user_id: 'merchant-a',
      sender: `96650000000${suffix}@s.whatsapp.net`,
      status: 'queued',
      attempts: 0,
      text_sent: false,
      quota_decremented: false,
      media_cursor: 0,
      provider_message_ids: [],
    };
  }
  const database = new CampaignWorkerRepository({
    campaigns,
    policies: { 'merchant-a': policy().policy },
    quotas: { 'merchant-a': { messages_remaining: 1, messages_used: 0 } },
    recipients,
  });
  const firstTransportEntered = deferred();
  const releaseFirstTransport = deferred();
  const sends = [];
  const dependencies = {
    database,
    getUserBot: async () => ({
      client: {},
      connection: { ready: true, status: 'connected' },
    }),
    gatewayFactory: () => ({
      async send(request) {
        sends.push(request);
        if (sends.length === 1) {
          firstTransportEntered.resolve();
          await releaseFirstTransport.promise;
        }
        return {
          decision: 'sent',
          provider: { providerMessageId: `provider-${sends.length}` },
        };
      },
    }),
  };
  const first = processCampaignRecipient({
    data: { campaignId: 'campaign-1', recipientId: 'recipient-1' },
    opts: { attempts: 1 },
    attemptsMade: 0,
  }, dependencies);
  await firstTransportEntered.promise;
  const second = processCampaignRecipient({
    data: { campaignId: 'campaign-2', recipientId: 'recipient-2' },
    opts: { attempts: 1 },
    attemptsMade: 0,
  }, dependencies);

  try {
    await waitUntil(() => sends.length > 1 || database.transactionWaiters > 0);
    assert.equal(sends.length, 1, 'the second campaign must wait for the shared quota reservation');
  } finally {
    releaseFirstTransport.resolve();
  }
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, [
    { sent: true },
    { paused: true, reason: 'empty' },
  ]);
  assert.equal(sends.length, 1);
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 0,
    messages_used: 1,
  });
});

test('an overlapping duplicate job cannot claim a recipient already sending', async () => {
  const database = new CampaignWorkerRepository({
    campaigns: {
      'campaign-a': {
        id: 'campaign-a',
        user_id: 'merchant-a',
        status: 'sending',
        approved_at: '2026-07-26T00:00:00.000Z',
        message_text: 'one delivery',
        audience_rules: { source: 'manual' },
        interval_min_seconds: 30,
        interval_max_seconds: 30,
        sent_count: 0,
      },
    },
    policies: { 'merchant-a': policy().policy },
    quotas: { 'merchant-a': { messages_remaining: 2, messages_used: 0 } },
    recipients: {
      'recipient-a1': {
        id: 'recipient-a1',
        campaign_id: 'campaign-a',
        user_id: 'merchant-a',
        sender: '966500000001@s.whatsapp.net',
        status: 'queued',
        attempts: 0,
        text_sent: false,
        quota_decremented: false,
        media_cursor: 0,
        provider_message_ids: [],
      },
    },
  });
  const firstTransportEntered = deferred();
  const releaseFirstTransport = deferred();
  let gatewayCalls = 0;
  const dependencies = {
    database,
    getUserBot: async () => ({
      client: {},
      connection: { ready: true, status: 'connected' },
    }),
    gatewayFactory: () => ({
      async send() {
        gatewayCalls += 1;
        if (gatewayCalls === 1) {
          firstTransportEntered.resolve();
          await releaseFirstTransport.promise;
          return {
            decision: 'sent',
            provider: { providerMessageId: 'provider-a1' },
          };
        }
        return {
          decision: 'duplicate',
          reservation: { provider_message_id: 'provider-a1' },
        };
      },
    }),
  };
  const job = {
    data: { campaignId: 'campaign-a', recipientId: 'recipient-a1' },
    opts: { attempts: 1 },
    attemptsMade: 0,
  };
  const first = processCampaignRecipient(job, dependencies);
  await firstTransportEntered.promise;
  const duplicate = processCampaignRecipient(job, dependencies);

  try {
    await waitUntil(() => gatewayCalls > 1 || database.transactionWaiters > 0);
    assert.equal(gatewayCalls, 1, 'an already-sending recipient must not be claimed twice');
  } finally {
    releaseFirstTransport.resolve();
  }
  assert.deepEqual(await Promise.all([first, duplicate]), [
    { sent: true },
    { skipped: true },
  ]);
  assert.equal(database.state.campaigns['campaign-a'].sent_count, 1);
  assert.equal(database.state.recipients['recipient-a1'].status, 'sent');
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 1,
    messages_used: 1,
  });
});

test('worker recreation resumes partial media and text without duplicate transport or quota', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-worker-safety-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const firstMedia = Buffer.from('%PDF-1.7\nfirst exact campaign media\n%%EOF');
  const secondMedia = Buffer.from('%PDF-1.7\nsecond exact campaign media\n%%EOF');
  const firstPath = path.join(tempDir, 'first.pdf');
  const secondPath = path.join(tempDir, 'second.pdf');
  await fs.writeFile(firstPath, firstMedia);
  await fs.writeFile(secondPath, secondMedia);
  const exactMessage = 'خصم خاص ✨\nhttps://example.test/offer?ref=A%20B\nالسطر الأخير';
  const database = new CampaignWorkerRepository({
    campaigns: {
      'campaign-a': {
        id: 'campaign-a',
        user_id: 'merchant-a',
        status: 'sending',
        approved_at: '2026-07-26T00:00:00.000Z',
        message_text: exactMessage,
        audience_rules: { source: 'manual' },
        interval_min_seconds: 30,
        interval_max_seconds: 30,
        sent_count: 0,
      },
    },
    media: {
      'campaign-a': [
        {
          campaign_id: 'campaign-a',
          kind: 'document',
          original_name: 'first.pdf',
          mime_type: 'application/pdf',
          storage_path: firstPath,
          sort_order: 0,
        },
        {
          campaign_id: 'campaign-a',
          kind: 'document',
          original_name: 'second.pdf',
          mime_type: 'application/pdf',
          storage_path: secondPath,
          sort_order: 1,
        },
      ],
    },
    policies: {
      'merchant-a': policy().policy,
    },
    quotas: {
      'merchant-a': { messages_remaining: 4, messages_used: 0 },
    },
    recipients: {
      'recipient-a1': {
        id: 'recipient-a1',
        campaign_id: 'campaign-a',
        user_id: 'merchant-a',
        sender: '966500000001@s.whatsapp.net',
        status: 'queued',
        attempts: 0,
        text_sent: false,
        quota_decremented: false,
        media_cursor: 0,
        provider_message_ids: [],
      },
    },
  });
  const transport = new DurableCampaignTransport();
  const dependencies = {
    database,
    getUserBot: async () => ({
      client: {},
      connection: { ready: true, status: 'connected' },
    }),
    gatewayFactory: () => transport.createGateway(),
  };
  database.failOnMediaCursorOnce = true;

  await assert.rejects(
    processCampaignRecipient({
      data: { campaignId: 'campaign-a', recipientId: 'recipient-a1' },
      opts: { attempts: 3 },
      attemptsMade: 0,
    }, dependencies),
    /INJECTED_CRASH_BEFORE_MEDIA_CURSOR/,
  );
  assert.equal(database.state.recipients['recipient-a1'].media_cursor, 0);
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 3,
    messages_used: 1,
  });

  database.failOnTextMarkerOnce = true;
  await assert.rejects(
    processCampaignRecipient({
      data: { campaignId: 'campaign-a', recipientId: 'recipient-a1' },
      opts: { attempts: 3 },
      attemptsMade: 1,
    }, dependencies),
    /INJECTED_CRASH_BEFORE_TEXT_MARKER/,
  );
  assert.equal(database.state.recipients['recipient-a1'].media_cursor, 2);
  assert.equal(database.state.recipients['recipient-a1'].text_sent, false);
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 3,
    messages_used: 1,
  });

  assert.deepEqual(
    await processCampaignRecipient({
      data: { campaignId: 'campaign-a', recipientId: 'recipient-a1' },
      opts: { attempts: 3 },
      attemptsMade: 2,
    }, dependencies),
    { sent: true },
  );

  assert.deepEqual(
    transport.sends.map(send => send.idempotencyKey),
    [
      'campaign:campaign-a:recipient-a1:media:0',
      'campaign:campaign-a:recipient-a1:media:1',
      'campaign:campaign-a:recipient-a1:text',
    ],
  );
  assert.deepEqual(Buffer.from(transport.sends[0].media.document), firstMedia);
  assert.deepEqual(Buffer.from(transport.sends[1].media.document), secondMedia);
  assert.equal(transport.sends[2].content, exactMessage);
  assert.equal(database.state.recipients['recipient-a1'].attempts, 3);
  assert.equal(database.state.recipients['recipient-a1'].media_cursor, 2);
  assert.equal(database.state.recipients['recipient-a1'].text_sent, true);
  assert.equal(database.state.recipients['recipient-a1'].quota_decremented, true);
  assert.equal(database.state.recipients['recipient-a1'].status, 'sent');
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 3,
    messages_used: 1,
  });
  assert.equal(database.state.messages.length, 1);
  assert.equal(database.state.messages[0].content, exactMessage);
  assert.equal(database.state.messages[0].user_id, 'merchant-a');
  assert.equal(database.state.messages[0].raw_payload.campaignRecipientId, 'recipient-a1');
  assert.equal(database.state.campaigns['campaign-a'].sent_count, 1);
  assert.equal(database.state.campaigns['campaign-a'].status, 'completed');
});

test('restart recovery preserves partial markers, live jobs, terminal rows, and exact future delay', async () => {
  const frozenNow = Date.now() + 3600000;
  const database = new CampaignWorkerRepository({
    campaigns: {
      'campaign-stale': {
        id: 'campaign-stale',
        user_id: 'merchant-a',
        status: 'sending',
      },
      'campaign-live': {
        id: 'campaign-live',
        user_id: 'merchant-a',
        status: 'sending',
      },
      'campaign-missing': {
        id: 'campaign-missing',
        user_id: 'merchant-a',
        status: 'sending',
      },
      'campaign-future': {
        id: 'campaign-future',
        user_id: 'merchant-b',
        status: 'scheduled',
        scheduled_at: new Date(frozenNow + 45000).toISOString(),
      },
      'campaign-done': {
        id: 'campaign-done',
        user_id: 'merchant-b',
        status: 'completed',
      },
    },
    recipients: {
      'recipient-stale': {
        id: 'recipient-stale',
        campaign_id: 'campaign-stale',
        user_id: 'merchant-a',
        status: 'sending',
        media_cursor: 1,
        text_sent: false,
        quota_decremented: false,
        provider_message_ids: ['provider-media-stale'],
      },
      'recipient-live': {
        id: 'recipient-live',
        campaign_id: 'campaign-live',
        user_id: 'merchant-a',
        status: 'queued',
        media_cursor: 0,
        text_sent: false,
        quota_decremented: false,
        provider_message_ids: [],
      },
      'recipient-missing': {
        id: 'recipient-missing',
        campaign_id: 'campaign-missing',
        user_id: 'merchant-a',
        status: 'queued',
        media_cursor: 0,
        text_sent: true,
        quota_decremented: false,
        provider_message_ids: ['provider-text-missing'],
      },
      'recipient-future': {
        id: 'recipient-future',
        campaign_id: 'campaign-future',
        user_id: 'merchant-b',
        status: 'pending',
        media_cursor: 0,
        text_sent: false,
        quota_decremented: false,
        provider_message_ids: [],
      },
      'recipient-terminal': {
        id: 'recipient-terminal',
        campaign_id: 'campaign-done',
        user_id: 'merchant-b',
        status: 'sent',
        media_cursor: 1,
        text_sent: true,
        quota_decremented: true,
        provider_message_ids: ['provider-terminal'],
      },
    },
  });
  const queue = new DeterministicCampaignQueue([{
    id: 'campaign-recipient-live',
    state: 'waiting',
    data: { campaignId: 'campaign-live', recipientId: 'recipient-live' },
  }]);

  assert.deepEqual(
    await recoverCampaignDeliveries({
      database,
      campaignQueue: queue,
      staleMs: 120000,
      now: () => frozenNow,
    }),
    { staleSending: 1, missingJobs: 1, scheduled: 3 },
  );

  assert.equal(database.state.recipients['recipient-stale'].status, 'queued');
  assert.equal(database.state.recipients['recipient-stale'].media_cursor, 1);
  assert.equal(database.state.recipients['recipient-stale'].provider_message_ids[0], 'provider-media-stale');
  assert.equal(database.state.recipients['recipient-live'].status, 'queued');
  assert.equal(database.state.recipients['recipient-missing'].status, 'queued');
  assert.equal(database.state.recipients['recipient-missing'].text_sent, true);
  assert.equal(database.state.recipients['recipient-terminal'].status, 'sent');
  assert.equal(database.state.recipients['recipient-terminal'].quota_decremented, true);
  assert.deepEqual(
    queue.added.map(job => ({ id: job.id, delay: job.options.delay })),
    [
      { id: 'campaign-recipient-stale', delay: 0 },
      { id: 'campaign-recipient-missing', delay: 0 },
      { id: 'campaign-recipient-future', delay: 45000 },
    ],
  );
  assert.equal(queue.jobs.get('campaign-recipient-live').state, 'waiting');
});

test('two active campaigns for one merchant keep same-recipient text, ids, quota, and status isolated', async () => {
  const database = new CampaignWorkerRepository({
    campaigns: {
      'campaign-a1': {
        id: 'campaign-a1',
        user_id: 'merchant-a',
        status: 'sending',
        approved_at: '2026-07-26T00:00:00.000Z',
        message_text: 'الحملة الأولى\nhttps://example.test/a1',
        audience_rules: { source: 'manual' },
        interval_min_seconds: 30,
        interval_max_seconds: 30,
        sent_count: 0,
      },
      'campaign-a2': {
        id: 'campaign-a2',
        user_id: 'merchant-a',
        status: 'sending',
        approved_at: '2026-07-26T00:00:00.000Z',
        message_text: 'الحملة الثانية ✨\nhttps://example.test/a2',
        audience_rules: { source: 'manual' },
        interval_min_seconds: 30,
        interval_max_seconds: 30,
        sent_count: 0,
      },
    },
    policies: {
      'merchant-a': policy().policy,
    },
    quotas: {
      'merchant-a': { messages_remaining: 5, messages_used: 0 },
    },
    recipients: {
      'recipient-a1': {
        id: 'recipient-a1',
        campaign_id: 'campaign-a1',
        user_id: 'merchant-a',
        sender: '966500000099@s.whatsapp.net',
        status: 'queued',
        attempts: 0,
        text_sent: false,
        quota_decremented: false,
        media_cursor: 0,
        provider_message_ids: [],
      },
      'recipient-a2': {
        id: 'recipient-a2',
        campaign_id: 'campaign-a2',
        user_id: 'merchant-a',
        sender: '966500000099@s.whatsapp.net',
        status: 'queued',
        attempts: 0,
        text_sent: false,
        quota_decremented: false,
        media_cursor: 0,
        provider_message_ids: [],
      },
    },
  });
  const transport = new DurableCampaignTransport();
  const dependencies = {
    database,
    getUserBot: async () => ({
      client: {},
      connection: { ready: true, status: 'connected' },
    }),
    gatewayFactory: () => transport.createGateway(),
  };

  assert.deepEqual(
    await processCampaignRecipient({
      data: { campaignId: 'campaign-a1', recipientId: 'recipient-a1' },
      opts: { attempts: 2 },
      attemptsMade: 0,
    }, dependencies),
    { sent: true },
  );
  assert.deepEqual(
    await processCampaignRecipient({
      data: { campaignId: 'campaign-a2', recipientId: 'recipient-a2' },
      opts: { attempts: 2 },
      attemptsMade: 0,
    }, dependencies),
    { sent: true },
  );

  assert.deepEqual(
    transport.sends.map(send => ({
      content: send.content,
      idempotencyKey: send.idempotencyKey,
      campaignId: send.tenantScope.campaignId,
      recipientId: send.tenantScope.recipientId,
      destination: send.destination,
    })),
    [
      {
        content: 'الحملة الأولى\nhttps://example.test/a1',
        idempotencyKey: 'campaign:campaign-a1:recipient-a1:text',
        campaignId: 'campaign-a1',
        recipientId: 'recipient-a1',
        destination: '966500000099@s.whatsapp.net',
      },
      {
        content: 'الحملة الثانية ✨\nhttps://example.test/a2',
        idempotencyKey: 'campaign:campaign-a2:recipient-a2:text',
        campaignId: 'campaign-a2',
        recipientId: 'recipient-a2',
        destination: '966500000099@s.whatsapp.net',
      },
    ],
  );
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 3,
    messages_used: 2,
  });
  assert.equal(database.state.recipients['recipient-a1'].status, 'sent');
  assert.equal(database.state.recipients['recipient-a2'].status, 'sent');
  assert.equal(database.state.campaigns['campaign-a1'].sent_count, 1);
  assert.equal(database.state.campaigns['campaign-a2'].sent_count, 1);
  assert.equal(database.state.campaigns['campaign-a1'].status, 'completed');
  assert.equal(database.state.campaigns['campaign-a2'].status, 'completed');
  assert.deepEqual(
    database.state.messages.map(message => ({
      userId: message.user_id,
      recipientId: message.raw_payload.campaignRecipientId,
      campaignId: message.raw_payload.campaignId,
      content: message.content,
    })),
    [
      {
        userId: 'merchant-a',
        recipientId: 'recipient-a1',
        campaignId: 'campaign-a1',
        content: 'الحملة الأولى\nhttps://example.test/a1',
      },
      {
        userId: 'merchant-a',
        recipientId: 'recipient-a2',
        campaignId: 'campaign-a2',
        content: 'الحملة الثانية ✨\nhttps://example.test/a2',
      },
    ],
  );

  assert.deepEqual(
    await processCampaignRecipient({
      data: { campaignId: 'campaign-a1', recipientId: 'recipient-a1' },
      opts: { attempts: 2 },
      attemptsMade: 1,
    }, dependencies),
    { skipped: true },
  );
  assert.equal(transport.sends.length, 2);
  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 3,
    messages_used: 2,
  });
});

test('two merchants keep destination, message, policy scope, quota, and results isolated', async () => {
  const database = new CampaignWorkerRepository({
    campaigns: {
      'campaign-a': {
        id: 'campaign-a',
        user_id: 'merchant-a',
        status: 'sending',
        approved_at: '2026-07-26T00:00:00.000Z',
        message_text: 'Merchant A bytes\n🅰️',
        audience_rules: { source: 'manual' },
        interval_min_seconds: 30,
        interval_max_seconds: 30,
        sent_count: 0,
      },
      'campaign-b': {
        id: 'campaign-b',
        user_id: 'merchant-b',
        status: 'sending',
        approved_at: '2026-07-26T00:00:00.000Z',
        message_text: 'Merchant B bytes\n🅱️',
        audience_rules: { source: 'manual' },
        interval_min_seconds: 30,
        interval_max_seconds: 30,
        sent_count: 0,
      },
    },
    policies: {
      'merchant-a': policy().policy,
      'merchant-b': policy().policy,
    },
    quotas: {
      'merchant-a': { messages_remaining: 2, messages_used: 0 },
      'merchant-b': { messages_remaining: 1, messages_used: 0 },
    },
    recipients: {
      'recipient-a': {
        id: 'recipient-a',
        campaign_id: 'campaign-a',
        user_id: 'merchant-a',
        sender: '966511111111@s.whatsapp.net',
        status: 'queued',
        attempts: 0,
        text_sent: false,
        quota_decremented: false,
        media_cursor: 0,
        provider_message_ids: [],
      },
      'recipient-b': {
        id: 'recipient-b',
        campaign_id: 'campaign-b',
        user_id: 'merchant-b',
        sender: '966522222222@s.whatsapp.net',
        status: 'queued',
        attempts: 0,
        text_sent: false,
        quota_decremented: false,
        media_cursor: 0,
        provider_message_ids: [],
      },
    },
  });
  const transport = new DurableCampaignTransport();
  const dependencies = {
    database,
    getUserBot: async () => ({
      client: {},
      connection: { ready: true, status: 'connected' },
    }),
    gatewayFactory: () => transport.createGateway(),
  };

  await processCampaignRecipient({
    data: { campaignId: 'campaign-a', recipientId: 'recipient-a' },
    opts: { attempts: 1 },
    attemptsMade: 0,
  }, dependencies);
  await processCampaignRecipient({
    data: { campaignId: 'campaign-b', recipientId: 'recipient-b' },
    opts: { attempts: 1 },
    attemptsMade: 0,
  }, dependencies);

  assert.deepEqual(
    transport.sends.map(send => ({
      userId: send.userId,
      content: send.content,
      destination: send.destination,
      tenantUserId: send.tenantScope.userId,
      campaignId: send.tenantScope.campaignId,
      recipientId: send.tenantScope.recipientId,
    })),
    [
      {
        userId: 'merchant-a',
        content: 'Merchant A bytes\n🅰️',
        destination: '966511111111@s.whatsapp.net',
        tenantUserId: 'merchant-a',
        campaignId: 'campaign-a',
        recipientId: 'recipient-a',
      },
      {
        userId: 'merchant-b',
        content: 'Merchant B bytes\n🅱️',
        destination: '966522222222@s.whatsapp.net',
        tenantUserId: 'merchant-b',
        campaignId: 'campaign-b',
        recipientId: 'recipient-b',
      },
    ],
  );
  assert.deepEqual(database.state.quotas, {
    'merchant-a': { messages_remaining: 1, messages_used: 1 },
    'merchant-b': { messages_remaining: 0, messages_used: 1 },
  });
  assert.deepEqual(
    database.state.messages.map(message => ({
      userId: message.user_id,
      sender: message.sender,
      content: message.content,
      campaignId: message.raw_payload.campaignId,
    })),
    [
      {
        userId: 'merchant-a',
        sender: '966511111111@s.whatsapp.net',
        content: 'Merchant A bytes\n🅰️',
        campaignId: 'campaign-a',
      },
      {
        userId: 'merchant-b',
        sender: '966522222222@s.whatsapp.net',
        content: 'Merchant B bytes\n🅱️',
        campaignId: 'campaign-b',
      },
    ],
  );
  assert.deepEqual(Object.keys(database.state.conversations).sort(), [
    'merchant-a:966511111111@s.whatsapp.net',
    'merchant-b:966522222222@s.whatsapp.net',
  ]);
});

test('two same-merchant campaigns cannot send more recipients than the shared quota', async () => {
  const campaigns = {};
  const recipients = {};
  for (const suffix of ['1', '2']) {
    campaigns[`campaign-${suffix}`] = {
      id: `campaign-${suffix}`,
      user_id: 'merchant-a',
      status: 'sending',
      approved_at: '2026-07-26T00:00:00.000Z',
      message_text: `exact-${suffix}`,
      audience_rules: { source: 'manual' },
      interval_min_seconds: 30,
      interval_max_seconds: 30,
      sent_count: 0,
    };
    recipients[`recipient-${suffix}`] = {
      id: `recipient-${suffix}`,
      campaign_id: `campaign-${suffix}`,
      user_id: 'merchant-a',
      sender: `96650000000${suffix}@s.whatsapp.net`,
      status: 'queued',
      attempts: 0,
      text_sent: false,
      quota_decremented: false,
      media_cursor: 0,
      provider_message_ids: [],
    };
  }
  const database = new CampaignWorkerRepository({
    campaigns,
    policies: { 'merchant-a': policy().policy },
    quotas: { 'merchant-a': { messages_remaining: 1, messages_used: 0 } },
    recipients,
  });
  const transport = new DurableCampaignTransport();
  const dependencies = {
    database,
    getUserBot: async () => ({
      client: {},
      connection: { ready: true, status: 'connected' },
    }),
    gatewayFactory: () => transport.createGateway(),
  };

  assert.deepEqual(await processCampaignRecipient({
    data: { campaignId: 'campaign-1', recipientId: 'recipient-1' },
    opts: { attempts: 1 },
    attemptsMade: 0,
  }, dependencies), { sent: true });
  assert.deepEqual(await processCampaignRecipient({
    data: { campaignId: 'campaign-2', recipientId: 'recipient-2' },
    opts: { attempts: 1 },
    attemptsMade: 0,
  }, dependencies), { paused: true, reason: 'empty' });

  assert.deepEqual(database.state.quotas['merchant-a'], {
    messages_remaining: 0,
    messages_used: 1,
  });
  assert.equal(transport.sends.length, 1);
  assert.equal(database.state.recipients['recipient-1'].status, 'sent');
  assert.equal(database.state.recipients['recipient-2'].status, 'pending');
  assert.equal(database.state.campaigns['campaign-1'].status, 'completed');
  assert.equal(database.state.campaigns['campaign-2'].status, 'paused');
  assert.equal(database.state.campaigns['campaign-2'].last_error, 'quota:empty');
});
