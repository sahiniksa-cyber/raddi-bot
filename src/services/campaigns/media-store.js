'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const db = require('../../db/client');

const ALLOWED_TYPES = new Map([
  ['image/jpeg', { kind: 'image', extension: '.jpg' }],
  ['image/png', { kind: 'image', extension: '.png' }],
  ['image/webp', { kind: 'image', extension: '.webp' }],
  ['video/mp4', { kind: 'video', extension: '.mp4' }],
  ['video/quicktime', { kind: 'video', extension: '.mov' }],
  ['video/webm', { kind: 'video', extension: '.webm' }],
  ['application/pdf', { kind: 'document', extension: '.pdf' }],
]);

function resolveDataDir() {
  const configured = String(process.env.DATA_DIR || '').trim();
  const railwayVolume = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  return path.resolve(configured || railwayVolume || process.cwd());
}

function mediaRoot() {
  return path.join(resolveDataDir(), 'campaign-media');
}

function assertInsideRoot(candidate) {
  const root = path.resolve(mediaRoot());
  const resolved = path.resolve(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid campaign media path');
  return resolved;
}

function normalizeUploadFilename(value, fallback = 'document.pdf') {
  let filename = path.basename(String(value || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .normalize('NFC');

  // Busboy/Multer can expose UTF-8 filename bytes as Latin-1. Decode only
  // when every source character is byte-sized and the result is valid Arabic,
  // so already-correct Arabic, emoji and ordinary Latin filenames stay intact.
  if (filename && [...filename].every(character => character.codePointAt(0) <= 0xff)) {
    const decoded = Buffer.from(filename, 'latin1').toString('utf8').normalize('NFC');
    if (!decoded.includes('\ufffd') && /[\u0600-\u06ff]/.test(decoded)) filename = decoded;
  }

  if (!filename || filename === '.' || filename === '..') filename = fallback;
  const extension = path.extname(filename).slice(0, 20);
  const stemLimit = Math.max(1, 255 - [...extension].length);
  const stem = [...filename.slice(0, filename.length - extension.length)].slice(0, stemLimit).join('');
  return `${stem}${extension}` || fallback;
}

function hasValidSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  return false;
}

async function saveCampaignMedia({ database = db, userId, campaignId, files = [] } = {}) {
  if (!Array.isArray(files) || !files.length) return [];
  const preparedFiles = files.map(file => {
    const mimeType = String(file.mimetype || '').toLowerCase();
    const type = ALLOWED_TYPES.get(mimeType);
    if (!type || !hasValidSignature(file.buffer, mimeType)) {
      const error = new Error('نوع الملف غير مدعوم. استخدم JPG أو PNG أو WEBP أو MP4 أو MOV أو WEBM أو PDF');
      error.statusCode = 400;
      throw error;
    }
    return { file, mimeType, type };
  });

  const transactional = typeof database.transaction === 'function';
  const run = transactional ? database.transaction.bind(database) : async operation => operation(database);
  const saved = [];
  const writtenPaths = [];
  try {
    return await run(async client => {
      const campaignResult = await client.query(
        `SELECT id, status FROM campaigns WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [campaignId, userId],
      );
      const campaign = campaignResult.rows[0];
      if (!campaign) {
        const error = new Error('الحملة غير موجودة');
        error.statusCode = 404;
        throw error;
      }
      if (!['draft', 'ready_for_approval', 'approved'].includes(campaign.status)) {
        const error = new Error('لا يمكن إضافة وسائط في حالة الحملة الحالية');
        error.statusCode = 400;
        throw error;
      }
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count, COALESCE(MAX(sort_order), -1)::int + 1 AS next_order
         FROM campaign_media WHERE campaign_id = $1`,
        [campaignId],
      );
      const existingCount = Number(countResult.rows[0]?.count || 0);
      const nextOrder = Number(countResult.rows[0]?.next_order || 0);
      if (existingCount + preparedFiles.length > 10) {
        const error = new Error('الحد الأقصى 10 صور أو فيديوهات أو مستندات PDF للحملة');
        error.statusCode = 400;
        throw error;
      }

      // Keep approval revocation, recipient deletion and media rows in one DB
      // transaction. A failed file write or insert must leave the campaign in
      // exactly the state it had before the upload attempt.
      const revoked = await client.query(
        `UPDATE campaigns SET status = 'draft', approved_at = NULL, approved_by = NULL,
           approved_snapshot_hash = NULL, audience_count = 0, content_version = content_version + 1,
           updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('draft','ready_for_approval','approved')
         RETURNING id`,
        [campaignId, userId],
      );
      if (!revoked.rows[0]) {
        const error = new Error('لا يمكن إضافة وسائط في حالة الحملة الحالية');
        error.statusCode = 400;
        throw error;
      }
      await client.query(`DELETE FROM campaign_recipients WHERE campaign_id = $1`, [campaignId]);

      const directory = assertInsideRoot(path.join(mediaRoot(), String(userId), String(campaignId)));
      await fs.mkdir(directory, { recursive: true });
      for (let index = 0; index < preparedFiles.length; index += 1) {
        const { file, mimeType, type } = preparedFiles[index];
        const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const filename = `${crypto.randomUUID()}${type.extension}`;
        const storagePath = assertInsideRoot(path.join(directory, filename));
        await fs.writeFile(storagePath, file.buffer, { flag: 'wx' });
        writtenPaths.push(storagePath);
        const result = await client.query(
          `INSERT INTO campaign_media (
             campaign_id, user_id, kind, original_name, mime_type, storage_path,
             size_bytes, sha256, sort_order
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, kind, original_name, mime_type, size_bytes, sha256, sort_order, created_at`,
          [campaignId, userId, type.kind, normalizeUploadFilename(file.originalname, filename),
            mimeType, storagePath, file.buffer.length, sha256, nextOrder + index],
        );
        saved.push({ ...result.rows[0], storage_path: storagePath });
      }
      return saved.map(({ storage_path: _private, ...item }) => item);
    });
  } catch (error) {
    const savedIds = saved.map(item => item.id).filter(Boolean);
    if (!transactional && savedIds.length) {
      await database.query(`DELETE FROM campaign_media WHERE id = ANY($1::uuid[])`, [savedIds]).catch(() => {});
    }
    for (const storagePath of writtenPaths) await fs.unlink(storagePath).catch(() => {});
    throw error;
  }
}

async function deleteCampaignMedia({ database = db, userId, campaignId, mediaId } = {}) {
  const campaignResult = await database.query(
    `SELECT status FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId],
  );
  if (!campaignResult.rows[0]) {
    const error = new Error('الحملة غير موجودة');
    error.statusCode = 404;
    throw error;
  }
  if (!['draft', 'ready_for_approval', 'approved'].includes(campaignResult.rows[0].status)) {
    const error = new Error('لا يمكن حذف الوسائط في حالة الحملة الحالية');
    error.statusCode = 400;
    throw error;
  }
  const revoked = await database.query(
    `UPDATE campaigns SET status = 'draft', approved_at = NULL, approved_by = NULL,
       approved_snapshot_hash = NULL, audience_count = 0, content_version = content_version + 1,
       updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status IN ('draft','ready_for_approval','approved')
     RETURNING id`,
    [campaignId, userId],
  );
  if (!revoked.rows[0]) {
    const error = new Error('لا يمكن حذف الوسائط في حالة الحملة الحالية');
    error.statusCode = 400;
    throw error;
  }
  await database.query(`DELETE FROM campaign_recipients WHERE campaign_id = $1`, [campaignId]);
  const result = await database.query(
    `DELETE FROM campaign_media WHERE id = $1 AND campaign_id = $2 AND user_id = $3
     RETURNING storage_path`,
    [mediaId, campaignId, userId],
  );
  if (!result.rows[0]) {
    const error = new Error('الوسائط غير موجودة');
    error.statusCode = 404;
    throw error;
  }
  const storagePath = assertInsideRoot(result.rows[0].storage_path);
  await fs.unlink(storagePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { deleted: true };
}

module.exports = {
  ALLOWED_TYPES,
  assertInsideRoot,
  deleteCampaignMedia,
  hasValidSignature,
  mediaRoot,
  normalizeUploadFilename,
  saveCampaignMedia,
};
