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
    this._loadingPromise = null;
    // Debounce key writes: every inbound message triggers 2-4 set() calls in
    // quick succession (signal ratchet step), and each was producing a full
    // JSONB rewrite of the entire keystore. Coalescing into one write per
    // window cuts DB I/O by ~90% under load. The flush() path drains the
    // pending timer so shutdown and reconnect never lose ratchet state.
    this._persistDebounce = null;
    this._persistDebounceMs = parseInt(process.env.WA_KEYSTORE_DEBOUNCE_MS || '500', 10);
    // Chain of in-flight set() promises. Each new set() appends to the tail
    // so flush() can await ALL pending sets, not just the most recent one.
    // If we tracked only the latest, two concurrent set() calls could leave
    // an earlier one's _schedulePersist unregistered when flush runs, dropping
    // the latest ratchet step on the floor.
    this._setChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = this._doLoad().finally(() => { this._loadingPromise = null; });
    return this._loadingPromise;
  }

  async _doLoad() {
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

  _schedulePersist() {
    if (this._persistDebounce) return;
    this._persistDebounce = setTimeout(() => {
      this._persistDebounce = null;
      this.persist().catch((err) => {
        console.error('[baileys-auth] debounced persist failed:', err.message);
      });
    }, this._persistDebounceMs);
    if (typeof this._persistDebounce.unref === 'function') this._persistDebounce.unref();
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
            // Append to the chain so flush()/saveCreds() can await EVERY
            // in-flight set(), not just the most recent. Without the chain,
            // a slow set A could finish AFTER flush ran for a faster set B,
            // leaving A's keystore mutation unscheduled and lost.
            const op = (async () => {
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
              // Debounce: coalesce N rapid set() calls into ONE DB write per
              // window. The in-memory cache is updated synchronously, so a
              // subsequent get() in the same tick sees the new value — no
              // correctness loss. Durability is bounded by the debounce window
              // (default 500ms); flush() and saveCreds use the immediate path.
              this._schedulePersist();
            })();
            // catch() on the chained promise so a single set() failure
            // doesn't break the chain for subsequent sets/flushes.
            this._setChain = this._setChain.then(() => op.catch(() => {}));
            return op;
          },
        },
      },
      // Credentials change rarely and carry pairing state (identity key,
      // signed prekey rotations) — persist immediately, no debounce.
      saveCreds: async () => {
        // Drain ALL in-flight set() calls so their _schedulePersist has run.
        try { await this._setChain; } catch (_) {}
        if (this._persistDebounce) {
          clearTimeout(this._persistDebounce);
          this._persistDebounce = null;
        }
        return this.persist();
      },
      // Drain everything: wait for any in-flight set() to register, cancel
      // any pending debounce timer by promoting it to an immediate persist,
      // then await all queued writes. Called on shutdown and before any
      // reconnect, so a redeploy can't kill the process while the latest
      // Double-Ratchet step is in the timer or queue (a lost step surfaces as
      // "Bad MAC" on the next message until the session re-negotiates).
      // Drains until the queue stops growing, so a write that was still
      // being enqueued (set() awaits load() first) is not missed.
      flush: async () => {
        // Drain ALL in-flight set() calls so their _schedulePersist has run.
        try { await this._setChain; } catch (_) {}
        if (this._persistDebounce) {
          clearTimeout(this._persistDebounce);
          this._persistDebounce = null;
          try { await this.persist(); } catch (_) {}
        }
        for (let i = 0; i < 10; i++) {
          const q = this.writeQueue;
          try { await q; } catch (_) {}
          if (q === this.writeQueue) break;
        }
      },
    };
  }

  async clear() {
    const prev = { creds: this.cache.creds, keys: this.cache.keys, loaded: this.loaded };
    this.cache = { creds: initAuthCreds(), keys: {} };
    this.loaded = true;
    try {
      await this.persist();
    } catch (err) {
      this.cache = { creds: prev.creds, keys: prev.keys };
      this.loaded = prev.loaded;
      throw err;
    }
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
