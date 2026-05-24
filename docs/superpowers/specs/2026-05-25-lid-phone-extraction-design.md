# Phase A — استخراج رقم العميل من `senderPn` بدل الـ lid

**التاريخ:** 2026-05-25
**الحالة:** للمراجعة
**النوع:** إصلاح بصري + تشغيلي (لا ميزة جديدة)

---

## 1. المشكلة

في Baileys + WhatsApp الجديد، الرسائل القادمة من أجهزة حديثة (خصوصاً iOS مع iCloud Private Relay) تصل بـ:

```js
msg.key.remoteJid = "276282495500304@lid"      // معرّف مجهول (lid)
msg.key.senderPn  = "966512345678@s.whatsapp.net"  // الرقم الحقيقي
```

الكود الحالي يحفظ `remoteJid` كـ `conversations.sender` ثم يعرضه في:

1. **بطاقات المحادثات** في `/dashboard/index.html` (عبر `cleanCustomerPhone`)
2. **header المحادثة المفتوحة** (نفس الدالة)
3. **إشعارات التصعيد للمالك** (عبر `cleanCustomerJid` في `escalation-routing.js`)

النتيجة: المالك يشاهد `276282495500304@lid` بدل `+966512345678`.

تأكيد المستخدم: "الرقم موجود في كل عميل — لو فتحت الواتساب على جوالك تشوفه فوق الشاشة. مافي عميل يخفي رقمه." → `senderPn` متوفر دائماً في Baileys 7+.

---

## 2. الهدف

استخراج رقم الجوال الحقيقي من `key.senderPn` (مع fallback لـ `participantPn` ولـ `remoteJid` لو ليس lid)، تخزينه في عمود جديد `conversations.phone_number`، وتمريره عبر مسار الـ AI worker لاستخدامه في:

- عرض بطاقات + header المحادثات في الـ dashboard
- صياغة إشعار التصعيد للمالك

**خارج النطاق:** لا backfill للمحادثات القديمة. الـ `phone_number` يُملأ تلقائياً عند أول رسالة جديدة بعد الـ deploy.

---

## 3. تدفّق البيانات بعد التغيير

```
WhatsApp (Baileys) 
   ↓ msg.key.senderPn = "966512345678@s.whatsapp.net"
toWhatsappWebMessage(msg)
   ↓ يُضيف phoneNumber = "966512345678" في الـ payload
MessageIngestService.ingestWhatsappMessage
   ↓ UPSERT INTO conversations (sender, phone_number) 
   ↓   ON CONFLICT DO UPDATE phone_number = COALESCE(existing, new)
   ↓ enqueueAiReply({ ..., phoneNumber })
ai-worker.js
   ↓ SELECT id, sender, phone_number FROM conversations
   ↓ prepareEscalation({ customerSender, customerPhoneNumber })
escalation-routing.js
   ↓ buildEscalationNotification → cleanCustomerJid(sender, { phoneNumber })
   ↓ يفضّل phoneNumber لو موجود

dashboard (GET /api/conversations)
   ↓ conversations.controller.js
   ↓ cleanCustomerPhone(row) يفضّل row.phone_number
```

---

## 4. التعديلات على الكود

### 4.1 — `src/db/migrations/init.js`

إضافة سطر ALTER بعد كتلة `CREATE TABLE conversations`:

```js
`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number TEXT`,
```

idempotent، آمن للنشر المتكرر. لا index لأن العمود لا يُستعلم به (يُقرأ مع باقي حقول الـ row).

### 4.2 — `src/services/whatsapp/baileys-connection-manager.js`

**إضافة دالة helper:**

```js
function extractPhoneNumber(key) {
  const candidates = [key?.senderPn, key?.participantPn, key?.remoteJid];
  for (const value of candidates) {
    const raw = String(value || '').trim();
    if (!raw || raw.endsWith('@lid') || raw.endsWith('@g.us') || raw.endsWith('@broadcast')) continue;
    const digits = raw.replace(/@.*$/, '').replace(/[^\d]/g, '');
    if (digits) return digits;
  }
  return null;
}
```

