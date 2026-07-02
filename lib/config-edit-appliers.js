'use strict';

// Pure appliers: given a section's current value + a plan operation, compute the
// new full section value. Return exactly one of:
//   { value, summary } | { error } | { needsClarify }
// No I/O — deterministic and unit-testable.

const { normalizeArabic } = require('./prompt-edit-keywords');
const { normalizeNumber } = require('../src/services/whatsapp/do-not-reply');

function cleanVariants(variants) {
  if (!Array.isArray(variants)) return null;
  const out = variants
    .map((v) => ({ label: String(v && v.label || '').trim(), price: String(v && v.price || '').trim() }))
    .filter((v) => v.label || v.price);
  return out.length ? out : null;
}

function findProductIndex(products, rawName) {
  const target = normalizeArabic(rawName);
  if (!target) return -1;
  let idx = products.findIndex((p) => normalizeArabic(p && p.name) === target);
  if (idx >= 0) return idx;
  return products.findIndex((p) => {
    const n = normalizeArabic(p && p.name);
    return n && (n.includes(target) || target.includes(n));
  });
}

function applyProductOp(products, op) {
  const list = Array.isArray(products) ? products.map((p) => ({ ...p })) : [];
  const p = (op && op.product) || {};
  const name = String(p.name || '').trim();
  const action = op && op.action;

  if (action === 'add') {
    if (!name) return { error: 'اسم المنتج مطلوب لإضافته.' };
    const prod = { name };
    if (p.description) prod.description = String(p.description).trim();
    if (p.price) prod.price = String(p.price).trim();
    if (p.url) prod.url = String(p.url).trim();
    if (p.longDescription) prod.longDescription = String(p.longDescription).trim();
    const variants = cleanVariants(p.variants);
    if (variants) prod.variants = variants;
    list.push(prod);
    return { value: list, summary: op.summary || `إضافة منتج: ${name}` };
  }

  const idx = findProductIndex(list, name);
  if (idx < 0) return { needsClarify: `ما لقيت منتج بالاسم "${name}". تبي تضيفه جديد؟ أرسل: أضف منتج ${name} …` };

  if (action === 'delete') {
    const removed = list.splice(idx, 1)[0];
    return { value: list, summary: op.summary || `حذف منتج: ${removed.name}` };
  }

  if (action === 'update') {
    const cur = list[idx];
    if (p.price !== undefined && p.price !== null && String(p.price).trim()) cur.price = String(p.price).trim();
    if (p.description) cur.description = String(p.description).trim();
    if (p.url) cur.url = String(p.url).trim();
    if (p.longDescription) cur.longDescription = String(p.longDescription).trim();
    const variants = cleanVariants(p.variants);
    if (variants) cur.variants = variants;
    return { value: list, summary: op.summary || `تعديل منتج: ${cur.name}` };
  }

  return { error: 'عملية غير معروفة على المنتجات.' };
}

function applyInstantReplyOp(map, op) {
  const out = { ...(map && typeof map === 'object' && !Array.isArray(map) ? map : {}) };
  const kw = String(op && op.keyword || '').trim();
  if (!kw) return { error: 'كلمة الرد الفوري مطلوبة.' };

  if (op.action === 'delete') {
    const norm = normalizeArabic(kw);
    const key = Object.keys(out).find((k) => normalizeArabic(k) === norm);
    if (!key) return { needsClarify: `ما لقيت رد فوري للكلمة "${kw}".` };
    delete out[key];
    return { value: out, summary: op.summary || `حذف الرد الفوري: ${kw}` };
  }

  const reply = String(op.reply || '').trim();
  if (!reply) return { error: 'نص الرد الفوري مطلوب.' };
  out[kw] = reply;
  return { value: out, summary: op.summary || `ضبط رد فوري للكلمة: ${kw}` };
}

function applyDoNotReplyOp(list, op) {
  const arr = Array.isArray(list) ? list.map((x) => ({ ...x })) : [];
  const num = String(op && op.number || '').trim();
  const norm = normalizeNumber(num);
  if (!norm || norm.length < 6) return { error: 'الرقم غير صالح — أرسل رقم جوال صحيح.' };

  if (op.action === 'delete') {
    const kept = arr.filter((e) => normalizeNumber(e.number) !== norm);
    if (kept.length === arr.length) return { needsClarify: `الرقم "${num}" مو موجود في قائمة الحظر.` };
    return { value: kept, summary: op.summary || `إزالة الحظر عن: ${num}` };
  }

  if (arr.some((e) => normalizeNumber(e.number) === norm)) {
    return { value: arr, summary: `الرقم محظور مسبقاً: ${num}` };
  }
  arr.push({ number: num, name: String(op.name || '').trim() });
  return { value: arr, summary: op.summary || `حظر الرقم: ${num}` };
}

module.exports = { applyProductOp, applyInstantReplyOp, applyDoNotReplyOp, findProductIndex };
