'use strict';

let campaignCurrent = null;
let campaignApproval = null;
let campaignVisited = new Set(['audience']);
let campaignLoadedOnce = false;
let campaignSearchTerms = [];
let campaignSignals = [];
let campaignSignalsLoaded = false;
let campaignSelectedSegment = null;
let campaignAudienceCount = 0;

function campaignFlash(message, error = false) {
  const el = document.getElementById('campaignFlash');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  el.style.background = error ? '#fef2f2' : '#ecfdf5';
  el.style.border = `1px solid ${error ? '#fecaca' : '#a7f3d0'}`;
  el.style.color = error ? '#991b1b' : '#065f46';
  window.setTimeout(() => { el.style.display = 'none'; }, 6000);
}

async function campaignApi(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.message || 'تعذر تنفيذ الطلب');
  return data;
}

function campaignGoStep(step) {
  campaignVisited.add(step);
  document.querySelectorAll('[data-campaign-page]').forEach(el => el.classList.toggle('active', el.dataset.campaignPage === step));
  document.querySelectorAll('[data-campaign-step]').forEach(el => {
    el.classList.toggle('active', el.dataset.campaignStep === step);
    el.classList.toggle('visited', campaignVisited.has(el.dataset.campaignStep));
  });
  if (step === 'review') campaignRenderReview();
  if (step === 'content') void campaignRefreshContentPreview();
  window.scrollTo(0, 0);
}

function campaignFormPayload() {
  const source = document.querySelector('input[name="campaignSource"]:checked')?.value || 'smart';
  const states = [...document.querySelectorAll('.campaignState:checked')].map(el => el.value);
  const product = document.getElementById('campaignProduct')?.value || '';
  const scheduled = document.getElementById('campaignScheduledAt')?.value;
  return {
    name: document.getElementById('campaignName').value.trim(),
    goal: document.getElementById('campaignGoal').value.trim(),
    messageText: document.getElementById('campaignMessage').value.trim(),
    audienceRules: {
      source,
      states,
      productKeys: product ? [product] : [],
      searchTerms: [...campaignSearchTerms],
      dateFrom: document.getElementById('campaignDateFrom').value || null,
      dateTo: document.getElementById('campaignDateTo').value || null,
    },
    intervalMinSeconds: Math.max(30, Number(document.getElementById('campaignIntervalMin').value) || 30),
    intervalMaxSeconds: Math.max(30, Number(document.getElementById('campaignIntervalMax').value) || 60),
    scheduledAt: scheduled ? new Date(scheduled).toISOString() : null,
  };
}

