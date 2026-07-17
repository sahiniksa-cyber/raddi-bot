'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const ExcelJS = require('exceljs');

const db = require('../../db/client');
const { checkMessageQuota } = require('../billing/message-quota');
const {
  WhatsAppHistoryImportService,
  purgeTemporaryHistory,
} = require('../whatsapp/history-import.service');
const { buildProductCatalog, normalizeProductText } = require('../products/product-knowledge');
const {
  classifyConversationDeterministic,
  mergeSignals,
  upsertSignals,
  validateAiSignals,
} = require('./smart-segmentation');

const EDITABLE_STATES = new Set(['draft', 'ready_for_approval', 'approved']);
const SIGNAL_STATES = new Set(['interested_unverified', 'ordered_confirmed', 'needs_verification']);
const CONTACT_STATUSES = new Set(['contact', 'ordered', 'subscription']);
const MIN_CAMPAIGN_INTERVAL_SECONDS = 30;

function badRequest(message, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function normalizePhone(value, defaultCountryCode = '966') {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length >= 9) digits = defaultCountryCode + digits.slice(1);
  if (!digits.startsWith(defaultCountryCode) && digits.length === 9 && digits.startsWith('5')) {
    digits = defaultCountryCode + digits;
  }
  if (digits.length < 8 || digits.length > 15) return '';
  return digits;
}

function senderFromPhone(phone) {
  return `${phone}@s.whatsapp.net`;
}

// Preserve URLs, intentional line breaks and emoji exactly as the merchant
// wrote them. Only surrounding whitespace is removed before storage/sending.
function normalizeCampaignMessage(value) {
  return String(value || '').trim().slice(0, 10000);
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeAudienceRules(value = {}) {
  const input = safeJson(value, {});
  const requestedSource = input.source === 'smart' ? 'contacts' : input.source;
  const source = ['keywords', 'contacts', 'conversations', 'all', 'saved_campaign'].includes(requestedSource)
    ? requestedSource
    : 'contacts';
  const hasExplicitStates = Array.isArray(input.states);
  const states = [...new Set((hasExplicitStates ? input.states : ['interested_unverified']).filter(state => SIGNAL_STATES.has(state)))];
  const productKeys = [...new Set((Array.isArray(input.productKeys) ? input.productKeys : [])
    .map(item => String(item || '').trim().slice(0, 200)).filter(Boolean))].slice(0, 100);
  const searchTerms = [];
  const seenSearchTerms = new Set();
  for (const raw of Array.isArray(input.searchTerms) ? input.searchTerms : []) {
    const term = String(raw || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 120);
    const key = term.toLocaleLowerCase('ar');
    if (term.length < 2 || seenSearchTerms.has(key)) continue;
    seenSearchTerms.add(key);
    searchTerms.push(term);
    if (searchTerms.length === 50) break;
  }
  const date = (raw, label) => {
    if (!raw) return null;
    const value = String(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw badRequest(`${label} غير صالح`);
    }
    return value;
  };
  const dateFrom = date(input.dateFrom, 'تاريخ البداية');
  const dateTo = date(input.dateTo, 'تاريخ النهاية');
  const hasExplicitNumbers = Array.isArray(input.numbers);
  const numbers = [];
  const seenNumbers = new Set();
  let invalidNumberCount = 0;
  if (hasExplicitNumbers) {
    for (const raw of input.numbers) {
      const phone = normalizePhone(raw);
      if (!phone) { invalidNumberCount += 1; continue; }
      if (seenNumbers.has(phone)) continue;
      seenNumbers.add(phone);
      numbers.push(phone);
      if (numbers.length === 10000) break;
    }
  }
  if (dateFrom && dateTo && dateFrom > dateTo) throw badRequest('تاريخ البداية يجب أن يسبق تاريخ النهاية');
  if (source === 'keywords' && searchTerms.length === 0) throw badRequest('أضف كلمة بحث واحدة على الأقل واضغط Enter');
  if (source === 'contacts' && hasExplicitNumbers && numbers.length === 0) {
    throw badRequest('أضف رقم جوال صحيحاً واحداً على الأقل');
  }
  if (source === 'contacts' && invalidNumberCount > 0) {
    throw badRequest(`يوجد ${invalidNumberCount} رقم غير صالح. صحح الأرقام ثم حاول مرة أخرى`);
  }
  const normalized = { source, states, productKeys, searchTerms, dateFrom, dateTo };
  if (source === 'contacts' && hasExplicitNumbers) normalized.numbers = numbers;
  if (source === 'saved_campaign') {
    const sourceCampaignId = String(input.sourceCampaignId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceCampaignId)) {
      throw badRequest('الحملة المصدر غير صالحة', 'SAVED_CAMPAIGN_INVALID');
    }
    normalized.sourceCampaignId = sourceCampaignId;
  }
  return normalized;
}

function campaignPublic(row) {
  if (!row) return null;
  return {
    ...row,
    audience_rules: safeJson(row.audience_rules, {}),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function snapshotHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(snapshot))).digest('hex');
}

