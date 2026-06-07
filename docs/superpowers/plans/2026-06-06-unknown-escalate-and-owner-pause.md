# سلوك عدم المعرفة + إيقاف البوت عند تدخّل المالك — خطة تنفيذ

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. خطوات `- [ ]`.

**Goal:** (أ) التاجر يختار سلوك البوت عند عدم المعرفة (يحاول/يخبر+يصعّد/يصعّد بصمت). (ب) لما المالك يرد يدوياً، البوت يسكت عن المحادثة مدة قابلة للضبط (افتراضي 30د) لين تنتهي أو يقفلها المالك.

**Architecture:** يعيد استخدام آلية الكتم القائمة (`conversations.escalated_until` + `isConversationEscalationMuted` + تخطّي العامل عند السطر 513). نضيف: ضبط الكتم عند fromMe، إعدادات config، endpoints حقيقية، وكشف/تطبيق سلوك عدم المعرفة.

**Tech Stack:** Node v24، `node:test`، Postgres. تشغيل: `node --test`.

**مبدأ الأمان:** `unknownBehavior` الافتراضي `try_answer` و`ownerPauseMinutes` الافتراضي 30 لكن الإيقاف يُضبط فقط عند fromMe (تغيير سلوكي مقصود = إصلاح للبَق). لا تغيير على العامل (يفحص الكتم أصلاً).

---

## المكوّن ب أولاً (إيقاف المالك — إصلاح بَق إنتاج، يعيد استخدام الموجود)

### Task 1: ضبط الكتم عند رد المالك اليدوي (fromMe)
**Files:** Modify `src/services/whatsapp/message-ingest.service.js` (مسار fromMe، بعد حفظ الرسالة قرب السطر 243-245) | Test: `tests/owner-pause.test.js` (إنشاء)

- [ ] **Step 1: اختبار فاشل** — أنشئ `tests/owner-pause.test.js` يختبر دالة نقية جديدة `ownerPauseExpiry(minutes, nowMs)`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerPauseExpiry } = require('../src/services/whatsapp/message-ingest.service');

test('ownerPauseExpiry returns now+minutes as Date', () => {
  const now = 1_000_000;
  const d = ownerPauseExpiry(30, now);
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), now + 30 * 60 * 1000);
});
test('ownerPauseExpiry returns null when minutes is 0 or invalid (pause disabled)', () => {
  assert.equal(ownerPauseExpiry(0, 1000), null);
  assert.equal(ownerPauseExpiry(undefined, 1000), null);
});
```

- [ ] **Step 2: شغّل** — `node --test tests/owner-pause.test.js` → FAIL (دالة غير موجودة).

- [ ] **Step 3: نفّذ** — في `message-ingest.service.js` أضف الدالة وصدّرها:
```js
function ownerPauseExpiry(minutes, nowMs) {
  const m = parseInt(minutes, 10);
  if (!Number.isFinite(m) || m <= 0) return null;
  return new Date(nowMs + m * 60 * 1000);
}
```
ثم في مسار fromMe (بعد `recorded fromMe human reply`، حيث `saved.conversationId` متاح)، أضف ضبط الكتم — اقرأ مدة الإيقاف من config التاجر (حمّلها عبر استعلام خفيف أو دالة موجودة لتحميل bot_configs بالـuserId؛ ادرس الملف لإيجاد أنظف طريقة)، ثم:
```js
  try {
    const minutes = /* config.ownerPauseMinutes للـuserId، افتراضي 30 */;
    const expiry = ownerPauseExpiry(minutes, Date.now());
    if (expiry && saved?.conversationId) {
      await this.db.query(
        `UPDATE conversations SET escalated_until = $2 WHERE id = $1`,
        [saved.conversationId, expiry],
      );
    }
  } catch (e) { this.logger?.warn?.('owner-pause', `failed to set pause: ${e.message}`); }
