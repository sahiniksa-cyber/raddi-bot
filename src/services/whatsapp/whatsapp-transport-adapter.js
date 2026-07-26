'use strict';

function createWhatsAppTransportAdapter({ client, timeoutMs = 30000 }) {
  if (!client || typeof client.sendMessage !== 'function') {
    throw new TypeError('A WhatsApp client with sendMessage is required');
  }
  return Object.freeze({
    async send({ destination, content, media, providerMessageId }) {
      const operation = async () => {
        if (providerMessageId && typeof client.getMessageById === 'function') {
          const original = await client.getMessageById(providerMessageId).catch(() => null);
          if (original && typeof original.reply === 'function') return original.reply(content);
        }
        if (typeof client.getChatById === 'function') {
          const chat = await client.getChatById(destination).catch(() => null);
          if (chat && typeof chat.sendMessage === 'function') {
            return chat.sendMessage(media || content);
          }
        }
        return client.sendMessage(destination, media || content);
      };
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`WhatsApp transport timeout (${timeoutMs}ms)`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      return {
        providerMessageId: result?.key?.id || result?.id?._serialized || result?.id || null,
        raw: result,
      };
    },
  });
}

module.exports = { createWhatsAppTransportAdapter };
