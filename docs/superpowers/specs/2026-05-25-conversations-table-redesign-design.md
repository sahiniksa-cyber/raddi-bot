# Conversations Page Redesign — Table Layout

**Date:** 2026-05-25
**Status:** Approved

---

## المشكلة

صفحة المحادثات الحالية تستخدم cards عمودية، الـ mockup المطلوب يستخدم **جدول صريح بأعمدة محددة** + لوحة محادثة بـ chat bubbles كاملة. الـ design الحالي ما يطابق الـ mockup.

---

## الهدف

إعادة بناء صفحة المحادثات لتطابق الـ mockup المرسل:
- جدول قائمة المحادثات بـ 3 أعمدة + avatar
- لوحة محادثة كاملة على اليسار: header (avatar + اسم + متصل) + bubbles + footer input
- بحث في الأعلى
- تصميم RTL نظيف بألوان خضراء (whatsapp theme)

---

## التصميم البصري (matching the mockup)

### Layout الكلي

```
┌──────────────────────────────────┬──────────────────────────────────┐
│                                  │  💬 صفحة المحادثات                │
│   ╳   🎥 📞  ⋮          أحمد محمد │                                  │
│        ●                  ●       │  🔍 [بحث عن محادثة...]            │
│                          ────────│                                  │
│   اليوم                          │  ┌──────┬───────────┬──────────┐ │
│                                  │  │ اسم  │ رقم جوال  │  متى     │ │
│       السلام عليكم               │  │ العميل│ العميل   │ أرسل     │ │
│       10:30 ص                    │  ├──────┼───────────┼──────────┤ │
│                                  │  │ 👤 +966│+966 50…  │ 10:33 ص │ │← active
│  وعليكم السلام                   │  │   ●   │          │          │ │
│  10:31 ص                         │  ├──────┼───────────┼──────────┤ │
│                                  │  │ 👤 +966│+966 55…  │ 9:15 ص  │ │
│   عندي استفسار                   │  ├──────┼───────────┼──────────┤ │
│   10:32 ص                        │  │ 👤 +966│+966 53…  │ أمس 8:45│ │
│                                  │  ├──────┼───────────┼──────────┤ │
│  أكيد، تفضل                      │  │ 👤 +966│+966 54…  │ أمس 6:20│ │
│  10:32 ص                         │  └──────┴───────────┴──────────┘ │
│                                  │                                  │
│  ─────────────────────────       │                                  │
│  😊 📎 [اكتب رسالة...]    🎤    │                                  │
└──────────────────────────────────┴──────────────────────────────────┘
```

### Right pane (قائمة المحادثات)

