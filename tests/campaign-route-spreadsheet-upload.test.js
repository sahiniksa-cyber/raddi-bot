'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');

const { createCampaignRoutes } = require('../src/routes/campaign.routes');

async function withCampaignServer(deps, run) {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: 'route-user' };
    next();
  });
  app.use(createCampaignRoutes({
    requireAuth: (_req, _res, next) => next(),
    database: { query: async () => ({ rows: [] }) },
    ...deps,
  }));
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.code || 'internal_error',
      message: error.message,
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function contactForm(buffer, name = 'contacts.csv') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'text/csv' }), name);
  return form;
}

test('contact import streams a >64 KiB upload through a unique temp path and cleans it after success', async () => {
  const sourcePaths = [];
  const csv = Buffer.from(`phone,name\n0551234567,${'A'.repeat(70 * 1024)}\n`);
  const campaignService = {
    async importContacts(userId, source, originalName) {
      assert.equal(userId, 'route-user');
      assert.equal(originalName, 'contacts.csv');
      assert.equal(typeof source, 'string');
      assert.ok(path.isAbsolute(source));
      assert.equal((await fs.stat(source)).size, csv.length);
      assert.deepEqual(await fs.readFile(source), csv);
      sourcePaths.push(source);
      return { added: 1, routeMarker: 'streamed' };
    },
  };

  await withCampaignServer({ campaignService }, async baseUrl => {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}/api/campaigns/contacts/import`, {
        method: 'POST',
        body: contactForm(csv),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).routeMarker, 'streamed');
    }
  });

  assert.equal(new Set(sourcePaths).size, 2);
  for (const source of sourcePaths) await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

test('contact import cleans its temp path when service parsing fails and preserves a 422 application error', async () => {
  let sourcePath;
  const campaignService = {
    async importContacts(_userId, source) {
      sourcePath = source;
      await fs.readFile(source);
      const error = new Error('Spreadsheet exceeds the 50,000-row workbook limit');
      error.code = 'SPREADSHEET_ROW_LIMIT_EXCEEDED';
      error.statusCode = 422;
      throw error;
    },
  };

  await withCampaignServer({ campaignService }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/campaigns/contacts/import`, {
      method: 'POST',
      body: contactForm(Buffer.from('phone,name\n0551234567,Layan\n')),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'SPREADSHEET_ROW_LIMIT_EXCEEDED',
      message: 'Spreadsheet exceeds the 50,000-row workbook limit',
    });
  });

  await assert.rejects(fs.stat(sourcePath), { code: 'ENOENT' });
});

test('contact upload limit returns 413 without leaving a temp artifact or crashing the route', async () => {
  let called = false;
  await withCampaignServer({
    campaignService: {
      async importContacts() {
        called = true;
        return {};
      },
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/campaigns/contacts/import`, {
      method: 'POST',
      body: contactForm(Buffer.alloc((25 * 1024 * 1024) + 1, 0x41)),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'SPREADSHEET_FILE_TOO_LARGE');
  });
  assert.equal(called, false);
});

test('campaign media upload remains memory-backed', async () => {
  let observed;
  await withCampaignServer({
    campaignService: {},
    saveCampaignMedia: async ({ files }) => {
      observed = {
        isBuffer: Buffer.isBuffer(files[0].buffer),
        bytes: files[0].buffer.length,
        path: files[0].path,
      };
      return [{ id: 'media-1' }];
    },
  }, async baseUrl => {
    const form = new FormData();
    form.append('media', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'image.png');
    const response = await fetch(`${baseUrl}/api/campaigns/campaign-1/media`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { success: true, media: [{ id: 'media-1' }] });
  });

  assert.deepEqual(observed, { isBuffer: true, bytes: 4, path: undefined });
});
