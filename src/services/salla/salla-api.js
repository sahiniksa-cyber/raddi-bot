'use strict';

/**
 * Salla Admin API client — reads customers, orders, and abandoned carts for a
 * merchant using the stored OAuth Bearer token. HTTP is injectable (`deps.fetch`)
 * so pagination, auth-error handling, and mapping are unit-tested without network.
 *
 * Base: https://api.salla.dev/admin/v2  (docs.salla.dev). Scopes required:
 * customers.read, orders.read, carts.read.
 */

const { toCanonicalPhone } = require('../identity/phone');

const DEFAULT_BASE = 'https://api.salla.dev/admin/v2';

function buildUrl(base, path, query = {}) {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function fetchResource(path, { token, query = {}, base = DEFAULT_BASE } = {}, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch available');
  const url = buildUrl(base, path, query);
  const res = await doFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const status = res.status;
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }

  if (status === 401 || status === 403) {
    const e = new Error('salla_unauthorized');
    e.code = 'SALLA_UNAUTHORIZED';
    e.status = status;
    throw e;
  }
  if (status === 429) {
    const e = new Error('salla_rate_limited');
    e.code = 'SALLA_RATE_LIMITED';
    e.status = 429;
    e.retryable = true;
    throw e;
  }
  if (status >= 400 || !body) {
    const e = new Error(`salla_http_${status}`);
    e.code = 'SALLA_HTTP_ERROR';
    e.status = status;
    throw e;
  }
  const items = Array.isArray(body.data) ? body.data : [];
  const pagination = body.pagination || {};
  return { items, pagination, status, body };
}

// Async generator over every item of a paginated resource.
async function* iterate(path, { token, query = {}, base } = {}, deps = {}) {
  let page = 1;
  let totalPages = 1;
  do {
    const { items, pagination } = await fetchResource(path, { token, base, query: { ...query, page } }, deps);
    if (!items.length) break; // guard: never loop on an empty page
    for (const it of items) yield it;
    totalPages = Number(pagination.totalPages || pagination.total_pages || 1) || 1;
    page += 1;
  } while (page <= totalPages);
}

// ── Single-page reads (used for progress totals) ──────────────────────────────
function listCustomersPage({ token, page = 1, query = {} } = {}, deps = {}) {
  return fetchResource('/customers', { token, query: { ...query, page } }, deps);
}
function listOrdersPage({ token, customerId, page = 1, query = {} } = {}, deps = {}) {
  return fetchResource('/orders', { token, query: { customer_id: customerId, ...query, page } }, deps);
}
function listAbandonedCartsPage({ token, page = 1, query = {} } = {}, deps = {}) {
  return fetchResource('/carts/abandoned', { token, query: { ...query, page } }, deps);
}

// ── Full iterators ────────────────────────────────────────────────────────────
function iterateCustomers({ token, query = {} } = {}, deps = {}) {
  return iterate('/customers', { token, query }, deps);
}
function iterateOrders({ token, customerId, query = {} } = {}, deps = {}) {
  return iterate('/orders', { token, query: { customer_id: customerId, ...query } }, deps);
}
function iterateAbandonedCarts({ token, query = {} } = {}, deps = {}) {
  return iterate('/carts/abandoned', { token, query }, deps);
}

// ── Mappers to the identity-resolver signal / crm_* shapes ─────────────────────
function combineMobile(mobileCode, mobile) {
  const code = mobileCode != null ? String(mobileCode).replace(/\D/g, '') : '';
  const num = mobile != null ? String(mobile).trim() : '';
  if (!num) return null;
  const raw = code && !num.replace(/\D/g, '').startsWith(code) ? code + num : num;
  const r = toCanonicalPhone(raw);
  return r ? r.canonical : (raw.replace(/\D/g, '') || null);
}

function mapSallaCustomerToSignal(c = {}) {
  return {
    sallaCustomerId: c.id != null ? String(c.id) : null,
    phone: combineMobile(c.mobile_code, c.mobile),
    email: c.email || null,
    name: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
    occurredAt: parseSallaDate(c.created_at),
    source: 'salla_customer',
    raw: c,
  };
}

function mapSallaOrder(o = {}) {
  const status = o.status || {};
  const total = o.total || {};
  const customer = o.customer || {};
  return {
    sallaOrderId: o.id != null ? String(o.id) : null,
    referenceId: o.reference_id != null ? String(o.reference_id) : null,
    statusSlug: status.slug || null,
    statusRaw: status,
    totalAmount: total.amount != null ? Number(total.amount) : null,
    currency: total.currency || null,
    sallaCustomerId: customer.id != null ? String(customer.id) : null,
    customerPhone: combineMobile(customer.mobile_code, customer.mobile),
    couponCode: (o.coupon && o.coupon.code) || o.coupon_code || null,
    items: Array.isArray(o.items) ? o.items : [],
    placedAt: parseSallaDate(o.date) || parseSallaDate(o.created_at),
    raw: o,
  };
}

function mapSallaCart(c = {}) {
  const total = c.total || {};
  const customer = c.customer || {};
  return {
    sallaCartId: c.id != null ? String(c.id) : null,
    totalAmount: total.amount != null ? Number(total.amount) : null,
    currency: total.currency || null,
    checkoutUrl: c.checkout_url || null,
    sallaCustomerId: customer.id != null ? String(customer.id) : null,
    customerPhone: combineMobile(customer.mobile_code, customer.mobile),
    abandonedAt: parseSallaDate(c.created_at) || parseSallaDate(c.updated_at),
    raw: c,
  };
}

// Salla dates arrive either as a string or as { date, timezone_type, timezone }.
function parseSallaDate(v) {
  if (!v) return null;
  const s = typeof v === 'object' ? v.date : v;
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  DEFAULT_BASE,
  fetchResource,
  iterate,
  listCustomersPage,
  listOrdersPage,
  listAbandonedCartsPage,
  iterateCustomers,
  iterateOrders,
  iterateAbandonedCarts,
  mapSallaCustomerToSignal,
  mapSallaOrder,
  mapSallaCart,
  combineMobile,
  parseSallaDate,
};
