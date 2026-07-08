/* Instagram tab — connection, seeded settings, inbox, manual reply.
 * Isolated from WhatsApp: talks ONLY to /api/instagram/* endpoints and never
 * touches the WhatsApp /api/config endpoint. Settings arrive pre-filled from
 * the merchant's WhatsApp config (seeded server-side on first open); the
 * merchant only edits. Any fields not shown here are still carried over,
 * because igSaveConf spreads the existing (seeded) config before overriding. */

let igConfig = {};
const igToast = (msg, err) => (window.toast ? window.toast(msg, err) : console.log(msg));

async function igLoadStatus() {
  try {
    const r = await fetch('/api/instagram/status');
    if (!r.ok) return;
    const d = await r.json();
    const st = document.getElementById('igStatus');
    if (st) st.textContent = d.connected ? ('مربوط: @' + (d.username || '')) : 'غير مربوط';
    const cbtn = document.getElementById('igConnectBtn');
    const dbtn = document.getElementById('igDisconnectBtn');
    if (cbtn) cbtn.style.display = d.connected ? 'none' : '';
    if (dbtn) dbtn.style.display = d.connected ? '' : 'none';
    const toggle = document.getElementById('ig_enabled');
    if (toggle) toggle.checked = d.aiEnabled === true;
  } catch (_) { /* non-fatal */ }
}

async function igLoadConf() {
  try {
    const r = await fetch('/api/instagram/config');
    if (r.status === 401) { location.href = '/login'; return; }
    if (!r.ok) return;
    const d = await r.json();
    igConfig = d.config || {};
    igFillForm(igConfig, d.enabled);
  } catch (_) { igToast('❌ تعذر تحميل إعدادات إنستقرام', true); }
}

function igSetVal(id, val) { const el = document.getElementById(id); if (el) el.value = val == null ? '' : val; }
function igGetVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }

function igFillForm(c, enabled) {
  const t = document.getElementById('ig_enabled'); if (t) t.checked = enabled === true;
  igSetVal('ig_storeName', c.storeName);
  igSetVal('ig_storeDesc', c.storeDescription);
  igSetVal('ig_welcomeMsg', c.welcomeMessage);
  igSetVal('ig_workHours', c.workingHours);
  igSetVal('ig_botInstr', c.botInstructions);
  igSetVal('ig_maxLen', c.maxResponseLength || 300);
  const r = c.replyStyle || {};
  igSetVal('ig_rsEmployeeName', r.employeeName);
  igSetVal('ig_rsTone', r.tone || 'ودي ومحترم');
  igSetVal('ig_rsDialect', r.dialect || 'السعودية الخفيفة');
  igSetVal('ig_rsEmoji', r.emojiLevel || 'none');
  igSetVal('ig_rsReplyLength', r.replyLength || 'medium');
}

async function igSaveConf() {
  // Spread the existing (seeded) config first so fields not shown in this form
  // (keywords, escalation contacts, delays, ...) are preserved on save.
  const nc = {
    ...igConfig,
    storeName: igGetVal('ig_storeName').trim(),
    storeDescription: igGetVal('ig_storeDesc').trim(),
    welcomeMessage: igGetVal('ig_welcomeMsg').trim(),
    workingHours: igGetVal('ig_workHours').trim(),
    botInstructions: igGetVal('ig_botInstr').trim(),
    maxResponseLength: parseInt(igGetVal('ig_maxLen'), 10) || 300,
    replyStyle: {
      ...(igConfig.replyStyle || {}),
      employeeName: igGetVal('ig_rsEmployeeName').trim(),
      tone: igGetVal('ig_rsTone'),
      dialect: igGetVal('ig_rsDialect'),
      emojiLevel: igGetVal('ig_rsEmoji'),
      replyLength: igGetVal('ig_rsReplyLength'),
    },
  };
  const enabled = !!(document.getElementById('ig_enabled') && document.getElementById('ig_enabled').checked);
  try {
    const r = await fetch('/api/instagram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, config: nc }),
    });
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json();
    if (d.success) { igConfig = nc; igToast('✅ تم حفظ إعدادات إنستقرام'); } else igToast('❌ تعذر الحفظ', true);
  } catch (_) { igToast('❌ تعذر الحفظ', true); }
}

async function igDisconnect() {
  try { await fetch('/api/instagram/disconnect', { method: 'POST' }); } catch (_) { /* ignore */ }
  igLoadStatus();
}

async function igLoadInbox() {
  try {
    const r = await fetch('/api/instagram/conversations');
    if (!r.ok) return;
    const d = await r.json();
    const list = document.getElementById('igConvList');
    if (!list) return;
    const rows = d.conversations || [];
    list.innerHTML = rows.length
      ? rows.map((c) => '<div class="ig-conv" onclick="igOpen(\'' + c.id + '\')">@' + (c.participant_username || c.participant_id) + '</div>').join('')
      : '<div class="muted">لا توجد محادثات بعد</div>';
  } catch (_) { /* non-fatal */ }
}

async function igOpen(id) {
  try {
    const r = await fetch('/api/instagram/conversations/' + encodeURIComponent(id) + '/messages');
    if (!r.ok) return;
    const d = await r.json();
    const thread = document.getElementById('igThread');
    if (!thread) return;
    const msgs = (d.messages || []).map((m) =>
      '<div class="ig-msg ig-' + m.direction + '">' + escapeHtmlIg(m.content || '') + '</div>').join('');
    thread.innerHTML = msgs +
      '<div class="ig-reply-row"><input id="igReply" placeholder="ردّك..."><button onclick="igSend(\'' + id + '\')">إرسال</button></div>';
  } catch (_) { /* non-fatal */ }
}

async function igSend(id) {
  const input = document.getElementById('igReply');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  try {
    await fetch('/api/instagram/conversations/' + encodeURIComponent(id) + '/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    igOpen(id);
  } catch (_) { igToast('❌ تعذر الإرسال', true); }
}

function escapeHtmlIg(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Called by goTab('instagram') in index.html.
window.igOnTab = function igOnTab() { igLoadStatus(); igLoadConf(); igLoadInbox(); };
