# Owner Admin Billing Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private owner console for customer access, billing state, payment/free activation, suspension, and message receivables.

**Architecture:** Add billing tables and a focused billing service, then expose owner-only admin routes behind a configurable secret path and admin session check. Keep customer dashboard access gating off by default until `BILLING_ACCESS_GATE_ENABLED=true` to avoid breaking live users.

**Tech Stack:** Node.js, Express, PostgreSQL, vanilla dashboard HTML/CSS/JS, Node test runner.

---

## File Map

- Modify `src/db/migrations/init.js`: create billing tables.
- Create `src/services/billing/billing-settings.js`: parse env billing/admin settings.
- Create `src/services/billing/billing-service.js`: database operations for billing accounts and admin actions.
- Create `src/middleware/billing-access.js`: optional dashboard access gate.
- Create `src/routes/admin.routes.js`: owner console page and JSON API.
- Create `dashboard/admin.html`: private owner UI.
- Modify `src/server.js`: mount admin routes and optional billing gate.
- Modify `.env.example`: document owner/admin settings.
- Create tests in `tests/billing-settings.test.js`, `tests/billing-service.test.js`, `tests/admin-auth.test.js`.

## Tasks

### Task 1: Billing Settings

**Files:**
- Create: `src/services/billing/billing-settings.js`
- Test: `tests/billing-settings.test.js`

- [ ] Write tests that assert `normalizeSecretPath(' owner ')` returns `/owner`, invalid paths return `null`, admin emails are lowercased, and default upfront price is `175000`.
- [ ] Run `node --test tests/billing-settings.test.js` and verify it fails because the module is missing.
- [ ] Implement `billing-settings.js` with `getBillingSettings(env)` and `normalizeSecretPath(value)`.
- [ ] Run the test and verify it passes.

### Task 2: Database Tables

**Files:**
- Modify: `src/db/migrations/init.js`

- [ ] Add `billing_accounts`, `billing_payments`, `billing_payment_methods`, and `billing_events` tables with indexes.
- [ ] Run `node --check src/db/migrations/init.js`.

### Task 3: Billing Service

**Files:**
- Create: `src/services/billing/billing-service.js`
- Test: `tests/billing-service.test.js`

- [ ] Write tests for pure helpers: `isActiveAccess`, `normalizeAccessStatus`, and `buildAdminCustomerRow`.
- [ ] Run `node --test tests/billing-service.test.js` and verify it fails because the module is missing.
- [ ] Implement helpers and database functions: `isAdminUser`, `getUserBillingState`, `listAdminCustomers`, `grantFreeAccess`, `markPaidAccess`, `suspendAccess`, `reactivateAccess`, `updateReceivable`.
- [ ] Run the service tests and verify they pass.

### Task 4: Admin Route Protection

**Files:**
- Create: `src/routes/admin.routes.js`
- Test: `tests/admin-auth.test.js`

- [ ] Write route tests for `canOpenAdminConsole({ path, user, settings })`: wrong path false, normal user false, admin on secret path true.
- [ ] Run `node --test tests/admin-auth.test.js` and verify it fails.
- [ ] Implement route helper and Express routes: secret page, `/api/admin/customers`, `/api/admin/customers/:userId/action`.
- [ ] Run route tests and verify they pass.

### Task 5: Owner UI

**Files:**
- Create: `dashboard/admin.html`

- [ ] Build a compact RTL admin dashboard with customer table, status chips, action buttons, amount due input, and note textarea.
- [ ] Use `/api/admin/customers` to load rows and `/api/admin/customers/:userId/action` for actions.
- [ ] Run a syntax check over inline scripts using `new Function`.

### Task 6: Server Integration

**Files:**
- Modify: `src/server.js`
- Create: `src/middleware/billing-access.js`
- Modify: `.env.example`

- [ ] Mount admin routes before dashboard routes.
- [ ] Add optional dashboard access gate controlled by `BILLING_ACCESS_GATE_ENABLED`.
- [ ] Document `ADMIN_SECRET_PATH`, `ADMIN_EMAILS`, `PLATFORM_ACCESS_PRICE_HALALAS`, `MESSAGE_PRICE_HALALAS`, and `BILLING_ACCESS_GATE_ENABLED`.
- [ ] Run `node --check src/server.js`.

### Task 7: Verification

**Files:**
- All touched files.

- [ ] Run `npm test`.
- [ ] Run `git diff --stat` and review scope.
- [ ] Commit with message `Add owner admin billing console`.
- [ ] Push to GitHub.

