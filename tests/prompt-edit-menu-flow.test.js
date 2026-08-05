'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/prompt-edit/prompt-edit.service');

const GROUP = '120363111@g.us';
const USER = 'user-1';
const silentLogger = { info() {}, warn() {}, error() {} };

// Stateful fake DB that models the prompt_edit_requests session row, the
// group-action dedup table, and bot_configs writes — enough to drive the whole
// menu state machine across multiple inbound messages.
function makeDb({ config = {}, threadGroups = [GROUP] } = {}) {
  const state = {
    config: JSON.parse(JSON.stringify(config)),
    rows: new Map(),
    seq: 0,
    claimed: new Set(),
    configWrites: [],
  };
  const threadDigits = threadGroups.map((g) => String(g).replace(/@.*$/, '').replace(/\D/g, ''));

  async function query(sql, params = []) {
    if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config: state.config }] };
    if (/FROM escalation_threads/.test(sql)) {
      return { rows: threadDigits.includes(String(params[1])) ? [{ ok: 1 }] : [] };
    }
    if (/INSERT INTO whatsapp_group_action_dedup/.test(sql)) {
      const key = `${params[0]}|${params[1]}`;
      if (state.claimed.has(key)) return { rows: [] };
      state.claimed.add(key);
      return { rows: [{ message_id: params[1] }] };
    }
    if (/SELECT[\s\S]*FROM prompt_edit_requests[\s\S]*status = 'pending'[\s\S]*ORDER BY created_at DESC/.test(sql)) {
      const active = [...state.rows.values()].filter((r) => r.status === 'pending')
        .sort((a, b) => b.created_at - a.created_at)[0];
      return { rows: active ? [{ ...active }] : [] };
    }
    if (/INSERT INTO prompt_edit_requests/.test(sql)) {
      const id = `pe-${++state.seq}`;
      state.rows.set(id, {
        id, user_id: params[0], source_jid: params[1], requester_jid: params[2],
        request_text: params[3], current_instructions: params[4],
        proposed_instructions: params[5], change_summary: params[6],
        status: 'pending', target: params[7],
        proposed_value: params[8] == null ? null : JSON.parse(params[8]),
        stage: params[9], section: params[10],
        context: params[11] == null ? null : JSON.parse(params[11]),
        created_at: Date.now(),
      });
      return { rows: [{ id }] };
    }
    if (/UPDATE prompt_edit_requests\s+SET stage =/.test(sql)) {
      const row = state.rows.get(params[0]);
      if (row) {
        row.stage = params[1]; row.section = params[2];
        row.context = params[3] == null ? null : JSON.parse(params[3]);
        row.target = params[4]; row.request_text = params[5];
        row.proposed_instructions = params[6]; row.change_summary = params[7];
        row.proposed_value = params[8] == null ? null : JSON.parse(params[8]);
      }
      return { rows: [] };
    }
    if (/UPDATE prompt_edit_requests SET status = 'expired'/.test(sql)) {
      for (const r of state.rows.values()) if (r.status === 'pending') r.status = 'expired';
      return { rows: [] };
    }
    if (/UPDATE prompt_edit_requests SET status = \$2[\s\S]*status = 'pending' RETURNING id/.test(sql)) {
      const row = state.rows.get(params[0]);
      if (row && row.status === 'pending') { row.status = params[1]; return { rows: [{ id: row.id }] }; }
      return { rows: [] };
    }
    if (/UPDATE bot_configs[\s\S]*jsonb_set/.test(sql)) {
      const field = String(params[1]).replace(/[{}]/g, '');
      const value = JSON.parse(params[2]);
      state.config[field] = value;
      state.configWrites.push({ field, value });
      return { rowCount: 1 };
    }
    return { rows: [] };
  }

  return { query, state, isConfigured: () => true };
}

