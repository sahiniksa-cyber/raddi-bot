'use strict';

const { DEFAULT_CONFIG, DELAY_PRESETS } = require('../../lib/constants');

function resolveReplyDelayMs(config = {}, random = Math.random) {
  const preset = String(config.replyDelayPreset || DEFAULT_CONFIG.replyDelayPreset || '1min');
  const range = DELAY_PRESETS[preset] || DELAY_PRESETS[DEFAULT_CONFIG.replyDelayPreset] || [50, 75];
  const minSec = Number(range[0]) || 0;
  const maxSec = Number(range[1]) || minSec;
  const raw = Number(random());
  const ratio = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  const seconds = minSec + Math.round((maxSec - minSec) * ratio);
  return seconds * 1000;
}

module.exports = { resolveReplyDelayMs };

