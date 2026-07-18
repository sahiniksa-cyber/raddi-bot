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
let campaignHistoryPollTimer = null;
let campaignHistoryCountdownTimer = null;
let campaignHistoryCurrentStatus = null;
let campaignHistoryQrVersion = 0;
let campaignMediaUploadPromise = null;

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
  if (!response.ok) {
    const reference = data?.code ? ` (رمز الخطأ: ${data.code})` : '';
    throw new Error(data?.message || `تعذر تنفيذ الطلب${reference}`);
  }
  return data;
}

function campaignGoStep(step) {
  const activePage = document.querySelector('[data-campaign-page].active');
  const pendingMedia = document.getElementById('campaignMedia')?.files?.length || 0;
  if (activePage?.dataset.campaignPage === 'content' && step !== 'content' && pendingMedia > 0) {
    campaignFlash('الملف مختار لكنه لم يُرفع بعد. اضغط «حفظ والمتابعة» لرفعه تلقائياً قبل الانتقال.', true);
    return false;
  }
  campaignVisited.add(step);
  document.querySelectorAll('[data-campaign-page]').forEach(el => el.classList.toggle('active', el.dataset.campaignPage === step));
  document.querySelectorAll('[data-campaign-step]').forEach(el => {
    el.classList.toggle('active', el.dataset.campaignStep === step);
    el.classList.toggle('visited', campaignVisited.has(el.dataset.campaignStep));
  });
  if (step === 'review') campaignRenderReview();
  if (step === 'content') void campaignRefreshContentPreview();
  window.scrollTo(0, 0);
  return true;
}

