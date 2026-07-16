'use strict';

const express = require('express');
const multer = require('multer');

const db = require('../db/client');
const { createCampaignService } = require('../services/campaigns/campaign-service');
const { deleteCampaignMedia, saveCampaignMedia } = require('../services/campaigns/media-store');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 10, fileSize: 25 * 1024 * 1024 },
});

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: error.code, message: error.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف يتجاوز 25 ميجابايت' : 'تعذر رفع الملف' });
      }
      if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({ success: false, error: error.code || 'bad_request', message: error.message });
      }
      return next(error);
    }
  };
}

function handleUpload(middleware) {
  return (req, res, next) => middleware(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        error: error.code,
        message: error.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف يتجاوز 25 ميجابايت' : 'تعذر رفع الملف',
      });
    }
    return next(error);
  });
}

function createCampaignRoutes(deps = {}) {
  const router = express.Router();
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const database = deps.database || db;
  const service = createCampaignService({ database, getUserBot: deps.getUserBot });
  const userId = req => req.session.userId;

  router.use('/api/campaigns', requireAuth);

  router.get('/api/campaigns/smart/counts', asyncHandler(async (req, res) => {
    res.json({ success: true, counts: await service.segmentCounts(userId(req)) });
  }));
  router.get('/api/campaigns/smart/signals', asyncHandler(async (req, res) => {
    const filters = {
      states: req.query.state ? String(req.query.state).split(',') : [],
      productKeys: req.query.product ? String(req.query.product).split(',') : [],
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
    };
    res.json({ success: true, signals: await service.listSignals(userId(req), filters) });
  }));
  router.get('/api/campaigns/smart/export.xlsx', asyncHandler(async (req, res) => {
    const buffer = await service.exportSignals(userId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="smart-audience-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buffer));
  }));
  router.get('/api/campaigns/smart/export/:state.xlsx', asyncHandler(async (req, res) => {
    const buffer = await service.exportSignals(userId(req), req.params.state);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="smart-audience-${req.params.state}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buffer));
  }));
  router.patch('/api/campaigns/smart/signals/:signalId', asyncHandler(async (req, res) => {
    const signal = await service.updateSignal(userId(req), req.params.signalId, req.body || {});
    res.json({ success: true, signal });
  }));
  router.post('/api/campaigns/smart/analyze', asyncHandler(async (req, res) => {
    const result = await service.analyze(userId(req), { limit: req.body?.limit, useAi: req.body?.useAi !== false });
    res.json({ success: true, ...result });
  }));
  router.post('/api/campaigns/contacts/manual', asyncHandler(async (req, res) => {
    const result = await service.addManualContacts(userId(req), req.body?.contacts || req.body?.numbers || []);
    res.json({ success: true, ...result });
  }));
  router.get('/api/campaigns/contacts/template.xlsx', asyncHandler(async (_req, res) => {
    const buffer = await service.exportContactTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="campaign-contacts-template.xlsx"');
    res.send(Buffer.from(buffer));
  }));
  router.get('/api/campaigns/contacts/export.xlsx', asyncHandler(async (req, res) => {
    const buffer = await service.exportContacts(userId(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-contacts-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buffer));
  }));
  router.post('/api/campaigns/contacts/import', handleUpload(upload.single('file')), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'اختر ملف CSV أو Excel' });
    const result = await service.importContacts(userId(req), req.file.buffer, req.file.originalname);
    res.json({ success: true, ...result });
  }));

  router.get('/api/campaigns', asyncHandler(async (req, res) => {
    res.json({ success: true, campaigns: await service.list(userId(req)) });
  }));
  router.post('/api/campaigns', asyncHandler(async (req, res) => {
    res.status(201).json({ success: true, campaign: await service.create(userId(req), req.body || {}) });
  }));
  router.post('/api/campaigns/audience/preview', asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await service.previewAudience(userId(req), req.body?.audienceRules || {})) });
  }));
  router.get('/api/campaigns/:id', asyncHandler(async (req, res) => {
    res.json({ success: true, campaign: await service.get(userId(req), req.params.id) });
  }));
  router.patch('/api/campaigns/:id', asyncHandler(async (req, res) => {
    res.json({ success: true, campaign: await service.update(userId(req), req.params.id, req.body || {}) });
  }));
  router.get('/api/campaigns/:id/preview', asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await service.preview(userId(req), req.params.id)) });
  }));
  router.post('/api/campaigns/:id/media', handleUpload(upload.array('media', 10)), asyncHandler(async (req, res) => {
    const media = await saveCampaignMedia({ database, userId: userId(req), campaignId: req.params.id, files: req.files || [] });
    res.status(201).json({ success: true, media });
  }));
  router.delete('/api/campaigns/:id/media/:mediaId', asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await deleteCampaignMedia({ database, userId: userId(req), campaignId: req.params.id, mediaId: req.params.mediaId })) });
  }));
  router.post('/api/campaigns/:id/prepare-approval', asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await service.prepareApproval(userId(req), req.params.id)) });
  }));
  router.post('/api/campaigns/:id/approve', asyncHandler(async (req, res) => {
    res.json({ success: true, campaign: await service.approve(userId(req), req.params.id, req.body || {}) });
  }));
  router.post('/api/campaigns/:id/start', asyncHandler(async (req, res) => {
    res.json({ success: true, campaign: await service.start(userId(req), req.params.id) });
  }));
  router.post('/api/campaigns/:id/:action(pause|resume|cancel)', asyncHandler(async (req, res) => {
    res.json({ success: true, campaign: await service.setStatus(userId(req), req.params.id, req.params.action) });
  }));

  return router;
}

module.exports = { createCampaignRoutes };
