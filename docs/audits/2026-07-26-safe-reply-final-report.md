# التقرير النهائي لتقوية مسار الردود

التاريخ: 2026-07-26

فرع العمل: `codex/safe-reply-hardening`

نقطة الأساس والنسخة الاحتياطية: `70f9fd1eb6770139592bf7b12a811937fcc4deee` / `codex/backup-pre-safe-hardening-20260726`

## الخلاصة التنفيذية

- أُعيد إنتاج حادثة خلط سعر فري بيك مع أدوبي باختبار يفشل على النسخة الأساسية: الرد «أدوبي 6 أشهر بـ89 ريال، وسنة بـ139 ريال» كان يمر لأن الفاحص كان يجمع الأرقام من كتالوج المتجر كله.
- السبب لم يكن اختلاط محادثات أو عملاء؛ كان خلط حقائق بين منتجات المتجر نفسه داخل التحقق الرقمي والسياق المرسل للنموذج.
- أُصلح التحقق ليطابق الادعاء كوحدة واحدة: `product_id + plan + duration + price + currency + availability`.
- عند وضوح المنتج لا يصل للنموذج إلا هذا المنتج. وعند غموضه تُحجب الأسعار ويُطلب توضيح مختصر.
- أضيف فحص حتمي بعد كل إصلاح وعند حد الإرسال، ولا يستطيع تقييم النموذج تجاوز فشل برمجي.
- أُعيدت حمايات الكلمات والعبارات الممنوعة، ومنع كشف الهوية الآلية، وإزالة اسم الموظف غير المفعّل، وحدود الرد القصير، ومنع الصمت بسبب تكرار بسيط.
- أضيفت نسخ تاريخية غير قابلة للتعديل لكتالوج المنتجات، وسجل مراحل رد منقح من الأسرار بمدة احتفاظ 30 يومًا.
- أضيف نطاق صريح للمتجر والقناة والمحادثة والعميل إلى مفاتيح الطوابير، وإلى جلب السياق، ومراجعة ما قبل الإرسال، ومنع تكرار الرسالة.
- آخر تشغيل كامل على الشجرة النهائية: `1502 passed, 0 failed` خلال 32.2 ثانية.
- لم يُنشر شيء على الإنتاج، ولم تُطبق migrations، ولم تُعدل بيانات حقيقية.

## الحكم الواضح بشأن اختلاط المحادثات

في مسار واتساب الذي فُحص واختُبر: **لم نتمكن من إحداث اختلاط محادثات أو إعدادات أو منتجات بين العملاء أو المتاجر**. اختبار 20 عميلًا متزامنًا واختبار متاجر متعددة أثبتا بقاء الرسائل والأسعار والكلمات الممنوعة والشخصية والنبرة والكتالوج داخل النطاق الصحيح.

هذا لا يعني ضمانًا مطلقًا لكل بنية خارجية لم تُشغل محليًا. لم تُستخدم اتصالات الإنتاج الحقيقية بقاعدة البيانات وRedis وواتساب التزامًا بمنع لمس الإنتاج. أمّا الحادثة المصورة فهي ليست اختلاط عملاء؛ هي خلط بين صفوف منتجات داخل كتالوج المتجر نفسه، وقد أُعيد إنتاجها ثم منعها حتميًا.

## الأسباب الجذرية والمشاكل

### مشاكل حرجة

