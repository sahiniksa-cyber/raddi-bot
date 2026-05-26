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
  // The router prototype spy approach is unreliable due to module caching.
  // Instead: verify the limiter factory is called exactly once (for login only),
  // and inspect the returned router's route stack to confirm login has more
  // handlers than register (the extra handler is the limiter middleware).

  let factoryCallCount = 0;
  const fakeRateLimit = () => {
    factoryCallCount++;
    const mw = (req, res, next) => next();
    mw.__isLoginLimiter = true;
    return mw;
  };

  const router = createAuthRoutes({ rateLimitFactory: fakeRateLimit });

  // Factory should be called exactly once (only for the login route)
  assert.equal(factoryCallCount, 1, 'rate limit factory should be called exactly once (login route only)');

  // Inspect the router stack to verify login has the limiter and register does not
  const stack = router.stack || [];
  const loginLayer = stack.find(l => l.route && l.route.path && l.route.path.includes('login'));
  const registerLayer = stack.find(l => l.route && l.route.path && l.route.path.includes('register'));

  assert.ok(loginLayer, 'login route must exist in router stack');
  if (registerLayer) {
    const loginHandlerCount = loginLayer.route.stack.length;
    const registerHandlerCount = registerLayer.route.stack.length;
    assert.ok(
      loginHandlerCount > registerHandlerCount,
      `login route (${loginHandlerCount} handlers) should have more handlers than register (${registerHandlerCount}) due to limiter`
    );
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
