/* Instagram channel — connection + inbox, living INSIDE the shared settings
 * page (Instagram mode). The bot-brain settings are the exact same WhatsApp
 * form (see igOpenSettings / settingsChannel in index.html), so formatting is
 * identical. This file talks ONLY to /api/instagram/*.
 *
 * Gating: until the account is linked, everything except the connection panel
 * is hidden (igApplyGate), so settings appear only after linking. */

const igToast = (msg, err) => (window.toast ? window.toast(msg, err) : console.log(msg));

// Show/hide the settings panels based on connection: only the connect panel
// (and the Instagram-mode banner) stay visible until the account is linked.
function igApplyGate(connected) {
  const sw = document.querySelector('#view-settings .sw');
  if (!sw) return;
  [...sw.children].forEach((el) => {
    if (el.id === 'igCfgBanner' || el.classList.contains('ig-connect')) { el.classList.remove('ig-hidden'); return; }
    if (connected) el.classList.remove('ig-hidden'); else el.classList.add('ig-hidden');
  });
}

async function igLoadStatus() {
  try {
    const r = await fetch('/api/instagram/status');
    if (!r.ok) return;
    const d = await r.json();
    const connected = d.connected === true;
    const st = document.getElementById('igStatus');
    if (st) st.textContent = connected ? ('✅ مربوط: @' + (d.username || '')) : 'غير مربوط بعد.';
    const pill = document.getElementById('igStatusPill');
    if (pill) pill.textContent = connected ? 'مربوط' : '';
    const cbtn = document.getElementById('igConnectBtn');
    const dbtn = document.getElementById('igDisconnectBtn');
    if (cbtn) cbtn.style.display = connected ? 'none' : '';
    if (dbtn) dbtn.style.display = connected ? '' : 'none';
    const hint = document.getElementById('igNotLinkedHint');
    if (hint) hint.style.display = connected ? 'none' : '';
    igApplyGate(connected);
    if (connected) igLoadInbox();
  } catch (_) { /* non-fatal */ }
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

// Kept for safety if goTab('instagram') is ever called; the real entry is the
// Instagram channel chip → igOpenSettings().
window.igOnTab = function igOnTab() { igLoadStatus(); };
