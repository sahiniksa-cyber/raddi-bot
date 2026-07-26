'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageIngestService } = require('../src/services/whatsapp/message-ingest.service');
const { canonicalConfig } = require('./helpers/canonical-config');

const GROUP = '120363999@g.us';

test('FULL FLOW: untyped group edit is quarantined and confirmation cannot alter active policy', async () => {
  const config = canonicalConfig({
    contacts: [{ id: 'team', name: 'الفريق', phoneNumber: '+120363999' }],
  });
  const original = JSON.stringify(config.merchantPolicy);
  const edits = [];
  const database = {
    isConfigured: () => true,
    async query(sql, params = []) {
      if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM prompt_edit_requests[\s\S]*status = 'pending'/.test(sql)) {
        return { rows: edits.filter(edit => edit.status === 'pending').slice(-1) };
      }
      if (/UPDATE prompt_edit_requests SET status = 'expired'/.test(sql)) return { rows: [] };
      if (/INSERT INTO prompt_edit_requests/.test(sql)) {
        edits.push({
          id: 'pe-1',
          status: 'pending',
          target: params[7],
          proposed_value: JSON.parse(params[8]),
          created_at: new Date().toISOString(),
        });
        return { rows: [{ id: 'pe-1' }] };
      }
      if (/UPDATE prompt_edit_requests SET status = \$2/.test(sql)) {
        edits[0].status = params[1];
        return { rows: [] };
      }
      if (/UPDATE bot_configs/.test(sql)) throw new Error('policy must not be written');
      return { rows: [] };
    },
  };
  const outgoing = [];
  const service = new MessageIngestService({
    database,
    logger: { info() {}, warn() {} },
    queue: { enqueueAiReply: async () => { throw new Error('must not reach customer AI'); } },
    enqueueOutgoing: async payload => outgoing.push(payload),
  });
  const first = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'M1' }, from: GROUP, fromMe: false, body: 'تعديل: السعر 99' },
    source: 'baileys',
  });
  assert.equal(first.promptEdit, 'needs_review');
  const second = await service.ingestWhatsappMessage({
    userId: 'u1',
    msg: { id: { id: 'M2' }, from: GROUP, fromMe: false, body: 'نعم' },
    source: 'baileys',
  });
  assert.equal(second.promptEdit, 'needs_review');
  assert.equal(JSON.stringify(config.merchantPolicy), original);
  assert.equal(edits[0].status, 'needs_review');
  assert.equal(outgoing.every(item => item.policyVersion), true);
});