async function campaignSave() {
  const payload = campaignFormPayload();
  if (!payload.name) throw new Error('اكتب اسم الحملة أولاً');
  const data = campaignCurrent
    ? await campaignApi(`/api/campaigns/${campaignCurrent.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    : await campaignApi('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const detail = await campaignApi(`/api/campaigns/${data.campaign.id}`);
  campaignFill(detail.campaign);
  campaignApproval = null;
  campaignSearchTerms = [];
  campaignUpdateButtons();
  await campaignLoadList();
  return campaignCurrent;
}

async function campaignSaveAndNext(step) {
  try {
    await campaignSave();
    campaignFlash('تم حفظ المسودة');
    campaignGoStep(step);
  } catch (error) { campaignFlash(error.message, true); }
}

function campaignNew() {
  campaignCurrent = null;
  campaignApproval = null;
  campaignVisited = new Set(['audience']);
  ['campaignName', 'campaignGoal', 'campaignMessage', 'campaignDateFrom', 'campaignDateTo', 'campaignScheduledAt', 'campaignNumbers'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('campaignIntervalMin').value = 30;
  document.getElementById('campaignIntervalMax').value = 60;
  document.querySelector('input[name="campaignSource"][value="smart"]').checked = true;
  document.querySelectorAll('.campaignState').forEach(el => { el.checked = el.value === 'interested_unverified'; });
  document.getElementById('campaignMediaList').innerHTML = '';
  document.getElementById('campaignPicker').value = '';
  document.getElementById('campaignKeywordInput').value = '';
  document.getElementById('campaignKeywordPreview').style.display = 'none';
  campaignSelectedSegment = null;
  campaignAudienceCount = 0;
  document.querySelectorAll('[data-campaign-segment]').forEach(el => el.classList.remove('active'));
  const segmentDetails = document.getElementById('campaignSegmentDetails');
  if (segmentDetails) segmentDetails.hidden = true;
  campaignRenderKeywordTags();
  campaignToggleKeywordOptions();
  campaignRenderContentPreview();
  campaignUpdateButtons();
  campaignGoStep('audience');
}

function campaignFill(campaign) {
  campaignCurrent = campaign;
  campaignApproval = campaign.status === 'ready_for_approval' && campaign.approved_snapshot_hash
    ? { snapshotHash: campaign.approved_snapshot_hash, audienceCount: campaign.audience_count }
    : null;
  document.getElementById('campaignName').value = campaign.name || '';
  document.getElementById('campaignGoal').value = campaign.goal || '';
  document.getElementById('campaignMessage').value = campaign.message_text || '';
  document.getElementById('campaignIntervalMin').value = Math.max(30, campaign.interval_min_seconds || 30);
  document.getElementById('campaignIntervalMax').value = Math.max(30, campaign.interval_max_seconds || 60);
  document.getElementById('campaignScheduledAt').value = campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString().slice(0, 16) : '';
  const rules = campaign.audience_rules || {};
  campaignSearchTerms = Array.isArray(rules.searchTerms) ? [...rules.searchTerms] : [];
  const sourceInput = document.querySelector(`input[name="campaignSource"][value="${rules.source || 'smart'}"]`);
  if (sourceInput) sourceInput.checked = true;
  document.querySelectorAll('.campaignState').forEach(el => { el.checked = (rules.states || []).includes(el.value); });
  document.getElementById('campaignProduct').value = (rules.productKeys || [])[0] || '';
  document.getElementById('campaignDateFrom').value = rules.dateFrom || '';
  document.getElementById('campaignDateTo').value = rules.dateTo || '';
  document.getElementById('campaignKeywordInput').value = '';
  document.getElementById('campaignKeywordPreview').style.display = 'none';
  campaignRenderKeywordTags();
  campaignToggleKeywordOptions();
  document.getElementById('campaignMediaList').innerHTML = (campaign.media || []).map(item =>
    `<div style="display:flex;justify-content:space-between;gap:10px;padding:9px;border-bottom:1px solid var(--border)"><span>${campaignEscape(item.original_name)} · ${campaignEscape(item.kind)}</span><button class="campaign-btn secondary" onclick="campaignDeleteMedia('${item.id}')">حذف</button></div>`
  ).join('') || '<div class="hint">لا توجد وسائط مرفوعة.</div>';
  campaignRenderContentPreview();
  campaignUpdateButtons();
}

function campaignEscape(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function campaignToggleKeywordOptions() {
  const options = document.getElementById('campaignKeywordOptions');
  if (!options) return;
  const source = document.querySelector('input[name="campaignSource"]:checked')?.value;
  options.hidden = source !== 'keywords';
}

function campaignRenderKeywordTags() {
  const container = document.getElementById('campaignKeywordTags');
  if (!container) return;
  container.innerHTML = campaignSearchTerms.length
    ? campaignSearchTerms.map((term, index) => `<span class="campaign-keyword">${campaignEscape(term)}<button type="button" title="حذف" onclick="campaignRemoveKeyword(${index})">×</button></span>`).join('')
    : '<span class="hint">لم تُضف كلمات بعد.</span>';
}

function campaignAddKeyword(rawValue) {
  const term = String(rawValue || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (term.length < 2) {
    campaignFlash('كلمة البحث يجب أن تكون حرفين على الأقل.', true);
    return false;
  }
  if (campaignSearchTerms.length >= 50) {
    campaignFlash('الحد الأعلى 50 كلمة بحث.', true);
    return false;
  }
  if (campaignSearchTerms.some(item => item.toLocaleLowerCase('ar') === term.toLocaleLowerCase('ar'))) {
    campaignFlash('كلمة البحث مضافة مسبقاً.', true);
    return false;
  }
  campaignSearchTerms.push(term);
  campaignRenderKeywordTags();
  campaignMarkDirty();
  return true;
}

function campaignRemoveKeyword(index) {
  campaignSearchTerms.splice(index, 1);
  campaignRenderKeywordTags();
  campaignMarkDirty();
}

async function campaignPreviewKeywords() {
  try {
    const source = document.querySelector('input[name="campaignSource"]:checked')?.value;
    if (source !== 'keywords') throw new Error('اختر جمهور كلمات البحث أولاً');
    if (!campaignSearchTerms.length) throw new Error('أضف كلمة بحث واحدة على الأقل واضغط Enter');
    await campaignSave();
    const data = await campaignApi(`/api/campaigns/${campaignCurrent.id}/preview`);
    const preview = document.getElementById('campaignKeywordPreview');
    const rows = (data.recipients || []).map(row => {
      const identity = row.customer_name || row.normalized_phone || row.sender;
      return `<div class="campaign-preview-row"><b>${campaignEscape(identity)}</b><div class="hint">الكلمة المطابقة: ${campaignEscape(row.product_name || '')}</div><div>${campaignEscape(row.evidence_text || '')}</div></div>`;
    }).join('');
    preview.innerHTML = `<b>تم تحديد ${data.count} عميل بدون تكرار.</b>${data.count > 100 ? '<div class="hint">يظهر أول 100 عميل فقط هنا، بينما الاعتماد يشمل جميع المطابقين.</div>' : ''}${rows || '<div class="hint">لا يوجد عميل مطابق حالياً.</div>'}`;
    preview.style.display = 'block';
    campaignFlash(`تم فحص الرسائل وتحديد ${data.count} عميل مطابق.`);
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignOpen(id) {
  if (!id) return;
  try {
    const data = await campaignApi(`/api/campaigns/${id}`);
    campaignFill(data.campaign);
    campaignGoStep('audience');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignLoadList() {
  const data = await campaignApi('/api/campaigns');
  const picker = document.getElementById('campaignPicker');
  picker.innerHTML = '<option value="">اختر حملة محفوظة</option>' + data.campaigns.map(item =>
    `<option value="${item.id}">${campaignEscape(item.name)} · ${campaignEscape(item.status)}</option>`
  ).join('');
  if (campaignCurrent) picker.value = campaignCurrent.id;
}

async function campaignLoadCounts() {
  const data = await campaignApi('/api/campaigns/smart/counts');
  document.getElementById('campaignInterestedCount').textContent = data.counts.interested_unverified || 0;
  document.getElementById('campaignOrderedCount').textContent = data.counts.ordered_confirmed || 0;
  document.getElementById('campaignVerifyCount').textContent = data.counts.needs_verification || 0;
}

function campaignRenderContentPreview() {
  const messageInput = document.getElementById('campaignMessage');
  const bubble = document.getElementById('campaignWhatsappMessage');
  const mediaBox = document.getElementById('campaignWhatsappMedia');
  const mediaLabel = document.getElementById('campaignWhatsappMediaLabel');
  const audienceCount = document.getElementById('campaignContentAudienceCount');
  const itemsCount = document.getElementById('campaignContentItemsCount');
  if (!messageInput || !bubble || !mediaBox || !mediaLabel || !audienceCount || !itemsCount) return;

  const message = messageInput.value.trim() || 'اكتب رسالتك لتظهر هنا كما ستصل للعميل.';
  bubble.textContent = message;
  const time = document.createElement('span');
  time.className = 'campaign-wa-time';
  time.textContent = 'الآن ✓✓';
  bubble.appendChild(time);

  const savedMedia = Array.isArray(campaignCurrent?.media) ? campaignCurrent.media.length : 0;
  const selectedMedia = document.getElementById('campaignMedia')?.files?.length || 0;
  const mediaCount = savedMedia + selectedMedia;
  mediaBox.classList.toggle('visible', mediaCount > 0);
  mediaLabel.textContent = mediaCount === 1 ? 'عنصر وسائط واحد' : `${mediaCount} صور أو فيديوهات`;
  audienceCount.textContent = String(campaignAudienceCount);
  itemsCount.textContent = mediaCount ? `نص + ${mediaCount} وسائط لكل عميل` : 'نص واحد لكل عميل';
}

async function campaignRefreshContentPreview() {
  campaignRenderContentPreview();
  if (!campaignCurrent?.id) return;
  const campaignId = campaignCurrent.id;
  try {
    const data = await campaignApi(`/api/campaigns/${campaignId}/preview`);
    if (campaignCurrent?.id !== campaignId) return;
    campaignAudienceCount = Number(data.count) || 0;
    campaignRenderContentPreview();
  } catch (_) {
    campaignAudienceCount = 0;
    campaignRenderContentPreview();
  }
}

function campaignCloseSegment() {
  campaignSelectedSegment = null;
  document.querySelectorAll('[data-campaign-segment]').forEach(el => el.classList.remove('active'));
  const details = document.getElementById('campaignSegmentDetails');
  if (details) details.hidden = true;
}

function campaignRenderSegmentDetails() {
  const details = document.getElementById('campaignSegmentDetails');
  if (!details || !campaignSelectedSegment) return;
  const labels = {
    interested_unverified: 'العملاء المهتمون الذين لم يطلبوا',
    ordered_confirmed: 'العملاء الذين طلبوا المنتج',
    needs_verification: 'العملاء الذين يحتاجون مراجعة',
  };
  const rows = campaignSignals.filter(row => row.customer_state === campaignSelectedSegment);
  const content = rows.map(row => {
    const identity = row.customer_name || row.normalized_phone || row.sender || 'عميل بدون اسم';
    const product = row.product_name || 'لم يُحدد المنتج';
    const evidence = row.evidence_text || 'لا توجد تفاصيل إضافية محفوظة.';
    const order = row.order_reference ? `<span class="hint">رقم الطلب: ${campaignEscape(row.order_reference)}</span>` : '';
    return `<div class="campaign-segment-row"><div class="campaign-segment-row-top"><b>${campaignEscape(identity)}</b><span class="hint">${campaignEscape(product)}</span></div><p>${campaignEscape(evidence)}</p>${order}</div>`;
  }).join('');
  details.innerHTML = `<div class="campaign-segment-head"><b>${labels[campaignSelectedSegment] || 'تفاصيل العملاء'} · ${rows.length}</b><button type="button" onclick="campaignCloseSegment()">إغلاق التفاصيل</button></div>${content || '<div class="hint">لا يوجد عملاء داخل هذا القسم حالياً.</div>'}`;
  details.hidden = false;
}

async function campaignSelectSegment(state) {
  if (campaignSelectedSegment === state) {
    campaignCloseSegment();
    return;
  }
  campaignSelectedSegment = state;
  document.querySelectorAll('[data-campaign-segment]').forEach(el => el.classList.toggle('active', el.dataset.campaignSegment === state));
  const details = document.getElementById('campaignSegmentDetails');
  if (details) {
    details.hidden = false;
    details.innerHTML = '<div class="hint">جارٍ تحميل تفاصيل العملاء...</div>';
  }
  if (!campaignSignalsLoaded) await campaignLoadSignals();
  else campaignRenderSegmentDetails();
}

async function campaignLoadSignals() {
  try {
    const data = await campaignApi('/api/campaigns/smart/signals');
    campaignSignals = (data.signals || []).slice(0, 100);
    campaignSignalsLoaded = true;
    campaignRenderSegmentDetails();
  } catch (error) {
    campaignSignalsLoaded = false;
    const details = document.getElementById('campaignSegmentDetails');
    if (details && campaignSelectedSegment) details.innerHTML = `<div class="campaign-note">${campaignEscape(error.message)}</div>`;
  }
}

async function campaignLoadProducts() {
  try {
    const response = await campaignApi('/api/config');
    const config = response.config || response;
    const select = document.getElementById('campaignProduct');
    const selected = select.value;
    const products = Array.isArray(config.products) ? config.products : [];
    select.innerHTML = '<option value="">كل المنتجات</option>' + products.filter(item => item?.name).map(item =>
      `<option value="${campaignEscape(item.name)}">${campaignEscape(item.name)}</option>`
    ).join('');
    select.value = selected;
  } catch (_) {}
}

async function campaignAnalyze() {
  try {
    campaignFlash('جارٍ تحليل أحدث المحادثات...');
    const result = await campaignApi('/api/campaigns/smart/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 100, useAi: true }) });
    await Promise.all([campaignLoadCounts(), campaignLoadSignals()]);
    campaignFlash(`تم تحليل ${result.analyzed} محادثة وحفظ ${result.signals} إشارة.`);
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignAddNumbers() {
  try {
    const numbers = document.getElementById('campaignNumbers').value.split(/[\n,;]+/).map(value => value.trim()).filter(Boolean);
    const result = await campaignApi('/api/campaigns/contacts/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numbers }) });
    document.getElementById('campaignNumbers').value = '';
    campaignFlash(`تمت إضافة ${result.added} رقم${result.invalid.length ? `، وتعذر قراءة ${result.invalid.length}` : ''}.`);
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignImportContacts() {
  try {
    const input = document.getElementById('campaignImportFile');
    if (!input.files[0]) throw new Error('اختر ملف CSV أو Excel');
    const form = new FormData(); form.append('file', input.files[0]);
    const result = await campaignApi('/api/campaigns/contacts/import', { method: 'POST', body: form });
    input.value = '';
    await Promise.all([campaignLoadCounts(), campaignLoadSignals()]);
    campaignFlash(`تمت إضافة ${result.added} جهة اتصال${result.invalid.length ? `، وهناك ${result.invalid.length} صف غير صالح` : ''}.`);
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignUploadMedia() {
  try {
    if (!campaignCurrent) await campaignSave();
    const input = document.getElementById('campaignMedia');
    if (!input.files.length) throw new Error('اختر صورة أو فيديو أولاً');
    const form = new FormData(); [...input.files].forEach(file => form.append('media', file));
    await campaignApi(`/api/campaigns/${campaignCurrent.id}/media`, { method: 'POST', body: form });
    input.value = '';
    await campaignOpen(campaignCurrent.id);
    campaignGoStep('content');
    campaignFlash('تم رفع الوسائط');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignDeleteMedia(mediaId) {
  try {
    await campaignApi(`/api/campaigns/${campaignCurrent.id}/media/${mediaId}`, { method: 'DELETE' });
    await campaignOpen(campaignCurrent.id);
    campaignGoStep('content');
    campaignFlash('تم حذف العنصر وإلغاء أي اعتماد سابق');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignRenderReview() {
  const el = document.getElementById('campaignReview');
  if (!campaignCurrent) { el.textContent = 'احفظ الحملة أولاً لعرض الملخص.'; return; }
  try {
    const data = await campaignApi(`/api/campaigns/${campaignCurrent.id}/preview`);
    const sourceLabels = { contacts: 'القائمة الخارجية والأرقام اليدوية', all: 'كل العملاء', conversations: 'من تواصل في الفترة المحددة', smart: 'التحديد الذكي', keywords: 'كلمات البحث' };
    const source = sourceLabels[campaignCurrent.audience_rules?.source] || 'التحديد الذكي';
    const terms = campaignCurrent.audience_rules?.source === 'keywords' ? `\nكلمات البحث: ${(campaignCurrent.audience_rules.searchTerms || []).join('، ')}` : '';
    el.textContent = `الحملة: ${campaignCurrent.name}\nالجمهور: ${source}${terms}\nعدد المستلمين الحالي: ${data.count}\nالفاصل: ${campaignCurrent.interval_min_seconds}–${campaignCurrent.interval_max_seconds} ثانية\nالوسائط: ${(campaignCurrent.media || []).length}\n\nالرسالة:\n${campaignCurrent.message_text || '(بدون نص)'}`;
  } catch (error) { el.textContent = error.message; }
}

function campaignUpdateButtons() {
  const approve = document.getElementById('campaignApproveBtn');
  const start = document.getElementById('campaignStartBtn');
  const pause = document.getElementById('campaignPauseBtn');
  const resume = document.getElementById('campaignResumeBtn');
  const cancel = document.getElementById('campaignCancelBtn');
  const notice = document.getElementById('campaignApprovalNotice');
  if (!approve || !start) return;
  approve.disabled = !(campaignCurrent?.status === 'ready_for_approval' && campaignApproval);
  start.disabled = campaignCurrent?.status !== 'approved';
  pause.disabled = !['sending', 'scheduled'].includes(campaignCurrent?.status);
  resume.disabled = campaignCurrent?.status !== 'paused';
  cancel.disabled = !campaignCurrent || ['completed', 'canceled', 'failed'].includes(campaignCurrent.status);
  notice.textContent = campaignCurrent?.status === 'approved'
    ? 'الحملة معتمدة. لن يبدأ الإرسال إلا عند الضغط على «بدء الإرسال».'
    : campaignCurrent?.status === 'ready_for_approval'
      ? 'نسخة الاعتماد جاهزة. راجع العدد ثم اضغط «أوافق وأعتمد».'
      : 'الإرسال مقفل حتى تنشئ نسخة المراجعة وتوافق عليها صراحة.';
}

async function campaignAction(action) {
  try {
    if (!campaignCurrent) return;
    if (action === 'cancel' && !window.confirm('هل تريد إلغاء الحملة؟ لن تُرسل الرسائل المتبقية.')) return;
    const data = await campaignApi(`/api/campaigns/${campaignCurrent.id}/${action}`, { method: 'POST' });
    campaignCurrent = data.campaign;
    campaignUpdateButtons();
    await campaignLoadList();
    const messages = { pause: 'تم إيقاف الحملة مؤقتاً.', resume: 'تمت استعادة الحملة. اضغط «بدء الإرسال» للمتابعة.', cancel: 'تم إلغاء الحملة.' };
    campaignFlash(messages[action] || 'تم تحديث الحملة.');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignPrepareApproval() {
  try {
    await campaignSave();
    const data = await campaignApi(`/api/campaigns/${campaignCurrent.id}/prepare-approval`, { method: 'POST' });
    const detail = await campaignApi(`/api/campaigns/${data.campaign.id}`);
    campaignFill(detail.campaign);
    campaignApproval = data.approval;
    campaignUpdateButtons();
    await campaignRenderReview();
    campaignFlash(`نسخة الاعتماد جاهزة لعدد ${data.approval.audienceCount} مستلم.`);
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignApprove() {
  try {
    if (!campaignApproval) throw new Error('جهّز نسخة الاعتماد أولاً');
    const data = await campaignApi(`/api/campaigns/${campaignCurrent.id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(campaignApproval),
    });
    campaignCurrent = data.campaign;
    campaignUpdateButtons();
    campaignFlash('تم اعتماد الحملة. الإرسال لم يبدأ بعد.');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignStart() {
  try {
    if (!window.confirm('هل تريد بدء إرسال الحملة المعتمدة الآن؟')) return;
    const data = await campaignApi(`/api/campaigns/${campaignCurrent.id}/start`, { method: 'POST' });
    campaignCurrent = data.campaign;
    campaignUpdateButtons();
    await campaignLoadList();
    campaignFlash(campaignCurrent.status === 'scheduled' ? 'تمت جدولة الحملة.' : 'بدأ إرسال الحملة.');
  } catch (error) { campaignFlash(error.message, true); }
}

function campaignMarkDirty() {
  if (!campaignCurrent) return;
  document.getElementById('campaignApproveBtn').disabled = true;
  document.getElementById('campaignStartBtn').disabled = true;
  document.getElementById('campaignApprovalNotice').textContent = 'هناك تعديلات غير محفوظة. احفظها ثم أنشئ اعتماداً جديداً.';
}

async function campaignOnTab() {
  try {
    await Promise.all([campaignLoadList(), campaignLoadCounts(), campaignLoadProducts(), campaignLoadSignals()]);
    if (!campaignLoadedOnce) {
      campaignLoadedOnce = true;
      document.querySelectorAll('#view-campaigns input, #view-campaigns textarea, #view-campaigns select').forEach(el => {
        if (el.id !== 'campaignPicker') el.addEventListener('input', campaignMarkDirty);
      });
      document.querySelectorAll('input[name="campaignSource"]').forEach(el => el.addEventListener('change', campaignToggleKeywordOptions));
      document.getElementById('campaignKeywordInput').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (campaignAddKeyword(event.currentTarget.value)) event.currentTarget.value = '';
      });
      document.getElementById('campaignMessage').addEventListener('input', campaignRenderContentPreview);
      document.getElementById('campaignMedia').addEventListener('change', campaignRenderContentPreview);
      campaignToggleKeywordOptions();
      campaignRenderKeywordTags();
      campaignRenderContentPreview();
    }
  } catch (error) { campaignFlash(error.message, true); }
}

window.campaignOnTab = campaignOnTab;
