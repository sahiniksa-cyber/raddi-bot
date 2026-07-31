'use strict';

/**
 * Lightweight CSRF protection via Origin/Referer header check.
 * Only enforced for state-changing methods (POST/PUT/PATCH/DELETE).
 *
 * Note: Webhooks and other endpoints that legitimately receive cross-origin
 * requests must be mounted BEFORE this middleware (or excluded explicitly).
 */
function requireSameOrigin(req, res, next) {
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
}

// Pure decision: should this request be same-origin checked? Two modes:
//  • default (allowlist): only the configured protected prefixes (legacy behavior).
//  • strict (default-deny, opt-in via STABILITY_STRICT_CSRF): EVERY mutating
//    /api request except webhooks (HMAC-verified, legitimately cross-origin) and
//    explicit skips. Strict is opt-in so production behavior is unchanged until
//    it is validated and enabled.
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
function shouldEnforceSameOrigin({ method, path, strict = false, protectedPrefixes = [], skipPaths = new Set() } = {}) {
  if (skipPaths && typeof skipPaths.has === 'function' && skipPaths.has(path)) return false;
  if (strict) {
    return MUTATING_METHODS.includes(method) && String(path).startsWith('/api/') && !/webhook/i.test(path);
  }
  return protectedPrefixes.some((p) => String(path).startsWith(p));
}

module.exports = requireSameOrigin;
module.exports.shouldEnforceSameOrigin = shouldEnforceSameOrigin;
