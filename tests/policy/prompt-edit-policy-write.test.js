'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/prompt-edit/prompt-edit.service');

test('untyped prompt edits can never invoke a runtime writer', async () => {
  await assert.rejects(
    service.applyInstructions(null, 'u1', 'غيّر السعر إلى 99'),
    error => error.code === 'UNTYPED_POLICY_EDIT_REQUIRES_REVIEW',
  );
});