| المشكلة | السبب الجذري | موضع السبب/الإصلاح | الإصلاح | الاختبار المثبت |
|---|---|---|---|---|
| ربط سعر منتج بمنتج آخر | تجميع كل الأرقام في الكتالوج وقبول الرقم منفصلًا عن المنتج والخطة والمدة | `src/services/ai/product-claim-validator.js:85`, `:177`, `:219` و`src/services/products/product-facts.js:129` | استخراج ادعاءات تجارية ومطابقتها مع سجل واحد ذي `product_id` ثابت | `tests/product-claim-validator.test.js`, `tests/product-facts.test.js`, `tests/safe-reply-simulation.test.js` |
| تمرير منتجات غير مرتبطة للنموذج | بناء السياق من كتالوج كامل بلا حسم منتج | `src/services/products/product-facts.js:159`, `:172` و`lib/ai-client.js:284` | تحديد المنتج من الرسالة والسياق، وتمرير المنتج المحدد فقط؛ بلا سعر عند الغموض | `tests/ai-product-context-scope.test.js` |
| قدرة المراجعات المتعاقبة على محو تعارض سابق | نتيجة لاحقة كانت تستطيع إظهار ثقة كاملة وقائمة ادعاءات فارغة رغم اكتشاف سابق | `src/services/ai/final-reply-pipeline.js:13`, `:24`, `:38` | حمل الأخطاء السابقة، إصلاح حتمي واحد كحد أقصى، ثم إعادة جميع الفحوص؛ الفشل يمنع الإرسال | `tests/final-reply-pipeline.test.js`, `tests/reply-quality-gate.test.js` |
| إرسال رد غير متحقق أو مكرر عند retry | لم تكن هناك حالة رد ملزمة ولا معرف تسليم ثابت في كل المسار | `src/services/ai/reply-state-machine.js:20`, `:34`; `src/workers/outgoing-whatsapp-worker.js:493`, `:701`, `:982`; `src/queues/message-queue.js:48` | آلة حالات، شرط `queued_for_send + validated`، مفتاح مهمة شامل النطاق، ومعرف WhatsApp حتمي | `tests/reply-state-machine.test.js`, `tests/outgoing-pre-send-gate.test.js`, `tests/outgoing-deterministic-delivery-id.test.js`, `tests/queue-scope-keys.test.js` |
| احتمال تصادم معرف رسالة مزود بين قنوات المتجر | فهرس التفرد السابق لم يتضمن القناة | `src/db/migrations/init.js:225`, `src/services/whatsapp/message-ingest.service.js:104`, `:149` | التفرد أصبح `(user_id, channel_id, provider_message_id)` | `tests/message-provider-scope-migration.test.js`, `tests/message-ingest-idempotency.test.js` |

### مشاكل متوسطة

| المشكلة | السبب الجذري | موضع السبب/الإصلاح | الإصلاح | الاختبار المثبت |
|---|---|---|---|---|
| `avoidWords` و`avoidPhrases` لا يطبقان كاملين | الرجعة أزالت الدمج والفحص البرمجي واعتمدت أكثر على البرومبت | `lib/post-process-reply.js:67`, `:110`, `:147`, `:265` | دمج الافتراضي والخاص وإزالة التكرار، وفحص اختلافات المسافات والترقيم والعربية والإنجليزية | `tests/post-process-reply.test.js`, `tests/ai-identity.test.js` |
| كشف أن الرد آلي | غياب قائمة افتراضية ملزمة بعد الرجعة | `lib/post-process-reply.js:67`, `:93`, `:147` | منع AI/ذكاء اصطناعي/روبوت/بوت/نموذج/نظام آلي برمجيًا إلا بسماح صريح | `tests/ai-identity.test.js`, `tests/post-process-reply.test.js` |
| ذكر «محمد» أو تقمص اسم موظف | الاسم كان يُحقن بوصفه شخصية بلا تفعيل صريح | `lib/ai-client.js:277`, `lib/post-process-reply.js:132` | الاسم اختياري لكل متجر ولا يُحقن أو يُسمح بتقمصه إلا عند `employeeNameEnabled=true` | `tests/ai-identity.test.js` |
| الرد القصير بقي توجيهًا لينًا | لا يوجد حد برمجي للجمل والأسطر مع اختصار آمن | `src/services/ai/reply-validator.js:40`, `:58`, `:68` | حدود أحرف/جمل/أسطر، اختصار عند نهاية جملة، وحماية الحقائق والروابط ثم إعادة الفحص | `tests/reply-length-policy.test.js` |
| فاحص التكرار يترك العميل بلا رد | كان suppression يُستخدم حتى مع وجود سؤال عميل جديد | `lib/ai-client.js:245`, `src/workers/ai-worker.js:1181` | لا يصمت عند دور عميل جديد؛ يحذف/يعيد صياغة التكرار، ويقصر suppression على إعادة إرسال مطابقة بلا رسالة عميل جديدة | `tests/ai-worker-no-duplicate-rephrase.test.js`, `tests/integration-week1-live-scenarios.test.js` |
| لا يمكن إثبات الكتالوج وقت الرد | تخزين الحالة الحالية فقط | `src/db/migrations/init.js:1080`, `src/services/products/catalog-version-repository.js:39` | نسخ immutable بالقيمة القديمة والجديدة والمعدل والسبب والوقت والإصدار؛ التحديث والإصدار في transaction واحدة | `tests/catalog-version-migration.test.js`, `tests/catalog-version-repository.test.js` |
| لا يوجد أثر كامل لمراحل الرد | عدم حفظ المسودة والمراجعات والنسخة النهائية بإصدار القواعد | `src/db/migrations/init.js:1110`, `src/services/ai/reply-trace-repository.js:84`, `:130`, `:158` | سجل منقح مرتبط بالنطاق ومعرف العملية وإصدارات البرومبت والفاحص والكتالوج ومراحل الإرسال | `tests/reply-trace-migration.test.js`, `tests/reply-trace-repository.test.js`, `tests/reply-trace-integration.test.js` |
| مدة الاحتفاظ كانت قابلة لأن تصبح وصفية فقط | وجود `retention_until` وحده لا يحذف السجلات | `src/services/ai/reply-trace-repository.js:84`, `:186` | تنظيف حتى 1000 سجل منتهي مع كل كتابة جديدة، مع دالة تنظيف صريحة | `tests/reply-trace-repository.test.js` |

