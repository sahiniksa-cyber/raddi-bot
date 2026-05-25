# Product Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `variants` array (each `{ label, price }`) to every product, threaded through DB (JSONB), AI prompt, product-import normalization, and dashboard UI.

**Architecture:** Schema is additive only — JSONB-stored under `bot_configs.config.products[*].variants`. No migration. Five touch-points: dashboard UI (collect/render), `lib/ai-client.js` (render in prompt), `product-import.js` (normalize/merge/organize), `product-knowledge.js` (preserve on catalog output), and tests covering each path.

**Tech Stack:** Node.js `node:test`, vanilla JS dashboard, OpenAI SDK system-prompt builder.

**Spec:** [docs/superpowers/specs/2026-05-25-product-variants-design.md](../specs/2026-05-25-product-variants-design.md)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tests/product-variants.test.js` | Unit + integration tests for variants flow | Create |
| `src/services/products/product-import.js` | `normalizeImportedProduct`, `mergeImportedProducts`, `organizeProductsForConfig` preserve variants | Modify |
| `lib/ai-client.js` | `productsBlock` renders variants as sub-bullets | Modify |
| `dashboard/index.html` | `renderProd` + `addProd` + `appendVariantRow` + `addVariantRow` + `saveConf` collect variants; CSS for `.variant-row` and `.add-variant-btn` | Modify |

---

## Task 1: Tests + import preservation (TDD)

**Files:**
- Create: `tests/product-variants.test.js`
- Modify: `src/services/products/product-import.js`

- [ ] **Step 1: Create the failing test file**

Create `tests/product-variants.test.js`:

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

test('mergeImportedProducts keeps variants from existing product when imported has none', () => {
  const existing = [{ name: 'أدوبي', variants: [{ label: 'شهر', price: '99' }] }];
  const imported = [{ name: 'أدوبي', description: 'وصف جديد' }];
  const result = mergeImportedProducts(existing, imported);
  assert.deepEqual(result[0].variants, [{ label: 'شهر', price: '99' }]);
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

test('AI productsBlock skips fully-empty variants and keeps the rest', () => {
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

- [ ] **Step 2: Run tests — confirm FAIL**

Run:
```
node --test tests/product-variants.test.js
```
Expected: FAIL on all variant-related assertions (variants is dropped during normalize/merge; productsBlock has no `•` sub-bullets yet).

- [ ] **Step 3: Update `src/services/products/product-import.js`**

Open the file and replace `normalizeImportedProduct` (lines 5-18):

**BEFORE:**
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

**AFTER:**
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
  const out = {
    name,
    price,
    description,
    source: product.source || product.platform || 'import',
  };
  if (variants.length > 0) out.variants = variants;
  return out;
}
```

Replace `mergeImportedProducts` (lines 20-43). Find the inner loop and add a variants-merge line:

**BEFORE (last few lines of the loop):**
```js
    if (!current.price && product.price) current.price = product.price;
    if (product.description && !current.description.includes(product.description)) {
      current.description = [current.description, product.description].filter(Boolean).join('\n');
    }
    if (!current.source && product.source) current.source = product.source;
  }
```

**AFTER:**
```js
    if (!current.price && product.price) current.price = product.price;
    if (product.description && !current.description.includes(product.description)) {
      current.description = [current.description, product.description].filter(Boolean).join('\n');
    }
    if (!current.source && product.source) current.source = product.source;
    if (!current.variants && Array.isArray(product.variants) && product.variants.length > 0) {
      current.variants = product.variants;
    }
  }
```

Replace `organizeProductsForConfig` map block (lines 55-60):

**BEFORE:**
```js
    products: catalog.map(product => ({
      name: product.name,
      price: product.price || '',
      description: product.description || '',
      source: product.source || 'platform',
    })),
```

**AFTER:**
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

- [ ] **Step 4: Run tests — confirm import tests PASS, prompt tests still FAIL**

Run:
```
node --test tests/product-variants.test.js
```
Expected: 6 of 9 PASS (all `mergeImportedProducts` + `organizeProductsForConfig` tests), 3 still FAIL (the AI prompt tests).

