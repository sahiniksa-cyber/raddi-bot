'use strict';
/* سلة section — injected as a NATIVE tab inside the جواب dashboard SPA. Uses the
   platform's own identity (green #16a34a, Fatima, white .panel cards, .green-btn,
   .chip). Talks to /api/salla/* (gated behind SALLA_CRM_ENABLED; a 503 shows a
   "not enabled yet" note). goTab('salla') is called by the sidebar tab. */
(function () {
  var API = '/api/salla';
  var state = { sub: 'messages', segment: 'all', search: '', primed: false };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(v) { return v == null ? '—' : Number(v).toLocaleString('ar-SA') + ' ر.س'; }
  function num(v) { return Number(v || 0).toLocaleString('ar-SA'); }
  function when(v) { if (!v) return '—'; try { return new Date(v).toLocaleString('ar-SA'); } catch (e) { return v; } }
  function q(sel) { return document.querySelector(sel); }

  var LIFECYCLE_AR = { 'Lead': 'محتمل', 'Engaged Lead': 'محتمل متفاعل', 'Abandoned Cart Lead': 'سلة متروكة', 'First-Time Customer': 'أول شراء', 'Repeat Customer': 'متكرر', 'Recovered Customer': 'مسترجع', 'Inactive Customer': 'خامل' };
  var SEG_AR = { asked_not_ordered: 'سأل ولم يطلب', asked_then_ordered: 'سأل ثم طلب', ordered_then_contacted: 'طلب ثم تواصل', ordered_no_contact: 'طلب بدون تواصل', cart_abandoned_no_purchase: 'سلة متروكة', cart_recovered_then_purchased: 'سلة مسترجعة', repeat_customer: 'متكرر' };
  var EV_AR = { order_created: 'أنشأ طلباً', cart_abandoned: 'ترك سلة', cart_recovered: 'استرجع السلة', message: 'رسالة واتساب', conversation_started: 'بدأ محادثة' };

  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}))
      .then(function (r) {
        if (r.status === 503) { var e = new Error('disabled'); e.disabled = true; throw e; }
        if (!r.ok) { var e2 = new Error('http_' + r.status); e2.status = r.status; throw e2; }
        return r.status === 204 ? {} : r.json();
      });
  }
  function disabled(msg) { return '<div class="sl-disabled">' + (msg || 'ميزة سلة غير مفعّلة بعد. تُفعّل بعد ربط المتجر.') + '</div>'; }

  /* ---------- styles (platform tokens; white + green) ---------- */
  var CSS = ''
    + '#view-salla .sl-wrap{max-width:940px;margin:0 auto;padding:22px 18px 60px}'
    + '#view-salla .sl-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap}'
    + '#view-salla .sl-title{font-size:19px;font-weight:700;letter-spacing:-.02em}'
    + '#view-salla .sl-subttl{font-size:12.5px;color:var(--text-soft);margin-top:2px}'
    + '#view-salla .sl-conn{font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;background:var(--green-bg);border:1px solid var(--green-border);color:var(--green2)}'
    + '#view-salla .sl-conn.off{background:var(--bg-soft);border-color:var(--border);color:var(--text-soft)}'
    + '#view-salla .sl-subtabs{display:flex;gap:2px;background:var(--bg-soft);padding:4px;border-radius:11px;border:1px solid var(--border);margin-bottom:20px}'
    + '#view-salla .sl-subtab{flex:1;padding:8px 10px;border-radius:8px;border:0;background:transparent;color:var(--text-soft);font-family:var(--font);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}'
    + '#view-salla .sl-subtab.active{background:#fff;color:var(--green2);font-weight:700;box-shadow:var(--shadow-xs)}'
    + '#view-salla .sl-pane{display:none} #view-salla .sl-pane.active{display:block}'
    + '#view-salla .sl-panel{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px}'
    + '#view-salla .sl-note{display:flex;gap:9px;background:var(--green-bg);border:1px solid var(--green-border);border-radius:12px;padding:12px;font-size:12.5px;color:var(--green2);line-height:1.7;margin-bottom:16px}'
    + '#view-salla .sl-row{display:flex;align-items:center;justify-content:space-between;gap:10px}'
    + '#view-salla .sl-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}'
    + '#view-salla .sl-name{font-size:14.5px;font-weight:600}'
    + '#view-salla .sl-slug{font-size:11px;font-family:Consolas,monospace;padding:2px 7px;border-radius:6px;background:var(--bg-soft);color:var(--text-soft)}'
    + '#view-salla textarea.sl-msg{margin:12px 0 0;min-height:58px}'
    + '#view-salla .sl-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}'
    + '#view-salla .sl-var{font-size:11.5px;padding:4px 9px;border-radius:8px;background:var(--green-bg);border:1px solid var(--green-border);color:var(--green2);cursor:pointer;font-family:var(--font)}'
    + '#view-salla .sl-saverow{display:flex;align-items:center;justify-content:space-between;margin-top:10px}'
    + '#view-salla .sl-saved{color:var(--green2);font-size:12px;opacity:0;transition:opacity .2s} #view-salla .sl-saved.show{opacity:1}'
    + '#view-salla .sl-switch{position:relative;width:42px;height:23px;border-radius:999px;background:var(--border-strong);border:0;cursor:pointer;transition:background .15s;flex:none}'
    + '#view-salla .sl-switch.on{background:var(--green)}'
    + '#view-salla .sl-switch::after{content:"";position:absolute;top:3px;right:3px;width:17px;height:17px;background:#fff;border-radius:50%;transition:transform .15s;box-shadow:0 1px 2px rgba(15,23,42,.25)}'
    + '#view-salla .sl-switch.on::after{transform:translateX(-19px)}'
    + '#view-salla .sl-prog-l{display:flex;justify-content:space-between;font-size:12px;color:var(--text-soft);margin-bottom:5px}'
    + '#view-salla .sl-prog{height:8px;background:var(--bg-soft);border-radius:999px;overflow:hidden;margin-bottom:11px}'
    + '#view-salla .sl-prog>span{display:block;height:100%;background:var(--green);border-radius:999px;transition:width .4s}'
    + '#view-salla .sl-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}'
    + '#view-salla .sl-toolbar .sl-search{flex:1;min-width:200px}'
    + '#view-salla .sl-toolbar input{margin-bottom:0}'
    + '#view-salla .sl-segs{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}'
    + '#view-salla .sl-seg{font-size:12.5px;padding:6px 13px;border-radius:999px;background:var(--card);border:1px solid var(--border);color:var(--text-soft);cursor:pointer;font-family:var(--font)}'
    + '#view-salla .sl-seg:hover{border-color:var(--green-border)} #view-salla .sl-seg.active{background:var(--green);color:#fff;border-color:var(--green)}'
    + '#view-salla .sl-table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}'
    + '#view-salla .sl-table th,#view-salla .sl-table td{text-align:start;padding:10px 12px}'
    + '#view-salla .sl-table thead tr{color:var(--text-dim);font-size:11.5px;border-bottom:1px solid var(--border)}'
    + '#view-salla .sl-table tbody tr{border-bottom:1px solid var(--bg-soft);cursor:pointer}'
    + '#view-salla .sl-table tbody tr:last-child{border-bottom:0}'
    + '#view-salla .sl-table tbody tr:hover{background:var(--bg-soft)}'
    + '#view-salla .sl-tag{font-size:11.5px;padding:2px 9px;border-radius:999px;background:var(--green-bg);color:var(--green2);white-space:nowrap}'
    + '#view-salla .sl-tag.warn{background:#fffbeb;color:#b45309}'
    + '#view-salla .sl-count{color:var(--text-soft);font-size:12.5px;font-weight:600}'
    + '#view-salla .sl-empty,#view-salla .sl-disabled{color:var(--text-soft);text-align:center;padding:34px;font-size:13px}'
    + '.sl-drawer{position:fixed;inset-block:0;inset-inline-start:0;width:min(440px,96vw);background:var(--card);border-inline-end:1px solid var(--border);box-shadow:0 0 46px rgba(15,23,42,.2);transform:translateX(100%);transition:transform .2s;overflow:auto;z-index:600;font-family:var(--font)}'
    + '.sl-drawer.open{transform:translateX(0)}'
    + '.sl-drawer .dh{display:flex;justify-content:space-between;align-items:center;padding:15px 16px;border-bottom:1px solid var(--border)}'
    + '.sl-drawer .dh strong{font-size:15px;font-weight:700}'
    + '.sl-drawer .db{padding:16px}'
    + '.sl-kv{display:grid;grid-template-columns:100px 1fr;gap:6px 10px;font-size:12.5px;margin:10px 0 14px}'
    + '.sl-kv div:nth-child(odd){color:var(--text-soft)}'
    + '.sl-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:6px}'
    + '.sl-metric{background:var(--bg-soft);border:1px solid var(--border);border-radius:11px;padding:10px}'
    + '.sl-metric .n{font-size:17px;font-weight:700} .sl-metric .l{font-size:10.5px;color:var(--text-dim)}'
    + '.sl-drawer .sl-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}'
    + '.sl-drawer .sl-tag{font-size:11.5px;padding:2px 9px;border-radius:999px;background:var(--green-bg);color:var(--green2)}'
    + '.sl-sec{font-size:11.5px;color:var(--text-dim);margin:14px 0 8px;font-weight:700}'
    + '.sl-tl{border-inline-start:2px solid var(--bg-soft);padding-inline-start:13px;margin-inline-start:5px}'
    + '.sl-tl .it{position:relative;padding:6px 0;font-size:12.5px}'
    + '.sl-tl .it::before{content:"";position:absolute;inset-inline-start:-18px;top:10px;width:7px;height:7px;border-radius:50%;background:var(--green)}'
    + '.sl-tl .w{color:var(--text-dim);font-size:11px}'
    + '.sl-x{background:none;border:0;color:var(--text-dim);font-size:22px;cursor:pointer;line-height:1}'
    + '@media(max-width:560px){#view-salla .sl-table th:nth-child(4),#view-salla .sl-table td:nth-child(4){display:none}#view-salla .sl-subtab{font-size:12px;padding:8px 6px}}';

  function viewHTML() {
    return '<div class="sl-wrap">'
      + '<div class="sl-head"><div><div class="sl-title">متجر سلة</div><div class="sl-subttl">تكامل سلة × جواب · نظام العملاء الموحّد</div></div>'
      + '<span class="sl-conn off" id="slConn">غير مربوط</span></div>'
      + '<div class="sl-subtabs">'
      + '<button class="sl-subtab active" data-sub="messages">الرسائل الجاهزة</button>'
      + '<button class="sl-subtab" data-sub="connect">الربط والمزامنة</button>'
      + '<button class="sl-subtab" data-sub="customers">العملاء والشرائح</button></div>'
      // messages
      + '<div class="sl-pane active" data-pane="messages">'
      + '<div class="sl-note"><span>💬</span><span>فعّل حالة الطلب واكتب الرسالة اللي يرسلها البوت للعميل تلقائياً لما تتغيّر حالة طلبه في سلة. استعمل المتغيّرات لتخصيص الرسالة.</span></div>'
      + '<div id="slStatusList"></div></div>'
      // connect
      + '<div class="sl-pane" data-pane="connect">'
      + '<div class="sl-panel" id="slStore"><div class="sl-count">جارٍ التحميل…</div></div>'
      + '<div class="sl-panel"><div class="sl-name" style="margin-bottom:2px">ربط المتجر</div>'
      + '<div class="hint">إذا ثبّتّ التطبيق على متجرك في سلة وما ظهر مربوطاً، أدخل معرّف المتجر لربطه بحسابك.</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><input id="slMerchant" placeholder="معرّف المتجر" style="flex:1;min-width:180px;margin-bottom:0"><button class="green-btn" id="slLink" style="margin:0">ربط</button></div>'
      + '<div id="slLinkMsg" class="hint" style="margin:8px 0 0"></div></div>'
      + '<div class="sl-panel"><div class="sl-name" style="margin-bottom:2px">مزامنة بيانات المتجر</div>'
      + '<div class="hint">جلب العملاء والطلبات والسلات من سلة وبناء الملفات الموحّدة.</div>'
      + '<div id="slSync"></div>'
      + '<div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap"><button class="green-btn" id="slSyncBtn" style="margin:0">بدء المزامنة</button>'
      + '<button class="ghost-btn" id="slBackfill" style="margin:0">ربط بيانات واتساب القديمة</button></div></div></div>'
      // customers
      + '<div class="sl-pane" data-pane="customers">'
      + '<div class="sl-segs" id="slQuick"></div>'
      + '<div class="sl-toolbar"><div class="sl-search"><input id="slSearch" placeholder="ابحث: اسم / جوال / بريد / رقم طلب / معرّف سلة"></div><span class="sl-count" id="slCount"></span></div>'
      + '<div id="slTableWrap"><table class="sl-table"><thead><tr><th>العميل</th><th>الجوال</th><th>الطلبات</th><th>الإجمالي</th><th>التصنيف</th></tr></thead><tbody id="slRows"></tbody></table>'
      + '<div id="slEmpty" class="sl-empty" hidden>لا يوجد عملاء في هذه الشريحة بعد.</div></div></div>'
      + '</div>';
  }

  function ensureInjected() {
    if (!document.getElementById('salla-crm-css')) {
      var st = document.createElement('style'); st.id = 'salla-crm-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    var view = document.getElementById('view-salla');
    if (!view) {
      view = document.createElement('div'); view.className = 'view'; view.id = 'view-salla'; view.innerHTML = viewHTML();
      var app = document.querySelector('.dashboard-app') || document.body;
      app.appendChild(view);
    }
    if (!document.getElementById('slDrawer')) {
      var dr = document.createElement('div'); dr.className = 'sl-drawer'; dr.id = 'slDrawer';
      dr.innerHTML = '<div class="dh"><strong id="slDName">—</strong><button class="sl-x" id="slDClose">×</button></div><div class="db" id="slDBody"></div>';
      document.body.appendChild(dr);
    }
    wire();
  }

  var wired = false;
  function wire() {
    if (wired) return; wired = true;
    var view = document.getElementById('view-salla');
    view.addEventListener('click', function (e) {
      var sub = e.target.closest('.sl-subtab');
      if (sub) { setSub(sub.getAttribute('data-sub')); return; }
      var sw = e.target.closest('.sl-switch'); if (sw) { sw.classList.toggle('on'); return; }
      var v = e.target.closest('.sl-var'); if (v) { var ta = v.closest('.sl-panel').querySelector('textarea'); if (ta) { ta.value += v.getAttribute('data-var'); ta.focus(); } return; }
      var save = e.target.closest('.sl-save'); if (save) { saveStatus(save.closest('.sl-panel')); return; }
      var seg = e.target.closest('.sl-seg'); if (seg) { state.segment = seg.getAttribute('data-seg'); markSeg(); loadCustomers(); return; }
      var tr = e.target.closest('#slRows tr'); if (tr) { openCustomer(tr.getAttribute('data-id')); return; }
      if (e.target.id === 'slLink') return doLink();
      if (e.target.id === 'slSyncBtn') return doSync();
      if (e.target.id === 'slBackfill') return doBackfill();
    });
    var searchEl = document.getElementById('slSearch'); var t;
    searchEl.addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { state.search = e.target.value.trim(); loadCustomers(); }, 300); });
    document.getElementById('slDClose').addEventListener('click', function () { document.getElementById('slDrawer').classList.remove('open'); });
  }

  function setSub(sub) {
    state.sub = sub;
    document.querySelectorAll('#view-salla .sl-subtab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-sub') === sub); });
    document.querySelectorAll('#view-salla .sl-pane').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-pane') === sub); });
    if (sub === 'messages') loadStatusMessages();
    else if (sub === 'connect') loadConnect();
    else loadCustomers(true);
  }

  /* ---------- messages ---------- */
  function loadStatusMessages() {
    api(API + '/status-messages').then(function (d) {
      var vars = d.variables || ['order_id', 'customer_name', 'order_status', 'store_name'];
      document.getElementById('slStatusList').innerHTML = (d.statuses || []).map(function (s) {
        var chips = vars.map(function (v) { return '<button type="button" class="sl-var" data-var="{' + v + '}">{' + v + '}</button>'; }).join('');
        return '<div class="sl-panel" data-slug="' + esc(s.slug) + '">'
          + '<div class="sl-row"><div style="display:flex;align-items:center;gap:9px"><span class="sl-dot" style="background:' + esc(s.color || '#94a3b8') + '"></span><span class="sl-name">' + esc(s.label) + '</span><span class="sl-slug">' + esc(s.slug) + '</span></div>'
          + '<button type="button" class="sl-switch' + (s.enabled ? ' on' : '') + '"></button></div>'
          + '<textarea class="sl-msg" placeholder="اكتب الرسالة...">' + esc(s.message || '') + '</textarea>'
          + '<div class="sl-chips">' + chips + '</div>'
          + '<div class="sl-saverow"><span class="sl-saved">✓ تم الحفظ</span><button type="button" class="green-btn sl-save" style="margin:0">حفظ</button></div></div>';
      }).join('');
    }).catch(function (e) { if (e.disabled) document.getElementById('slStatusList').innerHTML = disabled(); });
  }
  function saveStatus(panel) {
    var btn = panel.querySelector('.sl-save'); btn.disabled = true;
    api(API + '/status-messages', { method: 'PUT', body: JSON.stringify({ statusSlug: panel.getAttribute('data-slug'), enabled: panel.querySelector('.sl-switch').classList.contains('on'), message: panel.querySelector('textarea').value }) })
      .then(function () { var s = panel.querySelector('.sl-saved'); s.classList.add('show'); setTimeout(function () { s.classList.remove('show'); }, 1600); })
      .catch(function () {}).then(function () { btn.disabled = false; });
  }

  /* ---------- connect + sync ---------- */
  function setConn(on) { var c = document.getElementById('slConn'); if (!c) return; c.className = 'sl-conn' + (on ? '' : ' off'); c.textContent = on ? 'مربوط' : 'غير مربوط'; }
  function loadConnect() {
    api(API + '/crm-status').then(function (d) {
      var s = d.store, j = d.lastSync || {};
      setConn(s && (s.status === 'authorized' || s.status === 'connected'));
      document.getElementById('slStore').innerHTML = s
        ? '<div class="sl-row"><div><div class="sl-name">' + esc(s.store_name || 'متجر سلة') + '</div><div class="sl-count">معرّف: ' + esc(s.merchant_id) + ' · ' + (s.token_expires_at ? 'الصلاحية سارية' : '—') + '</div></div><span class="sl-conn">مربوط ✓</span></div>'
        : '<div class="sl-count">لا يوجد متجر مربوط. ثبّت تطبيق جواب على متجرك في سلة، ثم اربطه بالأسفل.</div>';
      function bar(l, done, total) { var p = total ? Math.min(100, Math.round(done / total * 100)) : (done ? 100 : 0); return '<div class="sl-prog-l"><span>' + l + '</span><span>' + num(done) + (total ? ' / ' + num(total) : '') + '</span></div><div class="sl-prog"><span style="width:' + p + '%"></span></div>'; }
      document.getElementById('slSync').innerHTML = d.lastSync
        ? '<div class="sl-count" style="margin:2px 0 10px">آخر مزامنة: ' + esc(j.status || '') + (j.phase ? ' · ' + esc(j.phase) : '') + '</div>' + bar('العملاء', j.customers_done, j.customers_total) + bar('الطلبات', j.orders_done, j.orders_total) + bar('السلات', j.carts_done, j.carts_total)
        : '<div class="sl-count" style="margin-top:8px">لم تُشغّل مزامنة بعد.</div>';
    }).catch(function (e) { if (e.disabled) { document.getElementById('slStore').innerHTML = disabled(); document.getElementById('slSync').innerHTML = ''; } });
  }
  function doLink() {
    var id = document.getElementById('slMerchant').value.trim(); var msg = document.getElementById('slLinkMsg');
    if (!id) { msg.textContent = 'أدخل معرّف المتجر'; return; }
    document.getElementById('slLink').disabled = true; msg.textContent = 'جارٍ الربط…';
    api(API + '/link', { method: 'POST', body: JSON.stringify({ merchantId: id }) })
      .then(function () { msg.textContent = '✓ تم الربط'; loadConnect(); })
      .catch(function (e) { msg.textContent = e.status === 409 ? 'المتجر مربوط بحساب آخر' : e.status === 404 ? 'المتجر غير موجود (تأكد من التثبيت)' : 'تعذّر الربط'; })
      .then(function () { document.getElementById('slLink').disabled = false; });
  }
  function doSync() {
    var b = document.getElementById('slSyncBtn'); b.disabled = true;
    api(API + '/sync', { method: 'POST' }).then(function () { pollSync(0); })
      .catch(function (e) { b.disabled = false; alert(e.status === 400 ? 'اربط متجراً أولاً' : 'تعذّر بدء المزامنة'); });
  }
  function pollSync(n) { loadConnect(); if (n < 20) setTimeout(function () { pollSync(n + 1); }, 3000); else document.getElementById('slSyncBtn').disabled = false; }
  function doBackfill() {
    var b = document.getElementById('slBackfill'); b.disabled = true;
    api(API + '/backfill', { method: 'POST' }).then(function () { setTimeout(function () { b.disabled = false; loadConnect(); }, 1500); }).catch(function () { b.disabled = false; });
  }

  /* ---------- customers ---------- */
  function loadQuick() {
    api(API + '/quick-segments').then(function (d) {
      document.getElementById('slQuick').innerHTML = (d.segments || []).map(function (s) { return '<button class="sl-seg" data-seg="' + esc(s.key) + '">' + esc(s.name) + '</button>'; }).join('');
      markSeg();
    }).catch(function (e) { if (e.disabled) document.getElementById('slTableWrap').innerHTML = disabled(); });
  }
  function markSeg() { document.querySelectorAll('#slQuick .sl-seg').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-seg') === state.segment); }); }
  function qstr() { var a = []; if (state.segment) a.push('segment=' + encodeURIComponent(state.segment)); if (state.search) a.push('search=' + encodeURIComponent(state.search)); return a.length ? '?' + a.join('&') : ''; }
  function tagClass(m) { if (m && m.has_whatsapp_conversation && (m.orders_count || 0) === 0) return 'sl-tag warn'; return 'sl-tag'; }
  function loadCustomers(initQuick) {
    if (initQuick && !document.querySelector('#slQuick .sl-seg')) loadQuick();
    api(API + '/customers' + qstr()).then(function (d) {
      var rows = d.customers || [];
      document.getElementById('slEmpty').hidden = rows.length > 0;
      document.getElementById('slRows').innerHTML = rows.map(function (c) {
        return '<tr data-id="' + esc(c.id) + '"><td style="font-weight:600">' + esc(c.display_name || 'بدون اسم') + '</td>'
          + '<td style="color:var(--text-soft)">' + esc(c.canonical_phone || '—') + '</td><td>' + num(c.orders_count) + '</td>'
          + '<td>' + money(c.total_order_value) + '</td><td><span class="' + tagClass(c) + '">' + esc(LIFECYCLE_AR[c.lifecycle] || c.lifecycle || '—') + '</span></td></tr>';
      }).join('');
      api(API + '/audience/count', { method: 'POST', body: JSON.stringify({ segment: state.segment }) })
        .then(function (r) { document.getElementById('slCount').textContent = num(r.count != null ? r.count : rows.length) + ' عميل'; })
        .catch(function () { document.getElementById('slCount').textContent = num(rows.length) + ' عميل'; });
    }).catch(function (e) { if (e.disabled) document.getElementById('slTableWrap').innerHTML = disabled(); });
  }
  function segTags(m) {
    if (!m) return '';
    var t = [];
    if (m.has_whatsapp_conversation && (m.orders_count || 0) === 0) t.push('asked_not_ordered');
    if (m.contacted_before_purchase === true) t.push('asked_then_ordered');
    if (m.has_orders && m.has_whatsapp_conversation && !m.contacted_before_purchase) t.push('ordered_then_contacted');
    if (m.has_orders && !m.has_whatsapp_conversation) t.push('ordered_no_contact');
    if (m.has_abandoned_cart && (m.orders_count || 0) === 0) t.push('cart_abandoned_no_purchase');
    if (m.cart_recovered) t.push('cart_recovered_then_purchased');
    if ((m.orders_count || 0) >= 2) t.push('repeat_customer');
    return t.map(function (k) { return '<span class="sl-tag">' + SEG_AR[k] + '</span>'; }).join(' ');
  }
  function openCustomer(id) {
    api(API + '/customers/' + encodeURIComponent(id)).then(function (d) {
      var c = d.customer || {}, m = d.metrics || {};
      document.getElementById('slDName').textContent = c.display_name || c.canonical_phone || 'عميل';
      var h = '<div class="sl-chips">' + (segTags(m) || '<span class="sl-tag">جديد</span>') + '</div>'
        + '<div class="sl-metrics"><div class="sl-metric"><div class="l">الطلبات</div><div class="n">' + num(m.orders_count) + '</div></div>'
        + '<div class="sl-metric"><div class="l">الإجمالي</div><div class="n">' + num(m.total_order_value) + '</div></div>'
        + '<div class="sl-metric"><div class="l">التصنيف</div><div class="n" style="font-size:12px">' + esc(LIFECYCLE_AR[m.lifecycle] || m.lifecycle || '—') + '</div></div></div>'
        + '<div class="sl-kv"><div>الجوال</div><div>' + esc(c.canonical_phone || '—') + '</div><div>البريد</div><div>' + esc(c.email || '—') + '</div>'
        + '<div>معرّف سلة</div><div>' + esc(c.salla_customer_id || '—') + '</div><div>أول تواصل</div><div>' + when(m.first_contact_at) + '</div>'
        + '<div>أول طلب</div><div>' + when(m.first_order_at) + '</div></div>';
      if ((d.orders || []).length) h += '<div class="sl-sec">الطلبات</div><div class="sl-tl">' + d.orders.map(function (o) { return '<div class="it"><div>' + esc(o.reference_id || o.salla_order_id) + ' · ' + esc(o.status_slug || '') + (o.is_qualified_purchase ? ' ✓' : '') + '</div><div class="w">' + when(o.placed_at) + ' · ' + money(o.total_amount) + '</div></div>'; }).join('') + '</div>';
      h += '<div class="sl-sec">الرحلة</div>' + ((d.timeline || []).length ? '<div class="sl-tl">' + d.timeline.map(function (tv) { return '<div class="it"><div>' + esc(EV_AR[tv.event_type] || tv.event_type) + '</div><div class="w">' + when(tv.occurred_at) + '</div></div>'; }).join('') + '</div>' : '<div class="sl-count">لا أحداث بعد.</div>');
      document.getElementById('slDBody').innerHTML = h;
      document.getElementById('slDrawer').classList.add('open');
    }).catch(function () {});
  }

  // Called by goTab('salla'); also primes the connection pill once.
  window.sallaOnTab = function () {
    ensureInjected();
    if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch (e) {} }
    setSub(state.sub);
    if (!state.primed) { state.primed = true; loadQuick(); api(API + '/crm-status').then(function (d) { setConn(d.store && (d.store.status === 'authorized' || d.store.status === 'connected')); }).catch(function () {}); }
  };

  // Inject the view early so goTab can find #view-salla immediately.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureInjected); else ensureInjected();
})();