### مشاكل بسيطة

| المشكلة | السبب الجذري | موضع الإصلاح | الإصلاح/الدليل |
|---|---|---|---|
| مؤقت إرسال يبقى فعالًا بعد نجاح الإرسال | timeout لم يكن يُلغى | `src/workers/outgoing-whatsapp-worker.js` ضمن غلاف الإرسال | إلغاء المؤقت و`unref`؛ يغطيه كامل اختبارات worker |
| أسماء عامة مثل «اشتراك» أو «سنة» قد تربط منتجًا خطأ | مطابقة نصية واسعة | `src/services/products/product-facts.js:159`, `src/services/products/product-knowledge.js` | aliases مرتبطة بمعرف ثابت، والكلمات العامة لا تحسم المنتج وحدها |
| إنشاء نسخ كتالوج مكررة بلا تغيير | كل حفظ كان يمكن أن ينتج نسخة جديدة | `src/services/products/catalog-version-repository.js:39` | مقارنة آخر snapshot وإعادة نفس الإصدار عند عدم التغيير | `tests/catalog-version-repository.test.js` |

## تدقيق الرجعة 70f9fd1

الرجعة غيّرت 12 ملفًا وأضافت 85 سطرًا وحذفت 2355 سطرًا. أزالت بالخطأ حمايات غير مرتبطة بالتصعيد، منها:

1. تطبيق `avoidWords` و`avoidPhrases`.
2. منع كشف الهوية الآلية.
3. فرض الرد القصير.
4. منع استرجاع النص المحظور بعد أن يصبح الرد فارغًا.
5. فحوص ادعاءات غير رقمية واختبارات مرتبطة بها.

وفي الوقت نفسه أزالت منطق تصعيد كان يسبب تحويلات كاذبة عند نقص معلومة أو انخفاض ثقة النموذج. لذلك لم يُعكس commit كاملًا. استُعيدت الحمايات المفيدة فقط، ولم يُستعد التصعيد لمجرد `missing_product_fact` أو metadata النموذج أو الاعتراض الطبيعي على السعر.

التفصيل الكامل قبل/بعد وما استُعيد وما تُرك موجود في `docs/audits/2026-07-26-70f9fd1-rollback-audit.md`.

## السلوك قبل الرجعة وبعدها وبعد الإصلاح

| الحالة | قبل `70f9fd1` | بعد `70f9fd1` | الفرع الحالي |
|---|---|---|---|
| الكلمات المحظورة والهوية الآلية | حماية أفضل | تراجعت | حماية برمجية مدمجة |
| التصعيد | حساس ويحوّل أسئلة طبيعية | أخف | فصل صريح بين سؤال طبيعي وحالة بشرية |
| ربط السعر بالمنتج | غير صحيح | غير صحيح | مطابقة tuple كاملة |
| سياق المنتجات | واسع | واسع | المنتج الحالي فقط |
| إعادة الفحص بعد repair | غير حتمية | غير حتمية | إلزامية وحد أقصى محاولة واحدة |
| التتبع وإصدار الكتالوج | غير موجود | غير موجود | موجودان وقابلان للتدقيق |

## الحمايات المستعادة أو المضافة

- دمج قائمة المنع الافتراضية والخاصة للتاجر.
- تطبيق الكلمات والعبارات في آخر نص قبل الإرسال.
- منع كشف الهوية الآلية.
- منع اسم موظف غير مفعّل.
- حدود رد قصيرة قابلة للإعداد.
- إزالة التكرار دون صمت عن سؤال جديد.
- مطابقة المنتج والخطة والمدة والسعر والعملة والتوفر كوحدة واحدة.
- حمل نتائج الفحوص السابقة وعدم السماح لمراجعة لاحقة بمحوها.
- إعادة كل الفحوص بعد repair.
- بوابة إرسال لا تقبل ردًا آليًا بلا تحقق حتمي.
- نطاق المتجر والقناة والمحادثة والعميل في الطوابير والسياق والتدقيق.
- منع duplicate webhook وretry من إنشاء ردين.
- إصدار immutable لإعدادات المنتجات وسجل مراحل منقح.