**تعديل `toWhatsappWebMessage` (سطر 78):**

```js
function toWhatsappWebMessage(msg) {
  const remoteJid = msg.key?.remoteJid || null;
  return {
    id: { _serialized: msg.key?.id || null, id: msg.key?.id || null },
    from: remoteJid,
    to: msg.key?.participant || null,
    author: msg.key?.participant || null,
    fromMe: !!msg.key?.fromMe,
    phoneNumber: extractPhoneNumber(msg.key),  // ← جديد
    body: textFromBaileysMessage(msg.message || {}),
    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : null,
    type: Object.keys(msg.message || {})[0] || 'unknown',
    hasMedia: !!detectMediaPart(msg.message || {}),
    deviceType: 'baileys',
  };
}
```

### 4.3 — `src/services/whatsapp/message-ingest.service.js`

**إضافة helper:**

```js
function phoneNumberFromWhatsappMessage(msg) {
  const raw = String(msg?.phoneNumber || '').trim();
  return raw || null;
}
```

**تعديل `upsertConversation`:**

```js
async function upsertConversation(client, { userId, sender, phoneNumber }) {
  const result = await client.query(
    `INSERT INTO conversations (user_id, sender, phone_number, last_message_at, metadata)
     VALUES ($1, $2, $3, NOW(), '{}'::jsonb)
     ON CONFLICT (user_id, sender) DO UPDATE SET
       last_message_at = NOW(),
       phone_number = COALESCE(conversations.phone_number, EXCLUDED.phone_number)
     RETURNING id, phone_number`,
    [userId, sender, phoneNumber],
  );
  return { id: result.rows[0].id, phoneNumber: result.rows[0].phone_number };
}
```

**تعديل `ingestWhatsappMessage`:**

```js
const sender = senderFromWhatsappMessage(msg);
const phoneNumber = phoneNumberFromWhatsappMessage(msg);
// ...
const saved = await this.db.transaction(async (client) => {
  const { id: conversationId, phoneNumber: storedPhone } = await upsertConversation(client, {
    userId, sender, phoneNumber,
  });
  const messageId = await insertInboundMessage(client, { ... });
  return { conversationId, messageId, phoneNumber: storedPhone };
});

await this.queue.enqueueAiReply({
  userId,
  conversationId: saved.conversationId,
  messageId: saved.messageId,
  sender,
  phoneNumber: saved.phoneNumber,  // ← جديد (يستخدمه ai-worker لو لزم)
  text,
  providerMessageId,
  source,
  hasMedia: !!media,
  media,
}, { jobKey: `conversation-${saved.conversationId}` });
```

### 4.4 — `src/workers/ai-worker.js`

**تعديل استعلام تحميل المحادثة (سطر 97):**

```js
'SELECT id, sender, phone_number FROM conversations WHERE id = $1 AND user_id = $2'
```

**تعديل استدعاء `prepareEscalation` (سطر 453):**

```js
const escalation = prepareEscalation({
  reply,
  config,
  customerSender: conversation.sender,
  customerPhoneNumber: conversation.phone_number,  // ← جديد
  inboundText: text,
});
```

**تعديل استدعاء `enqueueOutgoingWhatsapp` للتصعيد (سطر 487):**

```js
await enqueueOutgoingWhatsapp({
  // ... القائم
  customerSender: conversation.sender,
  customerPhoneNumber: conversation.phone_number,  // ← جديد (للسجلات فقط، الـ outgoing-worker يستخدم sender فقط للإرسال)
}, { jobKey: buildEscalationJobKey(replyMessageId) });
```

### 4.5 — `src/workers/escalation-routing.js`

**تعديل `cleanCustomerJid` ليقبل phoneNumber:**

