'use strict';

/**
 * Lightweight CSRF protection via Origin/Referer header check.
 * Only enforced for state-changing methods (POST/PUT/PATCH/DELETE).
 *
 * Note: Webhooks and other endpoints that legitimately receive cross-origin
 * requests must be mounted BEFORE this middleware (or excluded explicitly).
 */
module.exports = function requireSameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return res.status(403).json({ success: false, error: 'origin_required' });
  try {
    const host = new URL(origin).host;
    if (host !== req.headers.host) {
      return res.status(403).json({ success: false, error: 'cross_origin' });
    }
  } catch (_) {
    return res.status(403).json({ success: false, error: 'bad_origin' });
  }
  next();
};
