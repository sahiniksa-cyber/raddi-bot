# Product Variants — Design Spec

**Date:** 2026-05-25
**Status:** Approved

---

## المشكلة

النموذج الحالي للمنتجات في `bot_configs.config.products` يدعم سعراً واحداً لكل منتج:
```js
{ name, price, description, source }
```

هذا لا يكفي لمنتجات بأسعار متعددة حسب الاختيار (مثل اشتراك أدوبي بمدد مختلفة، تيشيرت بأحجام مختلفة، عطر بأحجام مختلفة). صاحب المتجر يضطر يكتب كل اختيار كمنتج منفصل، أو يكدّس الأسعار في الـ description بصياغة الـ AI لا يفهمها بشكل موثوق.

---

## الهدف

دعم منتجات بـ **خيارات متعددة** (variants) في schema المنتج، بحيث:

1. **عام لكل أنواع المتاجر** — اشتراكات، ملابس، أطعمة، إلكترونيات، خدمات، أي شي. الـ `label` نص حر يحدّده صاحب المتجر.
2. **Backwards-compatible 100%** — المنتجات الموجودة بدون variants تستمر تعمل تماماً كما هي.
3. **AI يقرأها بدقة** — يعرض كل الأسعار للعميل ويرد على السؤال "كم سعر السنة؟" بدقة.
4. **Dashboard يدير الـ variants بسهولة** — زر "+ إضافة خيار" داخل كل منتج، حذف فردي، الـ label نص حر.

---

## مبادئ التصميم

- **Schema additive only** — حقل `variants` اختياري على المنتج. لا حقول محذوفة أو معاد تسميتها.
- **JSONB-friendly** — يُحفظ في `bot_configs.config` الموجود، صفر migration.
- **Generic labels** — "الخيارات المتاحة" بدل "المتغيرات" — تخدم اشتراكات وعطور وملابس على حد سواء.
- **Tests للحماية** — كل touch-point له اختبار.

---

## Data Schema

كل منتج في `config.products` يضاف له حقل اختياري `variants`:

```js
{
  name: "اشتراك أدوبي",
  price: "",                                // فاضي اختياري إذا الـ variants تغطي الأسعار
  description: "كل تطبيقات أدوبي",
  source: "platform",
  variants: [                               // ← جديد، اختياري
    { label: "شهر",    price: "99 ريال"  },
    { label: "4 أشهر", price: "349 ريال" },
    { label: "سنة",    price: "999 ريال" }
  ]
}
```

### قواعد القراءة (consumer-side):

- إذا `Array.isArray(product.variants) === false` → يعامَل كمنتج بدون variants (السلوك الحالي بالضبط)
- إذا `variants.length === 0` → يعامَل كمنتج بدون variants
- إذا الـ variant `{ label: "", price: "" }` (فاضي) → يُتجاهَل (filter قبل العرض)
- `label` و `price` كلاهما strings — لا أرقام، لا objects متداخلة

### قواعد الكتابة (writer-side):

- Dashboard يبني variants من الـ DOM (zero أو أكثر)
- `product-import.js` يحتفظ بـ variants لو موجودة في المُدخَل، ويضع `[]` افتراضياً
- `bot.config.products` يُحفظ في DB كما هو (JSONB يدعم arrays of objects)

---

## مكوّن 1: Dashboard UI

### HTML تعديل `addProd` (dashboard/index.html:2205)

```js
function renderProd(arr){
  document.getElementById('prodContainer').innerHTML='';
  arr.forEach(p=>addProd(p.name, p.description, p.price, p.variants||[]));
}

function addProd(n='', d='', p='', variants=[]){
  const c=document.getElementById('prodContainer');
  const el=document.createElement('div');
  el.className='prod-card';
  el.innerHTML=`
    <div class="g2">
      <div><label>المنتج</label><input type="text" class="pn" placeholder="اسم المنتج" value="${esc(n)}"></div>
      <div><label>السعر</label><input type="text" class="pp" placeholder="150 ريال" value="${esc(p)}"></div>
    </div>
    <label>الوصف</label>
    <input type="text" class="pd" placeholder="وصف مختصر" value="${esc(d)}">

    <label style="margin-top:10px;font-size:12px;color:var(--text-soft)">الخيارات المتاحة (اختياري)</label>
    <div class="prod-variants"></div>
    <button class="add-variant-btn" type="button" onclick="addVariantRow(this)">+ إضافة خيار</button>

    <button class="prod-del" onclick="this.parentElement.remove();updProd()">× حذف</button>
  `;
  c.appendChild(el);
  const variantsContainer = el.querySelector('.prod-variants');
  for (const v of (variants || [])) {
    if (v?.label || v?.price) appendVariantRow(variantsContainer, v.label || '', v.price || '');
  }
  updProd();
}

function appendVariantRow(container, label='', price=''){
  const row = document.createElement('div');
  row.className = 'variant-row';
  row.innerHTML = `
    <input type="text" class="vl" placeholder="مثال: شهر / صغير / 100 مل" value="${esc(label)}">
    <input type="text" class="vp" placeholder="السعر" value="${esc(price)}">
    <button class="variant-del" type="button" onclick="this.parentElement.remove()">×</button>
  `;
  container.appendChild(row);
}

function addVariantRow(btn){
  const container = btn.parentElement.querySelector('.prod-variants');
  appendVariantRow(container, '', '');
}
```