```js
function cleanCustomerJid(sender, { phoneNumber } = {}) {
  const pn = String(phoneNumber || '').trim();
  if (pn) return `+${pn}`;
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) return raw;
  return cleanDigits(sender) || raw;
}
```

**تعديل `buildEscalationNotification` (سطر 91):**

```js
function buildEscalationNotification({ contact, customerSender, customerPhoneNumber, inboundText, summary }) {
  const customer = cleanCustomerJid(customerSender, { phoneNumber: customerPhoneNumber });
  // ... الباقي كما هو
}
```

**تعديل `prepareEscalation` (سطر 115):**

```js
function prepareEscalation({ reply, config = {}, customerSender, customerPhoneNumber, inboundText }) {
  // ...
  reply: buildEscalationNotification({ contact, customerSender, customerPhoneNumber, inboundText, summary }),
}
```

### 4.6 — `src/controllers/conversations.controller.js`

**تعديل `cleanCustomerPhone` ليقبل phone_number:**

```js
function cleanCustomerPhone(senderOrRow) {
  // يقبل إما string (الواجهة القديمة) أو row object
  if (senderOrRow && typeof senderOrRow === 'object') {
    const pn = String(senderOrRow.phone_number || '').trim();
    if (pn) return `+${pn}`;
    return cleanCustomerPhone(senderOrRow.sender);
  }
  const raw = String(senderOrRow || '').trim();
  if (raw.endsWith('@lid')) return raw;
  const digits = raw.replace(/@(s\.whatsapp\.net|c\.us)$/i, '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : raw;
}
```

**تعديل استدعائها (سطر 135):**

```js
phone: cleanCustomerPhone(row),  // كان cleanCustomerPhone(row.sender)
```

**تعديل الـ SELECT للمحادثات (سطر 94-110):**

نضيف `c.phone_number` بعد `c.sender`:

```sql
SELECT c.id,
       c.sender,
       c.phone_number,    -- ← جديد
       c.last_message_at,
       COALESCE(first_msg.content, '') AS first_inquiry
FROM conversations c
...
```

ونضيف في الـ payload (سطر 132-140):

```js
const payload = conversations.rows.map(row => ({
  id: row.id,
  sender: row.sender,
  phoneNumber: row.phone_number || null,  // ← جديد (للواجهة لو لزم)
  phone: cleanCustomerPhone(row),
  // ...
}));
```

---

## 5. الاختبارات

### 5.1 — `tests/baileys-extract-phone.test.js` (جديد)

يختبر `extractPhoneNumber`:
- `senderPn = "966512345678@s.whatsapp.net"` → `"966512345678"`
- `senderPn = null, remoteJid = "966512345678@s.whatsapp.net"` → `"966512345678"`
- `senderPn = null, remoteJid = "276282495500304@lid"` → `null`
- `participantPn` كـ fallback يعمل
- ينظّف digits من علامات `+` و spaces

### 5.2 — `tests/message-ingest.test.js` (جديد)

ملف اختبار جديد لـ `MessageIngestService` (الموجود حالياً `message-ingest-media.test.js` يركّز على ميديا فقط):

- ingest برسالة فيها `phoneNumber` → الـ INSERT يحوي `phone_number` صحيحاً
- `enqueueAiReply` يستقبل `phoneNumber` في الـ payload
- ingest برسالة بدون `phoneNumber` (whatsapp-web.js مثلاً) → `phone_number = null` لكن INSERT ينجح
- استخدام fake DB client يمسك الـ SQL والـ params للتأكد من شكل الـ UPSERT (COALESCE موجود)

### 5.3 — `tests/conversations-controller.test.js` (موجود — توسيع)

- `cleanCustomerPhone({ phone_number: '966512345678', sender: 'x@lid' })` → `"+966512345678"`
- `cleanCustomerPhone({ phone_number: null, sender: 'x@lid' })` → `"x@lid"` (السلوك القديم)
- `cleanCustomerPhone('966512345678@s.whatsapp.net')` → `"+966512345678"` (backward compat للنداء بـ string)

