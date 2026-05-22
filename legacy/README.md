# كود قديم (Legacy) — غير مستخدم في الإنتاج

هذا المجلد يحتوي على النسخة القديمة من البوت التي كانت تعتمد على
`whatsapp-web.js` + تخزين ملفات على القرص، قبل الانتقال إلى البنية الحالية.

**الإنتاج لا يستخدم أي ملف هنا.** التشغيل الفعلي عبر `npm run start:all`
الذي يشغّل `src/server.js` + `src/workers/ai-worker.js` على محرك Baileys
وقاعدة PostgreSQL وطوابير Redis/BullMQ.

## المحتويات

| الملف | الوصف |
|------|-------|
| `index.js` | الخادم الأحادي القديم (whatsapp-web.js, تخزين JSON) |
| `ecosystem.config.js` | إعداد PM2 القديم الذي كان يشغّل `index.js` |
| `lib/connection-manager.js` | مدير اتصال whatsapp-web.js القديم |
| `lib/message-queue.js` | طابور رسائل داخل الذاكرة (قديم) |
| `lib/heartbeat.js` | مراقب نبض الاتصال القديم |
| `lib/error-handler.js` | معالج الأخطاء العام القديم |

> الوحدات المشتركة (`logger`, `constants`, `helpers`, `ai-client`, `store-scanner`)
> بقيت في `lib/` بالجذر لأن البنية الحالية في `src/` تستخدمها.

هذا الكود محفوظ للرجوع إليه فقط. لا تضِف عليه ميزات جديدة — العمل كله في `src/`.