function campaignFormPayload() {
  const source = document.querySelector('input[name="campaignSource"]:checked')?.value || 'contacts';
  const scheduled = document.getElementById('campaignScheduledAt')?.value;
  const numbers = String(document.getElementById('campaignNumbers')?.value || '')
    .split(/[\n,;]+/).map(value => value.trim()).filter(Boolean);
  return {
    name: document.getElementById('campaignName').value.trim(),
    goal: document.getElementById('campaignGoal').value.trim(),
    messageText: document.getElementById('campaignMessage').value.trim(),
    audienceRules: {
      source,
      sourceCampaignId: source === 'saved_campaign' ? campaignCurrent?.audience_rules?.sourceCampaignId : undefined,
      states: [],
      productKeys: [],
      searchTerms: [...campaignSearchTerms],
      dateFrom: document.getElementById('campaignDateFrom')?.value || null,
      dateTo: document.getElementById('campaignDateTo')?.value || null,
      numbers,
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
  campaignUpdateButtons();
  await campaignLoadList();
  return campaignCurrent;
}

async function campaignSaveAndNext(step) {
  try {
    await campaignSave();
    const uploadedCount = await campaignUploadPendingMedia();
    campaignFlash(uploadedCount
      ? `تم حفظ المسودة ورفع ${uploadedCount} مرفق بنجاح`
      : 'تم حفظ المسودة');
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
  document.querySelector('input[name="campaignSource"][value="contacts"]').checked = true;
  document.getElementById('campaignSavedAudienceOption').hidden = true;
  document.getElementById('campaignMediaList').innerHTML = '';
  document.getElementById('campaignMedia').value = '';
  document.getElementById('campaignPicker').value = '';
  document.getElementById('campaignKeywordInput').value = '';
  document.getElementById('campaignKeywordPreview').style.display = 'none';
  document.getElementById('campaignKeywordAudienceCount').textContent = '—';
  campaignSelectedSegment = null;
  campaignAudienceCount = 0;
  document.querySelectorAll('[data-campaign-segment]').forEach(el => el.classList.remove('active'));
  const segmentDetails = document.getElementById('campaignSegmentDetails');
  if (segmentDetails) segmentDetails.hidden = true;
  campaignRenderKeywordTags();
  campaignToggleKeywordOptions();
  campaignUpdateNumbersCount();
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
  const source = rules.source === 'smart' ? 'contacts' : (rules.source || 'contacts');
  document.getElementById('campaignSavedAudienceOption').hidden = source !== 'saved_campaign';
  const sourceInput = document.querySelector(`input[name="campaignSource"][value="${source}"]`)
    || document.querySelector('input[name="campaignSource"][value="contacts"]');
  if (sourceInput) sourceInput.checked = true;
  document.getElementById('campaignNumbers').value = Array.isArray(rules.numbers) ? rules.numbers.join('\n') : '';
  document.getElementById('campaignDateFrom').value = rules.dateFrom || '';
  document.getElementById('campaignDateTo').value = rules.dateTo || '';
  document.getElementById('campaignKeywordInput').value = '';
  document.getElementById('campaignKeywordPreview').style.display = 'none';
  document.getElementById('campaignKeywordAudienceCount').textContent = '—';
  campaignRenderKeywordTags();
  campaignToggleKeywordOptions();
  campaignUpdateNumbersCount();
  const mediaKindLabels = { image: 'صورة', video: 'فيديو', document: 'مستند PDF' };
  document.getElementById('campaignMediaList').innerHTML = (campaign.media || []).map(item =>
    `<div style="display:flex;justify-content:space-between;gap:10px;padding:9px;border-bottom:1px solid var(--border)"><span>${campaignEscape(item.original_name)} · ${campaignEscape(mediaKindLabels[item.kind] || item.kind)}</span><button class="campaign-btn secondary" onclick="campaignDeleteMedia('${item.id}')">حذف</button></div>`
  ).join('') || '<div class="hint">لا توجد وسائط مرفوعة.</div>';
  campaignRenderContentPreview();
  campaignUpdateButtons();
}

function campaignEscape(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function campaignToggleKeywordOptions() {
  const source = document.querySelector('input[name="campaignSource"]:checked')?.value;
  document.querySelectorAll('[data-campaign-source-panel]').forEach(panel => {
    panel.hidden = panel.dataset.campaignSourcePanel !== source;
  });
}

function campaignSelectSource(source) {
  const input = document.querySelector(`input[name="campaignSource"][value="${source}"]`);
  if (!input) return;
  document.querySelectorAll('input[name="campaignSource"]').forEach(option => { option.checked = option === input; });
  campaignToggleKeywordOptions();
  campaignMarkDirty();
}

function campaignUpdateNumbersCount() {
  const input = document.getElementById('campaignNumbers');
  const count = document.getElementById('campaignNumbersCount');
  if (!input || !count) return;
  const numbers = new Set(input.value.split(/[\n,;]+/).map(campaignNormalizePhone).filter(Boolean));
  count.textContent = `${numbers.size} رقم صالح`;
}

function campaignNormalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length >= 9) digits = `966${digits.slice(1)}`;
  if (!digits.startsWith('966') && digits.length === 9 && digits.startsWith('5')) digits = `966${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

function campaignResetKeywordPreview() {
  const count = document.getElementById('campaignKeywordAudienceCount');
  const preview = document.getElementById('campaignKeywordPreview');
  if (count) count.textContent = '—';
  if (preview) preview.style.display = 'none';
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
  campaignResetKeywordPreview();
  campaignMarkDirty();
  return true;
}

function campaignAddKeywordFromInput() {
  const input = document.getElementById('campaignKeywordInput');
  if (!input) return;
  if (campaignAddKeyword(input.value)) input.value = '';
}

function campaignRemoveKeyword(index) {
  campaignSearchTerms.splice(index, 1);
  campaignRenderKeywordTags();
  campaignResetKeywordPreview();
  campaignMarkDirty();
}

async function campaignPreviewKeywords() {
  try {
    const source = document.querySelector('input[name="campaignSource"]:checked')?.value;
    if (source !== 'keywords') throw new Error('اختر جمهور كلمات البحث أولاً');
    if (!campaignSearchTerms.length) throw new Error('أضف كلمة بحث واحدة على الأقل واضغط Enter');
    const data = await campaignApi('/api/campaigns/audience/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audienceRules: campaignFormPayload().audienceRules }),
    });
    const preview = document.getElementById('campaignKeywordPreview');
    document.getElementById('campaignKeywordAudienceCount').textContent = String(data.count);
    const rows = (data.recipients || []).map(row => {
      const number = row.normalized_phone || row.sender;
      const name = row.customer_name ? ` · ${campaignEscape(row.customer_name)}` : '';
      return `<div class="campaign-preview-row"><b dir="ltr">${campaignEscape(number)}</b>${name}<div class="hint">الكلمة المطابقة: ${campaignEscape(row.product_name || '')}</div><div>${campaignEscape(row.evidence_text || '')}</div></div>`;
    }).join('');
    preview.innerHTML = `<b>تم تحديد ${data.count} عميل بدون تكرار.</b>${data.count > 100 ? '<div class="hint">يظهر أول 100 عميل فقط هنا، بينما الاعتماد يشمل جميع المطابقين.</div>' : ''}${rows || '<div class="hint">لا يوجد عميل مطابق حالياً.</div>'}`;
    preview.style.display = 'block';
    campaignFlash(`تم فحص الرسائل وتحديد ${data.count} عميل مطابق.`);
  } catch (error) { campaignFlash(error.message, true); }
}

function campaignRenderHistoryImport(status = {}) {
  campaignHistoryCurrentStatus = status;
  const active = ['starting', 'running'].includes(status.status);
  const labels = {
    not_started: 'لم يبدأ',
    starting: 'يبدأ الآن',
    running: status.explicit_complete ? 'اكتمل الاستلام' : 'جارٍ الاستيراد',
    completed: 'مكتمل',
    partial: 'محفوظ جزئياً',
    failed: 'تعذر الاستيراد',
    canceled: 'ملغي',
  };
  const badge = document.getElementById('campaignHistoryBadge');
  if (!badge) return;
  badge.textContent = labels[status.status] || status.status || 'غير معروف';
  document.getElementById('campaignHistoryChats').textContent = String(Number(status.conversations_total) || 0);
  document.getElementById('campaignHistoryNumbers').textContent = String(Number(status.numbers_total) || 0);
  document.getElementById('campaignHistoryMessages').textContent = String(Number(status.inbound_messages_total) || 0);
  document.getElementById('campaignHistoryStart').disabled = active;
  document.getElementById('campaignHistoryFinish').disabled = !active;
  const note = document.getElementById('campaignHistoryNote');
  const qrBox = document.getElementById('campaignHistoryQr');
  const qrImage = document.getElementById('campaignHistoryQrImage');
  const showQr = active && status.qr_ready === true;
  if (qrBox) qrBox.classList.toggle('visible', showQr);
  if (showQr && qrImage && campaignHistoryQrVersion !== Number(status.qr_version || 0)) {
    campaignHistoryQrVersion = Number(status.qr_version || 0);
    qrImage.src = `/api/campaigns/history-import/qr-image?v=${campaignHistoryQrVersion}&t=${Date.now()}`;
  }
  if (!active) campaignHistoryQrVersion = 0;
  if (status.last_error) {
    note.textContent = `تعذر الاستيراد: ${status.last_error}`;
  } else if (active && status.explicit_complete) {
    note.textContent = 'وصلت إشارة اكتمال السجل من واتساب. سيُنهي النظام جهاز الاستيراد المؤقت، بينما يبقى البوت الأساسي متصلاً.';
  } else if (active) {
    if (status.connection_status === 'reconnecting' && status.connection_error) {
      note.textContent = 'تعذر إنشاء رمز QR في المحاولة السابقة، ويعيد النظام الاتصال تلقائياً. لا يلزمك فعل شيء حتى يظهر الرمز داخل هذه الخانة.';
    } else if (status.connection_status === 'qr_ready') {
      note.textContent = 'الاستيراد ينتظر ربط جهاز مؤقت جديد. لن يبدأ عداد الخمول قبل مسح رمز QR ونجاح الاتصال.';
    } else if (['waiting_qr', 'connecting'].includes(status.connection_status)) {
      note.textContent = 'جاري إنشاء رمز QR المؤقت. سيظهر داخل هذه الخانة فور استلامه من واتساب.';
    } else if (status.connection_status === 'connected' && !status.last_event_at) {
      note.textContent = 'تم ربط الجهاز المؤقت بنجاح. ننتظر الآن دفعات المحادثات الفعلية من واتساب، وستتغير العدادات عند حفظ كل دفعة.';
    } else {
      note.textContent = `يستقبل النظام سجل واتساب بوضع القراءة فقط${status.progress ? ` — التقدم المعلن ${status.progress}%` : ''}. تتحدث الأعداد أعلاه من قاعدة البيانات الفعلية، وليست عداداً شكلياً.`;
    }
  } else if (status.status === 'completed') {
    note.textContent = 'تم حفظ السجل الذي سلّمه واتساب وأصبح قابلاً للبحث. اكتب كلمات البحث واضغط حساب العملاء لعرض الأرقام.';
  } else if (status.status === 'partial') {
    note.textContent = 'تم حفظ البيانات المستلمة، لكن واتساب لم يرسل إشارة اكتمال السجل. نتائج البحث تشمل المحادثات المحفوظة فقط.';
  } else {
    note.textContent = 'الاستيراد منفصل تماماً عن صندوق الرسائل الحي. بعد إنهائه استخدم كلمات البحث ثم راجع العدد والأرقام قبل اعتماد الحملة.';
  }

  if (active && !campaignHistoryPollTimer) {
    campaignHistoryPollTimer = window.setInterval(() => campaignLoadHistoryImport().catch(() => {}), 3000);
  } else if (!active && campaignHistoryPollTimer) {
    window.clearInterval(campaignHistoryPollTimer);
    campaignHistoryPollTimer = null;
  }
  if (active && !campaignHistoryCountdownTimer) {
    campaignHistoryCountdownTimer = window.setInterval(campaignRenderHistoryCountdown, 1000);
  } else if (!active && campaignHistoryCountdownTimer) {
    window.clearInterval(campaignHistoryCountdownTimer);
    campaignHistoryCountdownTimer = null;
  }
  campaignRenderHistoryCountdown();
}

function campaignRenderHistoryCountdown() {
  const status = campaignHistoryCurrentStatus || {};
  const active = ['starting', 'running'].includes(status.status);
  const progress = document.getElementById('campaignHistoryProgress');
  if (!progress) return;
  if (!active) {
    progress.hidden = true;
    progress.textContent = '';
    return;
  }
  const waitingForQr = ['waiting_qr', 'qr_ready', 'connecting', 'reconnecting'].includes(status.connection_status)
    && !status.connected_at;
  const target = waitingForQr ? status.auto_finish_at : (status.idle_finish_at || status.auto_finish_at);
  const remaining = target ? Math.max(0, Math.ceil((new Date(target).getTime() - Date.now()) / 1000)) : null;
  const minutes = remaining === null ? null : Math.floor(remaining / 60);
  const seconds = remaining === null ? null : remaining % 60;
  const timer = remaining === null ? 'جارٍ الحساب' : `${minutes}:${String(seconds).padStart(2, '0')}`;
  const chats = Number(status.conversations_total) || 0;
  const messages = Number(status.inbound_messages_total) || 0;
  const stage = status.connection_status === 'qr_ready'
    ? 'بانتظار مسح رمز QR'
    : status.connection_status === 'reconnecting'
      ? 'تعذر إنشاء رمز QR، يحاول النظام مجدداً'
      : waitingForQr
        ? 'جاري إنشاء رمز QR'
    : status.last_event_at
      ? 'يستقبل ويحفظ دفعات المحادثات'
      : 'متصل وينتظر أول دفعة من واتساب';
  progress.hidden = false;
  progress.innerHTML = `<b>${campaignEscape(stage)}</b> · المتبقي <strong dir="ltr">${timer}</strong><br>المحفوظ فعلياً الآن: <strong>${chats}</strong> محادثة و<strong>${messages}</strong> رسالة واردة.`;
}

async function campaignLoadHistoryImport() {
  const data = await campaignApi('/api/campaigns/history-import');
  campaignRenderHistoryImport(data.historyImport || {});
  return data.historyImport;
}

async function campaignStartHistoryImport() {
  try {
    const confirmed = window.confirm('سيظهر رمز QR مؤقت داخل خانة الحملات. امسحه من الأجهزة المرتبطة حتى يرسل واتساب سجل المحادثات فعلياً. البوت الأساسي سيبقى متصلاً، واتصال الاستيراد مؤقت وللقراءة فقط ولن يطلق أي حملة. هل تريد البدء؟');
    if (!confirmed) return;
    const data = await campaignApi('/api/campaigns/history-import/start', { method: 'POST' });
    campaignRenderHistoryImport(data.historyImport || {});
    campaignFlash('بدأ الاستيراد. امسح رمز QR المؤقت الذي سيظهر داخل الخانة؛ لن تُرسل أي رسالة.');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignFinishHistoryImport() {
  try {
    const data = await campaignApi('/api/campaigns/history-import/finish', { method: 'POST' });
    campaignRenderHistoryImport(data.historyImport || {});
    campaignFlash('تم إنهاء جهاز الاستيراد المؤقت وحفظ البيانات المستلمة. البوت الأساسي لم يتوقف أثناء الاستيراد.');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignOpen(id) {
  if (!id) return;
  try {
    const data = await campaignApi(`/api/campaigns/${id}`);
    document.getElementById('campaignMedia').value = '';
    campaignFill(data.campaign);
    campaignGoStep('audience');
  } catch (error) { campaignFlash(error.message, true); }
}

async function campaignReuseAudience() {
  try {
    if (!campaignCurrent?.id) throw new Error('اختر حملة محفوظة أولاً');
    const confirmed = window.confirm('سيتم إنشاء مسودة جديدة بنفس قائمة المستلمين والنص. لن يبدأ أي إرسال، والوسائط تحتاج إضافتها من جديد. هل تريد المتابعة؟');
    if (!confirmed) return;
    const data = await campaignApi(`/api/campaigns/${campaignCurrent.id}/reuse-audience`, { method: 'POST' });
    const detail = await campaignApi(`/api/campaigns/${data.campaign.id}`);
    campaignFill(detail.campaign);
    campaignGoStep('audience');
    await campaignLoadList();
    campaignFlash('تم إنشاء مسودة جديدة بنفس الجمهور المحفوظ بدون إعادة البحث. لم يبدأ أي إرسال.');
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

  const savedItems = Array.isArray(campaignCurrent?.media) ? campaignCurrent.media : [];
  const selectedItems = [...(document.getElementById('campaignMedia')?.files || [])];
  const mediaCount = savedItems.length + selectedItems.length;
  const documentCount = savedItems.filter(item => item.kind === 'document').length
    + selectedItems.filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)).length;
  mediaBox.classList.toggle('visible', mediaCount > 0);
  mediaLabel.textContent = mediaCount === 1 && documentCount === 1
    ? 'مستند PDF واحد'
    : mediaCount === 1
      ? 'صورة أو فيديو واحد'
      : `${mediaCount} مرفقات${documentCount ? `، منها ${documentCount} PDF` : ''}`;
  if (selectedItems.length) mediaLabel.textContent += ` · ${selectedItems.length} بانتظار الرفع`;
  audienceCount.textContent = String(campaignAudienceCount);
  itemsCount.textContent = selectedItems.length
    ? `${selectedItems.length} مرفق بانتظار الرفع`
    : mediaCount
      ? `نص + ${mediaCount} وسائط لكل عميل`
      : 'نص واحد لكل عميل';
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
  const seenCustomers = new Set();
  const rows = campaignSignals.filter(row => {
    if (row.customer_state !== campaignSelectedSegment) return false;
    const key = row.normalized_phone || row.sender;
    if (!key || seenCustomers.has(key)) return false;
    seenCustomers.add(key);
    return true;
  });
  const content = rows.map(row => {
    const identity = row.customer_name || row.normalized_phone || row.sender || 'عميل بدون اسم';
    const product = row.product_name || 'لم يُحدد المنتج';
    const evidence = row.evidence_text || 'لا توجد تفاصيل إضافية محفوظة.';
    const order = row.order_reference ? `<span class="hint">رقم الطلب: ${campaignEscape(row.order_reference)}</span>` : '';
    const orderDate = row.order_date ? `<span class="hint">تاريخ الطلب: ${campaignEscape(row.order_date)}</span>` : '';
    const subscription = row.subscription_start_date || row.subscription_end_date
      ? `<span class="hint">الاشتراك: ${campaignEscape(row.subscription_start_date || 'غير محدد')} — ${campaignEscape(row.subscription_end_date || 'غير محدد')}</span>`
      : '';
    return `<div class="campaign-segment-row"><div class="campaign-segment-row-top"><b>${campaignEscape(identity)}</b><span class="hint">${campaignEscape(product)}</span></div><p>${campaignEscape(evidence)}</p><div style="display:flex;gap:10px;flex-wrap:wrap">${order}${orderDate}${subscription}</div></div>`;
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

async function campaignUploadPendingMedia() {
  const input = document.getElementById('campaignMedia');
  const files = [...(input?.files || [])];
  if (!files.length) return 0;
  if (campaignMediaUploadPromise) return campaignMediaUploadPromise;

  campaignMediaUploadPromise = (async () => {
    if (!campaignCurrent) await campaignSave();
    const form = new FormData();
    files.forEach(file => form.append('media', file));
    const result = await campaignApi(`/api/campaigns/${campaignCurrent.id}/media`, { method: 'POST', body: form });
    input.value = '';
    const detail = await campaignApi(`/api/campaigns/${campaignCurrent.id}`);
    campaignFill(detail.campaign);
    await campaignLoadList();
    return Array.isArray(result.media) ? result.media.length : files.length;
  })();

  try {
    return await campaignMediaUploadPromise;
  } finally {
    campaignMediaUploadPromise = null;
  }
}

async function campaignUploadMedia() {
  try {
    const input = document.getElementById('campaignMedia');
    if (!input.files.length) throw new Error('اختر صورة أو فيديو أو مستند PDF أولاً');
    const uploadedCount = await campaignUploadPendingMedia();
    campaignGoStep('content');
    campaignFlash(`تم رفع ${uploadedCount} مرفق بنجاح`);
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
    const sourceLabels = { contacts: 'الأرقام المحددة', all: 'كل العملاء', conversations: 'من تواصل في الفترة المحددة', smart: 'قائمة عملاء محفوظة سابقاً', keywords: 'كلمات البحث', saved_campaign: 'جمهور حملة محفوظة بدون إعادة بحث' };
    const source = sourceLabels[campaignCurrent.audience_rules?.source] || 'الأرقام المحددة';
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
  const reuse = document.getElementById('campaignReuseAudienceBtn');
  if (!approve || !start) return;
  approve.disabled = !(campaignCurrent?.status === 'ready_for_approval' && campaignApproval);
  start.disabled = campaignCurrent?.status !== 'approved';
  pause.disabled = !['sending', 'scheduled'].includes(campaignCurrent?.status);
  resume.disabled = campaignCurrent?.status !== 'paused';
  cancel.disabled = !campaignCurrent || ['completed', 'canceled', 'failed'].includes(campaignCurrent.status);
  if (reuse) reuse.disabled = !campaignCurrent?.approved_at || !(Number(campaignCurrent.audience_count) > 0);
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

function campaignBindControls() {
  if (campaignLoadedOnce) return;
  campaignLoadedOnce = true;
  document.querySelectorAll('#view-campaigns input, #view-campaigns textarea, #view-campaigns select').forEach(el => {
    if (el.id !== 'campaignPicker') el.addEventListener('input', campaignMarkDirty);
  });
  document.querySelectorAll('input[name="campaignSource"]').forEach(el => el.addEventListener('change', campaignToggleKeywordOptions));
  document.getElementById('campaignKeywordInput').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    campaignAddKeywordFromInput();
  });
  document.getElementById('campaignMessage').addEventListener('input', campaignRenderContentPreview);
  document.getElementById('campaignMedia').addEventListener('change', campaignRenderContentPreview);
  document.getElementById('campaignNumbers').addEventListener('input', campaignUpdateNumbersCount);
  campaignToggleKeywordOptions();
  campaignRenderKeywordTags();
  campaignRenderContentPreview();
}

async function campaignOnTab() {
  campaignBindControls();
  const [listResult, , , historyResult] = await Promise.allSettled([campaignLoadList(), campaignLoadCounts(), campaignLoadSignals(), campaignLoadHistoryImport()]);
  if (listResult.status === 'rejected') campaignFlash(`تعذر تحميل الحملات المحفوظة: ${listResult.reason.message}`, true);
  if (historyResult.status === 'rejected') campaignFlash(`تعذر تحميل حالة استيراد المحادثات: ${historyResult.reason.message}`, true);
}

window.campaignOnTab = campaignOnTab;
