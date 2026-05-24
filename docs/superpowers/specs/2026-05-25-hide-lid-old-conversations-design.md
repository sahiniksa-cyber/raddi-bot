# Hide LID Identifiers in Old Conversations — Design Spec

**Date:** 2026-05-25
**Status:** Draft
**Predecessor:** [2026-05-25-lid-phone-extraction-design.md](2026-05-25-lid-phone-extraction-design.md) (Phase A — deployed)

---

## المشكلة

Phase A نشر إصلاح يخزّن `phone_number` للرسائل الجديدة، فالمحادثات الجديدة تظهر بـ `+966xxxxxxxxx` في الـ dashboard. لكن **المحادثات القديمة** (قبل نشر Phase A في 2026-05-24) `phone_number = NULL` لأن `senderPn` لم يكن يُلتقط وقتها.

النتيجة الحالية في الـ dashboard:

```
276282495500304@lid
السلام عليكم

276282495500304@lid
أبغى استرجاع
```

المحادثات القديمة تظهر بـ `xxx@lid` raw — تجربة بشعة لصاحب المتجر، خصوصاً إن أغلب المحادثات الحالية على المنصة قديمة (قبل النشر).

**القيد:** لا backfill ممكن للـ `phone_number` (البيانات مفقودة من المصدر).

---

## الهدف

إخفاء الـ `@lid` raw وعرض **بديل بصري لطيف** للمحادثات القديمة، مع تمييز واضح أنها "قديمة" حتى يفهم المستخدم سبب غياب الرقم. التغيير في طبقة العرض فقط — البيانات الأصلية في DB تبقى كما هي.

---

## مبادئ التصميم

1. **Display-only change** — ما نلمس DB، queues، AI، أو Baileys.
2. **Backwards-compatible** — المحادثات الجديدة (بـ `phone_number`) تشتغل بدون أي تغيير.
3. **آخر 4 أرقام من الـ lid** — تعطي العميل هوية مميزة بدل "عميل قديم" غير معرف.
4. **Badge بصري "قديمة"** — تفسير واضح لصاحب المتجر بدل ما يحتار.
5. **Tested** — اختبارات لكل سيناريو قبل النشر.

---

## نطاق التغيير

### 1. `src/controllers/conversations.controller.js`

دالة `cleanCustomerPhone(senderOrRow)`:

**الحالي:**
```js
if (raw.endsWith('@lid')) return raw;
```

**الجديد:**
```js
if (raw.endsWith('@lid')) {
  const digits = raw.replace(/@lid$/, '').replace(/[^\d]/g, '');
  const last4 = digits.slice(-4);
  return last4 ? `عميل ····${last4}` : 'عميل قديم';
}
```

**باقي الدالة بدون تغيير** — `phone_number` لما يكون موجود يرجع `+phoneNumber` كما هو.

### 2. `src/workers/escalation-routing.js`

دالة `cleanCustomerJid(sender, { phoneNumber } = {})`:

**الحالي:**
```js
if (raw.endsWith('@lid')) return raw;
```

**الجديد:** نفس المنطق — نحوّل `xxx@lid` إلى `عميل ····XXXX`.

النتيجة: إشعارات التصعيد للموظف تصير `العميل: عميل ····0304` بدل `العميل: 276282495500304@lid`.

### 3. `dashboard/index.html`

**موضعان** يعرضون phone — الـ card في القائمة (سطر 2024) و header الـ panel (سطر 2095):

**الحالي:**
```html
<div class="phone">${esc(c.phone||c.sender||'')}</div>
```

**الجديد:**
```html
<div class="phone">
  ${esc(c.phone||c.sender||'')}
  ${!c.phoneNumber ? '<span class="old-badge">قديمة</span>' : ''}
</div>
```

CSS جديد (يُضاف في `<style>` الموجود):
```css
.old-badge {
  font-size: 10px;
  background: #f1f5f9;
  color: #64748b;
  padding: 2px 6px;
  border-radius: 4px;
  margin-right: 6px;
  vertical-align: middle;
}
```

### 4. Tests

#### `tests/conversations-controller.test.js` (موسّع)

3 اختبارات جديدة:

```js
test('cleanCustomerPhone converts @lid to masked customer label with last 4 digits', () => {
  assert.equal(cleanCustomerPhone('276282495500304@lid'), 'عميل ····0304');
});

test('cleanCustomerPhone falls back to "عميل قديم" when lid has no digits', () => {
  assert.equal(cleanCustomerPhone('@lid'), 'عميل قديم');
});

test('cleanCustomerPhone prefers phone_number over @lid sender (row form)', () => {
  assert.equal(
    cleanCustomerPhone({ phone_number: '966512345678', sender: '276282495500304@lid' }),
    '+966512345678',
  );
});
```

#### `tests/escalation-routing.test.js` (موسّع)

اختباران جديدان:

