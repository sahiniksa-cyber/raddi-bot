/* Instagram channel front-end. Flow:
 *   1) A simple connect/activate page (view-instagram) — like the WhatsApp
 *      الربط screen. Before linking, that's all the merchant sees.
 *   2) After linking, the SAME WhatsApp settings form opens in Instagram mode
 *      (see igOpenSettings / settingsChannel in index.html) — identical
 *      formatting — with the Instagram inbox as a panel inside it.
 * Talks ONLY to /api/instagram/*. */

const igToast = (msg, err) => (window.toast ? window.toast(msg, err) : console.log(msg));

async function igLoadStatus() {
  try {
    const r = await fetch('/api/instagram/status');
    if (!r.ok) return;
    const d = await r.json();
    const connected = d.connected === true;
    const st = document.getElementById('igStatus');
    if (st) st.textContent = connected
      ? ('✅ حسابك مربوط: @' + (d.username || '') + ' — التفعيل جاهز.')
      : 'اربط حساب إنستقرام للأعمال عشان يبدأ البوت يرد تلقائيًا على الرسائل الخاصة (DM).';
    const cbtn = document.getElementById('igConnectBtn');
    const obtn = document.getElementById('igOpenSettingsBtn');
    const dbtn = document.getElementById('igDisconnectBtn');
    if (cbtn) cbtn.style.display = connected ? 'none' : 'inline-block';
    if (obtn) obtn.style.display = connected ? 'inline-block' : 'none';
    if (dbtn) dbtn.style.display = connected ? 'inline-block' : 'none';
    // Status + stats panel inside the settings view (mirrors the WhatsApp header).
    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setTxt('igStatusText', connected ? ('مربوط: @' + (d.username || '')) : 'غير مربوط');
    // Plain Western digits (mirrors the WhatsApp stats). Using toLocaleString('ar-EG')
    // produced Arabic-Indic numerals whose glyphs the stat font lacks, so they
    // rendered as ◆ tofu boxes.
    setTxt('igStActive', Number(d.activeConversations || 0));
    setTxt('igStReplies', Number(d.repliesCount || 0));
    setTxt('igStUser', connected ? ('@' + (d.username || '')) : '—');
    setTxt('igStModel', String(d.model || '—').substring(0, 10));
    if (connected) igLoadInbox();
  } catch (_) { /* non-fatal */ }
}

async function igDisconnect() {
  try { await fetch('/api/instagram/disconnect', { method: 'POST' }); } catch (_) { /* ignore */ }
  if (typeof exitIgCfgMode === 'function') exitIgCfgMode();
  if (typeof goTab === 'function') goTab('instagram');
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
      ? rows.map((c) => '<div class="ig-conv" style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer" onclick="igOpen(\'' + c.id + '\')">@' + escapeHtmlIg(c.participant_username || c.participant_id) + '</div>').join('')
      : '<p class="hint">لا توجد محادثات بعد.</p>';
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
      '<div class="ig-msg ig-' + m.direction + '" style="margin:6px 0;padding:8px 11px;border-radius:10px;background:' +
      (m.direction === 'inbound' ? 'var(--bg-soft,#f1f5f9)' : 'var(--green-bg,#dcfce7)') + '">' +
      escapeHtmlIg(m.content || '') + '</div>').join('');
    thread.innerHTML = '<div style="margin-top:12px">' + msgs +
      '<div style="display:flex;gap:8px;margin-top:8px"><input id="igReply" placeholder="ردّك..." style="flex:1">' +
      '<button class="add-btn" onclick="igSend(\'' + id + '\')">إرسال</button></div></div>';
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

// ── Instagram sandbox test chat (mirrors the WhatsApp جرّب البوت) ────────────
let igTestSessionId = 'igtest-' + Date.now();
function igAppendTestMsg(role, text, meta) {
  const c = document.getElementById('igTestChat');
  if (!c) return null;
  const el = document.createElement('div');
  el.className = 'tm ' + role;
  el.innerHTML = escapeHtmlIg(text) + (meta ? '<div class="tm-meta">' + escapeHtmlIg(meta) + '</div>' : '');
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
  return el;
}
async function igSendTestMsg() {
  const inp = document.getElementById('igTestInput');
  const txt = inp ? inp.value.trim() : '';
  if (!txt) return;
  const btn = document.getElementById('igTestSendBtn');
  if (btn) btn.disabled = true;
  if (inp) inp.disabled = true;
  igAppendTestMsg('user', txt);
  if (inp) inp.value = '';
  const c = document.getElementById('igTestChat');
  const typingEl = document.createElement('div');
  typingEl.className = 'tm bot typing';
  if (c) { c.appendChild(typingEl); c.scrollTop = 999999; }
  try {
    const r = await fetch('/api/instagram/test-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: txt, sessionId: igTestSessionId }),
    });
    const d = await r.json();
    typingEl.remove();
    if (!d.success) {
      igAppendTestMsg('bot', '❌ ' + (d.message || 'خطأ'), 'خطأ');
    } else if (d.empty || !d.reply) {
      igAppendTestMsg('bot', 'ما وصل رد — تأكد من مفتاح الـ AI في الإعدادات.', 'تنبيه');
    } else {
      igAppendTestMsg('bot', d.reply, '🤖 AI · 🧠 ' + (d.historyLength || 0) + ' رسالة في الذاكرة');
      if (d.aiEnabled === false) {
        igAppendTestMsg('bot', '⚠️ ملاحظة: "تشغيل الرد الآلي" موقوف حاليًا — التجربة تشتغل، لكن العملاء الحقيقيين ما يوصلهم رد حتى تفعّله وتحفظ.', 'تنبيه');
      }
    }
  } catch (_) {
    typingEl.remove();
    igAppendTestMsg('bot', '❌ تعذر الاتصال', 'خطأ');
  } finally {
    if (btn) btn.disabled = false;
    if (inp) { inp.disabled = false; inp.focus(); }
  }
}
async function igResetTestChat() {
  igTestSessionId = 'igtest-' + Date.now();
  const c = document.getElementById('igTestChat');
  if (c) c.innerHTML = '';
  try {
    await fetch('/api/instagram/test-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true, sessionId: igTestSessionId }),
    });
  } catch (_) { /* ignore */ }
  igToast('✅ بدأت محادثة جديدة');
}

// goTab('instagram') shows the connect page; refresh its status.
window.igOnTab = function igOnTab() { igLoadStatus(); };

// Reveal the WhatsApp/Instagram channel switcher ONLY when the Instagram
// feature is enabled. When INSTAGRAM_ENABLED is off, /api/instagram/status
// returns 503 and the switcher stays hidden — so nothing half-finished is
// exposed to merchants and the dashboard looks like the WhatsApp-only version.
(function igGateSwitch() {
  fetch('/api/instagram/status').then(function (r) {
    if (r.ok) { const cs = document.querySelector('.chan-switch'); if (cs) cs.style.display = ''; }
  }).catch(function () { /* keep hidden */ });
})();