### CSS

في الـ `<style>` الموجود، نضيف:
```css
.variant-row{display:flex;gap:8px;margin-bottom:6px;align-items:center}
.variant-row input{flex:1;min-width:0}
.variant-row .vl{flex:1.2}
.variant-row .vp{flex:1}
.variant-row .variant-del{background:#fef2f2;border:1px solid #fca5a5;color:#dc2626;border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:14px;line-height:1;padding:0}
.add-variant-btn{background:#f0fdf4;border:1px dashed #86efac;color:#15803d;border-radius:8px;padding:6px 12px;font-family:var(--font);font-size:12px;cursor:pointer;margin-top:4px;display:block}
.add-variant-btn:hover{background:#dcfce7}
```

### saveConf — جمع variants من DOM (dashboard/index.html:2246)

**قبل:**
```js
const prods=[];
document.querySelectorAll('.prod-card').forEach(r=>{
  const n=r.querySelector('.pn')?.value?.trim();
  if(n)prods.push({name:n,description:r.querySelector('.pd')?.value?.trim()||'',price:r.querySelector('.pp')?.value?.trim()||''});
});
```

**بعد:**
```js
const prods=[];
document.querySelectorAll('.prod-card').forEach(r=>{
  const n=r.querySelector('.pn')?.value?.trim();
  if(!n)return;
  const variants=[];
  r.querySelectorAll('.variant-row').forEach(vr=>{
    const label=vr.querySelector('.vl')?.value?.trim()||'';
    const price=vr.querySelector('.vp')?.value?.trim()||'';
    if(label||price)variants.push({label,price});
  });
  const product={
    name:n,
    description:r.querySelector('.pd')?.value?.trim()||'',
    price:r.querySelector('.pp')?.value?.trim()||'',
  };
  if(variants.length>0)product.variants=variants;
  prods.push(product);
});
```

---

## مكوّن 2: AI Prompt Builder

في [lib/ai-client.js:111-112](lib/ai-client.js:111):

**قبل:**
```js
const productsBlock = this.config.products?.length
  ? this.config.products.map((p, i) => `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ''}${p.description ? ` — ${p.description}` : ''}`).join('\n')
```

**بعد:**
```js
const productsBlock = this.config.products?.length
  ? this.config.products.map((p, i) => {
      const head = `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ''}${p.description ? ` — ${p.description}` : ''}`;
      const variants = Array.isArray(p.variants)
        ? p.variants.filter(v => v && (String(v.label || '').trim() || String(v.price || '').trim()))
        : [];
      if (variants.length === 0) return head;
      const variantLines = variants
        .map(v => `   • ${String(v.label || '').trim() || '—'}: ${String(v.price || '').trim() || 'السعر عند الطلب'}`)
        .join('\n');
      return `${head}\n${variantLines}`;
    }).join('\n')
```