- **Title**: "💬 صفحة المحادثات" أعلى يمين
- **Search input**: input مع 🔍 placeholder "بحث عن محادثة..."
- **Status filter tabs (مخفية افتراضياً)**: نبقي tabs الموجودة (الكل/جارية/منتهية) فوق الجدول، أو نشيلها لو الـ mockup ما فيها — **نشيلها** ليطابق الـ mockup
- **Table** مع:
  - **Header row** (gray background, sticky): `اسم العميل` | `رقم جوال العميل` | `متى أرسل العميل`
  - **Data rows**: 
    - عمود 1: `avatar circle` (placeholder 👤 رمادي) + الرقم + `online dot` لو ongoing
    - عمود 2: الرقم formatted (`+966 50 123 4567`) أو "غير متوفر"
    - عمود 3: الوقت ("10:33 ص"، "أمس 8:45 م"، "12/05/2024")
  - **Selected row**: خلفية خضراء فاتحة (#f0fdf4) + خط يمين أخضر (3px solid #10b981)
  - **Hover**: خلفية رمادية فاتحة (#f8fafc)

### Left pane (لوحة المحادثة)

- **Header bar**:
  - يمين: avatar + اسم العميل + "متصل الآن" / "آخر ظهور قبل ..." حسب الـ status
  - يسار: 3 أزرار icon — ⋮ ، 📞 (call placeholder)، 🎥 (video placeholder). الأزرار **decoration only** (لا onClick).
- **Body**:
  - خلفية whatsapp pattern (light gray)
  - separator "اليوم" في الوسط بـ pill style
  - bubbles:
    - **رسائل العميل** (الـ user): يسار، خلفية بيضاء، حواف مدورة
    - **رسائل البوت** (assistant/outbound): يمين، خلفية أخضر فاتح (#e7f5e7)، حواف مدورة
    - كل bubble: نص + وقت صغير تحت
  - status ticks ✓✓ على رسائل البوت (decoration)
- **Footer**:
  - input "اكتب رسالة..." (decoration only — لا send)
  - أيقونات: 😊 emoji، 📎 paperclip، 🎤 microphone (kلها decoration)

### الألوان

- Primary green: `#10b981` (نفس الموجود)
- Active row background: `#f0fdf4`
- User bubble: `#ffffff` مع `box-shadow: 0 1px 2px rgba(0,0,0,0.08)`
- Bot bubble: `#dcf8c6` (whatsapp-like)
- Body bg: `#efeae2` (whatsapp pattern light)
- Header bg: `#f0f2f5`

---

## التحويلات (Backend → Frontend)

### Frontend helper جديد: `formatSaudiPhone(digits)`

```js
function formatSaudiPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return '';
  // 966XXXXXXXXX → +966 5X XXX XXXX
  if (digits.startsWith('966') && digits.length >= 12) {
    const tail = digits.slice(3);
    if (tail.length === 9) {
      return `+966 ${tail.slice(0,2)} ${tail.slice(2,5)} ${tail.slice(5)}`;
    }
  }
  return `+${digits}`;
}
```

استخدام:
- عمود `اسم العميل` و `رقم جوال العميل` كلاهما يعرض `formatSaudiPhone(c.phoneNumber)` لو موجود
- لو ما فيه `phoneNumber` (lid case): "عميل (رقم غير متوفر)"

### Time formatter جديد: `formatConvDate(value)`

نعيد استخدام `formatConvTime` الموجود — لكن نضمن أنه يرجع:
- "10:33 ص" لليوم
- "أمس 8:45 م" لأمس
- "12/05/2024" للأقدم

(الـ formatter الحالي يطابق هذا تقريباً — نتأكد فقط.)

---

## ملفات تتغير

| الملف | التغيير | حجم |
|---|---|---|
| `dashboard/index.html` | إعادة كتابة `renderConversationList` كـ table بدل cards + `renderConversationPanel` بـ header كامل + footer input + `formatSaudiPhone` helper | كبير |
| `dashboard/conversations.css` | إعادة كتابة بالكامل — table styles، avatar styles، new bubble colors، header bar، footer input bar | كبير |
| `tests/conversations-controller.test.js` | يبقى كما هو (لا تغيير في API) | لا تغيير |

**صفر تغييرات في:**
- `src/controllers/conversations.controller.js` (الـ API payload يحتوي على كل ما نحتاج)
- DB schema
- AI worker، queues، Baileys

---

## Backwards-compat

- الـ `/api/conversations` endpoint والـ payload **بدون تغيير**
- الـ `cleanCustomerPhone` (الـ "عميل ····0304") **يتم تجاوزه** في الـ frontend — نعرض `phoneNumber` مباشرة بـ `formatSaudiPhone` لو موجود، وإلا "غير متوفر"
- الـ status filter tabs والـ search filter يبقون شغالين (نخلي tabs كـ select بدل buttons — أنظف وأقل مساحة)

---

## Out of scope

- **Calls / video buttons**: decoration only (لا backend)
- **Sending messages from dashboard**: input في الـ footer decoration فقط
- **Avatar images**: placeholder 👤 emoji أو circle رمادي — لا upload
- **pushName من Baileys**: مستخدم اختار يعرض الرقم فقط، فلا حاجة لـ DB schema change
- **Escalation dedup**: مشروع F1 منفصل، سيأتي لاحقاً

---

## الاختبارات

ما عندنا frontend testing framework. الـ verification:
- **يدوي**: نفتح dashboard بعد deploy ونتأكد:
  - الجدول يطابق الـ mockup
  - الـ active row highlighted
  - chat panel header + bubbles + footer كلها تظهر
  - Search يفلتر القائمة
- **Smoke test في الـ tests**: تأكد أن `formatSaudiPhone` يعمل على inputs مختلفة (لو فصلناها في ملف separate JS — لكن YAGNI، نتركها inline)

---

## الـ behavior summary

| الإجراء | السلوك |
|---|---|
| فتح الصفحة | يحمل الـ list من `/api/conversations` ويعرضها كجدول |
| النقر على صف | يحدد الصف (خلفية خضراء + خط) + يفتح المحادثة في اللوحة اليسرى |
| البحث | يفلتر الصفوف client-side حسب الرقم أو نص الـ first inquiry |
| Mobile (<900px) | accordion-style كما الموجود (نحتفظ بالـ media query للمحمول) |
| العميل بدون phoneNumber | الرقم في العمودين = "عميل قديم" (matching dashboard badge); avatar بدون dot أخضر |
