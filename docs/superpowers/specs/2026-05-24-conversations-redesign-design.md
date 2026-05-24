# صفحة المحادثات — إعادة تصميم بصري

**التاريخ:** 2026-05-24
**الحالة:** للمراجعة
**يستبدل:** قسم `#view-conversations` الحالي في `dashboard/index.html`

---

## 1. الهدف

تحويل صفحة المحادثات من قائمة أكورديون متراصة إلى تصميم **two-pane** نظيف (مثل واتساب ويب):

- الجزء الأيمن: قائمة المحادثات + بحث فوري
- الجزء الأيسر: لوحة قراءة المحادثة المختارة بمساحة واسعة
- على الجوال (`max-width: 900px`): يتحوّل لـ accordion تلقائياً
- تمييز بصري واضح بين رسائل العميل والبوت
- عرض حالة كل رسالة وميديا الـ AI المُحلَّلة

النظام لا يضيف ميزات وظيفية جديدة كبيرة (لا live polling، لا pagination، لا tabs) — يركّز على وضوح القراءة.

---

## 2. التصميم البصري

### القائمة (الجزء الأيمن)

```
┌────────────────────────────┐
│ 🔍 [بحث بالرقم أو النص]   │
├────────────────────────────┤
│ ┌────────────────────────┐ │  ← البطاقة المختارة لها
│ │ +966512...        🟢   │ │     border-right: 3px أخضر
│ │ طلب 5234 ما وصل لي     │ │
│ │ 8 رسائل · قبل 5 دقائق  │ │
│ └────────────────────────┘ │
│ ┌────────────────────────┐ │
│ │ +966587...        ⚪   │ │
│ │ سؤال عن الشحن للإمارات │ │
│ │ 4 رسائل · أمس         │ │
│ └────────────────────────┘ │
└────────────────────────────┘
```

- نقطة 🟢 = نشطة (`status === 'ongoing'`)
- نقطة ⚪ = منتهية (`status === 'finished'`)
- البطاقة المختارة: حد أخضر يمين 3px + خلفية فاتحة
- بحث فوري **client-side** على الـ 20 المحملة (لا API call)

### لوحة المحادثة (الجزء الأيسر)

```
┌────────────────────────────────┐
│ HEADER:                        │
│   +966512345678 (رقم كامل)     │
│   عنوان الاستفسار              │
│   🟢 نشطة · آخر تحديث قبل 5د   │
├────────────────────────────────┤
│ SCROLLABLE:                    │
│   فقاعات الرسائل من فوق لتحت  │
└────────────────────────────────┘
```

### الـ Bubbles (5 ميزات مفعّلة)

| الميزة | التطبيق |
|---|---|
| **محاذاة جانبية** | عميل يمين (`background: var(--bg-soft)`), بوت يسار (`background: var(--green2); color: #fff`) |
| **timestamps** | أسفل كل فقاعة، خط 10px لون soft: `14:30` أو `أمس 14:30` أو `2026-05-22 14:30` |
| **أيقونة حالة** | لردود البوت فقط (`direction === 'outbound'`). تطابق الحالة: `sent` → ✓ ، `queued_for_send` → ⏳ ، `expired`/`canceled_no_quota` → 🚫 ، `send_failed` → ✗ . رسائل العميل بدون أيقونة. |
| **تمييز ميديا** | فقاعة بإطار dashed أزرق للصورة (🖼️) / بنفسجي للصوت (🎤) — تعرض النص المُحلَّل |
| **زر نسخ** | يظهر على hover فوق الفقاعة، ينسخ المحتوى للحافظة |

### الجوال (`max-width: 900px`)

- الـ static panel يصير `display: none`
- نقرة على بطاقة → JS يبني الـ bubbles داخل عنصر `.cv-card-body` داخل نفس البطاقة (يُحقن ديناميكياً)
- زر "إغلاق" داخل البطاقة المفتوحة يقلصها (يحذف `.cv-card-body`)
- بطاقة واحدة فقط مفتوحة في كل مرة

---

## 3. تعديلات API

### `GET /api/conversations` — حقول جديدة على الرسائل

في `src/controllers/conversations.controller.js`، دالة `normalizeMessage`:

**قبل:**
```js
{ speaker, role, direction, content, at }
```

**بعد:**
```js
{
  speaker, role, direction, content, at,
  status,          // 'sent' | 'queued_for_send' | 'expired' | 'canceled_no_quota' | 'send_failed' | 'queued_for_ai' | 'answered_by_ai' | ...
  hasMedia,        // boolean — true لو raw_payload.media موجود
  mediaKind,       // 'image' | 'audio' | 'video' | 'document' | 'ptt' | null
}
```