**النتيجة في الـ system prompt:**
```
📦 المنتجات المتوفرة:
1. اشتراك أدوبي — كل تطبيقات أدوبي
   • شهر: 99 ريال
   • 4 أشهر: 349 ريال
   • سنة: 999 ريال
2. عطر شانيل — رائحة فاخرة
   • 30 مل: 200 ريال
   • 50 مل: 320 ريال
   • 100 مل: 550 ريال
3. تيشيرت قطن
```
(منتج #3 بدون variants → يظهر بدون نقاط فرعية، كما كان دائماً)

---

## مكوّن 3: Product Import (preserve variants)

في `src/services/products/product-import.js`، دالة `normalizeImportedProduct`:

**قبل:**
```js
function normalizeImportedProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const name = String(product.name || product.title || '').trim();
  if (!name) return null;
  const price = String(product.price || product.sale_price || product.regular_price || '').trim();
  const description = String(product.description || product.short_description || product.summary || '').trim();
  return {
    name,
    price,
    description,
    source: product.source || product.platform || 'import',
  };
}
```

**بعد:**
```js
function normalizeImportedProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const name = String(product.name || product.title || '').trim();
  if (!name) return null;
  const price = String(product.price || product.sale_price || product.regular_price || '').trim();
  const description = String(product.description || product.short_description || product.summary || '').trim();
  const rawVariants = Array.isArray(product.variants) ? product.variants : [];
  const variants = rawVariants
    .map(v => ({
      label: String(v?.label || '').trim(),
      price: String(v?.price || '').trim(),
    }))
    .filter(v => v.label || v.price);
  const normalized = {
    name,
    price,
    description,
    source: product.source || product.platform || 'import',
  };
  if (variants.length > 0) normalized.variants = variants;
  return normalized;
}
```

في دالة `mergeImportedProducts`، نحتفظ بـ variants من الـ "current" إذا كانت موجودة (الـ source-of-truth الأقدم):

```js
function mergeImportedProducts(existingProducts = [], importedProducts = []) {
  const merged = [];
  const byKey = new Map();

  for (const product of [...existingProducts, ...importedProducts].map(normalizeImportedProduct).filter(Boolean)) {
    const key = normalizeProductText(product.name);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...product });
      merged.push(byKey.get(key));
      continue;
    }
    if (!current.price && product.price) current.price = product.price;
    if (product.description && !current.description.includes(product.description)) {
      current.description = [current.description, product.description].filter(Boolean).join('\n');
    }
    if (!current.source && product.source) current.source = product.source;
    // variants: keep the first non-empty one we encounter
    if (!current.variants && Array.isArray(product.variants) && product.variants.length > 0) {
      current.variants = product.variants;
    }
  }
  return merged;
}
```

في دالة `organizeProductsForConfig` (السطر 55-60)، نمرر variants:

**قبل:**
```js
products: catalog.map(product => ({
  name: product.name,
  price: product.price || '',
  description: product.description || '',
  source: product.source || 'platform',
})),
```

**بعد:**
```js
products: catalog.map(product => {
  const out = {
    name: product.name,
    price: product.price || '',
    description: product.description || '',
    source: product.source || 'platform',
  };
  if (Array.isArray(product.variants) && product.variants.length > 0) {
    out.variants = product.variants;
  }
  return out;
}),
```

---

## مكوّن 4: Product Knowledge (preserve variants in catalog output)

في `src/services/products/product-knowledge.js`، دالة `buildProductCatalog` تبني product objects. نمرر variants لو موجودة:

**في موضع build object** (السطور 80-83 و 99-100):
- `variants: Array.isArray(product.variants) ? product.variants : undefined` يُضاف فقط إذا موجودة
- search/match يظل يعمل على `name` و `description` (variants لا تُستخدم للـ matching)

التفصيل في الـ plan.

---

## ملفات تتغير

| الملف | التغيير | حجم |
|---|---|---|
| `dashboard/index.html` | UI variants + JS (renderProd, addProd, addVariantRow, appendVariantRow, saveConf) + CSS | متوسط |
| `lib/ai-client.js` | productsBlock يعرض variants كنقاط فرعية | صغير |
| `src/services/products/product-import.js` | normalize + merge + organize يحفظون variants | صغير |
| `src/services/products/product-knowledge.js` | catalog output يحتفظ بـ variants | صغير |
| `tests/product-variants.test.js` (جديد) | اختبارات schema + import + prompt | متوسط |

**صفر** تغييرات في: DB schema، migrations، AI worker، queues، escalation، Baileys.

---

## اختبارات

ملف جديد: `tests/product-variants.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeImportedProducts, organizeProductsForConfig } = require('../src/services/products/product-import');
const AIClient = require('../lib/ai-client');

function makePromptClient(products) {
  return new AIClient(
    { products, model: 'google/gemini-2.0-flash', googleApiKey: 'AIzaSyDummyKeyForTesting1234' },
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {}, save: () => {} },
  );
}

test('mergeImportedProducts preserves variants array on imported product', () => {
  const result = mergeImportedProducts([], [
    { name: 'أدوبي', variants: [{ label: 'شهر', price: '99 ريال' }] },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].variants, [{ label: 'شهر', price: '99 ريال' }]);
});

test('mergeImportedProducts filters out empty variants {label:"",price:""}', () => {
  const result = mergeImportedProducts([], [
    { name: 'أدوبي', variants: [{ label: '', price: '' }, { label: 'شهر', price: '99' }] },
  ]);
  assert.deepEqual(result[0].variants, [{ label: 'شهر', price: '99' }]);
});

test('mergeImportedProducts does not set variants field when none provided', () => {
  const result = mergeImportedProducts([], [{ name: 'تيشيرت', price: '50 ريال' }]);
  assert.equal(result[0].variants, undefined);
});

test('organizeProductsForConfig keeps variants on products', () => {
  const out = organizeProductsForConfig({}, [
    { name: 'عطر', variants: [{ label: '30 مل', price: '200 ريال' }] },
  ]);
  assert.deepEqual(out.products[0].variants, [{ label: '30 مل', price: '200 ريال' }]);
});

test('organizeProductsForConfig omits variants on products without them', () => {
  const out = organizeProductsForConfig({}, [{ name: 'كتاب', price: '40 ريال' }]);
  assert.equal(out.products[0].variants, undefined);
});

test('AI productsBlock renders variants as sub-bullets', () => {
  const ai = makePromptClient([
    { name: 'أدوبي', description: 'كل التطبيقات', variants: [
      { label: 'شهر', price: '99 ريال' },
      { label: 'سنة', price: '999 ريال' },
    ]},
  ]);
  const prompt = ai.buildSystemPrompt([]);
  assert.match(prompt, /1\. أدوبي/);
  assert.match(prompt, /• شهر: 99 ريال/);
  assert.match(prompt, /• سنة: 999 ريال/);
});

test('AI productsBlock works unchanged when variants is absent', () => {
  const ai = makePromptClient([{ name: 'كتاب', price: '40 ريال' }]);
  const prompt = ai.buildSystemPrompt([]);
  assert.match(prompt, /1\. كتاب — 40 ريال/);
  assert.doesNotMatch(prompt, /•/);
});

test('AI productsBlock skips empty variants and keeps the rest', () => {
  const ai = makePromptClient([{
    name: 'عطر',
    variants: [
      { label: '', price: '' },
      { label: '30 مل', price: '200 ريال' },
    ],
  }]);
  const prompt = ai.buildSystemPrompt([]);
  assert.match(prompt, /• 30 مل: 200 ريال/);
  assert.doesNotMatch(prompt, /• —:/);
});
```

---

## Data Flow

```
[المستخدم يفتح dashboard → ينقر "+ إضافة منتج"]
       ↓
[يدخل اسم: أدوبي، يترك السعر، يدخل وصف]
       ↓
[ينقر "+ إضافة خيار" 3 مرات]
       ↓
[يكتب: "شهر" / "99 ريال", "4 أشهر" / "349 ريال", "سنة" / "999 ريال"]
       ↓
[ينقر "💾 حفظ"]
       ↓
[saveConf يجمع variants من DOM → POST /api/config]
       ↓
[bot_configs.config.products = [{ name: 'أدوبي', variants: [...] }]]
       ↓
[العميل يسأل: "كم سعر السنة من أدوبي؟"]
       ↓
[ai-worker يستدعي AIClient.getReply]
       ↓
[buildSystemPrompt يعرض:
   1. أدوبي
      • شهر: 99 ريال
      • 4 أشهر: 349 ريال
      • سنة: 999 ريال]
       ↓
[الـ AI يرد: "سنة كاملة بـ 999 ريال"]
       ↓
[stripAvoidedContent → outgoing queue → WhatsApp]
```

---

## ضمانات الأمان

1. **Backwards-compatible** — منتجات بدون variants تشتغل بنفس الكود الحالي
2. **Empty variants → ignored** — الفلتر يحمي من `{ label: '', price: '' }`
3. **AI prompt fallback** — لو `variants` ليس array، الـ map ما يطبق
4. **Dashboard fallback** — `addProd` بدون variants param = `[]` افتراضي
5. **product-import preserves on merge** — variants من الكاتالوج القديم لا تضيع
6. **Tests** — 8 اختبارات تغطي كل سيناريو

---

## ما هو خارج النطاق

- **Store-scanner variants** — `lib/store-scanner.js` ما يرجع variants حالياً. لو لاحقاً نوسّعه ليرجع variants، الـ pipeline جاهز يستقبلها.
- **AI auto-detection** — الـ AI لا يستنتج variants من description تلقائياً
- **Variant-level images/SKUs** — YAGNI
- **Variant-level description** — `label + price` فقط (المستخدم اختار)
- **Stock/availability per variant** — YAGNI