- [ ] **Step 5: Commit**

```
git add src/services/products/product-import.js tests/product-variants.test.js
git commit -m "$(cat <<'EOF'
feat(products): preserve variants array through import + organize

normalizeImportedProduct keeps a sanitized variants list when present
(label and price strings, empties filtered out). mergeImportedProducts
keeps the first non-empty variants set encountered for a product key.
organizeProductsForConfig threads variants through to the saved config.
Backwards-compatible: products without variants are byte-identical to
before.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: AI prompt renders variants

**Files:**
- Modify: `lib/ai-client.js:111-112` (productsBlock)

- [ ] **Step 1: Update productsBlock in `lib/ai-client.js`**

In `lib/ai-client.js`, find lines 110-114:

**BEFORE:**
```js
    const productsBlock = this.config.products?.length
      ? this.config.products.map((p, i) => `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ''}${p.description ? ` — ${p.description}` : ''}`).join('\n')
      : hasLongCustomInstructions
      ? 'لم تُدخل منتجات في حقول المنتجات المنفصلة. إذا كانت التعليمات أعلاه تحتوي منتجات أو أسعاراً فهي مصدر الحقيقة؛ لا تخترع أي منتج أو سعر غير مذكور.'
      : '(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، أجب بأنك ستتأكد من التوفر وتعود إليه)';
```

**AFTER:**
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
      : hasLongCustomInstructions
      ? 'لم تُدخل منتجات في حقول المنتجات المنفصلة. إذا كانت التعليمات أعلاه تحتوي منتجات أو أسعاراً فهي مصدر الحقيقة؛ لا تخترع أي منتج أو سعر غير مذكور.'
      : '(لا توجد منتجات مضافة بعد — إذا سأل عن منتج، أجب بأنك ستتأكد من التوفر وتعود إليه)';
```

- [ ] **Step 2: Run tests — confirm all 9 PASS**

Run:
```
node --test tests/product-variants.test.js
```
Expected: All 9 tests PASS.

- [ ] **Step 3: Run full suite to check for regressions**

Run:
```
node --test "tests/*.test.js" 2>&1 | tail -10
```
Expected: All tests pass (previous 193 + 9 new = 202 total). If any pre-existing test breaks, STOP and fix before continuing.

- [ ] **Step 4: Commit**

