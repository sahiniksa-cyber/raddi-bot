# محرّك حالة المحادثة العام (Generic Conversation State Engine) — تصميم

**التاريخ:** 2026-08-13
**الفرع:** `claude/multi-tenant-platform-architecture-9bdab6`
**النطاق:** المرحلة الأولى من إعادة تأسيس منصة Multi-Tenant. هذه الوثيقة تغطّي محرّك حالة المحادثة فقط. (نموذج توافق الدفع، إزالة الـhardcoding من المُطابِقات المشتركة، وثغرة نطاق الطابور = مراحل لاحقة مستقلّة، خارج هذه الوثيقة.)

---

## 1. المشكلة الجذرية

المنصة تخدم عدّة متاجر/قطاعات (تجارة، حجوزات، برامج، خدمات...). المتجر = صفّ `users` واحد؛ `user_id` هو مفتاح الـtenant الوحيد (تاجر = بوت = جلسة واتساب واحدة).

الذاكرة الوحيدة للمحادثة حاليًا هي **النص الخام** لآخر ~50 رسالة، يُعاد تمريره للـLLM كل دورة. لا يوجد أي تمثيل منظّم للحالة. هذا الغياب الواحد هو الجذر المشترك لأربع فئات أعطال ظهرت في محادثات حقيقية (كلها Regression Cases، لا حالات تُحلّ فرديًّا):

- **لا تتبّع حلّ:** يعيد اقتراح خطوة أكّد العميل نجاحها ("دخلت"، "وصل"، "اشتغل").
- **لا تتبّع موضوع/كيان نشط:** لا ينتقل بوضوح من مشكلة محلولة إلى مشكلة جديدة مفتوحة.
- **تكرار نصّي لا معنوي:** المقارنة الحالية Jaccard على الحروف؛ إعادة الصياغة تمرّ.
- **لا حماية Stale معنوية:** رسالة عميل جديدة أثناء زمن التوليد لا تُبطل الرد القديم.

**معيار القبول الحاكم:** نفس المعمارية تمنع نفس المشكلة عند أي متجر/قطاع جديد لم يكن موجودًا وقت كتابة الكود. **ممنوع أي منطق مخصّص لمتجر/منتج/طريقة دفع بعينها** — كل المفردات مجرّدة.

---

## 2. المبادئ الحاكمة (قيود ملزمة)

1. **عمومية مطلقة:** كائن الحالة يستخدم خانات مجرّدة (`open_issues`, `resolved_issues`, `active_topic`, `active_entity`, `known_facts`, `customer_goal`, `actions_attempted`). لا enum لأنواع القطاعات. "المشكلة" شيء عام: دخول، شحنة، حجز، دفع، اشتراك، فاتورة، عطل تقني — المحرّك لا يعرف نوعها.
2. **عزل tenant صريح:** كل استعلام DB يحمل `user_id = $n` نصًّا (لا اعتماد ضمني على تفرّد `conversation_id`). كل مفتاح كاش/قفل يُسبَق بـ`userId`. كل دالة عامّة تأخذ `userId` صراحة. FK مركّب على مستوى الschema (defense-in-depth).
3. **Fail-soft:** فشل/مهلة الاستخراج لا يوقف الرد أبدًا، **ولا يُعرَض الحالة القديمة كحقيقة مؤكدة**. عند عدم توفّر حالة حديثة تعكس الرسائل الجارية، نتراجع للسلوك الحالي (نص المحادثة فقط) لتلك الدورة.
4. **الـLLM ليس مصدر الحقيقة للحالة النظامية:** الاستخراج يملأ المنطقة الدلالية فقط. الحالة النظامية (handoff من `escalation_threads`، نتائج تنفيذ الأدوات من سجلّها) تأتي دائمًا من السجلّات الرسمية؛ عند التعارض تفوز النظامية.
5. **إطلاق تدريجي:** كل قدرة خلف مفتاح مستقل، مطفأة افتراضيًا. التمكين على شرائح.
6. **إضافي غير كاسر:** كل المفاتيح مُطفأة = السلوك الحالي حرفيًا (legacy path سليم).

---

## 3. نموذج البيانات

### جدول جديد `conversation_states`

```sql
CREATE TABLE IF NOT EXISTS conversation_states (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL,
  channel_id       TEXT NOT NULL DEFAULT 'whatsapp',
  sender           TEXT NOT NULL,
  state            JSONB NOT NULL DEFAULT '{}'::jsonb,
  state_version    INTEGER NOT NULL DEFAULT 0,
  reflects_message_id UUID,          -- آخر رسالة واردة عكستها الحالة فعلاً
  extraction_ok    BOOLEAN NOT NULL DEFAULT TRUE, -- هل آخر استخراج نجح؟
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);
```

