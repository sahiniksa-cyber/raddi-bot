# Salla × Jawab — Customer Intelligence & Identity Resolution (Design)

Date: 2026-08-10
Status: **DESIGN — awaiting owner approval before implementation**
Scope: Build a unified Customer 360 / CRM intelligence layer on top of Salla store
data + WhatsApp (Jawab) activity. Identity resolution and the data model come
FIRST; UI and campaign integration come only after the model is proven on the
test scenarios (per owner's explicit instruction).

---

## 0. Grounding — current reality (from codebase investigation)

- **No canonical customer.** Identity today is the raw WhatsApp JID string stored
  in `conversations.sender` / `messages.sender`. The same human fragments across
  `@lid` and `@s.whatsapp.net`. `phone_number` is best-effort/nullable; live
  ingest never resolves a `@lid` back to a phone (only the read-only history
  importer does, via `history-import.service.js` `lidToPhone`).
- **4 divergent phone normalizers**, two incompatible normal forms:
  - `campaign-service.js:normalizePhone` → `966501234567` (country code, no `+`) — used for `campaign_contacts.normalized_phone`.
  - `do-not-reply.js:normalizeNumber` → `501234567` (country code stripped).
  - `history-import.service.js` and `escalation-routing.js` — two more variants.
  - `966` (Saudi) is hardcoded throughout. No stored `+`/true-E.164.
- **`customer_profiles`** is keyed by `conversation_id` (per-thread), and its
  `phone` column is effectively never populated (no phone regex in the extractor).
- **`campaign_contacts`** (UNIQUE `user_id, normalized_phone`) is the closest
  existing per-merchant address book; already has `customer_status`,
  `product_name`, `order_reference`, subscription dates.
- **Campaigns**: rules live in `campaigns.audience_rules` (JSONB), resolved to a
  **static snapshot** in `campaign_recipients` (UNIQUE `campaign_id, sender`) at
  approval, protected by `approved_snapshot_hash`. Dedup is in-memory by
  `phone:<digits>` else `sender:<jid>` — per-campaign only. Send-time eligibility
  re-check exists ONLY for `smart`/`keywords` sources. No AND/OR groups, no saved
  re-evaluating segment, no cross-campaign suppression.
- **Multi-tenant**: everything is scoped to a merchant `user_id`. Merchants ARE
  rows in `users`. A person messaging two merchants = two independent customers
  (by design — keep it).
- **Salla data** (Admin API base `https://api.salla.dev/admin/v2`, Bearer token
  already captured per-merchant by `salla-stores.getAccessToken`):
  - Customers: `GET /customers` (scope `customers.read`), `keyword` searches
    mobile/name/email; fields include `id, mobile, mobile_code, email, full_name, created_at`.
  - Orders: `GET /orders?customer_id=` (scope `orders.read`); `status.slug`,
    `total.{amount,currency}`, `items[]`, `date`.
  - Abandoned carts: `GET /carts/abandoned` (scope `carts.read`); conversion
    signalled by webhook `abandoned.cart.purchased` (`status="purchased"`).
  - Webhooks (currently logged-only in `salla_webhook_events`, not yet handled):
    `customer.created/updated`, `order.created/updated/status.updated/cancelled/refunded`,
    `abandoned.cart` / `abandoned.cart.purchased`, `coupon.applied`.
  - Scopes required: `customers.read orders.read carts.read offline_access`
    (space-separated, set in the Salla Partners portal per app).
  - `fetchSallaProducts` reads only page 1 — **pagination must be added**.

---

## 1. Design principles (from owner spec)

1. **One canonical customer per real person per merchant.** Never show the same
   person as 3 customers because they chatted, appeared in Salla, and ordered.
2. **Identity resolution by priority**, never by name alone:
   Salla Customer ID (confirmed) → normalized phone (strong) → verified email
   (policy, cautious) → Jawab/order/cart references.
3. **No aggressive auto-merge.** Confidence + explicit rules; conflicts become
   *suggested* merges for review, not silent merges. Full merge audit trail.
4. **Status is multi-dimensional, not one field.** Purchase / Conversation /
   Cart / Lifecycle / Campaign are independent dimensions. Segments are *derived*
   views recomputed from raw data — never the source of truth.
5. **Store raw timestamps + raw order status always**, so classification and
   attribution windows can be recomputed later (rebuildable). Nothing derived is
   allowed to depend on values that can't be reproduced from raw sources.
6. **Event-driven updates** from Salla webhooks + periodic reconciliation.
7. **International-ready**: no Saudi-only hardcoding that blocks other countries.

---

## 2. Foundation prerequisite — central phone normalization

Create `src/services/identity/phone.js` (single source of truth):
- `toCanonicalPhone(value, { defaultCountry }) -> { canonical, e164, national, country } | null`
  - `canonical`/`e164`: full international, `+<cc><national>` and digits form.
  - Handles `05…`, `5…`, `966…`, `+966…`, `00966…`, and general `+<cc>…`.
  - `defaultCountry` configurable per merchant (default `SA`/`966`), NOT hardcoded.
  - Reject obviously invalid lengths; keep the raw input alongside.
- Migrate the 4 existing normalizers to delegate here (behind their current
  signatures) so `campaign_contacts.normalized_phone` and the CRM match key use
  the SAME canonical form. This is what makes WhatsApp↔Salla phone matching work.
- Backfill: recompute canonical phone for existing `campaign_contacts` /
  `conversations.phone_number` / history rows (idempotent migration).

---

## 3. Canonical data model (new tables, all scoped by `user_id`)

Names are indicative; final naming TBD. `crm_` prefix to isolate from existing.

### 3.1 `crm_customers` — the canonical person
```
id UUID PK
user_id UUID NOT NULL (merchant)
canonical_phone TEXT            -- normalized E.164 digits; primary match key (nullable)
display_name TEXT
email TEXT
salla_customer_id TEXT          -- denormalized for fast lookup (also in identities)
first_seen_at TIMESTAMPTZ       -- earliest of any signal
created_at, updated_at
UNIQUE(user_id, canonical_phone)   -- partial, WHERE canonical_phone IS NOT NULL
UNIQUE(user_id, salla_customer_id) -- partial, WHERE salla_customer_id IS NOT NULL
```
Holds identity + a few denormalized keys ONLY. No metrics/status here.

### 3.2 `crm_identities` — every external key that resolves to a customer
```
id UUID PK
user_id UUID NOT NULL
customer_id UUID NOT NULL -> crm_customers(id) ON DELETE CASCADE
identity_type TEXT   -- 'salla_customer_id'|'whatsapp_sender'|'whatsapp_lid'|
                     --  'phone'|'email'|'order_customer'|'cart_customer'|'jawab_conversation'
identity_value TEXT
match_reason TEXT    -- why it was linked
confidence NUMERIC(5,4)
created_at
UNIQUE(user_id, identity_type, identity_value)
```
This is the resolution layer: one customer ↔ many identities. Lookups on
`(user_id, identity_type, identity_value)`.

### 3.3 `crm_merge_history` — audit of every merge (never delete external ids)
```
id BIGSERIAL PK
user_id, kept_customer_id, merged_customer_id
reason TEXT           -- e.g. 'phone_exact', 'salla_id_exact', 'manual'
matched_on JSONB      -- the identities that triggered it
created_at, created_by
```

### 3.4 `crm_customer_metrics` — DERIVED, recomputable rollup (one row/customer)
Purchase: `has_orders, orders_count, first_order_at, last_order_at,
last_order_status_slug, total_order_value, avg_order_value, last_order_value,
first_product, last_products JSONB`.
Conversation: `has_whatsapp_conversation, first_conversation_at,
last_conversation_at, conversation_count, last_message_at`.
Cart: `has_abandoned_cart, active_abandoned_carts_count, last_abandoned_cart_at,
last_abandoned_cart_value, last_abandoned_cart_id, cart_recovered, recovered_at`.
Attribution (raw, window-independent): `first_contact_at, first_order_at,
contacted_before_purchase BOOL, time_to_conversion_seconds,
conversion_order_id, conversion_conversation_id`.
Lifecycle: `lifecycle TEXT` (derived: Lead / Engaged Lead / Abandoned Cart Lead /
First-Time / Repeat / Recovered / Inactive).
`computed_at`. Everything here is recomputable by the Rebuild job (§9).

### 3.5 `crm_orders` — mirror of qualifying Salla orders (raw status kept)
```
id, user_id, customer_id, salla_order_id UNIQUE(user_id, salla_order_id),
reference_id, status_slug, status_raw JSONB, is_qualified_purchase BOOL,
total_amount, currency, items JSONB, coupon_code, placed_at, created_at, updated_at
```

### 3.6 `crm_carts` — mirror of abandoned carts
```
id, user_id, customer_id, salla_cart_id UNIQUE, total_amount, currency,
status TEXT ('abandoned'|'purchased'|'recovered'), checkout_url,
abandoned_at, converted_at, created_at, updated_at
```

### 3.7 `crm_timeline_events` — unified journey (append-only)
```
id BIGSERIAL, user_id, customer_id,
event_type TEXT   -- 'conversation_started','message','product_added','cart_abandoned',
                  --  'reminder_sent','coupon_used','order_created','segment_changed',...
occurred_at TIMESTAMPTZ,   -- REAL event time (not insert time)
source TEXT,               -- 'whatsapp'|'salla'|'campaign'|'system'
ref_type TEXT, ref_id TEXT,
detail JSONB
INDEX(user_id, customer_id, occurred_at)
```
Populated by event handlers; existing history can be backfilled by union query.

### 3.8 Segments / audiences (rules that re-evaluate)
```
crm_segments(id, user_id, name, rules JSONB, is_quick BOOL, created_at, updated_at)
```
`rules` = AND/OR groups of predicates over the dimensions in §3.4 (+ products,
city, coupon, campaign history, tags). Membership is computed live (a rule
compiler → SQL over crm_* tables). "Quick segments" (§24) are seeded rows.
Campaign send still freezes a **snapshot** (reuse existing
`campaign_recipients` + `approved_snapshot_hash`), keyed on `customer_id`.

### 3.9 New link columns (non-breaking) on existing tables
Add nullable `customer_id UUID -> crm_customers(id)` to: `conversations`,
`campaign_contacts`, `customer_product_signals`, `campaign_recipients`. Backfilled
by identity resolution; existing logic keeps working if null.

### 3.10 Tags & assignment (don't exist today — new, small)
`crm_customer_tags(user_id, customer_id, tag)` and optional
`conversations.assigned_user_id`. Only if needed by the UI phase.

---

## 4. Identity resolution algorithm

On any inbound signal (WhatsApp message, Salla customer/order/cart event, sync row):
1. Build candidate keys: `salla_customer_id`, `canonical_phone` (from WA
   `phone_number` OR Salla `mobile_code+mobile`), `email` (lowercased), WA
   `sender`/`lid`.
2. Look up `crm_identities` by each key in priority order.
3. **Resolution:**
   - Salla Customer ID exact match → **CONFIRMED** → use that customer.
   - Else canonical phone exact → **STRONG** → use/auto-link.
   - Else email exact AND no conflicting phone/salla-id on either side →
     **MEDIUM** → link, flag `suggested` (do NOT merge across different phones).
   - Else create a NEW `crm_customers` row.
4. **Merge** (when a later signal proves two existing customers are one):
   - Auto-merge only on CONFIRMED/STRONG and no hard conflict (different
     non-null `salla_customer_id` = hard conflict → suggested merge, not auto).
   - Keep the older row (or the one with `salla_customer_id`) as canonical;
     repoint identities + `customer_id` FKs; write `crm_merge_history`.
5. **@lid handling:** if only a lid is known, store identity `whatsapp_lid`;
   when a phone later resolves (live `senderPn`/`participantPn`, or history
   `lidToPhone`), link/merge to the phone-based customer.

Name is NEVER a match key. Email alone never merges two different phones.

---

## 5. Classification (derived views over dimensions — spec §8–14)

- **سأل ولم يطلب**: `has_whatsapp_conversation AND orders_count(qualified)=0`.
- **طلب بدون تواصل**: `orders_count>0 AND` no conversation before `first_order_at`.
- **سأل ثم طلب**: `first_contact_at < first_order_at` (and order within the
  configurable attribution window). Store `contacted_before_purchase`,
  `time_to_conversion`, `conversion_order_id`.
- **طلب ثم تواصل**: `first_order_at < first_contact_at` (existing customer asking
  post-purchase — must NOT be targeted by "لسه ما اشتريت").
- **ترك سلة ولم يشترِ / ترك سلة ثم اشترى**: from `crm_carts.status`.
- **Lifecycle**: derived (Lead/First-Time/Repeat/Recovered/Inactive), recomputed
  on every relevant event.
- **Attribution window** is a parameter at query/analysis time; raw timestamps
  stored so it can change without data loss (spec §11, §36).

## 5.1 Purchase Qualification Policy (spec §32)
A configurable set of Salla `status.slug` values that count as a purchase.
Proposed default: **qualified** = `completed, delivered, shipped, delivering,
in_progress`; **not qualified** = `canceled, payment_failed, payment_pending,
waiting_for_payment_confirmation, under_review`. Tolerate merchant custom
statuses (match by slug, keep raw). Owner to confirm/adjust.

---

## 6. Sync (spec §27–28)

- **Initial background sync** on first authorize (NOT inside the OAuth webhook):
  paginate `GET /customers`, then `/orders`, then `/carts/abandoned`; resolve
  identities; compute metrics. Emit progress (`salla_sync_jobs` table with
  counts) for a "8,420 / 12,300" style UI later.
- **Incremental**: handle the Salla webhooks (currently logged-only) —
  `customer.*`, `order.*`, `abandoned.cart.*`, `coupon.applied` → update
  crm_* → recompute affected metrics + segment membership → cancel now-ineligible
  campaign/automation entries. Periodic reconciliation as a safety net.
- Requires Salla token **refresh** (2-week expiry) — add
  `salla-oauth.refreshAccessToken` using `SALLA_APP_ID`/`SALLA_APP_SECRET`.

---

## 7. Campaigns integration (spec §16–23) — later phase

- Audience builder reads `crm_segments` rules (AND/OR groups) → live count.
- Recipients keyed on **`customer_id`** → true cross-source dedup (one send per
  person regardless of how many source rows).
- **Eligibility re-check at send** extended to all rule audiences (reuse
  worker pattern; fix the legacy `source==='smart'` branch). Skip + log reason
  (`converted_before_send`) if the customer no longer matches.
- Campaign history per customer (entered/excluded/sent/converted) via
  `crm_timeline_events` + a `crm_customer_campaigns` link.

---

## 8. Test scenarios (acceptance — spec §34–36). Must pass before "done".

1. New WA lead (no Salla) → "سأل ولم يطلب". Then same phone appears in Salla →
   **NO second customer**. Then abandons cart → "سأل + سلة متروكة + لم يطلب".
   Then orders → instantly: order linked, `orders_count++`, removed from
   "لم يطلب", removed from ineligible campaigns, cart reminders stopped, added to
   "سأل ثم طلب", conversion time recorded, order shows in profile.
2. Direct Salla buyer (no WA) → "اشترى / طلب بدون تواصل". Next day sends WA →
   matched by phone, **no new lead**; becomes "طلب ثم تواصل", NOT "سأل ثم طلب".
3. Very old conversation, later purchase → real chronology preserved; attribution
   engine decides (by window) whether the chat gets credit.
4. Duplicate-prevention: multiple source rows (WA sender, Salla customer, order,
   cart) for one phone → exactly ONE `crm_customers` row and ONE campaign
   recipient.

Validation needs a **staging environment + a real Salla test store** (live tests
are never run against production per project rule). This depends on the Salla
webhook being deployed and a test store installing the app.

---

## 9. Rebuild capability (spec §31)
An admin job `rebuildCustomerIntelligence(userId)` that recomputes
`crm_customer_metrics`, lifecycle, and segment membership from raw sources
(`crm_orders`, `crm_carts`, conversations/messages, `crm_timeline_events`).
Guarantees no derived value depends on non-reproducible state.

---

## 10. Phased delivery plan

- **Phase A — Foundation (no UI):** central phone normalizer + backfill;
  `crm_*` schema; identity resolution service (+ merge audit); Salla API client
  (customers/orders/carts, pagination, token refresh); initial sync + webhook
  handlers; metrics + qualification policy + attribution; backfill/link existing
  data. **Prove scenarios §8 with tests.**
- **Phase B — Read layer:** segment rule engine + quick segments; unified
  timeline; search; metrics for dashboard.
- **Phase C — UI:** Customers (Customer 360) page + timeline; Audience/Segments
  builder (AND/OR, saved audiences, live counts).
- **Phase D — Campaigns:** audience-from-segments, canonical dedup, eligibility
  re-check, campaign history/attribution.
- **Phase E — Live validation** on staging with a real Salla test store.

Each phase is built with TDD, isolated (feature-flagged), and does not disturb
the live WhatsApp bot until switched on.

---

## 11. Open decisions for the owner
1. Purchase Qualification Policy default (§5.1) — accept proposed, or adjust which
   Salla statuses count as "اشترى"?
2. Email-only matching (§4) — accept "suggest, never auto-merge across different
   phones"?
3. Instagram (existing module) — fold IG conversations into the same canonical
   customer now, or WhatsApp+Salla only for v1?
4. Staging/test-store plan for §8 live validation (ties to deploying the Salla
   webhook + installing the app on a demo store).