```
> توجيه: ادرس كيف يحمّل الملف config (هل عنده وصول؟). إن لم يكن متاحاً بسهولة، استخدم استعلاماً مباشراً: `SELECT config->>'ownerPauseMinutes' ...` من bot_configs بالـuserId. الافتراضي 30 عند الغياب.

- [ ] **Step 4: شغّل** — `node --test tests/owner-pause.test.js` → PASS. + `node --test tests/message-ingest*.test.js` (عدم انحدار، إن وُجدت).

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): owner manual reply pauses bot via escalated_until"`

### Task 2: endpoints حقيقية للـpaused-chats (بدل الstubs)
**Files:** Modify `src/server.js:405-406` | Test: `tests/paused-chats.test.js` (إنشاء، يختبر دوال نقية)

- [ ] **Step 1: اختبار فاشل** — أنشئ دالتين نقيّتين قابلتين للاختبار في `src/controllers/` أو module جديد `src/services/bot/paused-chats.js`:
  - `listPausedChats(db, userId) → [{sender, remainingMinutes}]` (المحادثات حيث escalated_until > NOW()).
  - `resumePausedChat(db, userId, sender|null) → عدد المصفّى` (يضبط escalated_until = NULL).
  اكتب اختبارات بـdb وهمي (mock) تتحقق من الاستعلام/النتيجة.

- [ ] **Step 2: شغّل** → FAIL.

- [ ] **Step 3: نفّذ** الدالتين في `src/services/bot/paused-chats.js`، ثم في `src/server.js` استبدل السطرين 405-406 بنداء الدوال (مع requireAuth وبالـuserId من الجلسة). صدّر الدوال للاختبار.

- [ ] **Step 4: شغّل** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): real paused-chats list/resume endpoints"`

### Task 3: إعداد ownerPauseMinutes + لوحة الإيقاف في الداشبورد
**Files:** Modify `dashboard/index.html`

- [ ] **Step 1:** أضف إدخال رقمي `id="ownerPauseMinutes"` (افتراضي 30) في قسم الإعدادات؛ حمّله من `c.ownerPauseMinutes ?? 30` واحفظه في كائن الحفظ `ownerPauseMinutes: parseInt(...)||30`. (نفس نمط maxLen.)
- [ ] **Step 2:** تأكد أن لوحة `#pausedPanel` و`loadPausedChats`/resume تستدعي `/api/paused-chats` الحقيقية (موجودة في الكود، تأكد أنها تعمل مع الرد الجديد).
- [ ] **Step 3:** تحقق سلامة الصفحة: `node -e` يتأكد أن `ownerPauseMinutes` يظهر ≥3 مرات (html+load+save). + `node --test tests/dashboard-ui.test.js` لا ينكسر.
- [ ] **Step 4: Commit** — `git commit -m "feat(dashboard): ownerPauseMinutes setting + wire paused-chats panel"`

---

## المكوّن أ (سلوك عدم المعرفة — config-driven)

### Task 4: كشف عدم المعرفة + تطبيق السلوك في ai-worker
**Files:** Modify `src/workers/ai-worker.js` (بعد بناء `reply` السطر ~635، قبل/حول prepareEscalation) | Test: `tests/unknown-behavior.test.js` (إنشاء، دالة نقية)

- [ ] **Step 1: اختبار فاشل** — أنشئ دالة نقية `resolveUnknownAction({behavior, replyIsCopOut})` في module جديد `src/services/ai/unknown-behavior.js`:
```js
// يرجّع 'none' | 'acknowledge_escalate' | 'silent_escalate'
function resolveUnknownAction({ behavior, replyIsCopOut }) {
  if (!replyIsCopOut) return 'none';
  if (behavior === 'acknowledge_escalate') return 'acknowledge_escalate';
  if (behavior === 'silent_escalate') return 'silent_escalate';
  return 'none'; // try_answer (افتراضي)
}
```
اختبارات: try_answer + copout → none؛ acknowledge + copout → acknowledge؛ acknowledge + !copout → none؛ silent + copout → silent.