عزل مركّب (نفس نمط `messages_conversation_scope_fk`):

```sql
ALTER TABLE conversation_states
  ADD CONSTRAINT conversation_states_scope_fk
  FOREIGN KEY (conversation_id, user_id, channel_id, sender)
  REFERENCES conversations (id, user_id, channel_id, sender)
  ON DELETE CASCADE;
```

هذا يجعل ربط حالة بمحادثة متجر آخر مستحيلًا هيكليًّا.

### شكل `state` (JSONB) — كله تسميات حرّة عامة

```jsonc
{
  "open_issues": [
    { "id": "iss_1", "summary": "…", "first_seen_at": "…", "status": "open|in_progress" }
  ],
  "resolved_issues": [
    { "id": "iss_0", "summary": "…", "resolved_by": "customer_confirmed|owner", "resolved_at": "…" }
  ],
  "active_topic": "تسمية قصيرة أو null",
  "active_entity": { "type": "product|order|service|topic|null", "ref": "…", "label": "…" },
  "known_facts": { "…": "…" },        // حقائق ذكرها العميل (وسيلة دفعه المتاحة، عنوان أعطاه…)
  "customer_goal": "تسمية قصيرة أو null",
  "actions_attempted": [
    { "action": "…", "outcome": "worked|failed|unknown", "confirmed_by": "customer|system|null" }
  ],
  "last_reply_intent": "تسمية قصيرة لنية آخر رد للبوت (لمنع التكرار المعنوي)"
}
```

**تقسيم المناطق (المبدأ 4):**
- **دلالية (يملؤها الـLLM):** `open_issues`, `resolved_issues[resolved_by=customer_confirmed]`, `active_topic`, `active_entity`, `known_facts`, `customer_goal`, `last_reply_intent`, و`actions_attempted[confirmed_by=customer]`.
- **نظامية (يختمها النظام، لا الـLLM):** `resolved_issues[resolved_by=owner]` (من `escalation_threads.resolved_at`)، و`actions_attempted[confirmed_by=system]` (من سجلّ تنفيذ الأدوات مستقبلًا). الـLLM ممنوع من ختم أي إجراء نظامي كـ`worked` أو حلّ مشكلة بحجّة "الفريق تكفّل بها".

---

## 4. الاشتقاق (Extraction) — موديول `src/services/ai/conversation-state.service.js`

### الدالة الأساسية

```
extractState({ userId, conversationId, previousState, newTurns, lastBotReply, config, aiClient })
  → { state, extraction_ok: boolean }
```

- تُستدعى **مرة واحدة لكل دورة رد** (المسار يجمّع الوارد أصلًا في وظيفة واحدة عبر debounce → استخراج واحد؛ تكلفة مضبوطة).
- تستخدم **أرخص موديل** عبر نفس محلّل الموديل/المزوّد (`resolveEffectiveModel`)، `max_tokens` صغير، `temperature` منخفض، مهلة قصيرة (~8–10 ث).
- **برومنت الاستخراج عام** بأمثلة من قطاعات متعددة (شحنة وصلت / تغيير موعد حجز / برنامج اشتغل ثم ترخيص مفقود / لا وسيلة دفع متوافقة) حتى لا ينحاز لقطاع واحد. يُصرَّح فيه:
  - عند تأكيد العميل نجاح خطوة (كلمات نجاح عامة: تم/دخلت/وصل/اشتغل/ضبط/جا الكود…) → انقل المشكلة إلى `resolved_issues[resolved_by=customer_confirmed]` ولا تُبقها مفتوحة.
  - عند ظهور مشكلة جديدة مختلفة → أضِفها إلى `open_issues` دون إسقاط المفتوحة غير المحلولة.
  - **ممنوع اختراع حقائق**؛ `known_facts` فقط ما ذكره العميل صراحة.
  - **ممنوع** ختم أي إجراء نظامي أو handoff كمُنجَز — تلك يحسمها النظام.
  - المخرج JSON صارم مطابق للсхема (نتحقق منه؛ عند عدم المطابقة `extraction_ok=false`).

### دمج المنطقة النظامية بعد الاستخراج (خطوة إلزامية)

بعد عودة الـLLM، يمرّ الناتج على `reconcileSystemState(llmState, systemFacts)`:
- `systemFacts.escalationPending` من `getPendingEscalation` (الموجود). إن كان هناك handoff مفتوح، الحالة النظامية تُختَم بغضّ النظر عن رأي الـLLM.
- عند تعارض LLM مع سجلّ نظامي → **النظام يفوز** (يُصحَّح/يُحذَف حكم الـLLM المخالف).

