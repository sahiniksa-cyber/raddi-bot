'use strict';
/* Customer Intelligence page (سلة → العملاء). Talks to /api/salla/* which is
   gated behind SALLA_CRM_ENABLED; a 503 shows the "not enabled yet" note. */
(function () {
  var state = { segment: 'all', segmentId: null, search: '' };

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(v, c) { if (v == null) return '—'; return Number(v).toLocaleString('ar-SA') + ' ' + (c || 'ر.س'); }
  function when(v) { if (!v) return '—'; try { return new Date(v).toLocaleString('ar-SA'); } catch (e) { return v; } }

  var LIFECYCLE_AR = {
    'Lead': 'عميل محتمل', 'Engaged Lead': 'محتمل متفاعل', 'Abandoned Cart Lead': 'سلة متروكة',
    'First-Time Customer': 'أول شراء', 'Repeat Customer': 'متكرر', 'Recovered Customer': 'مسترجع',
    'Inactive Customer': 'خامل'
  };
  var SEG_AR = {
    asked_not_ordered: 'سأل ولم يطلب', asked_then_ordered: 'سأل ثم طلب',
    ordered_then_contacted: 'طلب ثم تواصل', ordered_no_contact: 'طلب بدون تواصل',
    cart_abandoned_no_purchase: 'سلة متروكة', cart_recovered_then_purchased: 'سلة مسترجعة',
    repeat_customer: 'متكرر'
  };

  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}))
      .then(function (r) {
        if (r.status === 503) { var e = new Error('disabled'); e.disabled = true; throw e; }
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      });
  }

  function showDisabled() {
    el('tableWrap').innerHTML = '<div class="disabled-note">ميزة العملاء الموحّدين غير مفعّلة بعد.<br>فعّلها بضبط <code>SALLA_CRM_ENABLED=true</code> بعد ربط متجر سلة.</div>';
  }

  function loadQuick() {
    api('/api/salla/quick-segments').then(function (d) {
      el('quick').innerHTML = (d.segments || []).map(function (s) {
        return '<button class="seg" data-seg="' + esc(s.key) + '">' + esc(s.name) + '</button>';
      }).join('');
      Array.prototype.forEach.call(document.querySelectorAll('#quick .seg'), function (b) {
        b.addEventListener('click', function () { state.segment = b.getAttribute('data-seg'); state.segmentId = null; markActive(); load(); });
      });
      markActive();
    }).catch(function (e) { if (e.disabled) showDisabled(); });
  }

  function loadSaved() {
    api('/api/salla/segments').then(function (d) {
      el('saved').innerHTML = (d.segments || []).length
        ? d.segments.map(function (s) { return '<button class="seg" data-sid="' + esc(s.id) + '">' + esc(s.name) + '</button>'; }).join('')
        : '<div class="count" style="padding:4px 8px">لا شرائح محفوظة</div>';
      Array.prototype.forEach.call(document.querySelectorAll('#saved .seg'), function (b) {
        b.addEventListener('click', function () { state.segmentId = b.getAttribute('data-sid'); state.segment = null; markActive(); load(); });
      });
    }).catch(function () {});
  }

  function markActive() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (b) {
      var on = (state.segment && b.getAttribute('data-seg') === state.segment) || (state.segmentId && b.getAttribute('data-sid') === state.segmentId);
      b.classList.toggle('active', !!on);
    });
  }

  function queryString() {
    var q = [];
    if (state.segment) q.push('segment=' + encodeURIComponent(state.segment));
    if (state.segmentId) q.push('segmentId=' + encodeURIComponent(state.segmentId));
    if (state.search) q.push('search=' + encodeURIComponent(state.search));
    return q.length ? '?' + q.join('&') : '';
  }

  function load() {
    api('/api/salla/customers' + queryString()).then(function (d) {
      var rows = d.customers || [];
      el('empty').hidden = rows.length > 0;
      el('rows').innerHTML = rows.map(function (c) {
        return '<tr data-id="' + esc(c.id) + '">'
          + '<td>' + esc(c.display_name || 'بدون اسم') + '</td>'
          + '<td>' + esc(c.canonical_phone || '—') + '</td>'
          + '<td>' + (c.orders_count || 0) + '</td>'
          + '<td>' + money(c.total_order_value, 'ر.س') + '</td>'
          + '<td><span class="badge">' + esc(LIFECYCLE_AR[c.lifecycle] || c.lifecycle || '—') + '</span></td>'
          + '<td>' + when(c.last_message_at || c.last_order_at) + '</td>'
          + '</tr>';
      }).join('');
      Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
        tr.addEventListener('click', function () { openCustomer(tr.getAttribute('data-id')); });
      });
      // Live count for the current segment.
      var body = state.segmentId ? { segmentId: state.segmentId } : { segment: state.segment };
      api('/api/salla/audience/count', { method: 'POST', body: JSON.stringify(body) })
        .then(function (r) { el('count').textContent = (r.count != null ? r.count.toLocaleString('ar-SA') : rows.length) + ' عميل'; })
        .catch(function () { el('count').textContent = rows.length + ' عميل'; });
    }).catch(function (e) { if (e.disabled) showDisabled(); });
  }

  function segTags(m) {
    if (!m) return '';
    var tags = [];
    Object.keys(SEG_AR).forEach(function (k) {
      var on = false;
      if (k === 'asked_not_ordered') on = m.has_whatsapp_conversation && (m.orders_count || 0) === 0;
      else if (k === 'asked_then_ordered') on = m.contacted_before_purchase === true;
      else if (k === 'ordered_then_contacted') on = m.has_orders && m.has_whatsapp_conversation && !m.contacted_before_purchase;
      else if (k === 'ordered_no_contact') on = m.has_orders && !m.has_whatsapp_conversation;
      else if (k === 'cart_abandoned_no_purchase') on = m.has_abandoned_cart && (m.orders_count || 0) === 0;
      else if (k === 'cart_recovered_then_purchased') on = m.cart_recovered;
      else if (k === 'repeat_customer') on = (m.orders_count || 0) >= 2;
      if (on) tags.push('<span class="badge good">' + SEG_AR[k] + '</span>');
    });
    return tags.join(' ');
  }

  function openCustomer(id) {
    api('/api/salla/customers/' + encodeURIComponent(id)).then(function (d) {
      var c = d.customer || {}, m = d.metrics || {};
      el('d-name').textContent = c.display_name || c.canonical_phone || 'عميل';
      var html = '';
      html += '<div class="segtags">' + (segTags(m) || '<span class="badge">جديد</span>') + '</div>';
      html += '<div class="kv">';
      html += '<div>الجوال</div><div>' + esc(c.canonical_phone || '—') + '</div>';
      html += '<div>البريد</div><div>' + esc(c.email || '—') + '</div>';
      html += '<div>معرّف سلة</div><div>' + esc(c.salla_customer_id || '—') + '</div>';
      html += '<div>الطلبات</div><div>' + (m.orders_count || 0) + ' · ' + money(m.total_order_value, 'ر.س') + '</div>';
      html += '<div>أول تواصل</div><div>' + when(m.first_contact_at) + '</div>';
      html += '<div>أول طلب</div><div>' + when(m.first_order_at) + '</div>';
      html += '<div>التصنيف</div><div>' + esc(LIFECYCLE_AR[m.lifecycle] || m.lifecycle || '—') + '</div>';
      html += '</div>';

      if ((d.orders || []).length) {
        html += '<div class="sec-title">الطلبات</div>';
        html += d.orders.map(function (o) {
          return '<div class="tl"><div class="item"><div>' + esc(o.reference_id || o.salla_order_id) + ' · ' + esc(o.status_slug || '') + (o.is_qualified_purchase ? ' ✓' : '') + '</div><div class="when">' + when(o.placed_at) + ' · ' + money(o.total_amount, o.currency) + '</div></div></div>';
        }).join('');
      }

      html += '<div class="sec-title">الرحلة (الخط الزمني)</div>';
      if ((d.timeline || []).length) {
        html += '<div class="tl">' + d.timeline.map(function (t) {
          return '<div class="item"><div>' + esc(t.event_type) + '</div><div class="when">' + when(t.occurred_at) + ' · ' + esc(t.source) + '</div></div>';
        }).join('') + '</div>';
      } else { html += '<div class="count">لا أحداث بعد.</div>'; }

      el('d-body').innerHTML = html;
      el('drawer').classList.add('open');
    }).catch(function () {});
  }

  function init() {
    el('d-close').addEventListener('click', function () { el('drawer').classList.remove('open'); });
    el('refresh').addEventListener('click', load);
    var t;
    el('search').addEventListener('input', function (e) {
      clearTimeout(t); t = setTimeout(function () { state.search = e.target.value.trim(); load(); }, 300);
    });
    loadQuick(); loadSaved(); load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
