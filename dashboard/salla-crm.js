'use strict';
/* Salla hub (سلة → جواب). Three tabs wired to /api/salla/* (gated behind
   SALLA_CRM_ENABLED; a 503 shows a "not enabled yet" note per section). */
(function () {
  var state = { segment: 'all', segmentId: null, search: '', loaded: {} };

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(v) { if (v == null) return '—'; return Number(v).toLocaleString('ar-SA') + ' ر.س'; }
  function when(v) { if (!v) return '—'; try { return new Date(v).toLocaleString('ar-SA'); } catch (e) { return v; } }
  function num(v) { return Number(v || 0).toLocaleString('ar-SA'); }

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
  function disabledNote() { return '<div class="disabled-note">ميزة سلة غير مفعّلة بعد.<br>تُفعّل بضبط <code>SALLA_CRM_ENABLED=true</code> بعد ربط المتجر.</div>'; }

  /* ---------- tabs ---------- */
  function initTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.remove('active'); });
        Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        var pane = btn.getAttribute('data-pane');
        el('pane-' + pane).classList.add('active');
        loadPane(pane);
      });
    });
  }
  function loadPane(pane) {
    if (pane === 'messages') loadStatusMessages();
    else if (pane === 'connect') loadConnect();
    else if (pane === 'customers') { if (!state.loaded.customers) { loadQuick(); state.loaded.customers = true; } loadCustomers(); }
  }

  /* ---------- TAB 1: ready messages ---------- */
  function loadStatusMessages() {
    api('/api/salla/status-messages').then(function (d) {
      var vars = d.variables || ['order_id', 'customer_name', 'order_status', 'store_name'];
      el('statusList').innerHTML = (d.statuses || []).map(function (s) {
        var chips = vars.map(function (v) { return '<button type="button" class="chip" data-var="{' + v + '}">{' + v + '}</button>'; }).join('');
        return '<div class="card" data-slug="' + esc(s.slug) + '">'
          + '<div class="row"><div style="display:flex;align-items:center;gap:10px">'
          + '<span class="dot" style="background:' + esc(s.color || '#6b7280') + '"></span>'
          + '<span class="status-name">' + esc(s.label) + '</span><span class="slug">' + esc(s.slug) + '</span></div>'
          + '<button type="button" class="switch' + (s.enabled ? ' on' : '') + '" aria-label="تفعيل"></button></div>'
          + '<textarea placeholder="اكتب الرسالة...">' + esc(s.message || '') + '</textarea>'
          + '<div class="chips">' + chips + '</div>'
          + '<div class="save-row"><span class="saved">✓ تم الحفظ</span><button type="button" class="btn save">حفظ</button></div>'
          + '</div>';
      }).join('');
      wireStatusCards();
    }).catch(function (e) { if (e.disabled) el('statusList').innerHTML = disabledNote(); });
  }
  function wireStatusCards() {
    Array.prototype.forEach.call(document.querySelectorAll('#statusList .card'), function (card) {
      var sw = card.querySelector('.switch');
      var ta = card.querySelector('textarea');
      sw.addEventListener('click', function () { sw.classList.toggle('on'); });
      card.querySelectorAll('.chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var v = chip.getAttribute('data-var');
          var start = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd || start);
          ta.focus();
        });
      });
      card.querySelector('.save').addEventListener('click', function () {
        var btn = card.querySelector('.save'); btn.disabled = true;
        api('/api/salla/status-messages', { method: 'PUT', body: JSON.stringify({ statusSlug: card.getAttribute('data-slug'), enabled: sw.classList.contains('on'), message: ta.value }) })
          .then(function () { var s = card.querySelector('.saved'); s.classList.add('show'); setTimeout(function () { s.classList.remove('show'); }, 1600); })
          .catch(function () {})
          .then(function () { btn.disabled = false; });
      });
    });
  }

  /* ---------- TAB 2: connect + sync ---------- */
  function loadConnect() {
    api('/api/salla/crm-status').then(function (d) { renderStore(d); }).catch(function (e) {
      if (e.disabled) { el('storeCard').innerHTML = disabledNote(); el('syncProgress').innerHTML = ''; }
    });
  }
  function renderStore(d) {
    var store = d.store, job = d.lastSync;
    setConn(store && (store.status === 'authorized' || store.status === 'connected'), store);
    if (store) {
      el('storeCard').innerHTML = '<div class="row"><div style="display:flex;align-items:center;gap:12px">'
        + '<div class="logo" style="width:40px;height:40px;border-radius:12px;background:var(--teal-soft)"><span style="color:var(--teal);font-size:18px">🏪</span></div>'
        + '<div><div class="status-name">' + esc(store.store_name || 'متجر سلة') + '</div>'
        + '<div class="count">معرّف: ' + esc(store.merchant_id) + ' · ' + (store.token_expires_at ? 'الصلاحية سارية' : '—') + '</div></div></div>'
        + '<span class="pill on">مربوط</span></div>';
    } else {
      el('storeCard').innerHTML = '<div class="count">لا يوجد متجر مربوط بعد. ثبّت تطبيق جواب على متجرك في سلة، ثم اربطه بالأسفل.</div>';
    }
    var c = job || {};
    function bar(label, done, total) {
      var pct = total ? Math.min(100, Math.round((done / total) * 100)) : (done ? 100 : 0);
      return '<div style="margin-bottom:10px"><div class="prog-label"><span>' + label + '</span><span>' + num(done) + (total ? ' / ' + num(total) : '') + '</span></div><div class="prog"><span style="width:' + pct + '%"></span></div></div>';
    }
    el('syncProgress').innerHTML = job
      ? '<div class="count" style="margin-bottom:10px">آخر مزامنة: ' + esc(c.status || '') + (c.phase ? ' · ' + esc(c.phase) : '') + '</div>'
        + bar('العملاء', c.customers_done, c.customers_total) + bar('الطلبات', c.orders_done, c.orders_total) + bar('السلات', c.carts_done, c.carts_total)
        + (c.last_error ? '<div class="count" style="color:#c47f2f">خطأ: ' + esc(c.last_error) + '</div>' : '')
      : '<div class="count">لم تُشغّل مزامنة بعد.</div>';
  }
  function initConnectActions() {
    el('linkBtn').addEventListener('click', function () {
      var id = el('merchantId').value.trim();
      if (!id) { el('linkMsg').textContent = 'أدخل معرّف المتجر'; return; }
      el('linkBtn').disabled = true; el('linkMsg').textContent = 'جارٍ الربط…';
      api('/api/salla/link', { method: 'POST', body: JSON.stringify({ merchantId: id }) })
        .then(function () { el('linkMsg').textContent = '✓ تم الربط'; loadConnect(); })
        .catch(function (e) { el('linkMsg').textContent = e.status === 409 ? 'المتجر مربوط بحساب آخر' : e.status === 404 ? 'المتجر غير موجود (تأكد من التثبيت)' : 'تعذّر الربط'; })
        .then(function () { el('linkBtn').disabled = false; });
    });
    el('syncBtn').addEventListener('click', function () {
      el('syncBtn').disabled = true;
      api('/api/salla/sync', { method: 'POST' })
        .then(function () { pollSync(0); })
        .catch(function (e) { el('syncBtn').disabled = false; alert(e.status === 400 ? 'اربط متجراً أولاً' : 'تعذّر بدء المزامنة'); });
    });
    el('backfillBtn').addEventListener('click', function () {
      el('backfillBtn').disabled = true;
      api('/api/salla/backfill', { method: 'POST' }).then(function () { setTimeout(function () { el('backfillBtn').disabled = false; loadConnect(); }, 1500); }).catch(function () { el('backfillBtn').disabled = false; });
    });
  }
  function pollSync(n) {
    loadConnect();
    if (n < 20) setTimeout(function () { pollSync(n + 1); }, 3000);
    else el('syncBtn').disabled = false;
  }

  function setConn(on, store) {
    var pill = el('conn');
    if (on) { pill.className = 'pill on'; pill.textContent = 'مربوط'; }
    else { pill.className = 'pill off'; pill.textContent = 'غير مربوط'; }
  }

  /* ---------- TAB 3: customers ---------- */
  function loadQuick() {
    api('/api/salla/quick-segments').then(function (d) {
      el('quick').innerHTML = (d.segments || []).map(function (s) { return '<button class="seg" data-seg="' + esc(s.key) + '">' + esc(s.name) + '</button>'; }).join('');
      document.querySelectorAll('#quick .seg').forEach(function (b) {
        b.addEventListener('click', function () { state.segment = b.getAttribute('data-seg'); state.segmentId = null; markActive(); loadCustomers(); });
      });
      markActive();
    }).catch(function (e) { if (e.disabled) el('tableWrap').innerHTML = disabledNote(); });
  }
  function markActive() {
    document.querySelectorAll('#quick .seg').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-seg') === state.segment); });
  }
  function qs() {
    var q = [];
    if (state.segment) q.push('segment=' + encodeURIComponent(state.segment));
    if (state.segmentId) q.push('segmentId=' + encodeURIComponent(state.segmentId));
    if (state.search) q.push('search=' + encodeURIComponent(state.search));
    return q.length ? '?' + q.join('&') : '';
  }
  function tagClass(m) {
    if (m && m.has_orders && (m.orders_count || 0) >= 2) return 'tag';
    if (m && m.has_whatsapp_conversation && (m.orders_count || 0) === 0) return 'tag warn';
    if (m && m.cart_recovered) return 'tag blue';
    return 'tag';
  }
  function loadCustomers() {
    api('/api/salla/customers' + qs()).then(function (d) {
      var rows = d.customers || [];
      el('empty').hidden = rows.length > 0;
      el('rows').innerHTML = rows.map(function (c) {
        return '<tr data-id="' + esc(c.id) + '"><td>' + esc(c.display_name || 'بدون اسم') + '</td>'
          + '<td>' + esc(c.canonical_phone || '—') + '</td><td>' + num(c.orders_count) + '</td>'
          + '<td>' + money(c.total_order_value) + '</td>'
          + '<td><span class="' + tagClass(c) + '">' + esc(LIFECYCLE_AR[c.lifecycle] || c.lifecycle || '—') + '</span></td></tr>';
      }).join('');
      document.querySelectorAll('#rows tr').forEach(function (tr) { tr.addEventListener('click', function () { openCustomer(tr.getAttribute('data-id')); }); });
      var body = state.segmentId ? { segmentId: state.segmentId } : { segment: state.segment };
      api('/api/salla/audience/count', { method: 'POST', body: JSON.stringify(body) })
        .then(function (r) { el('count').textContent = num(r.count != null ? r.count : rows.length) + ' عميل'; })
        .catch(function () { el('count').textContent = num(rows.length) + ' عميل'; });
    }).catch(function (e) { if (e.disabled) el('tableWrap').innerHTML = disabledNote(); });
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
    return t.map(function (k) { return '<span class="tag">' + SEG_AR[k] + '</span>'; }).join(' ');
  }
  function openCustomer(id) {
    api('/api/salla/customers/' + encodeURIComponent(id)).then(function (d) {
      var c = d.customer || {}, m = d.metrics || {};
      el('d-name').textContent = c.display_name || c.canonical_phone || 'عميل';
      var h = '<div class="chips" style="margin-bottom:6px">' + (segTags(m) || '<span class="tag">جديد</span>') + '</div>';
      h += '<div class="metrics">'
        + '<div class="metric"><div class="l">الطلبات</div><div class="n">' + num(m.orders_count) + '</div></div>'
        + '<div class="metric"><div class="l">الإجمالي</div><div class="n">' + num(m.total_order_value) + '</div></div>'
        + '<div class="metric"><div class="l">التصنيف</div><div class="n" style="font-size:13px">' + esc(LIFECYCLE_AR[m.lifecycle] || m.lifecycle || '—') + '</div></div></div>';
      h += '<div class="kv"><div>الجوال</div><div>' + esc(c.canonical_phone || '—') + '</div>'
        + '<div>البريد</div><div>' + esc(c.email || '—') + '</div>'
        + '<div>معرّف سلة</div><div>' + esc(c.salla_customer_id || '—') + '</div>'
        + '<div>أول تواصل</div><div>' + when(m.first_contact_at) + '</div>'
        + '<div>أول طلب</div><div>' + when(m.first_order_at) + '</div></div>';
      if ((d.orders || []).length) {
        h += '<div class="sec">الطلبات</div>' + d.orders.map(function (o) {
          return '<div class="tl"><div class="item"><div>' + esc(o.reference_id || o.salla_order_id) + ' · ' + esc(o.status_slug || '') + (o.is_qualified_purchase ? ' ✓' : '') + '</div><div class="when">' + when(o.placed_at) + ' · ' + money(o.total_amount) + '</div></div></div>';
        }).join('');
      }
      h += '<div class="sec">الرحلة</div>';
      h += (d.timeline || []).length
        ? '<div class="tl">' + d.timeline.map(function (t) { return '<div class="item"><div>' + esc(EV_AR[t.event_type] || t.event_type) + '</div><div class="when">' + when(t.occurred_at) + '</div></div>'; }).join('') + '</div>'
        : '<div class="count">لا أحداث بعد.</div>';
      el('d-body').innerHTML = h;
      el('drawer').classList.add('open');
    }).catch(function () {});
  }

  function init() {
    initTabs();
    initConnectActions();
    el('d-close').addEventListener('click', function () { el('drawer').classList.remove('open'); });
    var t;
    el('search').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { state.search = e.target.value.trim(); loadCustomers(); }, 300); });
    // Prime the connection pill + first tab.
    api('/api/salla/crm-status').then(function (d) { setConn(d.store && (d.store.status === 'authorized' || d.store.status === 'connected'), d.store); }).catch(function () {});
    loadStatusMessages();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