### الحفظ والإصدار

- عند `extraction_ok=true`: نكتب `state`، نرفع `state_version += 1`، نضبط `reflects_message_id = آخر inbound id في الدفعة`، `extraction_ok=true`.
- عند `extraction_ok=false` (فشل/مهلة/schema غير مطابق): **لا نكتب حالة جديدة كحقيقة**. نضبط `extraction_ok=false` فقط (نُبقي الصف القديم بذرةً للاستخراج التالي)، ولا نغيّر `reflects_message_id`. النتيجة: الحقن يتراجع (المبدأ 3).

---

## 5. الحقن في البرومنت — `lib/ai-client.js` `buildSystemPrompt`

كتلة جديدة `conversationStateBlock` بجوار `pendingEscalationBlock`، خلف `CONVERSATION_STATE_ENABLED` (افتراضي `false`).

**شرط الحقن (Fail-soft):** تُحقن الحالة **فقط** إذا كانت حديثة تعكس الرسائل الجارية:
```
canInjectState = CONVERSATION_STATE_ENABLED
  && state.extraction_ok === true
  && state.reflects_message_id يغطّي دفعة الرسائل التي نجيب عليها الآن
```
إن لم يتحقّق الشرط → لا تُحقن أي حقيقة مشتقّة (تراجع للسلوك الحالي). لا تُعرَض الحالة القديمة كحقيقة أبدًا.

**محتوى الكتلة عند الحقن:**
- `resolved_issues` → «هذه الأمور تأكّد حلّها — لا تقترحها ولا تعيد خطواتها إلا إن أبلغ العميل بعودتها».
- `open_issues` → «أمور ما زالت مفتوحة، عالجها».
- `known_facts` → «معلومات مؤكدة عن العميل، لا تطلبها مجددًا».
- `active_topic` / `active_entity` → تركيز الرد الحالي.
- المنطقة النظامية (`escalationPending`) تبقى عبر كتلتها الحالية (`pendingEscalationBlock`) دون تكرار.

الحقن **إضافي**: عند إطفاء المفتاح، `buildSystemPrompt` كما هو حرفيًا.

---

## 6. الحرّاس الحتميون

### 6.1 حارس الحلّ (Resolution Guard)
- الحالة تُمرَّر لمراجِع الجودة الموجود (`reviewFinalReplyBeforeSend`/`reviewReplyQuality`). يُضاف فحص: هل الرد يعيد اقتراح خطوة لمشكلة في `resolved_issues` دون دليل جديد على عودتها؟ إن نعم → إعادة توليد واحدة مع تلميح، ثم قبول أفضل ناتج.
- خلف نفس مفتاح `CONVERSATION_STATE_ENABLED` (يستهلك الحالة).

### 6.2 حارس Stale/الإصدار الذرّي عند الإرسال (`SEND_STALE_GUARD_ENABLED`)
- كل رد يُوسَم وقت التوليد بـ`generated_against_message_id` (آخر inbound دُمج) — يُخزَّن على صف الرد (عمود جديد أو داخل `raw_payload`).
- في `outgoing-whatsapp-worker` قبل الإرسال الشبكي: **UPDATE شرطي واحد ذرّي** يطالب بحقّ الإرسال ويتحقق من عدم وجود رسالة عميل أحدث في نفس العبارة:

```sql
UPDATE messages
   SET status = 'sending'
 WHERE id = $replyId
   AND user_id = $userId               -- عزل صريح
   AND status IN ('queued','queued_for_send')
   AND NOT EXISTS (
     SELECT 1 FROM messages m2
      WHERE m2.user_id = $userId
        AND m2.conversation_id = $conversationId
        AND m2.direction = 'inbound'
        AND m2.id <> ALL($foldedInboundIds)   -- الرسائل التي دُمجت في هذا الرد
        AND m2.created_at > $generatedAgainstTs
   )
 RETURNING id;
```

- **0 صفوف** = وصلت رسالة عميل أحدث لم تُدمج → لا تُرسِل، علّم الرد `stale`، ودع الوظيفة الأحدث تُجيب. **صف واحد** = تمّت المطالبة بحقّ الإرسال ذرّيًا → أرسل. لا read-then-send.
- يعمل فوق `isReplyAlreadySent` (الموجود) وعامل الإرسال `concurrency=1`؛ الثلاثة معًا يغلقون السباق. يعمّم منطق owner-paused الحالي ليشمل رسائل العميل الجديدة (ما تطلبه المواصفات حرفيًا).

