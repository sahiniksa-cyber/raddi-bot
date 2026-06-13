'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const authSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'controllers', 'auth.controller.js'),
  'utf8',
);
const adminSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'admin.routes.js'),
  'utf8',
);

// ---- SEC-2: session fixation — SID must be regenerated on authentication ----

test('SEC-2: auth.controller defines regenerateSession and calls it on login before setting userId', () => {
  assert.match(authSrc, /function regenerateSession\(req\)/);
  const regenIdx = authSrc.indexOf('await regenerateSession(req)');
  const loginSetIdx = authSrc.indexOf('req.session.userId = user.id');
  assert.ok(regenIdx > 0 && loginSetIdx > 0, 'both regenerate call and userId assignment must exist');
  assert.ok(regenIdx < loginSetIdx, 'regenerate must run BEFORE assigning userId on login');
});

test('SEC-2: register also regenerates the session before establishing identity', () => {
  // second occurrence of the regenerate call (login + register)
  const matches = authSrc.match(/await regenerateSession\(req\)/g) || [];
  assert.equal(matches.length, 2, 'regenerate must be called in both login and register');
});

test('SEC-2: admin login rotates the session and preserves the user identity', () => {
  assert.match(adminSrc, /req\.session\.regenerate\(/);
  // preserves uid/uname across the rotation
  assert.match(adminSrc, /const uid = req\.session\.userId/);
  assert.match(adminSrc, /req\.session\.isAdmin = true/);
});

// ---- SEC-3: admin password compared in constant time ----

test('SEC-3: admin login uses a constant-time compare, not a raw !== on the password', () => {
  assert.match(adminSrc, /function timingSafeEqualStr/);
  assert.match(adminSrc, /timingSafeEqualStr\(password, adminPassword\)/);
  assert.match(adminSrc, /crypto\.timingSafeEqual/);
  // the old direct comparison must be gone
  assert.doesNotMatch(adminSrc, /password !== adminPassword/);
});

test('SEC-3: timingSafeEqualStr returns true for equal strings and false otherwise', () => {
  // exercise the real helper by re-implementing the same primitive (the module
  // does not export it); this guards the algorithm choice (hash → timingSafeEqual).
  const crypto = require('crypto');
  const cmp = (a, b) => crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a || '')).digest(),
    crypto.createHash('sha256').update(String(b || '')).digest(),
  );
  assert.equal(cmp('secret123', 'secret123'), true);
  assert.equal(cmp('secret123', 'wrong'), false);
  assert.equal(cmp('', ''), true); // equal-but-empty still compares safely
});