- [ ] **Step 2: شغّل** → FAIL. **Step 3: نفّذ** الدالة + صدّرها. **Step 4: شغّل** → PASS. **Step 5: Commit** `feat(ai): resolveUnknownAction helper`.

### Task 5: ربط السلوك في ai-worker
**Files:** Modify `src/workers/ai-worker.js`

- [ ] **Step 1:** بعد الحصول على `reply` (السطر ~635) واستيراد `isCopOut` من reply-validator و`resolveUnknownAction`:
```js
   const action = resolveUnknownAction({ behavior: config.unknownBehavior, replyIsCopOut: isCopOut(reply) });
```
- [ ] **Step 2:** 
  - `acknowledge_escalate`: لو الرد ما فيه `[تحويل:` أصلاً، حوّل `reply` إلى رسالة محترمة مع علامة تحويل: `reply = "تبشر، براجع وأرسلك بأقرب وقت. [تحويل:" + (اسم أول جهة تصعيد أو 'المالك') + "|" + ملخص قصير لرسالة العميل + "]";` — فيتكفّل `prepareEscalation` القائم بالتبليغ + ضبط الكتم.
  - `silent_escalate`: نفّذ التصعيد (نفس مسار ضبط escalated_until + تبليغ المالك الموجود) لكن **لا ترسل رد للعميل** — `return { skipped:true, reason:'silent_escalate' }` بعد التصعيد، دون enqueue للرد. (ادرس مسار prepareEscalation/التبليغ لتعيد استخدامه.)
  - `none`: لا تغيير.
- [ ] **Step 3:** شغّل اختبارات ai-worker القائمة (عدم انحدار): `node --test tests/ai-worker-store-assistant.test.js tests/ai-worker-quota.test.js tests/ai-worker-failure.test.js`.
- [ ] **Step 4:** Commit `feat(worker): apply unknownBehavior (acknowledge/silent escalate)`.

### Task 6: إعداد unknownBehavior في الداشبورد
**Files:** Modify `dashboard/index.html`
- [ ] قائمة منسدلة `id="unknownBehavior"` (try_answer/acknowledge_escalate/silent_escalate)، load من `c.unknownBehavior||'try_answer'`، save في كائن الحفظ. تحقق سلامة + commit.

---

## Task 7: إثبات + حزمة كاملة
- [ ] **إثبات حيّ:** harness يضبط `unknownBehavior='acknowledge_escalate'`، يسأل سؤالاً لا جواب له في المنتجات → الرد يحتوي "براجع/أتأكد" + `[تحويل:`. (مفتاح EVAL_API_KEY.)
- [ ] **الحزمة الكاملة:** `node --test` — الفشل البيئي runtime-bot-stability فقط مقبول.
- [ ] Commit أي ملف eval.

---

## Self-Review
- **تغطية:** المكوّن ب (Tasks 1-3): ضبط الكتم عند fromMe + endpoints + داشبورد. المكوّن أ (Tasks 4-6): كشف + تطبيق + داشبورد. إثبات (Task 7).
- **إعادة استخدام:** لا تغيير على فحص الكتم في العامل (السطر 513) — يشتغل تلقائياً. acknowledge_escalate يعيد استخدام prepareEscalation.
- **أمان:** الافتراضات تحافظ على السلوك الحالي (try_answer)؛ الإيقاف مقصود (إصلاح بَق).
- **مخاطر:** (1) قراءة config في message-ingest — تأكد من أنظف طريقة (استعلام مباشر مقبول). (2) silent_escalate يحتاج عناية: تصعيد بدون إرسال — ادرس مسار التبليغ. (3) acknowledge_escalate: تأكد أن العميل ما يجيه علامة [تحويل:] خام (prepareEscalation يزيلها — مؤكَّد من الكود القائم).
