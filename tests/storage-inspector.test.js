'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { inspectStorageRoot } = require('../src/services/storage/volume-inspector');

function writeBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

test('inspectStorageRoot reports top entries sorted by size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-storage-inspect-'));
  try {
    writeBytes(path.join(root, 'small', 'a.bin'), 10);
    writeBytes(path.join(root, 'large', 'b.bin'), 30);
    writeBytes(path.join(root, 'large', 'nested', 'c.bin'), 20);

    const report = inspectStorageRoot(root, { maxEntries: 2 });

    assert.equal(report.exists, true);
    assert.equal(report.totalBytes, 60);
    assert.deepEqual(report.entries.map(entry => entry.name), ['large', 'small']);
    assert.equal(report.entries[0].bytes, 50);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectStorageRoot handles missing roots without throwing', () => {
  const report = inspectStorageRoot(path.join(os.tmpdir(), 'missing-jwab-storage-root'));

  assert.equal(report.exists, false);
  assert.equal(report.totalBytes, 0);
  assert.deepEqual(report.entries, []);
});
