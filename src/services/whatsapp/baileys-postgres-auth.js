'use strict';

const {
  BufferJSON,
  initAuthCreds,
  proto,
} = require('@whiskeysockets/baileys');

function cloneForJson(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer), BufferJSON.reviver);
}

function serializeForDb(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function deserializeFromDb(value) {
  return JSON.parse(JSON.stringify(value || {}), BufferJSON.reviver);
}

class BaileysPostgresAuthState {
  constructor({ db, userId }) {
    if (!db?.query) throw new Error('db dependency is required');
    if (!userId) throw new Error('userId is required');
    this.db = db;
    this.userId = userId;
    this.cache = { creds: null, keys: {} };
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    const result = await this.db.query(
      `SELECT auth_state FROM whatsapp_sessions WHERE user_id = $1`,
      [this.userId],
    );
    const authState = result.rows[0]?.auth_state || {};
    const baileys = authState.baileys || {};
    this.cache = {
      creds: baileys.creds ? deserializeFromDb(baileys.creds) : initAuthCreds(),
      keys: baileys.keys ? deserializeFromDb(baileys.keys) : {},
    };
    this.loaded = true;
    await this.persist();
  }

  async persist() {
    const payload = serializeForDb({
      creds: this.cache.creds,
      keys: this.cache.keys,
      updatedAt: new Date().toISOString(),
    });
    this.writeQueue = this.writeQueue.then(() => this.db.query(
      `UPDATE whatsapp_sessions
       SET auth_state = jsonb_set(
         COALESCE(auth_state, '{}'::jsonb),
         '{baileys}',
         $2::jsonb,
         true
       )
       WHERE user_id = $1`,
      [this.userId, JSON.stringify(payload)],
    ));
    return this.writeQueue;
  }

  async state() {
    await this.load();
    return {
      state: {
        creds: this.cache.creds,
        keys: {
          get: async (type, ids) => {
            await this.load();
            const data = {};
            for (const id of ids) {
              let value = this.cache.keys?.[type]?.[id];
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value ? cloneForJson(value) : value;
            }
            return data;
          },
          set: async (data) => {
            await this.load();
            for (const category of Object.keys(data || {})) {
              if (!this.cache.keys[category]) this.cache.keys[category] = {};
              for (const id of Object.keys(data[category] || {})) {
                const value = data[category][id];
                if (value) this.cache.keys[category][id] = cloneForJson(value);
                else delete this.cache.keys[category][id];
              }
              if (Object.keys(this.cache.keys[category]).length === 0) delete this.cache.keys[category];
            }
            await this.persist();
          },
        },
      },
      saveCreds: async () => this.persist(),
    };
  }

  async clear() {
    this.cache = { creds: initAuthCreds(), keys: {} };
    this.loaded = true;
    await this.persist();
  }
}

async function usePostgresBaileysAuthState({ db, userId }) {
  const store = new BaileysPostgresAuthState({ db, userId });
  return store.state();
}

module.exports = {
  BaileysPostgresAuthState,
  usePostgresBaileysAuthState,
};