// AI stub with overridable behaviours.
function makeAi(overrides = {}) {
  return () => () => ({
    async proposePromptEdit(cur, req) { return { newInstructions: `${cur}\n${req}`.trim(), summary: `تعديل التعليمات: ${req}` }; },
    async planConfigEdit(cfg, req) { return overrides.plan || null; },
    async classifyReplyIntent(text) { return overrides.intent || 'other'; },
  });
}

// Driver: send a message through tryHandle. Each message gets a unique id
// unless one is supplied (to simulate re-delivery).
function driver(db, { ai = makeAi(), now } = {}) {
  const outbox = [];
  let seq = 0;
  const enqueue = async (job) => { outbox.push(job.reply); };
  const send = (text, id) => svc.tryHandle({
    database: db, userId: USER,
    msg: { from: GROUP, body: text, id: { _serialized: id || `m${++seq}` }, author: 'author@x' },
    enqueue, buildAiClient: ai(), logger: silentLogger, now: now || Date.now,
  });
  return { send, outbox, lastOut: () => outbox[outbox.length - 1] };
}

// ── Gate ─────────────────────────────────────────────────────────────────────
test('ignores non-escalation groups', async () => {
  const db = makeDb({ threadGroups: [] });
  const d = driver(db);
  assert.equal(await d.send('تعديل'), null);
});

test('respects the whatsappPromptEditEnabled=false switch', async () => {
  const db = makeDb({ config: { whatsappPromptEditEnabled: false } });
  const d = driver(db);
  assert.equal(await d.send('تعديل'), null);
});

// ── Menu open + navigation ────────────────────────────────────────────────────
test('trigger word opens the 8-section menu', async () => {
  const db = makeDb();
  const d = driver(db);
  const r = await d.send('تعديل');
  assert.equal(r.promptEdit, 'menu');
  assert.match(d.lastOut(), /وش تبي تعدّل/);
  assert.match(d.lastOut(), /عبارات الإغلاق/);
  const active = [...db.state.rows.values()].filter((x) => x.status === 'pending');
  assert.equal(active.length, 1);
  assert.equal(active[0].stage, 'menu');
});

test('فلاش and قائمة also open the menu', async () => {
  for (const word of ['فلاش', 'قائمة']) {
    const d = driver(makeDb());
    assert.equal((await d.send(word)).promptEdit, 'menu');
  }
});

test('invalid menu number re-prompts and stays on the menu', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل');
  const r = await d.send('99');
  assert.equal(r.promptEdit, 'reprompt');
  const row = [...db.state.rows.values()].find((x) => x.status === 'pending');
  assert.equal(row.stage, 'menu');
});

// ── Deterministic list section: closing phrases (6) ───────────────────────────
test('closing phrases: add via menu → confirm → written under replyStyle', async () => {
  const db = makeDb({ config: { replyStyle: { closingPhrases: ['تأمر شي؟'] } } });
  const d = driver(db);
  await d.send('تعديل');
  await d.send('6');
  const r1 = await d.send('يعطيك العافية');
  assert.equal(r1.promptEdit, 'proposed');
  assert.match(d.lastOut(), /أأكّد التطبيق/);
  const r2 = await d.send('نعم');
  assert.equal(r2.promptEdit, 'applied');
  assert.deepEqual(db.state.config.replyStyle.closingPhrases, ['تأمر شي؟', 'يعطيك العافية']);
});

test('closing phrases: احذف removes an existing phrase', async () => {
  const db = makeDb({ config: { replyStyle: { closingPhrases: ['تأمر شي؟', 'يعطيك العافية'] } } });
  const d = driver(db);
  await d.send('تعديل'); await d.send('6');
  await d.send('احذف: يعطيك العافية');
  await d.send('نعم');
  assert.deepEqual(db.state.config.replyStyle.closingPhrases, ['تأمر شي؟']);
});

// ── Blocked numbers (4) — stop bot for a customer ─────────────────────────────
test('do_not_reply: add a number stops the bot for that customer', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل'); await d.send('4');
  await d.send('0501234567');
  await d.send('نعم');
  assert.equal(db.state.config.doNotReplyList.length, 1);
  assert.match(db.state.config.doNotReplyList[0].number, /0501234567/);
});