## الملفات المعدلة

### كود التشغيل والترحيلات

`.env.example`, `lib/ai-client.js`, `lib/constants.js`, `lib/post-process-reply.js`,
`scripts/simulate-safe-replies.js`, `src/controllers/config.controller.js`,
`src/db/migrations/init.js`, `src/queues/message-queue.js`,
`src/services/ai/final-reply-pipeline.js`, `src/services/ai/pre-send-review.js`,
`src/services/ai/product-claim-validator.js`, `src/services/ai/reply-quality-gate.js`,
`src/services/ai/reply-state-machine.js`, `src/services/ai/reply-trace-repository.js`,
`src/services/ai/reply-validator.js`, `src/services/bot/platform-features.js`,
`src/services/bot/runtime-bot.js`, `src/services/products/catalog-version-repository.js`,
`src/services/products/product-facts.js`, `src/services/products/product-knowledge.js`,
`src/services/prompt-edit/prompt-edit.service.js`,
`src/services/whatsapp/message-ingest.service.js`, `src/workers/ai-worker.js`,
`src/workers/outgoing-whatsapp-worker.js`.

### اختبارات

`tests/ai-identity.test.js`, `tests/ai-product-context-scope.test.js`,
`tests/ai-prompt-rules.test.js`, `tests/ai-worker-no-duplicate-rephrase.test.js`,
`tests/catalog-version-migration.test.js`, `tests/catalog-version-repository.test.js`,
`tests/conversation-isolation-20-clients.test.js`,
`tests/cx-escalation-leak-and-double-send.test.js`,
`tests/final-reply-pipeline.test.js`,
`tests/integration-week1-live-scenarios.test.js`,
`tests/message-ingest-idempotency.test.js`,
`tests/message-provider-scope-migration.test.js`,
`tests/multi-tenant-product-isolation.test.js`,
`tests/outgoing-deterministic-delivery-id.test.js`,
`tests/outgoing-pre-send-gate.test.js`,
`tests/outgoing-records-whatsapp-id.test.js`,
`tests/outgoing-worker-quota.test.js`, `tests/owner-pause-lid-path.test.js`,
`tests/post-process-reply.test.js`, `tests/pre-send-review.test.js`,
`tests/pre-send-wiring.test.js`, `tests/product-claim-fuzz.test.js`,
`tests/product-claim-validator.test.js`, `tests/product-facts.test.js`,
`tests/queue-scope-keys.test.js`, `tests/reply-length-policy.test.js`,
`tests/reply-quality-gate.test.js`, `tests/reply-state-machine.test.js`,
`tests/reply-trace-integration.test.js`, `tests/reply-trace-migration.test.js`,
`tests/reply-trace-repository.test.js`, `tests/safe-reply-simulation.test.js`.

### توثيق وملفات رجوع

`docs/audits/2026-07-26-70f9fd1-rollback-audit.md`,
`docs/superpowers/specs/2026-07-26-safe-reply-pipeline-design.md`,
`docs/superpowers/plans/2026-07-26-safe-reply-pipeline.md`,
`docs/migrations/rollback-ai-reply-traces.sql`,
`docs/migrations/rollback-message-provider-scope.sql`,
`docs/migrations/rollback-product-catalog-versions.sql`.

## الاختبارات الجديدة ونتائجها

### إعادة إنتاج الخطأ

- اختبار الحادثة يمرر كتالوج أدوبي (4 أشهر/189، 8 أشهر/319) وفري بيك (6 أشهر/89، سنة/139).
- على النسخة الأساسية فشل الاختبار لأن «أدوبي 6 أشهر بـ89» عُدّت صحيحة.
- بعد الإصلاح يرفض 6/89 و12/139 و8/289 لأدوبي، ويقبل فقط 4/189 و8/319.

### طبقات الاختبار

- Unit: tuples، aliases، التوفر، الأسعار، المدد، القوائم الممنوعة، الهوية، الطول، الحالات.
- Integration: توليد الرد ثم review ثم pre-send ثم state gate.
- Regression: حادثة أدوبي/فري بيك، اسم محمد، كشف AI، الصمت بسبب التكرار، إصلاح بلا إعادة فحص.
- Concurrency: 20 عميلًا ومتاجر متعددة بإعدادات وأسعار ونبرات مختلفة.
- Property/fuzz: 500 ادعاء حتمي بأسعار ومدد وأسماء بديلة مختلفة.
- E2E shadow simulation: 41 سيناريو محادثة بلا إرسال حقيقي.

