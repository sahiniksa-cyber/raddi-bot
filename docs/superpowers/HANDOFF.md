# Session Handoff — راحلي → كلاود الجديد

> **اقرأ هذا الملف أولاً قبل أي عمل.** يحتوي ملخص كامل لما تم، ما المعلّق، والنمط المتبع.

**تاريخ التسليم:** 2026-05-24
**الفرع:** `claude/cool-lamport-f5f0ad`
**Worktree:** `C:\Users\lenovo\Downloads\بروفايل ai\whatsapp-bot\.claude\worktrees\cool-lamport-f5f0ad`

---

## 1. السياق العام

المستخدم (sahini) يدير منصة **ردّي** — بوت واتساب AI لخدمة العملاء لمتجر ProStoree، منشور على Railway من `master`، Dashboard على jwap.net. المنصة: Node.js + Baileys + BullMQ + Redis + PostgreSQL.

**أسلوب العمل المعتمد بصرامة:**
1. عند أي طلب ميزة جديدة → `superpowers:brainstorming` لـ scope assessment + decomposition
2. أسئلة واحدة في كل مرة (multiple choice ممكن، visual companion للأسئلة البصرية)
3. spec في `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
4. `superpowers:writing-plans` ينتج plan في `docs/superpowers/plans/...`
5. `superpowers:subagent-driven-development` ينفذ task-by-task
6. كل task: implementer subagent → spec reviewer → code quality reviewer
7. كل task ينتهي بـ commit (TDD: test أولاً → كود → test ينجح → commit)
8. آخر task: push + `gh pr create`
9. بعد موافقة المستخدم: `gh pr merge` → Railway ينشر تلقائياً

**لا تكسر هذا النمط.** المستخدم يثق فيه وتعوّد عليه.

---

## 2. ما تم في هذه الجلسة

### M0 — استقرار الواتساب + AI (PR #12، منشور)
- إصلاح 8 نقاط: تنزيل media من Baileys، معالجة 440 connectionReplaced، stability gate، grace 60s، bulk-batch guard، history filter، Anthropic إخفاء، auto-reply صارم
- ملفات معدّلة: `baileys-connection-manager.js`, `ai-history.js`, `ai-client.js`, `platform-features.js`
- merge commit: `72208c1`

### M1 — نظام Quota الرسائل (PR #13، منشور)
- 5 أعمدة جديدة على `billing_accounts`: `messages_remaining`, `quota_expires_at`, `expire_resets_quota`, `last_topup_amount`, `last_topup_at`
- helper جديد `src/services/billing/message-quota.js` (4 دوال atomic)
- ai-worker يفحص quota قبل توليد، outgoing-worker ينقص بعد كل إرسال ناجح
- لوحة الأدمن: زر "إضافة رسائل" + modal بـ 3 حقول (count, days, expireResetsQuota)
- شاشة العميل: حذف قسم التكلفة، إضافة كارد رصيد + banner + زر "طلب شحن رصيد"
- متغير بيئة جديد: `SUPPORT_WHATSAPP_PHONE`
- merge commit: `517ff52`

### M2 — تصميم صفحة المحادثات (PR #14، منشور للتو)
- two-pane على ديسكتوب، accordion على mobile (≤900px)
- 3 حقول جديدة على message payload: `status`, `hasMedia`, `mediaKind`
- بحث server-side عبر `?q=`
- ملف CSS جديد `dashboard/conversations.css`
- 12 دالة JS جديدة/مكتوبة من جديد
- حذف نظام tabs القديم
- merge commit: `1082f3d`

**كل M0+M1+M2 منشور على Railway.** 157 اختبار يمرّ.

---

## 3. ما المعلّق — Phase A و Phase C

### Phase A — إصلاح `lid` (التالي مباشرة، عاجل)

**المشكلة:** في الواتساب الجديد، الرسائل من أجهزة حديثة تصل بـ `key.remoteJid = "276282495500304@lid"` بدل رقم الجوال. الكود يخزنه كما هو، فيظهر في:
- بطاقات المحادثات في الـ dashboard
- إشعارات التصعيد للمالك
- header المحادثة المفتوحة

**المستخدم وضّح:** "الرقم موجود في كل عميل — لو فتحت الواتساب على جوالك تشوفه فوق الشاشة. مافي عميل يخفي رقمه." → يعني لا حالة fallback مقلقة.

**الحل التقني المعتمد:** استخراج `phone_number` من `message.key.senderPn` أو `participantPn` (متوفر في Baileys 7+)، تخزينه في عمود جديد `phone_number` على `conversations`، استخدامه في كل مكان بدل الـ lid.

**5 ملفات تتعدّل:**
1. `src/db/migrations/init.js` — `ALTER TABLE conversations ADD COLUMN phone_number TEXT NULL`
2. `src/services/whatsapp/baileys-connection-manager.js` — `toWhatsappWebMessage` يستخرج `phoneNumber`
3. `src/services/whatsapp/message-ingest.service.js` — يمرر `phoneNumber` ويحفظ في الـ INSERT
4. `src/controllers/conversations.controller.js` — `cleanCustomerPhone` يفضّل `phone_number`
5. `src/workers/escalation-routing.js` — `cleanCustomerJid` و `buildEscalationNotification`

**لا backfill** — الـ phone_number يُملأ تلقائياً عند أول رسالة جديدة (COALESCE في الـ UPSERT).

**حالة:** spec لم يُكتب بعد. الحوار في الجلسة الأصلية وصل لمرحلة "أبدأ Phase A الآن" ثم المستخدم قاطع للنقل.

### Phase C — variants للمنتجات (بعد Phase A)

**المثال الذي ضربه المستخدم:**
> اشتراك أدوبي → شهر / 4 أشهر / 12 شهر → سعر مختلف لكل مدة

**المطلوب:**
- كل منتج يدعم variants (ألوان، أحجام، مدة، كمية، إلخ)
- كل variant سعر مستقل
- الأدمن يدير من dashboard (editor جديد)
- الـ AI يفهم اختيار العميل ويرد بالسعر الصحيح

**هذا Phase أكبر (2-3 ساعات).** يحتاج brainstorming كامل من جديد لأن فيه قرارات تصميمية كثيرة:
- data model: JSONB column على products أم table منفصل `product_variants`؟
- كيف يفهم الـ AI الاختيار من رسالة العميل؟
- editor: nested form أم drag-drop؟
- backward compat: المنتجات بدون variants؟
- variants combinations (مثلاً لون × حجم) أم خيار واحد فقط؟

**ابدأ Phase C بـ `superpowers:brainstorming`** بعد ما Phase A يدمج وينشر.

---

## 4. حالة الـ Worktree

```bash
git log --oneline -3
# يعرض آخر commits على الفرع claude/cool-lamport-f5f0ad
# آخر merge في master: 1082f3d (PR #14)
```

الفرع `claude/cool-lamport-f5f0ad` بعد آخر merge **خالي من تعديلات pending**. آمن للبدء من جديد.

---

## 5. قواعد ذهبية تعلّمتها مع المستخدم

1. **اكتب بالعربي** للمحادثة و الـ PR descriptions. الكود + commit messages بالإنجليزي.
2. **لا تبدأ كود قبل التصميم.** الـ HARD-GATE في brainstorming يمنع ذلك.
3. **أسئلة قصيرة، خيارات واضحة.** المستخدم يحب multiple choice، يكره الأسئلة الطويلة.
4. **توصية صريحة دائماً.** لما يسأل "ايش رأيك؟"، أعطه إجابة حاسمة مع السبب.
5. **PRs منفصلة لكل ميزة.** لا تدمج phases في PR واحد.
6. **خاصية Visual Companion** مفيدة جداً للأسئلة البصرية. السيرفر يعمل auto-exit بعد 30 دقيقة.
7. **اكتب تقارير concise.** Tables أفضل من paragraphs. ASCII art ممتاز لـ layout.
8. **بعد كل merge، Railway ينشر تلقائياً.** ذكّر المستخدم بـ env vars الجديدة لو لزم.
9. **استخدم `raddi-bot-doctor` skill** لو المستخدم أبلغ عن مشكلة في البوت بعد النشر.

---

## 6. الـ Memory Files

تُحمّل تلقائياً في كل جلسة جديدة من:
`C:\Users\lenovo\.claude\projects\C--Users-lenovo-Downloads---------ai-whatsapp-bot\memory\`

موجود:
- `project_raddi.md` — overview المشروع
- `reference_domain.md` — jwap.net + admin links
- `project_deploy_state_2026_05.md` — معمارية Railway
- `project_connection_conflict_incident.md` — حادثة 440 (تم إصلاحها في M0)
- `project_message_quota_phase1.md` — تفاصيل M1

**سأضيف ملف جديد** `project_phase_a_c_pending.md` للمعلّقات.

---

## 7. كيف تبدأ في المحادثة الجديدة

افعل بالترتيب:

1. اقرأ هذا الملف بالكامل
2. اقرأ `docs/superpowers/specs/2026-05-24-conversations-redesign-design.md` (لتفهم نمط الـ spec)
3. اقرأ `docs/superpowers/plans/2026-05-24-conversations-redesign.md` (لتفهم نمط الـ plan)
4. لما المستخدم يقول "ابدأ Phase A" أو ما يشبهه:
   - استدعِ `superpowers:brainstorming`
   - استكشف الكود سريعاً (5 ملفات أعلاه)
   - اعرض التصميم في رسالة واحدة (مكثفة لأن المستخدم رآه قبل)
   - اطلب موافقة
   - اكتب spec في `docs/superpowers/specs/2026-05-25-lid-phone-extraction-design.md`
   - استدعِ `superpowers:writing-plans`
   - اكتب plan في `docs/superpowers/plans/2026-05-25-lid-phone-extraction.md`
   - استدعِ `superpowers:subagent-driven-development`
   - نفّذ task-by-task
5. بعد Phase A merge → ابدأ Phase C بنفس النمط (`brainstorming` من جديد لأن variants تصميم جديد كامل)

---

## 8. مفاتيح فنية مهمة

| المفهوم | مكانه |
|---|---|
| Baileys connection | `src/services/whatsapp/baileys-connection-manager.js` |
| Ingest pipeline | `src/services/whatsapp/message-ingest.service.js` |
| AI worker | `src/workers/ai-worker.js` (checkMessageQuota قبل التوليد) |
| Outgoing worker | `src/workers/outgoing-whatsapp-worker.js` (decrementMessageQuota بعد الإرسال) |
| Escalation | `src/workers/escalation-routing.js` |
| Quota helper | `src/services/billing/message-quota.js` |
| AI client | `lib/ai-client.js` |
| Constants (delays, retries) | `lib/constants.js` |
| Migrations (single file) | `src/db/migrations/init.js` |

---

## 9. الـ env vars الموجودة (لا تكسرها)

- `WA_ENGINE=baileys`
- `SUPPORT_WHATSAPP_PHONE` (يضبطه المستخدم في Railway)
- `WA_STABLE_RESET_MS=20000`
- `WA_ACCEPT_MESSAGES_GRACE_MS=60000`
- `MEDIA_ANALYSIS_MAX_BYTES`
- `AI_REPLY_DEBOUNCE_MS=9000`
- `OUTGOING_CONNECTED_SETTLE_MS` (Baileys default 3000)

---

**اقرأ الملف، ابدأ بثقة. المستخدم يحب الاحترافية.**
