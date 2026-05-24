'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEscalationNotification } = require('../src/workers/escalation-routing');

test('buildEscalationNotification masks lid identifiers when WhatsApp hides the phone number', () => {
  const text = buildEscalationNotification({
    contact: { name: 'owner', role: 'owner' },
    customerSender: '278571713060916@lid',
    inboundText: 'customer asks about adobe',
    summary: 'needs owner follow up',
  });

  assert.match(text, /عميل ····0916/);
  assert.doesNotMatch(text, /@lid/);
  assert.match(text, /customer asks about adobe/);
  assert.match(text, /needs owner follow up/);
});
