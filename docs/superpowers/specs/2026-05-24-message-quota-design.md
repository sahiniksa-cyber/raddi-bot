# نظام Quota الرسائل — تصميم

**التاريخ:** 2026-05-24
**الحالة:** للمراجعة
**يستبدل:** عرض تكلفة AI، نظام `platform_access_status` كآلية تحكم

---

## 1. الهدف

تحويل المنصة من نظام تسعير بالـ هللات/التوكنات إلى **حصة رسائل** بسيطة لكل عميل:

- العميل يدفع للحصول على عدد محدد من الرسائل (مثلاً 3,000)
- لكل دفعة مدة صلاحية اختيارية (افتراضي 30 يوم)
- بعد انتهاء الرسائل أو المدة (لو مفعّل التصفير): البوت يتوقف عن الرد تماماً
- العميل يطلب شحن رصيد عبر زر تواصل واتساب → الأدمن يضيف يدوياً

النظام **يحلّ محل** عرض التكلفة في dashboard العميل، ويعمل بالتوازي مع النظام المالي القديم (الذي يبقى في DB للأرشيف فقط).

---

## 2. نموذج البيانات

### تعديل جدول `billing_accounts` الموجود

```sql
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS messages_remaining INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quota_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS expire_resets_quota BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_topup_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_topup_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_billing_accounts_quota
  ON billing_accounts(user_id, messages_remaining)
  WHERE messages_remaining > 0;
```

### دلالة الحقول

| الحقل | المعنى |
|---|---|
| `messages_remaining` | الرصيد الحالي (ينقص مع كل إرسال outbound ناجح) |
| `quota_expires_at` | تاريخ انتهاء صلاحية آخر إضافة (`NULL` = ما في إضافة بعد) |
| `expire_resets_quota` | لو `TRUE` ومرّ `quota_expires_at`، الرصيد يُعتبر `0` |
| `last_topup_amount` | عدد الرسائل في آخر إضافة (للنسبة المئوية في dashboard العميل) |
| `last_topup_at` | تاريخ آخر إضافة (للسجل) |

### الرصيد الفعّال (effective remaining)

عند الفحص:

```
effective_remaining =
  IF (expire_resets_quota = TRUE
      AND quota_expires_at IS NOT NULL
      AND quota_expires_at < NOW())
    THEN 0
    ELSE messages_remaining
```

البوت يرد فقط إذا `effective_remaining > 0`.

---

## 3. منطق الإرسال والنقص

### قاعدة عامة

**كل رسالة outbound يرسلها البوت تنقص 1 من الرصيد**، بغض النظر عن نوعها:

| نوع الرسالة | تنقص؟ |
|---|---|
| ردّ AI للعميل | ✅ نعم |
| auto-reply keyword | ✅ نعم |
| تنبيه escalation للمالك | ✅ نعم |
| رسائل النظام الإدارية (سجلات، تنبيهات أدمن) | ❌ لا |

### نقطتا التحكم

**1. فحص في `src/workers/ai-worker.js` — قبل توليد AI**

الغرض: توفير تكلفة OpenAI لو الرصيد نفد بالفعل.

```js
const quota = await checkMessageQuota(userId);
if (!quota.canReply) {
  await markInboundMessagesQuotaExceeded({ messageIds });
  return { skipped: true, reason: quota.reason };
}
```

نفس الفحص يُجرى قبل مسار auto-reply.

**2. نقص في `src/workers/outgoing-whatsapp-worker.js` — بعد نجاح الإرسال**

الغرض: نقطة موحدة للنقص الذرّي بعد التأكد الفعلي من وصول الرسالة لواتساب.

```js
await sendWhatsappReply(bot, { sender, reply, providerMessageId });

const dec = await decrementMessageQuota(userId);
if (!dec.success) {
  logger.warn('quota', `sent but quota already empty for ${userId}`);
}

await markReplyMessage(replyMessageId, 'sent', {
  ...,
  quotaRemainingAfter: dec.remaining ?? 0,
});
```

### حالة سباق (race condition)

لو الرصيد نفد بين الفحص والإرسال (مثلاً رسالة أخرى للعميل بين الخطوتين):

- الرسالة الأولى تنجح: ترسل، تُسجَّل في DB، الرصيد يصير 0
- الرسالة الثانية تصل لـ outgoing بعد reply delay
- `decrementMessageQuota` (atomic UPDATE) يفشل لأن `messages_remaining = 0`
- نسجل تحذير في log لكن **لا نلغي الإرسال** الذي وصل فعلاً (الرسالة وصلت، فقط الرصيد فعلياً تحت الصفر بـ 1)
- الرسائل التالية في الـ queue: `outgoing-whatsapp-worker` لا يفحص الـ quota قبل الإرسال، لكن `ai-worker` للجولات الجديدة سيرى remaining = 0 ويتوقف

---

## 4. الـ Helper الجديد

ملف جديد: `src/services/billing/message-quota.js`