### 6.3 منع التكرار المعنوي (`SEMANTIC_DEDUP_ENABLED`)
- يقارن **نية/إجراء** الرد المسوّدة بـ`last_reply_intent` والردود الأخيرة، لا النص فقط.
- الاستخراج (خطوة 4) يُنتج `candidate_reply_intent` للرد المسوّد؛ إن طابق نية رد سابق **ولا رسالة عميل جديدة بينهما** → يُعامَل كتكرار (إعادة صياغة/توليد أو suppress حسب المنطق الحالي).
- مفتاح مستقل عن `CONVERSATION_STATE_ENABLED` ليُطلق/يُطفأ منفردًا، لكنه يستهلك بنية الحالة.
- fail-open كطبقات التكرار الحالية (خطأ في الفحص لا يمنع ردًّا مشروعًا).

---

## 7. نقاط الدمج (Integration Points) المؤكدة

| المكوّن | الملف:السطر | التغيير |
|---|---|---|
| Schema | `src/db/migrations/init.js` | جدول `conversation_states` + FK المركّب + عمود وسم التوليد على `messages` (أو داخل `raw_payload`) |
| تحميل الحالة | `src/workers/ai-worker.js` (~`processAiReply` 703-1170) | تحميل الحالة الحالية بـ`(user_id, conversation_id)` قبل التوليد |
| الاستخراج | جديد `src/services/ai/conversation-state.service.js` | `extractState` + `reconcileSystemState` |
| الحقن | `lib/ai-client.js:299-354` | `conversationStateBlock` بجوار `pendingEscalationBlock` |
| حارس الحلّ | `src/services/ai/reply-quality-gate.js` | تمرير الحالة + فحص إعادة فتح محلولة |
| حارس Stale الذرّي | `src/workers/outgoing-whatsapp-worker.js` (~377-416) | UPDATE الشرطي الذرّي قبل الإرسال |
| منع التكرار المعنوي | `src/workers/reply-deduplication.js` / `ai-worker.js:1049-1126` | مقارنة النية بجانب Jaccard |
| الحالة النظامية | `src/workers/ai-worker.js:993` `getPendingEscalation` | مصدر `escalationPending` للمصالحة |

---

## 8. المفاتيح (Feature Flags)

| المفتاح | الافتراضي | يحكم |
|---|---|---|
| `CONVERSATION_STATE_ENABLED` | `false` | الاستخراج + الحقن + حارس الحلّ |
| `SEND_STALE_GUARD_ENABLED` | `false` | حارس Stale الذرّي عند الإرسال |
| `SEMANTIC_DEDUP_ENABLED` | `false` | منع التكرار المعنوي |
| `CONVERSATION_STATE_MODEL` | (فارغ→أرخص افتراضي) | موديل الاستخراج |
| `CONVERSATION_STATE_EXTRACT_TIMEOUT_MS` | `9000` | مهلة الاستخراج |

كلها مطفأة = السلوك الحالي حرفيًا.

---

## 9. العزل (Tenant Isolation) — تحقق صريح

- كل استعلامات `conversation_states` تحمل `user_id = $n` + `conversation_id = $n` نصًّا.
- FK مركّب `(conversation_id, user_id, channel_id, sender)` يمنع الربط عبر المتاجر هيكليًّا.
- `extractState` توقيعها يفرض `userId`؛ لا مسار يقرأ حالة/إعدادات دون `userId`.
- أي كاش/قفل داخلي مفتاحه `${userId}:${conversationId}`.
- الاستخراج يقرأ حالة هذه المحادثة وإعدادات هذا المتجر (`config`) فقط — لا مسار عابر.

---

## 10. الاختبارات

### Regression (محادثات ProStore كحالات عامة)
- إعادة إنتاج: "دخلت الحساب زبط" ثم لا يُعاد اقتراح تسجيل الدخول.

### Generic Multi-Tenant (متاجر وهمية — إلزامية)
- **Tenant A — تجارة:** «طلبي ما وصل» ثم «خلاص وصل» → ممنوع بعدها طلب تتبّع الشحنة (`resolved_issues`).
- **Tenant B — حجوزات:** «أبغى أغيّر موعدي» → ممنوع قول «تم التغيير» قبل تنفيذ فعلي (المنطقة النظامية؛ لا يوجد tool تنفيذ الآن → يبقى `open`/تصعيد، والـLLM ممنوع من ختمه مُنجَزًا).
- **Tenant C — برامج:** «البرنامج ما يشتغل» ثم «اشتغل بس الترخيص مو ظاهر» → انتقال من مشكلة محلولة إلى مشكلة مفتوحة جديدة (`resolved_issues` + `open_issues`).
- **Tenant D — دفع:** العميل بلا وسيلة دفع متوافقة → تُلتقط في `known_facts` بلا أي اسم محفظة مثبّت (تمهيد لمرحلة نموذج الدفع؛ هنا نتحقق فقط أن الحالة تلتقط الحقيقة عامًّا).

