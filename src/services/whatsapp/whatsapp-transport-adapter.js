'use strict';

function createWhatsAppTransportAdapter({ client }) {
  if (!client || typeof client.sendMessage !== 'function') {
    throw new TypeError('A WhatsApp client with sendMessage is required');
  }
  return Object.freeze({
    async send({ destination, content, media }) {
      const payload = media || content;
      const result = await client.sendMessage(destination, payload);
      return {
        providerMessageId: result?.key?.id || result?.id?._serialized || result?.id || null,
        raw: result,
      };
    },
  });
}

module.exports = { createWhatsAppTransportAdapter };