function pickCell(row, headers) {
  for (const header of headers) {
    const value = row[header];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function pickRawCell(row, headers) {
  for (const header of headers) {
    const value = row[header];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return null;
}

function normalizeImportDate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(raw * 86400000));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const value = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : value;
  }
  const local = value.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (local) {
    const [, day, month, year] = local;
    const normalized = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const parsed = new Date(`${normalized}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.getUTCDate() === Number(day) && parsed.getUTCMonth() + 1 === Number(month)) return normalized;
  }
  return null;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

async function audit(database, campaignId, userId, eventType, payload = {}) {
  await database.query(
    `INSERT INTO campaign_events (campaign_id, user_id, actor_user_id, event_type, payload)
     VALUES ($1, $2, $2, $3, $4::jsonb)`,
    [campaignId, userId, eventType, JSON.stringify(payload)],
  );
}

async function getOwnedCampaign(database, userId, campaignId, { lock = false } = {}) {
  const result = await database.query(
    `SELECT * FROM campaigns WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [campaignId, userId],
  );
  if (!result.rows[0]) {
    const error = new Error('الحملة غير موجودة');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

async function revokeApproval(database, campaign) {
  if (!EDITABLE_STATES.has(campaign.status)) throw badRequest('لا يمكن تعديل الحملة في حالتها الحالية', 'CAMPAIGN_NOT_EDITABLE');
  await database.query(
    `UPDATE campaigns SET status = 'draft', approved_at = NULL, approved_by = NULL,
       approved_snapshot_hash = NULL, audience_count = 0, content_version = content_version + 1,
       updated_at = NOW() WHERE id = $1`,
    [campaign.id],
  );
  await database.query(`DELETE FROM campaign_recipients WHERE campaign_id = $1`, [campaign.id]);
}

function buildAudienceWhere(userId, rules = {}) {
  const params = [userId];
  const clauses = ['s.user_id = $1'];
  const states = (Array.isArray(rules.states) ? rules.states : []).filter(state => SIGNAL_STATES.has(state));
  if (states.length) {
    params.push(states);
    clauses.push(`s.state = ANY($${params.length}::text[])`);
  }
  const productKeys = (Array.isArray(rules.productKeys) ? rules.productKeys : []).map(normalizeProductText).filter(Boolean);
  if (productKeys.length) {
    params.push(productKeys);
    clauses.push(`s.product_key = ANY($${params.length}::text[])`);
  }
  if (rules.dateFrom) {
    params.push(rules.dateFrom);
    clauses.push(`s.last_detected_at >= $${params.length}::timestamptz`);
  }
  if (rules.dateTo) {
    params.push(rules.dateTo);
    clauses.push(`s.last_detected_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  return { clauses, params };
}

async function resolveAudience(database, userId, rules = {}) {
  const source = rules.source === 'smart' ? 'contacts' : (rules.source || 'contacts');
  const rows = [];
  if (source === 'saved_campaign') {
    const normalized = normalizeAudienceRules(rules);
    const result = await database.query(
      `SELECT r.conversation_id, r.sender, r.normalized_phone,
              ''::text AS customer_name, NULL::text AS product_key,
              NULL::text AS product_name, NULL::text AS customer_state,
              NULL::numeric AS confidence, NULL::uuid AS evidence_message_id,
              ''::text AS evidence_text, 'saved_campaign'::text AS source
       FROM campaign_recipients r
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.id = $2 AND c.user_id = $1 AND c.approved_at IS NOT NULL
       ORDER BY r.created_at`,
      [userId, normalized.sourceCampaignId],
    );
    rows.push(...result.rows);
  }
  if (source === 'keywords') {
    const searchTerms = normalizeAudienceRules(rules).searchTerms;
    const params = [userId, searchTerms];
    const messageClauses = [
      `m.user_id = $1`,
      `m.conversation_id = c.id`,
      `m.direction = 'inbound'`,
      `EXISTS (
         SELECT 1 FROM unnest($2::text[]) AS keyword(term)
         WHERE STRPOS(LOWER(m.content), LOWER(keyword.term)) > 0
       )`,
    ];
    if (rules.dateFrom) {
      params.push(rules.dateFrom);
      messageClauses.push(`m.created_at >= $${params.length}::timestamptz`);
    }
    if (rules.dateTo) {
      params.push(rules.dateTo);
      messageClauses.push(`m.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const result = await database.query(
      `SELECT c.id AS conversation_id, c.sender, c.phone_number AS normalized_phone,
              COALESCE(c.metadata->>'name', '') AS customer_name,
              NULL::text AS product_key, matched.matched_term AS product_name,
              NULL::text AS customer_state, 1::numeric AS confidence,
              matched.id AS evidence_message_id, matched.content AS evidence_text,
              'keyword_search'::text AS source
       FROM conversations c
       JOIN LATERAL (
         SELECT m.id, m.content,
                (SELECT keyword.term FROM unnest($2::text[]) AS keyword(term)
                 WHERE STRPOS(LOWER(m.content), LOWER(keyword.term)) > 0
                 ORDER BY LENGTH(keyword.term) DESC LIMIT 1) AS matched_term
         FROM messages m
         WHERE ${messageClauses.join(' AND ')}
         ORDER BY m.created_at DESC
         LIMIT 1
       ) matched ON TRUE
       WHERE c.user_id = $1
         AND c.sender NOT LIKE '%@g.us'
         AND c.sender NOT LIKE '%@broadcast'
       ORDER BY c.last_message_at DESC`,
      params,
    );
    rows.push(...result.rows);

    const historyClauses = [
      `m.user_id = $1`,
      `m.sender = c.sender`,
      `m.direction = 'inbound'`,
      `EXISTS (
         SELECT 1 FROM unnest($2::text[]) AS keyword(term)
         WHERE STRPOS(LOWER(m.content), LOWER(keyword.term)) > 0
       )`,
    ];
    const historyParams = [userId, searchTerms];
    if (rules.dateFrom) {
      historyParams.push(rules.dateFrom);
      historyClauses.push(`m.message_at >= $${historyParams.length}::timestamptz`);
    }
    if (rules.dateTo) {
      historyParams.push(rules.dateTo);
      historyClauses.push(`m.message_at < ($${historyParams.length}::date + INTERVAL '1 day')`);
    }
    const historyResult = await database.query(
      `SELECT NULL::uuid AS conversation_id, c.sender,
              COALESCE(c.normalized_phone, matched.normalized_phone) AS normalized_phone,
              c.customer_name,
              NULL::text AS product_key, matched.matched_term AS product_name,
              NULL::text AS customer_state, 1::numeric AS confidence,
              NULL::uuid AS evidence_message_id, matched.content AS evidence_text,
              'keyword_history'::text AS source
       FROM whatsapp_history_conversations c
       JOIN LATERAL (
         SELECT m.normalized_phone, m.content,
                (SELECT keyword.term FROM unnest($2::text[]) AS keyword(term)
                 WHERE STRPOS(LOWER(m.content), LOWER(keyword.term)) > 0
                 ORDER BY LENGTH(keyword.term) DESC LIMIT 1) AS matched_term
         FROM whatsapp_history_messages m
         WHERE ${historyClauses.join(' AND ')}
         ORDER BY m.message_at DESC NULLS LAST, m.created_at DESC
         LIMIT 1
       ) matched ON TRUE
       WHERE c.user_id = $1
         AND c.sender NOT LIKE '%@g.us'
         AND c.sender NOT LIKE '%@broadcast'
       ORDER BY c.last_message_at DESC NULLS LAST`,
      historyParams,
    );
    rows.push(...historyResult.rows);
  }
  if (source === 'conversations' || source === 'all') {
    const params = [userId];
    const clauses = [`user_id = $1`, `sender NOT LIKE '%@g.us'`, `sender NOT LIKE '%@broadcast'`];
    if (source === 'conversations' && rules.dateFrom) {
      params.push(rules.dateFrom);
      clauses.push(`last_message_at >= $${params.length}::timestamptz`);
    }
    if (source === 'conversations' && rules.dateTo) {
      params.push(rules.dateTo);
      clauses.push(`last_message_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const result = await database.query(
      `SELECT id AS conversation_id, sender, phone_number AS normalized_phone,
              COALESCE(metadata->>'name', '') AS customer_name,
              NULL::text AS product_key, NULL::text AS product_name,
              NULL::text AS customer_state, NULL::numeric AS confidence,
              NULL::uuid AS evidence_message_id, ''::text AS evidence_text,
              'conversation'::text AS source
       FROM conversations WHERE ${clauses.join(' AND ')} ORDER BY last_message_at DESC`,
      params,
    );
    rows.push(...result.rows);

    const historyParams = [userId];
    const historyClauses = [`user_id = $1`, `sender NOT LIKE '%@g.us'`, `sender NOT LIKE '%@broadcast'`];
    if (source === 'conversations' && rules.dateFrom) {
      historyParams.push(rules.dateFrom);
      historyClauses.push(`last_message_at >= $${historyParams.length}::timestamptz`);
    }
    if (source === 'conversations' && rules.dateTo) {
      historyParams.push(rules.dateTo);
      historyClauses.push(`last_message_at < ($${historyParams.length}::date + INTERVAL '1 day')`);
    }
    const historyResult = await database.query(
      `SELECT NULL::uuid AS conversation_id, sender, normalized_phone,
              customer_name, NULL::text AS product_key, NULL::text AS product_name,
              NULL::text AS customer_state, NULL::numeric AS confidence,
              NULL::uuid AS evidence_message_id, ''::text AS evidence_text,
              'history_conversation'::text AS source
       FROM whatsapp_history_conversations
       WHERE ${historyClauses.join(' AND ')} ORDER BY last_message_at DESC NULLS LAST`,
      historyParams,
    );
    rows.push(...historyResult.rows);
  }
  if (source === 'contacts' && Array.isArray(rules.numbers)) {
    const numbers = normalizeAudienceRules(rules).numbers || [];
    rows.push(...numbers.map(phone => ({
      conversation_id: null,
      sender: senderFromPhone(phone),
      normalized_phone: phone,
      customer_name: '',
      product_key: null,
      product_name: null,
      customer_state: null,
      confidence: null,
      evidence_message_id: null,
      evidence_text: '',
      source: 'campaign_numbers',
    })));
  } else if (source === 'contacts' || source === 'all') {
    const result = await database.query(
      `SELECT NULL::uuid AS conversation_id, sender, normalized_phone, name AS customer_name,
              NULL::text AS product_key, product_name,
              customer_status AS customer_state, NULL::numeric AS confidence,
              NULL::uuid AS evidence_message_id, ''::text AS evidence_text, source,
              order_reference, order_date, subscription_start_date, subscription_end_date
       FROM campaign_contacts WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    );
    rows.push(...result.rows);
  }

  const bySender = new Map();
  for (const row of rows) {
    const sender = String(row.sender || '').trim();
    // Modern WhatsApp privacy-masked customers are represented by @lid JIDs.
    // Baileys can deliver to these identifiers directly, so excluding them here
    // silently removed most real customers from campaign previews and sends.
    if (!sender || sender.includes('@g.us') || sender.includes('@broadcast')) continue;
    const phone = String(row.normalized_phone || '').replace(/\D/g, '');
    const key = phone ? `phone:${phone}` : `sender:${sender}`;
    if (!bySender.has(key)) {
      bySender.set(key, row);
      continue;
    }
    const current = bySender.get(key);
    bySender.set(key, {
      ...current,
      normalized_phone: current.normalized_phone || row.normalized_phone,
      customer_name: current.customer_name || row.customer_name,
      evidence_text: current.evidence_text || row.evidence_text,
      product_name: current.product_name || row.product_name,
    });
  }
  return [...bySender.values()];
}

function createCampaignService({ database = db, getUserBot, scheduleCampaignRecipient = null } = {}) {
  const historyServiceFor = userId => new WhatsAppHistoryImportService({ database, userId });

  async function historyImportStatus(userId) {
    const status = await historyServiceFor(userId).latestStatus();
    if (typeof getUserBot !== 'function' || !WhatsAppHistoryImportService.isActiveStatus(status.status)) {
      return status;
    }
    const bot = await getUserBot(userId);
    const state = bot?.historyImportAppState || bot?.appState || {};
    return {
      ...status,
      connection_status: state.status || null,
      connection_error: state.error || null,
      qr_ready: state.status === 'qr_ready' && Boolean(state.qrString),
      qr_version: Number(state.qrVersion) || 0,
      live_session_will_resume: Boolean(status.resume_after_import),
    };
  }

  async function startHistoryImport(userId) {
    if (typeof getUserBot !== 'function') {
      throw badRequest('تعذر الوصول إلى اتصال واتساب', 'WHATSAPP_CONNECTION_UNAVAILABLE');
    }
    const activeCampaign = await database.query(
      `SELECT COUNT(*)::int AS count FROM campaigns
       WHERE user_id = $1 AND status IN ('sending','scheduled')`,
      [userId],
    );
    if (Number(activeCampaign.rows[0]?.count || 0) > 0) {
      throw badRequest('أوقف الحملة الجارية أو ألغِ المجدولة قبل استيراد المحادثات. اتصال الاستيراد مؤقت وللقراءة فقط، ولا يوقف البوت الأساسي.', 'CAMPAIGN_ACTIVE_DURING_HISTORY_IMPORT');
    }
    const bot = await getUserBot(userId);
    if (typeof bot?.startHistoryImport !== 'function' || typeof bot?.lockHistoryImportSending !== 'function') {
      throw badRequest('هذا الاتصال لا يدعم استيراد سجل واتساب الآمن', 'HISTORY_IMPORT_UNSUPPORTED');
    }
    bot.lockHistoryImportSending();
    const service = historyServiceFor(userId);
    let historyImport = null;
    try {
      const resumeAfterImport = bot.sessionDesiredState === 'running'
        || bot.connection?.ready === true
        || bot.connection?.status === 'connected';
      historyImport = await service.beginImport({ resumeAfterImport });
      return await bot.startHistoryImport(historyImport.id);
    } catch (error) {
      if (historyImport?.id) await service.failImport(historyImport.id, error).catch(() => {});
      throw error;
    } finally {
      // The dedicated import socket is permanently read-only. The live socket
      // only needs this short lock while the active import row is being created,
      // which closes the race with a simultaneous campaign launch without
      // pausing normal bot replies for the duration of the import.
      bot.unlockHistoryImportSending?.();
    }
  }

  async function finishHistoryImport(userId) {
    if (typeof getUserBot !== 'function') {
      throw badRequest('تعذر الوصول إلى اتصال واتساب', 'WHATSAPP_CONNECTION_UNAVAILABLE');
    }
    const service = historyServiceFor(userId);
    const status = await service.latestStatus();
    if (!WhatsAppHistoryImportService.isActiveStatus(status.status)) {
      throw badRequest('لا يوجد استيراد محادثات قيد التشغيل', 'HISTORY_IMPORT_NOT_ACTIVE');
    }
    const bot = await getUserBot(userId);
    if (typeof bot?.finishHistoryImport !== 'function') {
      throw badRequest('هذا الاتصال لا يدعم إنهاء استيراد السجل', 'HISTORY_IMPORT_UNSUPPORTED');
    }
    await bot.finishHistoryImport(status.id);
    return service.latestStatus();
  }

  async function list(userId) {
    const result = await database.query(
      `SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    );
    return result.rows.map(campaignPublic);
  }

  async function get(userId, campaignId) {
    const campaign = campaignPublic(await getOwnedCampaign(database, userId, campaignId));
    const [media, recipients, events] = await Promise.all([
      database.query(`SELECT id, kind, original_name, mime_type, size_bytes, sha256, sort_order, created_at FROM campaign_media WHERE campaign_id = $1 ORDER BY sort_order`, [campaignId]),
      database.query(`SELECT * FROM campaign_recipients WHERE campaign_id = $1 ORDER BY created_at LIMIT 1000`, [campaignId]),
      database.query(`SELECT event_type, payload, created_at FROM campaign_events WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 100`, [campaignId]),
    ]);
    return { ...campaign, media: media.rows, recipients: recipients.rows, events: events.rows };
  }

  async function create(userId, input = {}) {
    const name = String(input.name || '').trim().slice(0, 120);
    if (!name) throw badRequest('اسم الحملة مطلوب');
    const min = Math.max(MIN_CAMPAIGN_INTERVAL_SECONDS, Math.min(3600, Number(input.intervalMinSeconds) || 30));
    const max = Math.max(min, Math.min(3600, Number(input.intervalMaxSeconds) || 60));
    const result = await database.query(
      `INSERT INTO campaigns (user_id, name, goal, message_text, audience_rules, interval_min_seconds, interval_max_seconds)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
      [
        userId,
        name,
        String(input.goal || '').trim().slice(0, 500),
        normalizeCampaignMessage(input.messageText),
        JSON.stringify(normalizeAudienceRules(input.audienceRules || {})),
        min,
        max,
      ],
    );
    await audit(database, result.rows[0].id, userId, 'created');
    return campaignPublic(result.rows[0]);
  }

  async function reuseAudience(userId, campaignId) {
    return database.transaction(async client => {
      const sourceCampaign = await getOwnedCampaign(client, userId, campaignId, { lock: true });
      if (!sourceCampaign.approved_at) {
        throw badRequest('لا يمكن إعادة استخدام جمهور حملة لم تُعتمد', 'CAMPAIGN_AUDIENCE_NOT_APPROVED');
      }
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1`,
        [campaignId],
      );
      const audienceCount = Number(countResult.rows[0]?.count || 0);
      if (!audienceCount) {
        throw badRequest('لا توجد أرقام محفوظة داخل هذه الحملة', 'CAMPAIGN_AUDIENCE_EMPTY');
      }
      const audienceRules = normalizeAudienceRules({
        source: 'saved_campaign',
        sourceCampaignId: campaignId,
      });
      const result = await client.query(
        `INSERT INTO campaigns (
           user_id, name, goal, message_text, audience_rules,
           interval_min_seconds, interval_max_seconds
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
        [
          userId,
          `${String(sourceCampaign.name || '').slice(0, 105)} - إعادة`.slice(0, 120),
          sourceCampaign.goal || '',
          sourceCampaign.message_text || '',
          JSON.stringify(audienceRules),
          sourceCampaign.interval_min_seconds,
          sourceCampaign.interval_max_seconds,
        ],
      );
      await audit(client, result.rows[0].id, userId, 'created_from_saved_audience', {
        sourceCampaignId: campaignId,
        audienceCount,
        mediaCopied: false,
      });
      return campaignPublic(result.rows[0]);
    });
  }

  async function update(userId, campaignId, input = {}) {
    return database.transaction(async client => {
      const current = await getOwnedCampaign(client, userId, campaignId, { lock: true });
      await revokeApproval(client, current);
      const min = Math.max(MIN_CAMPAIGN_INTERVAL_SECONDS, Math.min(3600, Number(input.intervalMinSeconds ?? current.interval_min_seconds) || 30));
      const max = Math.max(min, Math.min(3600, Number(input.intervalMaxSeconds ?? current.interval_max_seconds) || 60));
      const name = String(input.name ?? current.name).trim().slice(0, 120);
      if (!name) throw badRequest('اسم الحملة مطلوب');
      const audienceRules = normalizeAudienceRules(input.audienceRules ?? safeJson(current.audience_rules, {}));
      let scheduledAt = input.scheduledAt === undefined ? current.scheduled_at : (input.scheduledAt || null);
      if (scheduledAt && Number.isNaN(new Date(scheduledAt).getTime())) throw badRequest('موعد الإرسال غير صالح');
      const result = await client.query(
        `UPDATE campaigns SET name = $3, goal = $4, message_text = $5,
           audience_rules = $6::jsonb, interval_min_seconds = $7, interval_max_seconds = $8,
           scheduled_at = $9, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
        [
          campaignId, userId,
          name,
          String(input.goal ?? current.goal).trim().slice(0, 500),
          normalizeCampaignMessage(input.messageText ?? current.message_text),
          JSON.stringify(audienceRules),
          min, max, scheduledAt,
        ],
      );
      await audit(client, campaignId, userId, 'updated', { contentVersion: result.rows[0].content_version });
      return campaignPublic(result.rows[0]);
    });
  }

  async function addManualContacts(userId, values = []) {
    let added = 0;
    let duplicates = 0;
    const invalid = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : String(values || '').split(/[\n,;]+/)) {
      const raw = typeof value === 'object' ? value.phone : value;
      const phone = normalizePhone(raw);
      if (!phone) { if (String(raw || '').trim()) invalid.push(String(raw)); continue; }
      if (seen.has(phone)) { duplicates += 1; continue; }
      seen.add(phone);
      await database.query(
        `INSERT INTO campaign_contacts (user_id, normalized_phone, sender, name, source, metadata)
         VALUES ($1, $2, $3, $4, 'manual', $5::jsonb)
         ON CONFLICT (user_id, normalized_phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, campaign_contacts.name),
           source = 'manual', metadata = campaign_contacts.metadata || EXCLUDED.metadata, updated_at = NOW()`,
        [userId, phone, senderFromPhone(phone), typeof value === 'object' ? String(value.name || '').trim() || null : null, JSON.stringify({ original: String(raw) })],
      );
      added += 1;
    }
    return { added, duplicates, invalid };
  }

  async function importContacts(userId, buffer, originalName = '') {
    const workbook = new ExcelJS.Workbook();
    const lower = String(originalName).toLowerCase();
    try {
      if (lower.endsWith('.csv')) await workbook.csv.read(require('stream').Readable.from(buffer));
      else if (lower.endsWith('.xlsx')) await workbook.xlsx.load(buffer);
      else throw badRequest('صيغة الملف غير مدعومة. استخدم CSV أو XLSX');
    } catch (error) {
      if (error.statusCode) throw error;
      throw badRequest('تعذر قراءة الملف. تأكد أنه ملف CSV أو XLSX صالح', 'INVALID_CONTACT_FILE');
    }
    if (!workbook.worksheets[0]) throw badRequest('الملف لا يحتوي على ورقة بيانات');
    const rows = [];
    for (const sheet of workbook.worksheets) {
      const headers = [];
      sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = normalizeHeader(cell.text); });
      sheet.eachRow((row, number) => {
        if (number === 1) return;
        const data = {};
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          data[headers[col] || `column ${col}`] = cell.value instanceof Date ? cell.value : cell.text;
        });
        rows.push({ data, rowNumber: number, sheetName: sheet.name });
      });
    }
    const phoneHeaders = ['phone', 'mobile', 'whatsapp', 'الجوال', 'رقم', 'رقم الجوال', 'رقم الهاتف', 'رقم العميل'];
    const nameHeaders = ['name', 'customer name', 'الاسم', 'اسم العميل'];
    const productHeaders = ['product', 'product name', 'subscription', 'subscription name', 'المنتج', 'اسم المنتج', 'الاشتراك', 'اسم الاشتراك', 'المنتج أو الاشتراك'];
    const orderHeaders = ['order reference', 'order number', 'order id', 'رقم الطلب', 'الطلب'];
    const orderDateHeaders = ['order date', 'purchase date', 'تاريخ الطلب', 'تاريخ الشراء'];
    const subscriptionStartHeaders = ['subscription start', 'subscription start date', 'start date', 'بداية الاشتراك', 'تاريخ بداية الاشتراك'];
    const subscriptionEndHeaders = ['subscription end', 'subscription end date', 'expiry date', 'end date', 'نهاية الاشتراك', 'تاريخ نهاية الاشتراك', 'تاريخ الانتهاء'];
    const recordTypeHeaders = ['record type', 'customer type', 'purchase status', 'نوع السجل', 'نوع العميل', 'النوع'];
    const stateHeaders = ['state', 'status', 'classification', 'التصنيف', 'الحالة'];
    const stateAliases = {
      interested_unverified: 'interested_unverified',
      ordered_confirmed: 'ordered_confirmed',
      needs_verification: 'needs_verification',
      'مهتم بلا طلب مؤكد': 'interested_unverified',
      'مهتمون بلا طلب مؤكد': 'interested_unverified',
      'طلب مؤكد': 'ordered_confirmed',
      'الطلبات المؤكدة': 'ordered_confirmed',
      'يحتاج تحقق': 'needs_verification',
      'يحتاجون تحقق': 'needs_verification',
    };
    const contactStatusAliases = {
      contact: 'contact', customer: 'contact', 'عميل': 'contact', 'رقم': 'contact',
      ordered: 'ordered', order: 'ordered', purchased: 'ordered', 'طلب': 'ordered', 'تم الطلب': 'ordered', 'طلب مؤكد': 'ordered', ordered_confirmed: 'ordered',
      subscription: 'subscription', subscribed: 'subscription', subscriber: 'subscription', 'اشتراك': 'subscription', 'مشترك': 'subscription', 'اشتراك فعال': 'subscription',
    };
    let added = 0;
    let duplicates = 0;
    const invalid = [];
    const seenPhones = new Set();
    const orderedPhones = new Set();
    const subscriptionPhones = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const { data: row, rowNumber, sheetName } = rows[index];
      const rawPhone = pickCell(row, phoneHeaders);
      const phone = normalizePhone(rawPhone);
      if (!phone) { invalid.push({ row: rowNumber, sheet: sheetName, phone: rawPhone }); continue; }
      const name = pickCell(row, nameHeaders) || null;
      const productName = pickCell(row, productHeaders);
      const orderReference = pickCell(row, orderHeaders);
      const importedState = stateAliases[normalizeHeader(pickCell(row, stateHeaders))] || null;
      const rawOrderDate = pickRawCell(row, orderDateHeaders);
      const rawSubscriptionStart = pickRawCell(row, subscriptionStartHeaders);
      const rawSubscriptionEnd = pickRawCell(row, subscriptionEndHeaders);
      const orderDate = normalizeImportDate(rawOrderDate);
      const subscriptionStart = normalizeImportDate(rawSubscriptionStart);
      const subscriptionEnd = normalizeImportDate(rawSubscriptionEnd);
      if ((rawOrderDate && !orderDate) || (rawSubscriptionStart && !subscriptionStart) || (rawSubscriptionEnd && !subscriptionEnd)) {
        invalid.push({ row: rowNumber, sheet: sheetName, phone: rawPhone, reason: 'تاريخ غير صالح. استخدم YYYY-MM-DD أو يوم/شهر/سنة' });
        continue;
      }
      if (subscriptionStart && subscriptionEnd && subscriptionStart > subscriptionEnd) {
        invalid.push({ row: rowNumber, sheet: sheetName, phone: rawPhone, reason: 'بداية الاشتراك بعد تاريخ الانتهاء' });
        continue;
      }
      const explicitStatus = contactStatusAliases[normalizeHeader(pickCell(row, recordTypeHeaders))] || null;
      const customerStatus = explicitStatus
        || (subscriptionStart || subscriptionEnd ? 'subscription' : null)
        || (orderReference || orderDate || importedState === 'ordered_confirmed' ? 'ordered' : 'contact');
      if (!CONTACT_STATUSES.has(customerStatus)) {
        invalid.push({ row: rowNumber, sheet: sheetName, phone: rawPhone, reason: 'نوع السجل غير صالح' });
        continue;
      }
      if (seenPhones.has(phone)) duplicates += 1;
      else { seenPhones.add(phone); added += 1; }
      if (customerStatus === 'ordered') orderedPhones.add(phone);
      if (customerStatus === 'subscription') subscriptionPhones.add(phone);
      await database.query(
        `INSERT INTO campaign_contacts (
           user_id, normalized_phone, sender, name, source, metadata, customer_status,
           product_name, order_reference, order_date, subscription_start_date, subscription_end_date
         ) VALUES ($1, $2, $3, $4, 'import', $5::jsonb, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (user_id, normalized_phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, campaign_contacts.name),
           source = 'import',
           customer_status = CASE
             WHEN campaign_contacts.customer_status = 'subscription' OR EXCLUDED.customer_status = 'subscription' THEN 'subscription'
             WHEN campaign_contacts.customer_status = 'ordered' OR EXCLUDED.customer_status = 'ordered' THEN 'ordered'
             ELSE 'contact' END,
           product_name = COALESCE(EXCLUDED.product_name, campaign_contacts.product_name),
           order_reference = COALESCE(EXCLUDED.order_reference, campaign_contacts.order_reference),
           order_date = COALESCE(EXCLUDED.order_date, campaign_contacts.order_date),
           subscription_start_date = COALESCE(EXCLUDED.subscription_start_date, campaign_contacts.subscription_start_date),
           subscription_end_date = COALESCE(EXCLUDED.subscription_end_date, campaign_contacts.subscription_end_date),
           metadata = campaign_contacts.metadata || EXCLUDED.metadata, updated_at = NOW()`,
        [
          userId, phone, senderFromPhone(phone), name,
          JSON.stringify({ file: originalName, sheet: sheetName, row: rowNumber, customerStatus }),
          customerStatus, productName || null, orderReference || null, orderDate, subscriptionStart, subscriptionEnd,
        ],
      );
      const signalProductName = productName || (customerStatus === 'subscription' ? 'اشتراك غير محدد' : (customerStatus === 'ordered' ? 'طلب غير محدد' : ''));
      if (signalProductName) {
        const key = normalizeProductText(signalProductName);
        const authoritativeOrder = customerStatus === 'ordered' || customerStatus === 'subscription';
        const evidenceText = customerStatus === 'subscription'
          ? `اشتراك مستورد${subscriptionStart ? ` يبدأ ${subscriptionStart}` : ''}${subscriptionEnd ? ` وينتهي ${subscriptionEnd}` : ''}`
          : (customerStatus === 'ordered'
            ? `طلب مستورد${orderDate ? ` بتاريخ ${orderDate}` : ''}${orderReference ? ` ورقمه ${orderReference}` : ''}`
            : 'ارتباط منتج مستورد من ملف العميل');
        await upsertSignals({
          database, userId, sender: senderFromPhone(phone), signals: [{
            productKey: key,
            productName: signalProductName,
            state: authoritativeOrder ? 'ordered_confirmed' : (importedState || 'needs_verification'),
            confidence: authoritativeOrder || importedState ? 1 : 0.6,
            orderReference: orderReference || null,
            evidenceText,
            source: 'merchant_file_import',
            metadata: { file: originalName, sheet: sheetName, row: rowNumber, importedState, customerStatus, orderDate, subscriptionStart, subscriptionEnd },
          }],
        });
      }
    }
    return { added, duplicates, ordered: orderedPhones.size, subscriptions: subscriptionPhones.size, invalid, totalRows: rows.length };
  }

  async function analyze(userId, { limit = 100, useAi = true } = {}) {
    const bot = await getUserBot(userId);
    const config = typeof bot?.resolveConfig === 'function' ? await bot.resolveConfig() : (bot.config || {});
    bot?.ai?.updateConfig?.(config);
    const conversations = await database.query(
      `SELECT id, sender FROM conversations WHERE user_id = $1 AND sender NOT LIKE '%@g.us'
       ORDER BY last_message_at DESC LIMIT $2`,
      [userId, Math.max(1, Math.min(500, Number(limit) || 100))],
    );
    const products = buildProductCatalog(config);
    let analyzed = 0;
    let signalCount = 0;
    let aiReviews = 0;
    const configuredAiLimit = process.env.CAMPAIGN_AI_REVIEW_LIMIT === undefined
      ? 25
      : Number(process.env.CAMPAIGN_AI_REVIEW_LIMIT);
    const aiReviewLimit = Math.max(0, Math.min(25, Number.isFinite(configuredAiLimit) ? configuredAiLimit : 25));
    for (const conversation of conversations.rows) {
      const messagesResult = await database.query(
        `SELECT id, direction, role, content, created_at FROM messages
         WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 200`,
        [conversation.id],
      );
      const deterministic = classifyConversationDeterministic({ messages: messagesResult.rows, config });
      let ai = [];
      // Rules handle clear product/order evidence cheaply. AI is reserved for
      // conversations where the deterministic pass found nothing, and capped
      // per request so a large inbox cannot create an unbounded model bill.
      if (useAi && deterministic.length === 0 && aiReviews < aiReviewLimit && typeof bot.ai?.classifyCampaignCustomer === 'function' && products.length) {
        const raw = await bot.ai.classifyCampaignCustomer({ messages: messagesResult.rows, products });
        ai = validateAiSignals({ signals: raw, config, messages: messagesResult.rows });
        aiReviews += 1;
      }
      const signals = mergeSignals(deterministic, ai);
      if (signals.length) {
        const saved = await upsertSignals({ database, userId, conversationId: conversation.id, sender: conversation.sender, signals });
        signalCount += saved.length;
      }
      analyzed += 1;
    }
    return { analyzed, signals: signalCount, products: products.length, aiReviews };
  }

  async function listSignals(userId, filters = {}) {
    const { clauses, params } = buildAudienceWhere(userId, filters);
    const result = await database.query(
      `SELECT s.id AS signal_id, s.conversation_id, s.sender,
              COALESCE(c.phone_number, cc.normalized_phone) AS normalized_phone,
              COALESCE(c.metadata->>'name', cc.name, '') AS customer_name,
              s.product_key, s.product_name, s.state AS customer_state,
              s.confidence, s.evidence_message_id, s.evidence_text,
              COALESCE(s.order_reference, cc.order_reference) AS order_reference,
              cc.customer_status, cc.order_date, cc.subscription_start_date, cc.subscription_end_date,
              s.source, s.last_detected_at, s.metadata
       FROM customer_product_signals s
       LEFT JOIN conversations c ON c.id = s.conversation_id
       LEFT JOIN campaign_contacts cc ON cc.user_id = s.user_id AND cc.sender = s.sender
       WHERE ${clauses.join(' AND ')}
       ORDER BY s.last_detected_at DESC
       LIMIT 1000`,
      params,
    );
    return result.rows;
  }

  async function updateSignal(userId, signalId, input = {}) {
    const state = String(input.state || '');
    if (!SIGNAL_STATES.has(state)) throw badRequest('التصنيف غير صالح');
    const orderReference = String(input.orderReference || '').trim().slice(0, 100) || null;
    const note = String(input.note || '').trim().slice(0, 500);
    return database.transaction(async client => {
      const currentResult = await client.query(
        `SELECT * FROM customer_product_signals WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [signalId, userId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        const error = new Error('سجل العميل غير موجود');
        error.statusCode = 404;
        throw error;
      }
      const result = await client.query(
        `UPDATE customer_product_signals SET
           state = $3,
           confidence = 1,
           order_reference = CASE WHEN $3 = 'ordered_confirmed' THEN $4 ELSE NULL END,
           evidence_text = CASE WHEN $5 <> '' THEN $5 ELSE evidence_text END,
           source = 'merchant_manual',
           last_detected_at = NOW(),
           metadata = metadata || $6::jsonb
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [signalId, userId, state, orderReference, note,
          JSON.stringify({ manuallyEdited: true, manuallyConfirmed: state === 'ordered_confirmed', manuallyEditedAt: new Date().toISOString() })],
      );
      await client.query(
        `INSERT INTO customer_product_signal_events (
           signal_id, user_id, previous_state, new_state, order_reference, note, source
         ) VALUES ($1,$2,$3,$4,$5,$6,'merchant_manual')`,
        [signalId, userId, current.state, state, orderReference, note],
      );
      return result.rows[0];
    });
  }

  async function segmentCounts(userId) {
    const result = await database.query(
      `SELECT state, COUNT(DISTINCT sender)::int AS count FROM customer_product_signals
       WHERE user_id = $1 GROUP BY state`,
      [userId],
    );
    const counts = { interested_unverified: 0, ordered_confirmed: 0, needs_verification: 0 };
    for (const row of result.rows) counts[row.state] = Number(row.count);
    return counts;
  }

  async function preview(userId, campaignId) {
    const campaign = await getOwnedCampaign(database, userId, campaignId);
    const recipients = await resolveAudience(database, userId, safeJson(campaign.audience_rules, {}));
    return { count: recipients.length, recipients: recipients.slice(0, 100) };
  }

  async function previewAudience(userId, audienceRules = {}) {
    const rules = normalizeAudienceRules(audienceRules);
    const recipients = await resolveAudience(database, userId, rules);
    return { count: recipients.length, recipients: recipients.slice(0, 100) };
  }

  async function buildSnapshot(client, campaign) {
    const recipients = await resolveAudience(client, campaign.user_id, safeJson(campaign.audience_rules, {}));
    const media = await client.query(
      `SELECT id, kind, sha256, sort_order FROM campaign_media WHERE campaign_id = $1 ORDER BY sort_order`,
      [campaign.id],
    );
    return {
      snapshot: {
        campaignId: campaign.id,
        contentVersion: campaign.content_version,
        messageText: campaign.message_text,
        audienceRules: safeJson(campaign.audience_rules, {}),
        intervalMinSeconds: campaign.interval_min_seconds,
        intervalMaxSeconds: campaign.interval_max_seconds,
        scheduledAt: campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString() : null,
        media: media.rows,
        recipients: recipients.map(row => row.sender).sort(),
      },
      recipients,
    };
  }

  async function buildMaterializedSnapshot(client, campaign) {
    const [recipients, media] = await Promise.all([
      client.query(
        `SELECT sender FROM campaign_recipients
         WHERE campaign_id = $1 AND user_id = $2 ORDER BY sender`,
        [campaign.id, campaign.user_id],
      ),
      client.query(
        `SELECT id, kind, sha256, sort_order FROM campaign_media WHERE campaign_id = $1 ORDER BY sort_order`,
        [campaign.id],
      ),
    ]);
    return {
      snapshot: {
        campaignId: campaign.id,
        contentVersion: campaign.content_version,
        messageText: campaign.message_text,
        audienceRules: safeJson(campaign.audience_rules, {}),
        intervalMinSeconds: campaign.interval_min_seconds,
        intervalMaxSeconds: campaign.interval_max_seconds,
        scheduledAt: campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString() : null,
        media: media.rows,
        recipients: recipients.rows.map(row => row.sender).sort(),
      },
      recipients: recipients.rows,
    };
  }

  async function prepareApproval(userId, campaignId) {
    return database.transaction(async client => {
      const campaign = await getOwnedCampaign(client, userId, campaignId, { lock: true });
      if (!EDITABLE_STATES.has(campaign.status)) throw badRequest('لا يمكن تجهيز الحملة في حالتها الحالية');
      const mediaFiles = await client.query(`SELECT storage_path FROM campaign_media WHERE campaign_id = $1 ORDER BY sort_order`, [campaignId]);
      if (!String(campaign.message_text || '').trim() && !mediaFiles.rows[0]) {
        throw badRequest('أضف رسالة أو وسائط قبل طلب الموافقة');
      }
      for (const media of mediaFiles.rows) {
        try { await fs.access(media.storage_path); } catch (_) {
          throw badRequest('أحد ملفات الوسائط غير موجود. احذفه وأعد رفعه قبل الاعتماد', 'CAMPAIGN_MEDIA_MISSING');
        }
      }
      const { snapshot, recipients } = await buildSnapshot(client, campaign);
      if (!recipients.length) throw badRequest('لم يتم العثور على مستلمين مطابقين');
      await client.query(`DELETE FROM campaign_recipients WHERE campaign_id = $1`, [campaignId]);
      for (const recipient of recipients) {
        await client.query(
          `INSERT INTO campaign_recipients (
             campaign_id, user_id, conversation_id, sender, normalized_phone, customer_name,
             product_key, product_name, customer_state, confidence, evidence_message_id,
             evidence_text, source
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [campaignId, userId, recipient.conversation_id, recipient.sender, recipient.normalized_phone,
            recipient.customer_name, recipient.product_key, recipient.product_name, recipient.customer_state,
            recipient.confidence, recipient.evidence_message_id, recipient.evidence_text, recipient.source],
        );
      }
      const hash = snapshotHash(snapshot);
      const result = await client.query(
        `UPDATE campaigns SET status = 'ready_for_approval', audience_count = $3,
           approved_snapshot_hash = $4, approved_at = NULL, approved_by = NULL, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [campaignId, userId, recipients.length, hash],
      );
      await audit(client, campaignId, userId, 'approval_requested', { audienceCount: recipients.length, snapshotHash: hash });
      return { campaign: campaignPublic(result.rows[0]), approval: { audienceCount: recipients.length, snapshotHash: hash } };
    });
  }

  async function approve(userId, campaignId, { snapshotHash: expectedHash, audienceCount } = {}) {
    return database.transaction(async client => {
      const campaign = await getOwnedCampaign(client, userId, campaignId, { lock: true });
      if (campaign.status !== 'ready_for_approval') throw badRequest('الحملة ليست بانتظار الموافقة');
      const { snapshot, recipients } = await buildMaterializedSnapshot(client, campaign);
      const currentHash = snapshotHash(snapshot);
      if (!expectedHash || expectedHash !== campaign.approved_snapshot_hash || currentHash !== campaign.approved_snapshot_hash) {
        throw badRequest('تغير محتوى الحملة أو جمهورها؛ راجعها ثم اطلب الموافقة من جديد', 'APPROVAL_SNAPSHOT_CHANGED');
      }
      if (Number(audienceCount) !== recipients.length || recipients.length !== campaign.audience_count) {
        throw badRequest('تغير عدد المستلمين؛ راجع الحملة من جديد', 'APPROVAL_AUDIENCE_CHANGED');
      }
      const result = await client.query(
        `UPDATE campaigns SET status = 'approved', approved_at = NOW(), approved_by = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [campaignId, userId],
      );
      await audit(client, campaignId, userId, 'approved', { audienceCount: recipients.length, snapshotHash: currentHash });
      const importedAudience = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM campaign_recipients
           WHERE campaign_id = $1 AND source = 'keyword_history'
         ) AS present`,
        [campaignId],
      );
      if (importedAudience.rows[0]?.present) {
        // The approved recipient snapshot becomes the durable source of truth.
        // Raw imported messages and evidence are no longer needed after the
        // merchant explicitly approves this exact audience.
        await client.query(
          `UPDATE campaign_recipients SET
             customer_name = NULL, product_key = NULL, product_name = NULL,
             customer_state = NULL, confidence = NULL, evidence_message_id = NULL,
             evidence_text = '', source = 'saved_history_number', updated_at = NOW()
           WHERE campaign_id = $1 AND source = 'keyword_history'`,
          [campaignId],
        );
        const purged = await purgeTemporaryHistory(client, userId);
        await audit(client, campaignId, userId, 'temporary_history_purged', purged);
      }
      return campaignPublic(result.rows[0]);
    });
  }

  async function setStatus(userId, campaignId, action) {
    const transitions = {
      pause: { from: ['sending', 'scheduled'], to: 'paused' },
      resume: { from: ['paused'], to: 'approved' },
      cancel: { from: ['draft', 'ready_for_approval', 'approved', 'scheduled', 'sending', 'paused'], to: 'canceled' },
    };
    const transition = transitions[action];
    if (!transition) throw badRequest('إجراء غير صالح');
    return database.transaction(async client => {
      const campaign = await getOwnedCampaign(client, userId, campaignId, { lock: true });
      if (!transition.from.includes(campaign.status)) throw badRequest('لا يمكن تنفيذ الإجراء في حالة الحملة الحالية');
      const result = await client.query(`UPDATE campaigns SET status = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`, [campaignId, userId, transition.to]);
      if (action === 'pause') await client.query(`UPDATE campaign_recipients SET status = 'pending', updated_at = NOW() WHERE campaign_id = $1 AND status = 'queued'`, [campaignId]);
      if (action === 'cancel') await client.query(`UPDATE campaign_recipients SET status = 'canceled', updated_at = NOW() WHERE campaign_id = $1 AND status IN ('pending','queued')`, [campaignId]);
      await audit(client, campaignId, userId, action);
      return campaignPublic(result.rows[0]);
    });
  }

  async function start(userId, campaignId) {
    const campaign = await getOwnedCampaign(database, userId, campaignId);
    if (campaign.status !== 'approved') throw badRequest('يجب اعتماد الحملة قبل بدء الإرسال', 'CAMPAIGN_NOT_APPROVED');
    if (!campaign.approved_at || !campaign.approved_snapshot_hash) throw badRequest('اعتماد الحملة غير مكتمل');
    if (typeof getUserBot !== 'function') throw badRequest('تعذر التحقق من اتصال واتساب', 'WHATSAPP_CONNECTION_UNAVAILABLE');
    const bot = await getUserBot(userId);
    if (!bot?.client?.sendMessage || !bot.connection?.ready || bot.connection?.status !== 'connected') {
      throw badRequest('واتساب غير متصل. شغّل البوت وتأكد أن الحالة «متصل» قبل بدء الحملة', 'WHATSAPP_NOT_CONNECTED');
    }
    const activeHistoryImport = await database.query(
      `SELECT COUNT(*)::int AS count FROM whatsapp_history_imports
       WHERE user_id = $1 AND status IN ('starting','running')`,
      [userId],
    );
    if (Number(activeHistoryImport.rows[0]?.count || 0) > 0) {
      throw badRequest('استيراد محادثات واتساب يعمل الآن بوضع القراءة فقط. أنهِ الاستيراد قبل إطلاق أي حملة.', 'HISTORY_IMPORT_READ_ONLY');
    }
    const pendingResult = await database.query(
      `SELECT COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`,
      [campaignId],
    );
    const pending = Number(pendingResult.rows[0]?.count || 0);
    if (!pending) throw badRequest('لا يوجد مستلمون بانتظار الإرسال');
    const quota = await checkMessageQuota(userId, { database });
    if (!quota.canReply || quota.remaining < pending) {
      throw badRequest(`الرصيد غير كافٍ. المطلوب ${pending} والمتاح ${quota.remaining || 0}`, 'INSUFFICIENT_QUOTA');
    }
    const scheduledAt = campaign.scheduled_at ? new Date(campaign.scheduled_at).getTime() : 0;
    const delay = Math.max(0, scheduledAt - Date.now());
    const nextStatus = delay > 0 ? 'scheduled' : 'sending';
    const started = await database.query(
      `UPDATE campaigns SET status = $3,
         started_at = CASE WHEN $3 = 'sending' THEN COALESCE(started_at, NOW()) ELSE started_at END,
         updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'approved'
         AND approved_at IS NOT NULL AND approved_snapshot_hash IS NOT NULL
       RETURNING id`,
      [campaignId, userId, nextStatus],
    );
    if (!started.rows[0]) throw badRequest('تغيرت الحملة قبل بدء الإرسال؛ راجع اعتمادها من جديد', 'CAMPAIGN_START_RACE');
    try {
      const scheduler = scheduleCampaignRecipient
        || require('../../workers/campaign-worker').scheduleNextRecipient;
      await scheduler(campaignId, { database, delay });
    } catch (error) {
      await database.query(`UPDATE campaigns SET status = 'approved', last_error = $2, updated_at = NOW() WHERE id = $1`, [campaignId, error.message]).catch(() => {});
      throw error;
    }
    await audit(database, campaignId, userId, 'started', { scheduled: delay > 0, delayMs: delay });
    return campaignPublic(await getOwnedCampaign(database, userId, campaignId));
  }

  async function exportContactTemplate() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('نموذج الاستهداف', { views: [{ rightToLeft: true }] });
    sheet.columns = [
      { header: 'رقم الجوال', key: 'phone', width: 20 },
      { header: 'اسم العميل', key: 'name', width: 24 },
      { header: 'نوع السجل', key: 'status', width: 18 },
      { header: 'المنتج أو الاشتراك', key: 'product', width: 30 },
      { header: 'رقم الطلب', key: 'orderReference', width: 20 },
      { header: 'تاريخ الطلب', key: 'orderDate', width: 18 },
      { header: 'بداية الاشتراك', key: 'subscriptionStart', width: 18 },
      { header: 'نهاية الاشتراك', key: 'subscriptionEnd', width: 18 },
    ];
    sheet.addRow({ phone: '0551234567', name: 'مثال عميل طلب', status: 'طلب', product: 'اسم المنتج', orderReference: 'ORD-1001', orderDate: '2026-07-16' });
    sheet.addRow({ phone: '0559876543', name: 'مثال عميل مشترك', status: 'اشتراك', product: 'الاشتراك السنوي', subscriptionStart: '2026-07-01', subscriptionEnd: '2027-06-30' });
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: 'A1', to: 'H1' };
    for (let row = 2; row <= 1000; row += 1) {
      sheet.getCell(`C${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"عميل,طلب,اشتراك"'] };
    }
    const guide = workbook.addWorksheet('التعليمات', { views: [{ rightToLeft: true }] });
    guide.addRows([
      ['الحقل', 'الشرح'],
      ['نوع السجل', 'اكتب عميل أو طلب أو اشتراك. إذا وُجد رقم طلب أو تاريخ اشتراك تتعرف المنصة عليه تلقائياً.'],
      ['التواريخ', 'استخدم الصيغة الواضحة YYYY-MM-DD، مثال: 2026-07-16.'],
      ['التكرار', 'الرقم المكرر يُدمج مع السجل الموجود ولا يُنشئ عميلاً جديداً.'],
      ['الأمثلة', 'احذف صفّي المثال قبل رفع ملفك الحقيقي.'],
    ]);
    guide.columns = [{ width: 22 }, { width: 90 }];
    guide.getRow(1).font = { bold: true };
    return workbook.xlsx.writeBuffer();
  }

  async function exportContacts(userId) {
    const result = await database.query(
      `SELECT normalized_phone, name, customer_status, product_name, order_reference, order_date,
              subscription_start_date, subscription_end_date, source, updated_at
       FROM campaign_contacts WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    );
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('قاعدة العملاء', { views: [{ rightToLeft: true }] });
    sheet.columns = [
      { header: 'رقم الجوال', key: 'phone', width: 20 },
      { header: 'اسم العميل', key: 'name', width: 24 },
      { header: 'نوع السجل', key: 'status', width: 18 },
      { header: 'المنتج أو الاشتراك', key: 'product', width: 30 },
      { header: 'رقم الطلب', key: 'orderReference', width: 20 },
      { header: 'تاريخ الطلب', key: 'orderDate', width: 18 },
      { header: 'بداية الاشتراك', key: 'subscriptionStart', width: 18 },
      { header: 'نهاية الاشتراك', key: 'subscriptionEnd', width: 18 },
      { header: 'المصدر', key: 'source', width: 18 },
      { header: 'آخر تحديث', key: 'updatedAt', width: 24 },
    ];
    const statusLabels = { contact: 'عميل', ordered: 'طلب', subscription: 'اشتراك' };
    for (const row of result.rows) sheet.addRow({
      phone: row.normalized_phone,
      name: row.name || '',
      status: statusLabels[row.customer_status] || 'عميل',
      product: row.product_name || '',
      orderReference: row.order_reference || '',
      orderDate: row.order_date || '',
      subscriptionStart: row.subscription_start_date || '',
      subscriptionEnd: row.subscription_end_date || '',
      source: row.source || '',
      updatedAt: row.updated_at || '',
    });
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: 'A1', to: 'J1' };
    return workbook.xlsx.writeBuffer();
  }

  async function exportSignals(userId, state = null) {
    if (state && !SIGNAL_STATES.has(state)) throw badRequest('التصنيف المطلوب غير صالح');
    const rows = await listSignals(userId, state ? { states: [state] } : {});
    const workbook = new ExcelJS.Workbook();
    const stateSheets = {
      interested_unverified: 'مهتمون بلا طلب مؤكد',
      ordered_confirmed: 'الطلبات المؤكدة',
      needs_verification: 'يحتاجون تحقق',
    };
    const statesToWrite = state ? [state] : Object.keys(stateSheets);
    for (const targetState of statesToWrite) {
      const sheet = workbook.addWorksheet(stateSheets[targetState], { views: [{ rightToLeft: true }] });
      sheet.columns = [
        { header: 'رقم العميل', key: 'phone', width: 20 },
        { header: 'اسم العميل', key: 'name', width: 24 },
        { header: 'المنتج', key: 'product', width: 28 },
        { header: 'التصنيف', key: 'state', width: 24 },
        { header: 'رقم الطلب', key: 'orderReference', width: 20 },
        { header: 'تاريخ الطلب', key: 'orderDate', width: 18 },
        { header: 'بداية الاشتراك', key: 'subscriptionStart', width: 18 },
        { header: 'نهاية الاشتراك', key: 'subscriptionEnd', width: 18 },
        { header: 'نسبة الثقة', key: 'confidence', width: 14 },
        { header: 'الدليل', key: 'evidence', width: 50 },
        { header: 'المصدر', key: 'source', width: 20 },
        { header: 'آخر تحديث', key: 'updatedAt', width: 24 },
      ];
      for (const row of rows.filter(item => item.customer_state === targetState)) sheet.addRow({
        phone: row.normalized_phone || row.sender,
        name: row.customer_name || '',
        product: row.product_name || '',
        state: row.customer_state || '',
        orderReference: row.order_reference || '',
        orderDate: row.order_date || '',
        subscriptionStart: row.subscription_start_date || '',
        subscriptionEnd: row.subscription_end_date || '',
        confidence: row.confidence === null ? '' : Number(row.confidence),
        evidence: row.evidence_text || '',
        source: row.source || '',
        updatedAt: row.last_detected_at || '',
      });
      sheet.getRow(1).font = { bold: true };
      sheet.autoFilter = { from: 'A1', to: 'L1' };
    }
    return workbook.xlsx.writeBuffer();
  }

  return {
    addManualContacts,
    analyze,
    approve,
    create,
    exportSignals,
    exportContactTemplate,
    exportContacts,
    get,
    importContacts,
    finishHistoryImport,
    historyImportStatus,
    list,
    listSignals,
    normalizePhone,
    prepareApproval,
    preview,
    previewAudience,
    reuseAudience,
    segmentCounts,
    setStatus,
    start,
    startHistoryImport,
    update,
    updateSignal,
  };
}

module.exports = {
  MIN_CAMPAIGN_INTERVAL_SECONDS,
  canonicalize,
  createCampaignService,
  normalizeAudienceRules,
  normalizeCampaignMessage,
  normalizePhone,
  resolveAudience,
  snapshotHash,
};
