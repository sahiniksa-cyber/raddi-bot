'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertConversation, insertInboundMessage } = require('../src/services/whatsapp/message-ingest.service');

function client(returnRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: returnRows || [{ id: 'conv-1', phone_number: '966500000000', inbound_seq: 7 }], rowCount: 1 };
    },
  };
}

test('upsertConversation bumps inbound_seq only when bumpInboundSeq=true and returns it', async () => {
  const c = client();
  const out = await upsertConversation(c, { userId: 'u1', sender: 's1', phoneNumber: 'p1', bumpInboundSeq: true });
  assert.equal(out.inboundSeq, 7);
  const q = c.calls[0];
  assert.ok(/inbound_seq = conversations\.inbound_seq \+ \$4/.test(q.sql));
  assert.ok(/RETURNING id, phone_number, inbound_seq/.test(q.sql));
  assert.equal(q.params[3], 1); // bump amount = 1
});

test('upsertConversation does NOT bump for the owner/fromMe path (bump amount 0)', async () => {
  const c = client();
  await upsertConversation(c, { userId: 'u1', sender: 's1', phoneNumber: 'p1' });
  assert.equal(c.calls[0].params[3], 0);
});

test('insertInboundMessage stamps the inbound_seq it was given', async () => {
  const c = client([{ id: 'msg-1' }]);
  await insertInboundMessage(c, {
    userId: 'u1', conversationId: 'conv-1', sender: 's1', text: 'hi',
    providerMessageId: 'p-1', rawPayload: {}, inboundSeq: 7,
  });
  const insert = c.calls.find(x => /INSERT INTO messages/.test(x.sql));
  assert.ok(/inbound_seq/.test(insert.sql));
  assert.ok(insert.params.includes(7));
});