```js
test('buildEscalationNotification masks @lid sender when customerPhoneNumber is missing', () => {
  const text = buildEscalationNotification({
    contact: { name: 'علي', role: 'دعم', phone: '966500000000' },
    customerSender: '276282495500304@lid',
    inboundText: 'مشكلة',
    summary: 'يحتاج متابعة',
  });
  assert.ok(text.includes('عميل ····0304'));
  assert.ok(!text.includes('@lid'));
});

test('buildEscalationNotification still prefers customerPhoneNumber when provided', () => {
  // الاختبار الموجود في PR #15 — يبقى كما هو
});
```

⚠️ **ملاحظة:** الاختبار الموجود حالياً في [tests/escalation-routing.test.js:126-135](tests/escalation-routing.test.js:126):
```js
test('buildEscalationNotification falls back to sender when customerPhoneNumber is missing', () => {
  // ...
  assert.ok(text.includes('276282495500304@lid'));
});
```

**يحتاج تعديل** — بعد التغيير، هذا الاختبار يفشل لأن النص يصير `عميل ····0304` لا `276282495500304@lid`. التعديل سيكون:
```js
assert.ok(text.includes('عميل ····0304'));
assert.ok(!text.includes('@lid'));
```

---

## Data Flow

```
[المحادثة القديمة في DB]
  sender = '276282495500304@lid'
  phone_number = NULL
        │
        ▼
[GET /api/conversations (الـ list endpoint)]
  cleanCustomerPhone(row) → 'عميل ····0304'
  payload.phone = 'عميل ····0304'
  payload.phoneNumber = null
        │
        ▼
[Dashboard render]
  c.phone → 'عميل ····0304'
  !c.phoneNumber → يظهر badge "قديمة"
```

```
[محادثة جديدة بعد Phase A]
  sender = '276282495500304@lid'
  phone_number = '966512345678'
        │
        ▼
[GET /api/conversations]
  cleanCustomerPhone(row) → '+966512345678'
  payload.phone = '+966512345678'
  payload.phoneNumber = '966512345678'
        │
        ▼
[Dashboard render]
  c.phone → '+966512345678'
  !c.phoneNumber = false → بدون badge
```

---

## ما لا يتغير (ضمانات الأمان)

| المكوّن | الحالة |
|---|---|
| DB schema | بدون تغيير — لا migration |
| `messages.content`, `conversations.sender`, `conversations.phone_number` في DB | بدون تغيير — نص الـ lid raw يظل محفوظاً |
| `ai-client.js`, AI prompts | بدون تغيير |
| BullMQ queues | بدون تغيير |
| Baileys connection, ingest service | بدون تغيير |
| API contract في `/api/conversations` | متطابق — نفس الحقول، نص `phone` فقط هو المختلف |
| Phase A pipeline (`senderPn` → `phone_number`) | يستمر يشتغل كما هو |

---

## حالات حدية محسومة

| الحالة | السلوك |
|---|---|
| `sender = '276282495500304@lid'`, `phone_number = NULL` | `عميل ····0304` + badge |
| `sender = '276282495500304@lid'`, `phone_number = '966512345678'` | `+966512345678` بدون badge |
| `sender = '@lid'` (بدون أرقام) | `'عميل قديم'` + badge |
| `sender = '966500000000@s.whatsapp.net'`, `phone_number = NULL` | `+966500000000` بدون badge (الـ JID الكامل فيه الرقم) |
| `sender = '120363xxx@g.us'` (group) | `+120363xxx` (لا يطبق منطق lid) |
| `sender = NULL` | يرجع `''` (نفس الحالي) |

---

## خطة الاختبار

### قبل النشر (محلياً)
```bash
node --test "tests/conversations-controller.test.js" "tests/escalation-routing.test.js"
```
يجب أن تمر كل الاختبارات (الموجودة + الجديدة).

### بعد النشر (Railway)
1. افتح dashboard → "محادثات"
2. تحقق: المحادثات القديمة تظهر بـ `عميل ····XXXX` مع badge "قديمة"
3. تحقق: المحادثات الجديدة (بعد 2026-05-24 19:56 UTC) تظهر بـ `+966xxxxxxxxx` بدون badge
4. أرسل رسالة تستدعي تصعيد من عميل قديم → تحقق أن إشعار الموظف يحتوي `عميل ····0304` بدل lid raw

---

## الأثر على المستخدم النهائي

**صاحب المتجر يشوف:**
- المحادثات القديمة: `عميل ····0304` `قديمة`
- المحادثات الجديدة: `+966512345678`
- إشعارات التصعيد للموظف: `العميل: عميل ····0304` (للقديمة) أو `العميل: +966512345678` (للجديدة)

**النتيجة المتوقعة:** اختفاء الإحباط البصري للـ `@lid`، وفهم واضح لسبب غياب الأرقام في المحادثات القديمة.

---

## ما هو خارج النطاق

- **Backfill للـ phone_number** — مستحيل تقنياً (البيانات مفقودة من Baileys للرسائل قبل Phase A)
- **حذف أو أرشفة المحادثات القديمة** — لا، البيانات قيّمة للسجل
- **تغيير ترتيب المحادثات (القديم تحت الجديد)** — مرفوض، ترتيب `last_message_at DESC` صحيح وطبيعي
- **Phase D (variants)** — مشروع منفصل، spec لاحقاً
- **Phase A AI prompts cleanup** — مشروع منفصل، spec لاحقاً
