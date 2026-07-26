'use strict';

const {
  createWhatsAppTransportAdapter,
} = require('../../src/services/whatsapp/whatsapp-transport-adapter');

function gatewayFactory({ bot }) {
  const transport = createWhatsAppTransportAdapter({
    client: bot.client,
    timeoutMs: 1000,
  });
  return {
    async send(request) {
      const provider = await transport.send(request);
      return {
        decision: 'sent',
        provider,
        validation: { ok: true, evidenceRefs: [], violations: [] },
      };
    },
  };
}

module.exports = { gatewayFactory };