### وحدات
- `extractState` (LLM مموّه): schema صارم، `extraction_ok=false` عند عدم المطابقة.
- `reconcileSystemState`: النظام يفوز عند التعارض؛ الـLLM لا يختم handoff.
- الحقن: يُحقن فقط عند `extraction_ok && reflects_message_id` مغطّى؛ يتراجع بأمان خلاف ذلك.
- حارس Stale الذرّي: 0 صف عند وجود inbound أحدث؛ 1 صف خلاف ذلك (اختبار بلا DB عبر محاكاة الاستعلام حيث أمكن، أو دالة صافية للمنطق).
- المفاتيح مطفأة → مخرجات `buildSystemPrompt`/المسار مطابقة للـlegacy.

### قيود بيئة الاختبار
لا Postgres/Redis محليًّا و`.env` يشير للإنتاج → لا تجارب حية تُرسل واتساب. التحقق بالاختبارات (`node --test`) + منطق صافٍ قابل للاختبار بلا DB حيثما أمكن. التحقق الحي مؤجَّل لبيئة staging مُجهّزة.

---

## 11. خارج النطاق (مراحل لاحقة)
- نموذج توافق الدفع المنظّم (merchant ∩ customer).
- إزالة أسماء العلامات/القطاعات المثبّتة من `product-knowledge.js` و`knowledge-retrieval.js`.
- طبقة تنفيذ أدوات حقيقية (orders/refund/booking) — عند وجودها تصبح مصدر `actions_attempted[confirmed_by=system]`.

---

## 12. المرحلة 1.1 — Hardening (منجزة)

بعد المرحلة ١، أربعة إصلاحات تصليب قبل أي تفعيل على الإنتاج:

1. **عزل tenant في الطابور:** `buildScopedJobKey(userId, rawKey)` يُسبق مفتاح الطابور الوارد (WhatsApp `key.id` غير عالمي التفرّد) بمعرّف المتجر → لا تصادم عبر المتاجر في `jobs(queue_name, job_key)` ولا في BullMQ jobId. (مفاتيح AI-reply=conversation UUID والإرسال=reply UUID عالمية التفرّد أصلًا.)

2. **حارس stale على مسار @lid:** `handleLidOutgoing` كان يرجع قبل حارس stale في المسار الرئيسي؛ أُضيف الحارس داخله (بوابة `source==='ai_reply'`) — يغطّي غالبية العملاء ذوي الأرقام المقنّعة.

3. **تسلسل ذرّي مصدره DB بدل مقارنة الساعات:** استُبدل `generatedAgainstTs` (ساعة التطبيق) مقابل `created_at` (ساعة Postgres) بعدّاد أعداد صحيحة `conversations.inbound_seq` (يُبمّ ذرّيًا لكل وارد، يُختَم على `messages.inbound_seq`). الرد يحفظ أقصى seq أجاب عنه؛ الحارس يلغيه إذا وُجد وارد بـseq أعلى. لا انحراف ساعات. `messages.inbound_seq` nullable بلا default = ALTER ميتاداتا فقط (لا إعادة كتابة للجدول الكبير)؛ صفوف ما قبل الترحيل NULL ولا تُفعّل الحارس. Fail-open عند غياب seq.

4. **حارس حتمي لإعادة فتح المحلول:** `detectResolvedReopen` — تراكب رموز لغوي (بلا LLM، بلا قطاع) يكشف إن كان الرد يقترح خطوات لمشكلة أكّد العميل حلّها ولم يُعِد إثارتها؛ عند الكشف إعادة توليد واحدة موجّهة، ويُقبل الناتج فقط إن لم يُعِد الفتح. لا حذف. يكمّل منع الحقن لا يستبدله.

**benchmark:** `scripts/benchmark-state-extraction.js` يقيس p50/p95/p99 ونسبة الفشل لنداء الاستخراج عبر نفس مسار العامل، بلا DB/Redis/واتساب — يُشغَّل على staging بمفاتيح المزوّد.

**يحتاج تحقّق staging قبل تفعيل المفاتيح:** زمن الاستخراج المضاف قبل التوليد، وقيم p50/p95/p99 الفعلية، وسلوك inbound_seq تحت التزامن.