```js
async function checkMessageQuota(userId) {
  const result = await db.query(
    `SELECT messages_remaining, quota_expires_at, expire_resets_quota
     FROM billing_accounts WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return { canReply: false, remaining: 0, reason: 'no_account' };

  const expired = row.expire_resets_quota
    && row.quota_expires_at
    && new Date(row.quota_expires_at) < new Date();
  if (expired) return { canReply: false, remaining: 0, reason: 'expired', expiresAt: row.quota_expires_at };

  const remaining = row.messages_remaining || 0;
  if (remaining <= 0) return { canReply: false, remaining: 0, reason: 'empty' };

  return { canReply: true, remaining, expiresAt: row.quota_expires_at };
}

async function decrementMessageQuota(userId) {
  const result = await db.query(
    `UPDATE billing_accounts
     SET messages_remaining = messages_remaining - 1,
         updated_at = NOW()
     WHERE user_id = $1
       AND messages_remaining > 0
       AND (
         NOT expire_resets_quota
         OR quota_expires_at IS NULL
         OR quota_expires_at > NOW()
       )
     RETURNING messages_remaining`,
    [userId]
  );
  if (!result.rows[0]) return { success: false };
  return { success: true, remaining: result.rows[0].messages_remaining };
}

async function addMessagesToQuota(userId, { messages, days, expireResetsQuota }) {
  const result = await db.query(
    `INSERT INTO billing_accounts (
       user_id, messages_remaining, quota_expires_at, expire_resets_quota,
       last_topup_amount, last_topup_at
     )
     VALUES ($1, $2, NOW() + ($3 || ' days')::INTERVAL, $4, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET messages_remaining = billing_accounts.messages_remaining + EXCLUDED.messages_remaining,
           quota_expires_at = EXCLUDED.quota_expires_at,
           expire_resets_quota = EXCLUDED.expire_resets_quota,
           last_topup_amount = EXCLUDED.last_topup_amount,
           last_topup_at = NOW(),
           updated_at = NOW()
     RETURNING messages_remaining, quota_expires_at, expire_resets_quota,
               last_topup_amount, last_topup_at`,
    [userId, messages, String(days), expireResetsQuota]
  );
  return result.rows[0];
}
```

---

## 5. لوحة الأدمن

### تعديل `dashboard/admin.html`

في جدول العملاء، إضافة عمودين جديدين:

| الحقل | المصدر |
|---|---|
| الرصيد المتبقي | `messages_remaining` (مع تنبيه ⚠ لو منتهي + flag) |
| تاريخ الانتهاء | `quota_expires_at` (مع "بدون انتهاء" لو flag = false) |

زر "إضافة رسائل" يفتح modal:

```
┌──────────────────────────────────┐
│  إضافة رسائل لـ: <اسم العميل>   │
├──────────────────────────────────┤
│  عدد الرسائل:  [____]            │
│  مدة الصلاحية: [____] يوم        │
│  ☑ تصفير الرصيد عند انتهاء المدة │
│                                  │
│  [إلغاء]            [تفعيل]      │
└──────────────────────────────────┘
```

### Endpoint جديد

```
POST /api/admin/customers/:userId/add-messages
Auth: requireOwner (موجود)
Body: {
  messages: number,            // > 0
  days: number,                // > 0
  expireResetsQuota: boolean   // default true
}
Response: {
  success: true,
  messagesRemaining: number,
  quotaExpiresAt: ISO 8601 string,
  expireResetsQuota: boolean
}
```

### تعديل Endpoint موجود

`GET /api/admin/customers` يضيف لكل صف:

```js
{
  ...الحقول الموجودة,
  messagesRemaining: number,
  effectiveRemaining: number,        // 0 لو منتهي + flag
  quotaExpiresAt: string | null,
  expireResetsQuota: boolean,
  daysLeft: number | null,
  quotaStatus: 'active' | 'expired' | 'empty' | 'never_topped_up'
}
```

---

## 6. شاشة العميل (`dashboard/index.html`)

### في الـ Stats Bar

استبدال كارد "تكلفة AI" بكارد:

```
💬 رصيد الرسائل
   2,847