// ── Reply style (5) — sub-menus, no free text ─────────────────────────────────
test('reply style: tone via sub-menus writes replyStyle.tone', async () => {
  const db = makeDb({ config: { replyStyle: { tone: 'ودي ومحترم' } } });
  const d = driver(db);
  await d.send('تعديل'); await d.send('5'); // reply style
  const attrOut = d.lastOut();
  assert.match(attrOut, /النبرة/);
  await d.send('1'); // tone
  await d.send('2'); // رسمي ومحترف
  assert.match(d.lastOut(), /أأكّد/);
  await d.send('نعم');
  assert.equal(db.state.config.replyStyle.tone, 'رسمي ومحترف');
});

test('reply style: language sets useDialect derived flag', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل'); await d.send('5');
  await d.send('2'); // language
  await d.send('1'); // dialect
  await d.send('نعم');
  assert.equal(db.state.config.replyStyle.languageStyle, 'dialect');
  assert.equal(db.state.config.replyStyle.useDialect, true);
});

// ── Forbidden (8) — word vs phrase sub-choice ─────────────────────────────────
test('forbidden: word sub-choice adds to avoidWords', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل'); await d.send('8');
  assert.match(d.lastOut(), /كلمة ممنوعة/);
  await d.send('1'); // word
  await d.send('ChatGPT');
  await d.send('نعم');
  assert.deepEqual(db.state.config.replyStyle.avoidWords, ['ChatGPT']);
});

test('forbidden: phrase sub-choice adds to avoidPhrases', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل'); await d.send('8');
  await d.send('2'); // phrase
  await d.send('إذا عندك أي استفسار أنا موجود');
  await d.send('نعم');
  assert.deepEqual(db.state.config.replyStyle.avoidPhrases, ['إذا عندك أي استفسار أنا موجود']);
});

// ── Prompt (1) + Instant (3) + Products (2) ───────────────────────────────────
test('prompt section: free text → AI merge → botInstructions updated', async () => {
  const db = makeDb({ config: { botInstructions: 'تعليمات قديمة' } });
  const d = driver(db);
  await d.send('تعديل'); await d.send('1');
  await d.send('نوصّل للرياض مجاناً');
  await d.send('نعم');
  assert.match(db.state.config.botInstructions, /نوصّل للرياض مجاناً/);
});

test('instant replies: keyword then reply → autoReplyKeywords updated', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل'); await d.send('3');
  await d.send('التوصيل');
  assert.match(d.lastOut(), /الرد الجاهز/);
  await d.send('نوصّل خلال ٣ أيام');
  await d.send('نعم');
  assert.equal(db.state.config.autoReplyKeywords['التوصيل'], 'نوصّل خلال ٣ أيام');
});

test('products: AI plan → applyProductOp → products updated', async () => {
  const db = makeDb({ config: { products: [{ name: 'ساعة', price: '100' }] } });
  const ai = makeAi({ plan: { target: 'products', action: 'update', product: { name: 'ساعة', price: '120' }, summary: 'تعديل سعر ساعة' } });
  const d = driver(db, { ai });
  await d.send('تعديل'); await d.send('2');
  await d.send('غيّر سعر الساعة إلى 120');
  await d.send('نعم');
  assert.equal(db.state.config.products[0].price, '120');
});

// ── Cancel + explicit shortcut ────────────────────────────────────────────────
test('لا cancels at confirm stage without writing config', async () => {
  const db = makeDb({ config: { replyStyle: { closingPhrases: [] } } });
  const d = driver(db);
  await d.send('تعديل'); await d.send('6'); await d.send('شكراً');
  const r = await d.send('لا');
  assert.equal(r.promptEdit, 'rejected');
  assert.equal(db.state.configWrites.length, 0);
});