```
git add lib/ai-client.js
git commit -m "$(cat <<'EOF'
feat(ai): render product variants as sub-bullets in system prompt

When a product has a non-empty variants array, each variant is rendered
as "   • <label>: <price>" beneath the product line. Products without
variants render exactly as before. The AI can now answer questions like
"how much for a year of Adobe?" by reading the right variant.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Dashboard UI — collect and render variants

**Files:**
- Modify: `dashboard/index.html` (CSS + JS functions + saveConf)

- [ ] **Step 1: Add CSS for variant rows**

In `dashboard/index.html`, find the existing `.kw-row` CSS (line 157):
```css
.kw-row{display:flex;gap:8px;margin-bottom:8px;align-items:flex-start}
.kw-row input,.kw-row textarea{margin-bottom:0}
.kw-row input{flex:1}.kw-row textarea{flex:2;min-height:42px}
```

Immediately after that block (still inside `<style>`), append:
```css
.variant-row{display:flex;gap:8px;margin-bottom:6px;align-items:center}
.variant-row input{flex:1;min-width:0}
.variant-row .vl{flex:1.2}
.variant-row .vp{flex:1}
.variant-row .variant-del{background:#fef2f2;border:1px solid #fca5a5;color:#dc2626;border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:14px;line-height:1;padding:0}
.add-variant-btn{background:#f0fdf4;border:1px dashed #86efac;color:#15803d;border-radius:8px;padding:6px 12px;font-family:var(--font);font-size:12px;cursor:pointer;margin-top:4px;display:block}
.add-variant-btn:hover{background:#dcfce7}
.prod-variants{margin-top:6px}
```

- [ ] **Step 2: Update `renderProd` and `addProd`**

Find lines 2204-2209:

**BEFORE:**
```js
function renderProd(arr){document.getElementById('prodContainer').innerHTML='';arr.forEach(p=>addProd(p.name,p.description,p.price));}
function addProd(n='',d='',p=''){
  const c=document.getElementById('prodContainer'),el=document.createElement('div');el.className='prod-card';
  el.innerHTML=`<div class="g2"><div><label>المنتج</label><input type="text" class="pn" placeholder="اسم المنتج" value="${esc(n)}"></div><div><label>السعر</label><input type="text" class="pp" placeholder="150 ريال" value="${esc(p)}"></div></div><label>الوصف</label><input type="text" class="pd" placeholder="وصف مختصر" value="${esc(d)}"><button class="prod-del" onclick="this.parentElement.remove();updProd()">× حذف</button>`;
  c.appendChild(el);updProd();
}
```

**AFTER:**
```js
function renderProd(arr){
  document.getElementById('prodContainer').innerHTML='';
  arr.forEach(p=>addProd(p.name,p.description,p.price,p.variants||[]));
}
function addProd(n='',d='',p='',variants=[]){
  const c=document.getElementById('prodContainer'),el=document.createElement('div');el.className='prod-card';
  el.innerHTML=`<div class="g2"><div><label>المنتج</label><input type="text" class="pn" placeholder="اسم المنتج" value="${esc(n)}"></div><div><label>السعر</label><input type="text" class="pp" placeholder="150 ريال" value="${esc(p)}"></div></div><label>الوصف</label><input type="text" class="pd" placeholder="وصف مختصر" value="${esc(d)}"><label style="margin-top:10px;font-size:12px;color:var(--text-soft)">الخيارات المتاحة (اختياري)</label><div class="prod-variants"></div><button class="add-variant-btn" type="button" onclick="addVariantRow(this)">+ إضافة خيار</button><button class="prod-del" onclick="this.parentElement.remove();updProd()">× حذف</button>`;
  c.appendChild(el);
  const variantsContainer=el.querySelector('.prod-variants');
  for(const v of (variants||[])){if(v&&(v.label||v.price))appendVariantRow(variantsContainer,v.label||'',v.price||'');}
  updProd();
}
function appendVariantRow(container,label='',price=''){
  const row=document.createElement('div');
  row.className='variant-row';
  row.innerHTML=`<input type="text" class="vl" placeholder="مثال: شهر / صغير / 100 مل" value="${esc(label)}"><input type="text" class="vp" placeholder="السعر" value="${esc(price)}"><button class="variant-del" type="button" onclick="this.parentElement.remove()">×</button>`;
  container.appendChild(row);
}
function addVariantRow(btn){
  const card=btn.closest('.prod-card');
  if(!card)return;
  const container=card.querySelector('.prod-variants');
  if(container)appendVariantRow(container,'','');
}
```

- [ ] **Step 3: Update `saveConf` to collect variants**

Find lines 2245-2246:

**BEFORE:**
```js
  const prods=[];
  document.querySelectorAll('.prod-card').forEach(r=>{const n=r.querySelector('.pn')?.value?.trim();if(n)prods.push({name:n,description:r.querySelector('.pd')?.value?.trim()||'',price:r.querySelector('.pp')?.value?.trim()||''});});
```

**AFTER:**
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

- [ ] **Step 4: Syntax sanity check**

Run:
```
node -e "const fs=require('fs');const html=fs.readFileSync('dashboard/index.html','utf8');console.log('addVariantRow:',(html.match(/addVariantRow/g)||[]).length);console.log('appendVariantRow:',(html.match(/appendVariantRow/g)||[]).length);console.log('variant-row CSS rule:',(html.match(/\.variant-row\s*\{/g)||[]).length);"
```
Expected:
```
addVariantRow: 2   (function def + onclick)
appendVariantRow: 3 (function def + 2 callers)
variant-row CSS rule: 1
```

- [ ] **Step 5: Commit**

```
git add dashboard/index.html
git commit -m "$(cat <<'EOF'
feat(dashboard): "الخيارات المتاحة" variant rows inside product cards

Each product card now has a "+ إضافة خيار" button that appends a row
with two free-text inputs (label + price) and a delete button. renderProd
threads any existing variants in on load; saveConf collects them into
the product object only when at least one row is non-empty. Generic by
design — the label is whatever the store owner types (month, size, color,
package, anything).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Full test suite + PR + merge + deploy

**Files:** none (verification + deployment)

- [ ] **Step 1: Run all tests**

Run:
```
node --test "tests/*.test.js" 2>&1 | tail -10
```
Expected: 202 tests pass.

- [ ] **Step 2: Push branch**

Run:
```
git push 2>&1
```

- [ ] **Step 3: Create PR**

Run:
```
gh pr create --title "feat: product variants (generic label + price options)" --body "$(cat <<'EOF'
## Summary
- Optional `variants: [{ label, price }]` field on each product
- Dashboard adds "+ إضافة خيار" inside every product card
- AI prompt renders variants as sub-bullets under the product
- Backwards-compatible: products without variants behave identically to today

## Why
The current product schema only supports a single price per product. Stores that sell with multiple price points per product (subscriptions by duration, perfumes by ml, clothes by size, services by tier — anything generic) have to either duplicate products or stuff prices into the description where the AI cannot reliably parse them.

## What changed
- `src/services/products/product-import.js` — `normalizeImportedProduct`, `mergeImportedProducts`, `organizeProductsForConfig` thread variants through
- `lib/ai-client.js` — `productsBlock` renders \`   • <label>: <price>\` lines under products that have variants
- `dashboard/index.html` — new variant-row UI inside each product card (+ CSS)
- 9 new tests covering import, merge, organize, and prompt rendering

## What did NOT change
- DB schema, migrations — variants live in the existing JSONB \`bot_configs.config\`
- AI worker, queues, escalation, Baileys — untouched
- Existing products without variants — byte-identical behavior

## Test plan
- [x] \`node --test "tests/*.test.js"\` passes locally — 202/202
- [ ] After Railway deploy: open dashboard → add a product → add 2 variants → save → ask the bot for the price → verify it reads the right variant
- [ ] Verify an existing product without variants still renders cleanly in the dashboard

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Merge**

Run:
```
gh pr merge --squash 2>&1
gh pr view --json state,mergeCommit
```
Expected: `state: MERGED`.

- [ ] **Step 5: Verify Railway deploy**

After ~2-3 minutes, check the live dashboard for the new variant rows inside product cards.

---

## Self-Review

### 1. Spec coverage
- ✅ `variants` schema (label + price array) → Task 1 (normalizeImportedProduct)
- ✅ Empty variants filtered out → Task 1 (test + filter logic)
- ✅ Backwards-compat (no variants ⇒ no `variants` field) → Task 1 (`if (variants.length > 0)` guards)
- ✅ Merge preserves variants from existing → Task 1 (test + merge code)
- ✅ AI prompt sub-bullets → Task 2
- ✅ AI prompt absence behavior unchanged → Task 2 (test)
- ✅ Dashboard UI for adding/removing variants → Task 3
- ✅ Dashboard loadConf threads variants → Task 3 (renderProd updated)
- ✅ Dashboard saveConf threads variants → Task 3
- ✅ CSS for variant rows → Task 3 (Step 1)
- ✅ Generic label naming ("الخيارات المتاحة") → Task 3 (HTML)
- ✅ Full suite + PR + deploy → Task 4

### 2. Placeholder scan
- No "TBD" / "TODO" / "similar to" patterns.
- All code blocks are complete copy-paste ready.
- All commands have explicit expected output.

### 3. Type consistency
- `{ label, price }` field names identical across spec, tests, normalize, prompt builder, dashboard.
- Container class `prod-variants` identical in HTML, CSS, JS.
- Row class `variant-row` identical in HTML, CSS, JS.
- Function names `addVariantRow` / `appendVariantRow` consistent in declaration and callers.

Plan is consistent and complete.
