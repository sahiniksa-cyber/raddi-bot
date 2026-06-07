# تصميم: سلوك عدم المعرفة + إيقاف البوت عند تدخّل المالك

**التاريخ:** 2026-06-06 | **الحالة:** مُصادق عليه (المستخدم)

## السياق المكتشف (مهم)
- آلية الكتم موجودة وتشتغل: `isConversationEscalationMuted` (ai-worker.js:124) يفحص `conversations.escalated_until > NOW()`، والعامل **يتخطّى الرد تماماً** عند الكتم (ai-worker.js:513). التصعيد يضبط `escalated_until = NOW()+30min` (ai-worker.js:795).
- **الناقص:** رد المالك اليدوي (`fromMe`) في `message-ingest.service.js` يُسجَّل لكن **لا يضبط `escalated_until`** → البوت يقحم نفسه على رسائل العميل التالية.
- `src/server.js:405-406` endpoints الـpaused-chats مجرد stubs (ترجع فاضي/no-op)، رغم وجود لوحة في الداشبورد.

## المكوّن أ — سلوك عند عدم المعرفة (config-driven)
**الإعداد:** `config.unknownBehavior` ∈ { `try_answer` (افتراضي، السلوك الحالي), `acknowledge_escalate`, `silent_escalate` }.
**الكشف:** بعد محاولة الإصلاح الحالية في `validateAndRepair`، لو الرد النهائي `isCopOut` (تهرّب/ما يعرف) → "عدم معرفة".
**التطبيق** (في ai-worker بعد الحصول على الرد):
- `try_answer`: لا تغيير.
- `acknowledge_escalate`: الرد = رسالة محترمة ("تبشر، براجع وأرسلك") + إلصاق علامة `[تحويل:المالك|ملخص]` → يمرّ على `prepareEscalation` القائم فيُبلَّغ المالك ويُضبط الكتم (الآلية القائمة).
- `silent_escalate`: لا يُرسل رد للعميل؛ يُبلَّغ المالك فقط + يُضبط الكتم. (مسار "صعّد بدون إرسال".)
> الافتراضي `try_answer` يحفظ سلوك التجار الحاليين.

## المكوّن ب — إيقاف البوت عند تدخّل المالك (إعادة استخدام آلية الكتم)
**الإعداد:** `config.ownerPauseMinutes` (افتراضي 30، قابل للضبط؛ 0 = معطّل).
**الضبط:** في مسار `fromMe` بـ`message-ingest.service.js` (لما المالك يرد يدوياً) → `UPDATE conversations SET escalated_until = NOW() + (ownerPauseMinutes دقيقة) WHERE id = ?`. (نقرأ المدة من config التاجر.)
**التطبيق:** العامل **أصلاً** يتخطّى الرد عند `escalated_until > NOW()` (لا تغيير في العامل) → البوت يسكت تلقائياً طوال المدة.
**الاستئناف:** ينتهي الوقت تلقائياً، **أو** زر "قفلت المحادثة" → `escalated_until = NULL`.
**endpoints حقيقية** (بدل الstubs في server.js):
- `GET /api/paused-chats` → المحادثات حيث `escalated_until > NOW()` (sender + الدقائق المتبقية).
- `POST /api/paused-chats/resume` → يصفّر `escalated_until` (للكل أو لـsender محدد).
**الداشبورد:** لوحة `#pausedPanel` القائمة تُربط بالـendpoints الحقيقية + إعداد `ownerPauseMinutes`.

## معالجة الأخطاء
- `escalated_until` غير موجود (migration ما اشتغل) → fail-open (موجود أصلاً في isConversationEscalationMuted).
- ضبط الكتم عند fromMe يفشل → يُسجَّل ولا يكسر الإدخال.
- `ownerPauseMinutes = 0` → لا إيقاف (للتجار اللي ما يبون).

## الاختبار
- **وحدة:** كشف عدم المعرفة + تطبيق كل سلوك (acknowledge/silent/try)؛ منطق /api/paused-chats (list/resume) عبر db وهمي؛ حساب escalated_until من ownerPauseMinutes.
- **تكامل:** fromMe → escalated_until مضبوط؛ رسالة عميل أثناء الكتم → skip (موجود)؛ انتهاء/استئناف → يرد.
- **حيّ:** عدم معرفة → "براجع وأرسلك" + علامة تحويل.
- **عدم انحدار:** اختبارات ai-worker + escalation القائمة.

## خارج النطاق (YAGNI)
لا تغيير على منطق التصعيد الصريح القائم (طلب العميل لموظف). لا توحيد لـfindAutoReply.