من 3,000 ▓▓▓▓▓▓▓░░ 95%
```

### القسم الرئيسي (يحلّ محل قسم "💰 تكلفة الذكاء الاصطناعي")

```
┌─────────────────────────────────────────────────┐
│  💬 رصيد الرسائل                                │
├─────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │ 2,847   │ │ 153     │ │ 22 يوم │          │
│  │ المتبقي │ │المستخدم │ │  ينتهي │          │
│  └─────────┘ └─────────┘ └─────────┘          │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░  95%                │
│  [🔄 طلب شحن رصيد]                              │
└─────────────────────────────────────────────────┘
```

### Banner عند انتهاء الرصيد

```
⚠️ انتهى الرصيد — البوت متوقف عن الرد
رصيدك الحالي: 0 رسالة
[💬 تواصل لشحن الرصيد]
```

### زر "تواصل لشحن الرصيد"

يفتح رابط واتساب:
```
https://wa.me/<SUPPORT_WHATSAPP_PHONE>?text=<مرحباً، أحتاج شحن رصيد لحسابي: <name>>
```

`SUPPORT_WHATSAPP_PHONE` متغير بيئة جديد (مثلاً `966500000000`).

### Endpoint للعميل

```
GET /api/billing/messages
Auth: requireAuth (المستخدم نفسه)
Response: {
  remaining: number,             // الرصيد الفعلي (0 لو منتهي + flag)
  totalLastTopup: number,        // آخر إضافة للنسبة المئوية
  used: number,                  // totalLastTopup - remaining
  quotaExpiresAt: string | null,
  daysLeft: number | null,
  status: 'active' | 'expired' | 'empty',
  supportWhatsappPhone: string | null
}
```

`totalLastTopup` يُقرأ من `last_topup_amount` (الذي يحدّثه `addMessagesToQuota` مع كل إضافة — راجع القسم 2).

---

## 7. حالات `messages` الجديدة

| status | السياق |
|---|---|
| `quota_exceeded` | inbound تم تجاوزها لأن الرصيد نفد (ai-worker) |
| `canceled_no_quota` | outbound تم إلغاؤها (race condition، outgoing-worker) |

### تعديل `ai-recovery.js`

لا يعيد محاولة الرسائل بحالة `quota_exceeded`:

```sql
WHERE m.status IN ('queued_for_ai', 'ai_failed')
  AND m.status NOT IN ('quota_exceeded', ...)
```

---

## 8. ما يُحذف من الـ UI

### من `dashboard/index.html`

| العنصر | السطر تقريباً |
|---|---|
| Stat "تكلفة AI" في الـ stats bar | 933 |
| قسم "💰 تكلفة الذكاء الاصطناعي" بالكامل | 1287-1308 |
| `loadCosts()`، `resetCosts()` | 2171-2196 |
| أي زر أو تبويب يرتبط بالتكاليف | يُفحص في التنفيذ |

### من `dashboard/admin.html`

إخفاء الأزرار: `grant_free`، `mark_paid`، `update_receivable` (الـ endpoints تبقى للأرشيف).

### من `src/server.js`

إزالة (لو موجود) `/api/costs` endpoint من الـ user dashboard.

---

## 9. ما يبقى للأرشيف

| العنصر | لماذا |
|---|---|
| جدول `ai_usage` | tokens + cost تاريخي — مفيد للمالك يدوياً |
| `recordUsage()` في ai-worker | يستمر يكتب في `ai_usage` (غير ظاهر للعميل) |
| أعمدة `billing_accounts` القديمة (`platform_access_status` إلخ) | البيانات السابقة محفوظة |

---

## 10. خطة التراجع (rollback)

لو حصلت مشكلة:

1. revert الـ commit من GitHub
2. الأعمدة الجديدة تبقى في DB (آمنة، لا تكسر الكود القديم)
3. الكود القديم يتجاهلها — يعمل عادي

---

## 11. الاختبارات الجديدة

| الملف | يختبر |
|---|---|
| `tests/message-quota.test.js` | `checkMessageQuota`، `decrementMessageQuota`، `addMessagesToQuota` (atomic، expiry، race) |
| `tests/ai-worker-quota.test.js` | skip عند الـ quota، علامة `quota_exceeded` |
| `tests/outgoing-worker-quota.test.js` | atomic decrement، حالة race، `canceled_no_quota` |
| `tests/admin-add-messages.test.js` | endpoint الأدمن، validation |
| `tests/dashboard-billing-messages.test.js` | endpoint العميل، `supportWhatsappPhone` |

تعديل tests موجودة:
- `tests/ai-recovery.test.js` — التأكد من تجاهل `quota_exceeded`

---

## 12. متغيرات البيئة الجديدة

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `SUPPORT_WHATSAPP_PHONE` | (فارغ) | رقم واتساب الدعم لزر "تواصل لشحن الرصيد"؛ صيغة دولية بدون `+` (مثلاً `966500000000`) |

---

## 13. النشر

1. Migration تعمل تلقائياً عند بدء السيرفر (idempotent)
2. الـ deploy على Railway من master
3. كل العملاء يبدأون بـ `messages_remaining = 0` (يحتاج الأدمن يفعّل كل واحد يدوياً)
4. الفترة الانتقالية: العميل يشوف banner "الرصيد انتهى" حتى يفعّله الأدمن

---

## 14. خارج النطاق

- إشعارات بريد إلكتروني عند انتهاء الرصيد (يمكن إضافتها لاحقاً)
- تقارير شهرية بالاستخدام (يمكن إضافتها لاحقاً)
- نظام payment integration (لا — العميل يحوّل بنكياً، الأدمن يضيف يدوياً)
- تعديل صفحة المحادثات (سبيك منفصل — Phase 2)