test('لا cancels at the menu stage', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل');
  assert.equal((await d.send('لا')).promptEdit, 'rejected');
});

test('explicit "برومنت …" jumps straight to confirm (no menu)', async () => {
  const db = makeDb({ config: { botInstructions: 'x' } });
  const d = driver(db);
  const r = await d.send('برومنت أضف إننا نسكّر الجمعة');
  assert.equal(r.promptEdit, 'proposed');
  await d.send('نعم');
  assert.match(db.state.config.botInstructions, /نسكّر الجمعة/);
});

// ── Idempotency (the confirm-loop fix) ────────────────────────────────────────
test('Layer 1: re-delivered message id at ANY stage is a silent no-op', async () => {
  const db = makeDb();
  const d = driver(db);
  const first = await d.send('تعديل', 'dup-1');
  assert.equal(first.promptEdit, 'menu');
  const again = await d.send('تعديل', 'dup-1'); // same id → re-delivery
  assert.equal(again.promptEdit, 'duplicate');
  const active = [...db.state.rows.values()].filter((x) => x.status === 'pending');
  assert.equal(active.length, 1); // no second session created
});

test('Layer 1: re-delivered "نعم" applies exactly once', async () => {
  const db = makeDb({ config: { replyStyle: { closingPhrases: [] } } });
  const d = driver(db);
  await d.send('تعديل'); await d.send('6'); await d.send('شكراً');
  const a = await d.send('نعم', 'yes-1');
  assert.equal(a.promptEdit, 'applied');
  // Re-delivery: the row is already 'applied' → no active session → safe no-op.
  const b = await d.send('نعم', 'yes-1');
  assert.equal(b, null);
  assert.equal(db.state.config.replyStyle.closingPhrases.length, 1); // added once
});

test('Layer 1: re-delivered INPUT (while pending) does not create a 2nd proposal', async () => {
  const db = makeDb({ config: { replyStyle: { closingPhrases: [] } } });
  const d = driver(db);
  await d.send('تعديل'); await d.send('6');
  const first = await d.send('شكراً', 'in-1');
  assert.equal(first.promptEdit, 'proposed');
  const dup = await d.send('شكراً', 'in-1'); // same id re-delivered before confirm
  assert.equal(dup.promptEdit, 'duplicate');
  // Still exactly one pending confirm row for the group.
  const pend = [...db.state.rows.values()].filter((x) => x.status === 'pending');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].stage, 'confirm');
});

test('Layer 2: confirm with a MISSING message id still cannot double-apply', async () => {
  const db = makeDb({ config: { replyStyle: { closingPhrases: [] } } });
  const outbox = [];
  const enqueue = async (job) => { outbox.push(job.reply); };
  const ai = makeAi();
  const mkMsg = (text) => ({ from: GROUP, body: text, id: null, author: 'a@x' }); // NO id
  const call = (text) => svc.tryHandle({
    database: db, userId: USER, msg: mkMsg(text), enqueue,
    buildAiClient: ai(), logger: silentLogger,
  });
  await call('تعديل'); await call('6'); await call('شكراً');
  const first = await call('نعم');
  assert.equal(first.promptEdit, 'applied');
  // Same "نعم" re-delivered with no id → the pending row is already 'applied',
  // so there's no active session and it's a no-op (null), never a second write.
  const second = await call('نعم');
  assert.equal(second, null);
  assert.equal(db.state.config.replyStyle.closingPhrases.length, 1);
});

// ── TTL expiry ─────────────────────────────────────────────────────────────────
test('a stale session (older than TTL) is expired and ignored', async () => {
  const db = makeDb();
  const d = driver(db);
  await d.send('تعديل');
  const row = [...db.state.rows.values()].find((x) => x.status === 'pending');
  row.created_at = Date.now() - 11 * 60 * 1000; // backdate beyond 10-min TTL
  // A bare number now has no active session → not a trigger → ignored.
  const r = await d.send('6');
  assert.equal(r, null);
  assert.equal(row.status, 'expired');
});