### نتائج المحاكاة

| المؤشر | النتيجة |
|---|---:|
| السيناريوهات | 41 |
| الردود الآمنة الناتجة | 41 |
| المسودات الخطرة التي اعتُرضت | 7 |
| إصلاحات حتمية من الكتالوج | 5 |
| أسئلة توضيح آمنة | 2 |
| إرسال واتساب فعلي | 0 |
| حالات الفشل | 0 |
| التطابق البرمجي | 100% |
| حالات fuzz | 500 |

أمثلة:

- قبل: `أدوبي 6 أشهر بـ89 ريال، والسنة بـ139 ريال`.
- بعد: `أدوبي متوفر 4 أشهر بـ189 ريال أو 8 أشهر بـ319 ريال. ما عندنا خطة سنة حاليًا.`
- قبل عند الغموض: ذكر سعر من كتالوج غير محدد.
- بعد: `تقصد أي منتج؟` بلا سعر.

## أوامر التحقق

```powershell
$env:NODE_ENV='test'
$env:DATABASE_URL=''
$env:REDIS_URL=''
$env:REPLY_TRACE_ENABLED='false'
npm test
node scripts/simulate-safe-replies.js
git diff --check
git status --short
```

إفراغ `DATABASE_URL` و`REDIS_URL` مقصود لمنع أي اتصال بالإنتاج.

## diff منظم لأهم التغييرات

| المجموعة | حجم/طبيعة التغيير |
|---|---|
| حقائق المنتجات | كتالوج منظم + تحديد منتج + aliases ثابتة |
| فحص الادعاءات | استخراج ومطابقة tuple كاملة |
| خط الرد النهائي | فحص حتمي + repair واحد + إعادة فحص |
| الأسلوب والهوية | قوائم منع مدمجة + اسم اختياري + طول ملزم |
| العزل والتزامن | مفاتيح queue تشمل 4 معرفات + provider uniqueness بالقناة |
| التدقيق | جدول traces منقح + 30 يومًا + تنظيف فعلي |
| نسخ الكتالوج | snapshots immutable وتحديث ذري |
| الإرسال | state gate + deterministic delivery ID + retry idempotency |

إجمالي الفرق من `70f9fd1` قبل إضافة هذا التقرير: 62 ملفًا، 4271 سطرًا مضافًا و145 محذوفًا. لم تُستبدل منظومة التصعيد القديمة كاملة ولم يُعكس commit بصورة عمياء.

## المخاطر والحالات غير المضمونة

1. لم تُشغل migrations على PostgreSQL حقيقي أو بيئة staging لأن المتاح محليًا لا يحتوي بيانات اعتماد آمنة، ولأن لمس الإنتاج ممنوع.
2. لم يُرسل WhatsApp حقيقي؛ المحاكاة وصلت حتى حد الإرسال وأثبتت أن عدد الإرسالات الفعلية صفر.
3. جودة الصياغة الدلالية للنموذج احتمالية بطبيعتها، لكن الأسعار والمدد والتوفر والكلمات المحظورة والطول وحالة الإرسال أصبحت حواجز برمجية.
4. عند نجاح مزود خارجي ثم انقطاع الاتصال قبل استلام الإيصال تبقى هناك نافذة “نتيجة غير معلومة”. مسار Baileys يستخدم معرف تسليم حتمي لتقليل التكرار عند retry، لكن يلزم اختبار staging مع المزود نفسه.
5. `REPLY_TRACE_ENABLED` بقي `false` افتراضيًا إلى أن تُطبق migration ويبدأ shadow rollout. لذلك الإنتاج الحالي، الذي لم يُنشر عليه هذا الفرع، لا يملك سجل المراحل الجديد.
6. اختبارات العزل تستخدم قواعد البيانات والطوابير عبر seams محلية حقيقية للكود، لا بنية Railway الحية. اختبار staging المتزامن يبقى شرطًا قبل الإطلاق.

## حالة الإنتاج

**لم يتم النشر.**

**لم تُطبق migrations.**

**لم تُعدل أو تُحذف أي بيانات حقيقية.**

الإنتاج ما زال على سلوكه السابق؛ لذلك لا يجوز اعتبار حادثة خلط أسعار المنتجات معالجة على الإنتاج إلى أن تُنفذ خطة الإطلاق بعد موافقة صريحة.