الـ SELECT للرسائل يضاف عليه:
```sql
SELECT conversation_id, role, direction, content, status, raw_payload, created_at
FROM messages
```

### Endpoint موسّع: `GET /api/conversations?q=<search>`

البحث server-side اختياري. لو الـ `q` موجود:
- يفلتر على `phone` (cleanCustomerPhone) أو `first_inquiry`
- استخدم `ILIKE '%' || $q || '%'` على `c.sender` و `messages.content`

```sql
WHERE c.user_id = $1
  AND (
    $q::text IS NULL
    OR c.sender ILIKE '%' || $q || '%'
    OR EXISTS (
      SELECT 1 FROM messages m2
      WHERE m2.conversation_id = c.id
        AND m2.user_id = c.user_id
        AND m2.content ILIKE '%' || $q || '%'
    )
  )
```

ملاحظة: للـ MVP، البحث client-side على الـ 20 المحملة كافٍ. الـ server-side خياري للحالة لو فاق العدد 20.

---

## 4. التعديلات على الكود

### ملفات جديدة

| الملف | المسؤولية |
|---|---|
| `dashboard/conversations.css` | كل CSS قسم المحادثات (يستخرج من inline ويُربط في `index.html`) |

### ملفات معدّلة

| الملف | التعديل |
|---|---|
| `dashboard/index.html` | استبدال `#view-conversations` بـ two-pane HTML + ربط الملف CSS الجديد + refactor JS |
| `src/controllers/conversations.controller.js` | إضافة `status` و `hasMedia` و `mediaKind` لـ `normalizeMessage` + دعم `?q=` |
| `src/routes/conversations.routes.js` (إن وجد) | تمرير `req.query.q` |

### JavaScript Functions

- `loadConversations()` — يبقى لكن payload فيه حقول جديدة
- `renderConversationList(conversations)` — جديد، يبني الـ list فقط
- `renderConversationPanel(conversation)` — جديد، يبني الـ panel
- `selectConversation(id)` — جديد، يحدّد الـ active وينقل البيانات للـ panel
- `filterConversations(query)` — جديد، فلترة client-side
- `renderBubble(message)` — جديد، يبني فقاعة واحدة (يفصل نوع الـ media)
- `formatBubbleTime(at)` — جديد، format ذكي (وقت / أمس / تاريخ)
- `copyBubble(content)` — جديد، writes للحافظة
- على mobile (`window.innerWidth <= 900`): النقر يستخدم accordion بدلاً من select

---

## 5. CSS الجديد

`dashboard/conversations.css` يحتوي:

```css
/* === Two-pane container === */
.cv-shell { display: flex; gap: 14px; height: calc(100vh - 220px); min-height: 480px; }
.cv-list { flex: 0 0 38%; overflow-y: auto; border-left: 1px solid var(--border); padding-left: 12px; }
.cv-panel { flex: 1; display: flex; flex-direction: column; }

/* === Search === */
.cv-search { position: sticky; top: 0; background: var(--panel); padding: 8px 0 12px; border-bottom: 1px solid var(--border); margin-bottom: 8px; z-index: 1; }
.cv-search input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; font-family: inherit; font-size: 13px; }

/* === List items === */
.cv-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s; }
.cv-card:hover { background: var(--bg-soft); }
.cv-card.active { border-right: 3px solid var(--green2); background: var(--green-bg); }
.cv-card .phone { font-weight: 800; font-size: 13.5px; direction: ltr; text-align: right; }
.cv-card .title { color: var(--text-soft); font-size: 12px; margin-top: 4px; line-height: 1.5; }
.cv-card .meta { color: var(--text-dim); font-size: 11px; margin-top: 6px; display: flex; justify-content: space-between; }
.cv-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; vertical-align: middle; }
.cv-dot.ongoing { background: var(--green2); }
.cv-dot.finished { background: #cbd5e1; }

/* === Panel header === */
.cv-panel-header { padding: 14px 16px; border-bottom: 1px solid var(--border); }
.cv-panel-header .phone { font-size: 18px; font-weight: 900; direction: ltr; text-align: right; }
.cv-panel-header .title { font-size: 13px; color: var(--text-soft); margin-top: 4px; }
.cv-panel-header .meta { font-size: 11.5px; color: var(--text-dim); margin-top: 6px; }

/* === Bubbles === */
.cv-bubbles { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 4px; }
.cv-bubble-wrap { display: flex; flex-direction: column; }
.cv-bubble-wrap.customer { align-items: flex-start; }
.cv-bubble-wrap.ai { align-items: flex-end; }
.cv-bubble { max-width: 72%; padding: 9px 13px; border-radius: 14px; font-size: 13px; line-height: 1.6; word-break: break-word; position: relative; }
.cv-bubble-wrap.customer .cv-bubble { background: var(--panel); border: 1px solid var(--border); border-radius: 14px 14px 14px 4px; }
.cv-bubble-wrap.ai .cv-bubble { background: var(--green2); color: #fff; border-radius: 14px 14px 4px 14px; }
.cv-bubble-time { font-size: 10.5px; color: var(--text-dim); margin: 2px 4px 8px; }
.cv-bubble-wrap.ai .cv-bubble-time { text-align: left; }
.cv-bubble-status { display: inline-block; margin-right: 4px; opacity: 0.7; }

/* === Media bubbles === */
.cv-bubble.media-image { background: #eff6ff; border: 1px dashed #93c5fd; color: #1e40af; }
.cv-bubble.media-audio { background: #fdf4ff; border: 1px dashed #d8b4fe; color: #6b21a8; }
.cv-bubble.media-other { background: #f3f4f6; border: 1px dashed #9ca3af; color: #374151; }

/* === Failed bubble === */
.cv-bubble.failed { background: #fef2f2; color: #991b1b; border: 1px solid #fca5a5; }

/* === Copy button === */
.cv-bubble-copy { position: absolute; top: 4px; left: 4px; background: rgba(255,255,255,0.9); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; font-size: 10px; opacity: 0; cursor: pointer; transition: opacity 0.15s; }
.cv-bubble-wrap.ai .cv-bubble-copy { background: rgba(0,0,0,0.2); border-color: rgba(255,255,255,0.3); color: #fff; }
.cv-bubble:hover .cv-bubble-copy { opacity: 1; }

/* === Empty / loading states === */
.cv-empty { text-align: center; color: var(--text-soft); padding: 60px 20px; font-size: 13.5px; }

/* === Mobile (accordion) === */
@media (max-width: 900px) {
  .cv-shell { display: block; height: auto; }
  .cv-list { flex: none; border: none; padding: 0; overflow: visible; }
  .cv-panel { display: none; }
  .cv-card-body { /* injected by JS on tap, contains bubbles */
    border-top: 1px dashed var(--border);
    margin-top: 12px;
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cv-card.expanded { background: var(--bg-soft); }
  .cv-card-close { background: none; border: none; color: var(--text-soft); font-size: 12px; cursor: pointer; margin-top: 8px; }
}
```

---

## 6. الاختبارات

| الملف | يختبر |
|---|---|
| `tests/conversations-controller.test.js` (موسّع) | `normalizeMessage` يعيد status/hasMedia/mediaKind |
| `tests/conversations-search.test.js` (جديد) | الـ `?q=` ينتج WHERE clause يحتوي ILIKE |
| `tests/dashboard-conversations-ui.test.js` (جديد) | regex assertions على HTML: two-pane elements، CSS classes، لا أكورديون tabs الـ tabs السابقة محذوفة |

---

## 7. ما يبقى كما هو

- ACTIVE_WINDOW_MS = 30 دقيقة (نفس التصنيف ongoing/finished)
- limit = 20 محادثة
- معدّل التحديث: 30 ثانية (setInterval)
- مسار `GET /api/conversations` نفس الـ URL

---

## 8. ما يُحذف

- `.conv-tabs` (الأزرار: الكل/مستمرة/منتهية) — نوع الفلتر صار بصرياً عبر النقطة 🟢/⚪
- `convFilter` متغيّر و `setConvFilter()` دالة
- `updateConvTabCounts()` دالة
- `.conv-item`, `.conv-head`, `.conv-body` CSS classes القديمة (تُستبدل)

---

## 9. خطة التراجع

التغيير في الـ UI فقط — لا migrations. لو حصل خطأ: revert الـ commit. الـ API change (إضافة status/hasMedia/mediaKind في normalizeMessage) backward-compatible (إضافة حقول لا تكسر).

---

## 10. متغيرات بيئة جديدة

لا يوجد.

---

## 11. خارج النطاق

- live polling أسرع من 30 ثانية
- pagination / load-more
- عرض الصور الفعلية (نعرض النص المحلَّل فقط)
- تصدير محادثة كـ PDF/TXT
- إشعارات push
