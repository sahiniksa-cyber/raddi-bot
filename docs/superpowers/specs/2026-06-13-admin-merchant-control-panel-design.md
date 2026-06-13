# لوحة تحكم التاجر للأدمن — وثيقة التصميم

**التاريخ:** 2026-06-13
**الحالة:** معتمدة من المستخدم، قيد التنفيذ.

## المشكلة

عند حدوث مشكلة مع تاجر معيّن ("بوتي ما يرد")، لا يملك الأدمن اليوم أي أداة لتشخيص أو إصلاح بوت ذلك التاجر عن بُعد. كل أزرار التحكم (`start/stop/restart/clearSession`) مربوطة بجلسة التاجر نفسه (`req.session.userId`). خيارات الإدارة الحالية: الطلب من التاجر، أو جراحة يدوية على قاعدة البيانات، أو إعادة نشر المنصة كاملة (تعطّل الجميع).

## الهدف

لوحة في صفحة الأدمن: الأدمن يبحث عن تاجر (رقم/إيميل/اسم) → تظهر بياناته الحيّة → يتحكم ببوته (إعادة تشغيل/ربط/إيقاف/مسح جلسة/تحرير قفل) — كل ذلك **لذلك التاجر فقط**.

## المقاربة

Controller إداري منفصل يعيد استخدام دوال `RuntimeBot` المُختبَرة، مع تمرير `userId` التاجر المستهدف من رابط المسار بدل الجلسة. **لا تُلمَس مسارات التاجر الحالية إطلاقاً** (تجنّب أي انكسار في ما يعمل).

العزل مضمون بالبناء: كل إجراء يأخذ `:userId` صريحاً → `getUserBot(userId)` يرجّع بوت ذلك التاجر وحده.

## المكوّنات

1. **Migration** — جدول `admin_audit_log` (admin_user_id, action, target_user_id, detail, result, created_at).
2. **`src/services/admin/merchant-search.js`** — `searchMerchants(query, { db, limit })`: بحث ذكي بالأرقام (whatsapp_sessions.phone / users.phone) أو نص (email/name).
3. **`src/services/admin/merchant-diagnostics.js`** — `getMerchantDiagnostics(userId, { db, getUserBot })`: الهوية + الفوترة/الرصيد + حالة الواتساب الحيّة (من `appState`) + عدّادات الرسائل (queued_for_ai/queued_for_send/ai_failed) + آخر رد + آخر سجلات. و `forceReleaseLease(userId, { db })`: مسح `connection_owner`/`connection_lease_expires_at` دون شرط المالك (لقفل عالق من نسخة ميتة).
4. **`src/services/admin/admin-audit.js`** — `logAdminAction({ adminUserId, action, targetUserId, detail, result }, { db })`.
5. **`src/controllers/admin-merchant.controller.js`** — `createAdminMerchantController({ getUserBot, database })` يرجّع: `search`, `diagnostics`, `qrImage`, `restart`, `stop`, `clearSession`, `releaseLease`. كل إجراء قوي يُسجَّل في التدقيق.
6. **مسارات** في `admin.routes.js` (خلف `requireOwner` + `requireSameOrigin` الموجودين):
   - `GET /api/admin/customers/search?q=`
   - `GET /api/admin/customers/:userId/diagnostics`
   - `GET /api/admin/customers/:userId/bot/qr-image`
   - `POST /api/admin/customers/:userId/bot/restart`
   - `POST /api/admin/customers/:userId/bot/stop`
   - `POST /api/admin/customers/:userId/bot/clear-session` (يتطلب `confirm: true`)
   - `POST /api/admin/customers/:userId/bot/release-lease`
   - `getUserBot` (async) يُمرَّر إلى `createAdminRoutes` من `server.js` — **وليس** `syncBotLookup` (الأخير يرمي لأي بوت غير محمّل في botCache، وأغلب التجار غير محمّلين). handlers الأدمن async وتعمل `await getUserBot(userId)`.
   - **أثر جانبي مقصود:** `load()` يبدأ اتصالاً تلقائياً لتاجر `desired_state='running'` فقط (مطابق لـ boot-recovery)؛ الموقوف لا يبدأ.
7. **واجهة** — قسم في `dashboard/admin.html` بنفس الستايل: خانة بحث → نتائج → بطاقة بيانات حيّة → أزرار. كل المحتوى المعروض يُهرَّب (escape) ضد XSS.

## الأمان والعزل

- كل المسارات خلف `requireOwner` (جلسة isAdmin أو role=admin) + `requireSameOrigin`.
- التحقق أن `:userId` تاجر موجود قبل أي إجراء؛ غير موجود → 404.
- `clear-session` يتطلب `confirm:true` صريح.
- كل إجراء قوي يُسجَّل في `admin_audit_log`.

## الاختبارات (TDD)

- بحث: رقم/إيميل/اسم، الحد الأقصى، لا نتيجة.
- تشخيص: تجميع صحيح، `forceReleaseLease` يمسح الأعمدة.
- controller: كل زر يستدعي دالة البوت الصحيحة بـ userId المستهدف (mock getUserBot)، userId غير موجود → 404، التدقيق يُسجَّل.
- مسارات: التركيب، رفض غير-الأدمن، تمرير getUserBot.
- تحقق نهائي: `node --test` كامل + agents متوازية للربط.

## خارج النطاق (YAGNI)

- عرض محتوى المحادثات (ملخص فقط الآن).
- استرجاع/خصم رصيد أو ربط بنكي.