### 5.4 — `tests/escalation-routing.test.js` (موجود — توسيع)

- `cleanCustomerJid('x@lid', { phoneNumber: '966512345678' })` → `"+966512345678"`
- `cleanCustomerJid('x@lid', {})` → `"x@lid"` (backward compat)
- `buildEscalationNotification` يحوي الرقم الصحيح في النص لما `customerPhoneNumber` يُمرَّر

### 5.5 — الـ ai-worker

الـ ai-worker يحوي test files متعددة (ai-worker-failure, ai-worker-quota, ...) لكن أي منها لا يفحص استعلام تحميل المحادثة مباشرة. لا حاجة لـ test جديد للـ SELECT — الـ tests الموجودة تستخدم fake DB ولا تتحقّق من شكل الـ SELECT. التحقّق من شكل الـ SELECT بـ `phone_number` يُغطّى عملياً عبر integration الـ migration + الـ ingest.

لو ظهرت حاجة لتغطية الـ prepareEscalation call بـ phoneNumber، نضيفها في `tests/escalation-routing.test.js` (المغطى في 5.4).

---

## 6. ما لا يتغيّر

- `conversations.sender` (الـ lid) يبقى كما هو — لا نكتب فوقه. مستخدم كـ unique key.
- المحادثات القديمة المخزّنة بـ lid ستظهر بـ phone_number = NULL → يفول-باك للسلوك القديم (يعرض الـ lid).
- جميع الـ outgoing messages تُرسَل بـ `sender` (الـ lid)، لا تتغيّر — Baileys يفهم الـ lid للإرسال.
- لا تغيير في الـ UI نفسه (HTML/CSS).
- لا تغيير في الـ ingest pipeline العام (whatsapp-web.js يمرّ بنفس المسار، `phoneNumber` يصير null هناك).

---

## 7. خطة التراجع

التغيير backward-compatible تماماً:
- العمود `phone_number` يقبل NULL → القائم سيعمل لو حصل rollback للكود.
- الـ `cleanCustomerPhone`/`cleanCustomerJid` يفولّان للسلوك القديم لو phone_number غير موجود.
- لو حصل خطأ بعد النشر: revert الـ merge commit، الـ ALTER COLUMN يبقى (غير ضار).

---

## 8. متغيّرات بيئة جديدة

لا يوجد.

---

## 9. ملفات تتعدّل (الإجمالي)

| الملف | النوع |
|---|---|
| `src/db/migrations/init.js` | تعديل (ALTER) |
| `src/services/whatsapp/baileys-connection-manager.js` | تعديل (helper + toWhatsappWebMessage) |
| `src/services/whatsapp/message-ingest.service.js` | تعديل (UPSERT + payload) |
| `src/workers/ai-worker.js` | تعديل (SELECT + استدعاء التصعيد) |
| `src/workers/escalation-routing.js` | تعديل (cleanCustomerJid + buildEscalationNotification + prepareEscalation) |
| `src/controllers/conversations.controller.js` | تعديل (cleanCustomerPhone + SELECT) |
| `tests/baileys-extract-phone.test.js` | جديد |
| `tests/message-ingest.test.js` | جديد |
| `tests/conversations-controller.test.js` | توسيع |
| `tests/escalation-routing.test.js` | توسيع |

**6 ملفات إنتاج + 4 ملفات اختبار (2 جديدة + 2 توسيع).**

---

## 10. خارج النطاق

- backfill للمحادثات القديمة
- index على `phone_number`
- استخدام `phone_number` في البحث (`?q=`)
- تعديل الـ outgoing JID (يبقى sender/lid، Baileys يحلّ)
- توحيد المحادثات لو نفس العميل ظهر بـ lid مختلفين (سيبقى محادثتين منفصلتين)
