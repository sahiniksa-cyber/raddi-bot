'use strict';

const fs = require('fs');
const path = require('path');

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex++;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function fileSystemStats(root) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(root);
    const totalBytes = Number(stats.blocks || 0) * Number(stats.bsize || 0);
    const freeBytes = Number(stats.bfree || 0) * Number(stats.bsize || 0);
    const availableBytes = Number(stats.bavail || 0) * Number(stats.bsize || 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes,
      usedBytes,
      freeBytes,
      availableBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
      total: formatBytes(totalBytes),
      used: formatBytes(usedBytes),
      free: formatBytes(freeBytes),
      available: formatBytes(availableBytes),
    };
  } catch (err) {
    return { error: err.message };
  }
}

function entrySize(target, state) {
  if (state.count > state.maxNodes) return 0;
  state.count++;

  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (_) {
    return 0;
  }

  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return stats.size || 0;

  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (_) {
    return 0;
  }

  for (const entry of entries) {
    total += entrySize(path.join(target, entry.name), state);
  }
  return total;
}

function inspectStorageRoot(root, options = {}) {
  const resolvedRoot = path.resolve(root || '.');
  const maxEntries = Math.max(1, parseInt(options.maxEntries || '12', 10));
  const maxNodes = Math.max(100, parseInt(options.maxNodes || '20000', 10));
  const report = {
    path: resolvedRoot,
    exists: false,
    totalBytes: 0,
    total: '0 B',
    entries: [],
    fileSystem: null,
  };

  if (!fs.existsSync(resolvedRoot)) return report;
  report.exists = true;
  report.fileSystem = fileSystemStats(resolvedRoot);

  let children = [];
  try {
    children = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch (err) {
    report.error = err.message;
    return report;
  }

  const state = { count: 0, maxNodes };
  const entries = children.map((entry) => {
    const target = path.join(resolvedRoot, entry.name);
    const bytes = entrySize(target, state);
    return {
      name: entry.name,
      path: toPosixPath(path.relative(resolvedRoot, target) || entry.name),
      type: entry.isDirectory() ? 'dir' : 'file',
      bytes,
      size: formatBytes(bytes),
    };
  }).sort((a, b) => b.bytes - a.bytes);

  report.totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  report.total = formatBytes(report.totalBytes);
  report.entries = entries.slice(0, maxEntries);
  if (state.count > maxNodes) report.truncated = true;
  return report;
}

module.exports = {
  formatBytes,
  inspectStorageRoot,
};
