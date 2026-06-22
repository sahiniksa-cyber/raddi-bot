# Login Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict per-IP rate limiter specifically on `POST /api/auth/login` to prevent brute-force password attacks. The existing global API limiter (120 req/min) is too loose for the login endpoint.

**Architecture:** `express-rate-limit` is already installed and used in `src/server.js`. We inject a new, tighter limiter directly on the login route in `src/routes/auth.routes.js`. The limiter allows 10 login attempts per IP per 15 minutes; on breach it returns a JSON `{ success: false, message: '...' }` (consistent with all other auth errors). The limiter factory is an injectable dep so tests can verify the route is protected without making real HTTP requests.

**Tech Stack:** Node.js, `express-rate-limit` (already in package.json), `node:test`, `node:assert/strict`.

---

### Task 1: Login-specific rate limiter in auth routes

**Files:**
- Modify: `src/routes/auth.routes.js`
- Create: `tests/auth-login-rate-limit.test.js`

**Context:**

Current `auth.routes.js` (line 11):
```js
router.post('/api/auth/login', controller.login);
```

`express-rate-limit` is imported in `server.js` as `require('express-rate-limit')`. We add a `createLoginLimiter` factory to `auth.routes.js` that accepts an optional `rateLimitFactory` dep (defaults to `require('express-rate-limit')`). The route wires it in as middleware before the login handler.

Settings for the limiter:
- `windowMs`: 15 * 60 * 1000 (15 minutes)
- `max`: 10 attempts per IP
- `standardHeaders`: true (sets Retry-After header)
- `legacyHeaders`: false
- `skipSuccessfulRequests`: true (only failed/all requests count toward the limit — set to false for simplicity)
- `message`: `{ success: false, message: 'محاولات كثيرة للدخول. حاول بعد 15 دقيقة.' }`

- [ ] **Step 1: Write the failing test**

Create `tests/auth-login-rate-limit.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuthRoutes } = require('../src/routes/auth.routes');

// Check that the route was created with a rate limiter applied before the login handler
test('login route has a rate limiter middleware applied', () => {
  let limiterFactoryCalled = false;
  let limiterOpts = null;

  // Fake rateLimit factory — records options and returns a no-op middleware
  const fakeRateLimit = (opts) => {
    limiterFactoryCalled = true;
    limiterOpts = opts;
    return (req, res, next) => next(); // no-op
  };

  // Create routes — should call our fake factory during construction
  createAuthRoutes({ rateLimitFactory: fakeRateLimit });

  assert.equal(limiterFactoryCalled, true, 'rate limit factory should be called');
  assert.ok(limiterOpts, 'rate limit options should be set');
  assert.ok(limiterOpts.windowMs >= 10 * 60 * 1000, 'window should be at least 10 minutes');
  assert.ok(limiterOpts.max <= 20, 'max attempts should be 20 or fewer per window');
});

test('rate limiter is applied ONLY on login, not on other auth routes', () => {
  const appliedTo = [];

  const fakeRateLimit = () => {
    const mw = (req, res, next) => next();
    mw.__isLoginLimiter = true;
    return mw;
  };

  // Spy on the router to record which routes get which middlewares
  const express = require('express');
  const originalPost = express.Router.prototype.post;

  const postCalls = [];
  express.Router.prototype.post = function(path, ...handlers) {
    postCalls.push({ path, hasLimiter: handlers.some(h => h.__isLoginLimiter) });
    return originalPost.call(this, path, ...handlers);
  };

  try {
    createAuthRoutes({ rateLimitFactory: fakeRateLimit });
  } finally {
    express.Router.prototype.post = originalPost;
  }

  const loginRoute = postCalls.find(c => c.path.includes('login'));
  assert.ok(loginRoute, 'login route must exist');
  assert.equal(loginRoute.hasLimiter, true, 'login route must have rate limiter');

  const registerRoute = postCalls.find(c => c.path.includes('register'));
  if (registerRoute) {
    assert.equal(registerRoute.hasLimiter, false, 'register route should NOT have the login limiter');
  }
});

test('rate limiter message is JSON-compatible and Arabic', () => {
  let capturedMessage = null;

  const fakeRateLimit = (opts) => {
    capturedMessage = opts.message;
    return (req, res, next) => next();
  };

  createAuthRoutes({ rateLimitFactory: fakeRateLimit });

  assert.ok(capturedMessage, 'message option must be set');
  if (typeof capturedMessage === 'object') {
    assert.equal(capturedMessage.success, false, 'message.success must be false');
    assert.ok(typeof capturedMessage.message === 'string', 'message.message must be a string');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/auth-login-rate-limit.test.js
```
Expected: `login route has a rate limiter middleware applied` FAILS (no limiter exists yet, `limiterFactoryCalled` stays false).

- [ ] **Step 3: Implement in auth.routes.js**

Replace `src/routes/auth.routes.js` entirely with:

```js
'use strict';

const express = require('express');
const { createAuthController } = require('../controllers/auth.controller');

const LOGIN_LIMITER_DEFAULTS = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 login attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة للدخول. حاول بعد 15 دقيقة.' },
};

function createAuthRoutes(deps = {}) {
  const router = express.Router();
  const controller = createAuthController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const rateLimitFactory = deps.rateLimitFactory || require('express-rate-limit');

  const loginLimiter = rateLimitFactory(LOGIN_LIMITER_DEFAULTS);

  router.post('/api/auth/login', loginLimiter, controller.login);
  router.post('/api/auth/register', controller.register);
  router.post('/api/auth/logout', controller.logout);
  router.get('/api/auth/me', controller.me);
  router.post('/api/auth/change-password', requireAuth, controller.changePassword);

  router.post('/api/auth/verify-email', (req, res) => res.json({ success: true, verified: true }));
  router.post('/api/auth/resend-code', (req, res) => res.json({ success: true }));
  router.post('/api/auth/forgot-password', (req, res) => res.json({ success: false, message: 'استعادة كلمة المرور غير مفعلة في الخادم الجديد بعد' }));
  router.post('/api/auth/reset-password', (req, res) => res.json({ success: false, message: 'استعادة كلمة المرور غير مفعلة في الخادم الجديد بعد' }));

  return router;
}

module.exports = { createAuthRoutes };
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test tests/auth-login-rate-limit.test.js
```
Expected: 3/3 PASS.

- [ ] **Step 5: Run full test suite**

```
node --test tests/
```
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/routes/auth.routes.js tests/auth-login-rate-limit.test.js
git commit -m "feat(auth): add strict per-IP rate limiter on POST /api/auth/login"
```
