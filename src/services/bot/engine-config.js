'use strict';

const SUPPORTED_ENGINES = new Set(['baileys']);

function resolveWhatsappEngine(env = process.env) {
  const raw = String(env.WA_ENGINE || '').trim().toLowerCase().replace(/_/g, '-');
  const engine = raw || 'baileys';
  return SUPPORTED_ENGINES.has(engine) ? engine : 'baileys';
}

module.exports = {
  resolveWhatsappEngine,
  SUPPORTED_ENGINES,
};
