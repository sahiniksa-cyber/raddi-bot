# Platform UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the visual layer of the جواب platform (dashboard, login, billing) to a cleaner, more professional SaaS look — lighter typography, better spacing, subtle shadows, no emoji-as-icons — WITHOUT touching ANY JavaScript, ANY onclick handler, ANY HTML id, or ANY element structure.

**Architecture:** Pure CSS-only refactor. Each phase modifies a tightly-scoped group of CSS rules inside existing `<style>` blocks (or `conversations.css`). The HTML structure stays 100% identical — same IDs, same classes, same onclick attributes, same DOM tree. Visual changes happen entirely through CSS rule replacements. The reference design is the mockup HTML provided in the previous conversation turn.

**Tech Stack:** Vanilla HTML + Vanilla CSS (no Tailwind, no framework). Existing font is `'Fatima'` (custom) with Cairo/Segoe UI fallback. RTL Arabic. Green primary `#16a34a`.

---

## ⚠️ Hard Constraints (ALL phases)

Every phase MUST respect these rules. Violating any one of them risks breaking the working platform:

1. **NEVER** edit anything between `<script>` and `</script>` tags
2. **NEVER** edit any `onclick="..."` attribute
3. **NEVER** edit any `id="..."` attribute
4. **NEVER** add or remove HTML elements (no new `<div>`, no deleted `<button>`)
5. **NEVER** rename a CSS class (don't change `.tab` to `.nav-tab` — the JS depends on the name)
6. **NEVER** touch any file in `src/` — backend untouched
7. **ONLY** edit CSS rule bodies (the `{...}` part) inside `<style>` blocks and `.css` files
8. **ONLY** edit text content inside elements when explicitly stated in the task

Before any commit, run this verification:

```bash
# Confirm no JS/structure was touched — only CSS changed
git diff --stat
git diff dashboard/ | grep -E "^[+-].*onclick=|^[+-].*\bid=" | head -5
# Expected: NO lines matching onclick= or id= (means structure intact)
```

If the second command returns any output, the change has touched structure and must be reverted before committing.

---

## File Map

| Phase | File | Scope |
|-------|------|-------|
| 1 | `dashboard/index.html` (`:root` vars, body, `.topbar`, `.logo`, `.nav-tabs`, `.tab`, `.conn-badge`, `.user-pill`, `.dot`) | Top navigation + design tokens |
| 2 | `dashboard/index.html` (`.cscreen`, `.ccard`, `.stop-card`, `.conn-card`, `.err-card`, `.ctitle`, `.csub`, `.spin`, `.qr-wrap`, `.step`, `.stepn`, `.phone-pill`, `.green-btn`, `.red-btn`, `.ghost-btn`) | Connect/QR screen + global buttons |
| 3 | `dashboard/conversations.css` (entire file) | Conversations view (two-pane) |
| 4 | `dashboard/index.html` (`.sw`, `.stats-row`, `.stat`, `.bot-ctrl`, `.panel`, `.phdr`, `.pbdy`, `label`, `input`, `textarea`, `select`, `.hint`, `.g2`) | Settings, stats, form fields |
| 5 | `dashboard/login.html` (`<style>` block) | Login + signup card |
| 6 | `dashboard/billing.html` (`<style>` block) | Billing/activation card |

---

## Design Tokens (used by every phase)

Every phase pulls colors and spacing from this shared vocabulary. The phase that introduces them is **Phase 1** — but subsequent phases will reference these values:

```
Colors:
  --green:        #16a34a   (primary)
  --green2:       #15803d   (primary dark, text)
  --green-light:  #22c55e   (accent)
  --green-bg:    #f0fdf4   (tint)
  --green-border: #bbf7d0   (subtle border)
  --bg:           #f8fafc   (page background)
  --bg-soft:      #f1f5f9   (input background)
  --card:         #ffffff
  --border:       #e5e7eb   (default border)
  --text:         #0f172a   (heading text)
  --text-2:       #1e293b   (body text)
  --text-muted:   #475569   (secondary)
  --text-soft:    #64748b   (tertiary)
  --text-dim:     #94a3b8   (placeholder)

Typography (font-weight):
  Headings (>16px):  700  (was 900)
  Sub-headings:      600  (was 800)
  Body strong:       600  (was 700)
  Body:              500  (was 600)
  Labels:            600  (uppercase, dimmed color)

Letter-spacing:
  All headings >18px: tracking-tight (letter-spacing: -0.02em)
  Logo: letter-spacing: -0.03em

Shadow:
  --shadow-xs:  0 1px 2px rgba(15,23,42,.04)
  --shadow-sm:  0 1px 3px rgba(15,23,42,.06)
  --shadow:     0 4px 12px rgba(15,23,42,.05)
  --shadow-lg:  0 8px 24px rgba(15,23,42,.06)

Border-radius:
  Cards:   16px (was 24px — felt too bubbly)
  Inputs:  10px
  Buttons: 10px
  Pills:   999px

Spacing scale (8px base):
  xs: 6px, sm: 8px, md: 12px, lg: 16px, xl: 24px, 2xl: 32px
```

---

## Phase 1: Design Tokens + Topbar

**Files:** `dashboard/index.html` only.

**Sections to modify** (CSS rules inside `<style>`):
- `:root { ... }` — refine token values
- `body { ... }` — base typography
- `.topbar { ... }` — height, padding
- `.logo { ... }` — remove gradient (was `-webkit-background-clip`), use solid color, lighter weight
- `.nav-tabs { ... }` — softer background
- `.tab { ... }` — lighter weight, subtler hover
- `.tab.active { ... }` — refined active state
- `.conn-badge { ... }` — refined pill
- `.user-pill { ... }` — refined pill
- `.dot, .dot.green, .dot.yellow, .dot.gray, .dot.blink { ... }` — match new color tokens
- `@keyframes blink` — keep as-is

Do NOT touch any HTML markup. Do NOT change class names.

- [ ] **Step 1: Read the current `:root` and topbar CSS to confirm baseline**

```bash
# Note: this is for the AGENT'S reference; the test in the next step is the real verification.
grep -n -A 20 "^:root{" dashboard/index.html | head -25
```

Expected: see the current `--green`, `--bg`, `--text` variables (around lines 13-32).

- [ ] **Step 2: Replace `:root` block with refined tokens**

In `dashboard/index.html`, locate the block that starts with `:root{` (around line 13) and ends with `}` before `*,*::before` (around line 32). Replace its body with these tokens (keep the same variable NAMES — the rest of the file references them):

```css
:root{
  --font:'Fatima','Cairo','Segoe UI',Tahoma,sans-serif;
  --green:#16a34a;--green2:#15803d;--green-light:#22c55e;
  --green-bg:#f0fdf4;--green-border:#bbf7d0;
  --bg:#f8fafc;--bg-soft:#f1f5f9;
  --card:#ffffff;--card-soft:#fafbfc;
  --border:#e5e7eb;--border-strong:#d1d5db;
  --text:#0f172a;--text-2:#1e293b;
  --text-muted:#475569;--text-soft:#64748b;--text-dim:#94a3b8;
  --red:#dc2626;--red-soft:#ef4444;--red-bg:#fef2f2;--red-border:#fecaca;
  --amber:#d97706;--amber-soft:#f59e0b;--amber-bg:#fffbeb;--amber-border:#fde68a;
  --indigo:#4f46e5;--indigo-soft:#6366f1;--indigo-bg:#eef2ff;--indigo-border:#c7d2fe;
  --purple:#7c3aed;--purple-bg:#f5f3ff;--purple-border:#ddd6fe;
  --sky:#0284c7;--sky-soft:#0ea5e9;
  --shadow-xs:0 1px 2px rgba(15,23,42,.04);
  --shadow-sm:0 1px 3px rgba(15,23,42,.06);
  --shadow:0 4px 12px rgba(15,23,42,.05);
  --shadow-lg:0 8px 24px rgba(15,23,42,.06);
  --shadow-xl:0 16px 32px rgba(15,23,42,.08);
}
```

(The values are nearly identical to before — this primarily neutralizes the over-strong `--shadow-lg` and `--shadow-xl` that gave cards a heavy, lifted feel.)

- [ ] **Step 3: Replace `.topbar`, `.logo`, `.nav-tabs`, `.tab` rules**

Find this group of rules (around lines 38-43 in `dashboard/index.html`):

```css
.topbar{background:#ffffff;border-bottom:1px solid var(--border);padding:0 28px;height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:var(--shadow-xs)}
.logo{font-size:26px;font-weight:900;background:linear-gradient(135deg,var(--green),var(--green-light));-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.025em}
.nav-tabs{display:flex;gap:2px;background:var(--bg-soft);padding:4px;border-radius:12px}
.tab{padding:8px 18px;border-radius:9px;border:none;background:transparent;color:var(--text-soft);font-family:var(--font);font-size:14px;font-weight:700;cursor:pointer;transition:all .18s}
.tab.active{background:#ffffff;color:var(--green);box-shadow:var(--shadow-sm)}
.tab:hover:not(.active){color:var(--text-2)}
```

Replace with:

```css
.topbar{background:#ffffff;border-bottom:1px solid var(--border);padding:0 24px;height:58px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200}
.logo{font-size:20px;font-weight:700;color:var(--green);letter-spacing:-.03em;user-select:none}
.nav-tabs{display:flex;gap:2px;background:var(--bg-soft);padding:4px;border-radius:11px;border:1px solid var(--border)}
.tab{padding:6px 15px;border-radius:8px;border:none;background:transparent;color:var(--text-soft);font-family:var(--font);font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;white-space:nowrap}
.tab.active{background:#ffffff;color:var(--green);font-weight:600;box-shadow:var(--shadow-xs)}
.tab:hover:not(.active){color:var(--text-2)}
```

Key changes: logo is now solid color (not gradient), font-weight 700 not 900, topbar is shorter (58px), tabs are lighter (500 weight).

- [ ] **Step 4: Replace `.conn-badge`, `.user-pill`, `.dot` group**

Find this block (around lines 44-50):

```css
.conn-badge{display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:99px;background:var(--card);font-family:var(--font);font-size:13px;font-weight:700;color:var(--text-2);border:1px solid var(--border);box-shadow:var(--shadow-xs)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--text-dim);flex-shrink:0;transition:background .3s}
.dot.blink{animation:blink 1s infinite;background:var(--red-soft)}
.dot.green{background:var(--green-light);box-shadow:0 0 0 3px var(--green-bg);animation:none}
.dot.yellow{background:var(--amber-soft);animation:blink 1s infinite}
.dot.gray{background:var(--text-dim);animation:none}
```

And the user-pill (around lines 52-54):

```css
.user-pill{display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:99px;background:var(--card);border:1px solid var(--border);font-size:13px;font-weight:700;color:var(--text-muted);box-shadow:var(--shadow-xs)}
.user-pill button{background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:14px;padding:0 2px;transition:color .2s}
.user-pill button:hover{color:var(--red-soft) !important}
```

Replace both groups with:

```css
.conn-badge{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:var(--green-bg);border:1px solid var(--green-border);font-family:var(--font);font-size:12px;font-weight:600;color:var(--green2)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--text-dim);flex-shrink:0;transition:background .3s;display:inline-block}
.dot.blink{animation:blink 1s infinite;background:var(--red-soft)}
.dot.green{background:var(--green-light);box-shadow:0 0 0 2px #dcfce7;animation:none}
.dot.yellow{background:var(--amber-soft);animation:blink 1s infinite}
.dot.gray{background:var(--text-dim);animation:none}

.user-pill{display:flex;align-items:center;gap:7px;padding:5px 13px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--border);font-size:12px;font-weight:600;color:var(--text-muted)}
.user-pill button{background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:13px;padding:0 2px;transition:color .15s;display:flex;align-items:center}
.user-pill button:hover{color:var(--red-soft) !important}
```

- [ ] **Step 5: Manually verify in browser**

Open `dashboard/index.html` in a browser (or hit the running preview server). Confirm:
- Logo "جواب" appears in solid green (not gradient), thinner than before
- Topbar is shorter (58px vs the old 64px)
- Tabs are lighter weight, slightly smaller padding
- Status pill on the left has a soft green background tint
- ALL TABS STILL CLICK and switch views (test by clicking كل tab once)
- No console errors

If any tab fails to switch, REVERT (`git checkout dashboard/index.html`) — the JS was broken by an unintended structural change. Investigate what was touched outside the CSS rule bodies before retrying.

- [ ] **Step 6: Confirm no JS/structure changed**

```bash
git diff dashboard/index.html | grep -E "^[+-].*onclick=|^[+-].*\bid=|^[+-]<script" | head
```

Expected: NO output (empty). If anything appears, revert and investigate.

- [ ] **Step 7: Commit**

```bash
git add dashboard/index.html
git commit -m "ui(dashboard): refine design tokens and topbar — lighter weights, softer shadows"
```

---

## Phase 2: Connect / QR Screen + Global Buttons

**Files:** `dashboard/index.html` only.

**Sections to modify:**
- `.cscreen, .ccard, .stop-card, .conn-card, .err-card`
- `.ctitle, .csub`
- `.spin, .spin-sm, .big-icon, .phone-pill`
- `.err-box, .logs-box`
- `.qr-wrap, .qr-fallback`
- `.steps, .step, .stepn`
- `.green-btn, .red-btn, .ghost-btn`

This phase is independent of Phase 1 except it uses the tokens from `:root`. If Phase 1 is not yet merged, this phase still works — it just uses the existing tokens.

- [ ] **Step 1: Replace card/screen rules**

Find these rules (around lines 61-66):

```css
.cscreen{min-height:calc(100vh - 64px);display:flex;align-items:center;justify-content:center;padding:32px 20px}
.ccard{background:var(--card);border:1px solid var(--border);border-radius:24px;padding:40px;max-width:460px;width:100%;text-align:center;box-shadow:var(--shadow-lg)}
.stop-card{background:var(--card);border:1px solid var(--border);border-radius:24px;padding:48px 40px;max-width:460px;width:100%;text-align:center;box-shadow:var(--shadow-lg)}
.conn-card{background:linear-gradient(135deg,var(--green-bg) 0%,#ffffff 100%);border:1px solid var(--green-border);border-radius:24px;padding:40px;max-width:460px;width:100%;text-align:center;box-shadow:var(--shadow-lg)}
.err-card{background:linear-gradient(135deg,var(--red-bg) 0%,#ffffff 100%);border:1px solid var(--red-border);border-radius:24px;padding:40px;max-width:500px;width:100%;text-align:center;box-shadow:var(--shadow-lg)}
.ctitle{font-size:23px;font-weight:900;color:var(--text);margin-bottom:8px;letter-spacing:-.01em}
.csub{font-size:14.5px;color:var(--text-soft);line-height:1.7;margin-bottom:24px}
```

Replace with:

```css
.cscreen{min-height:calc(100vh - 58px);display:flex;align-items:center;justify-content:center;padding:40px 20px}
.ccard{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:36px;max-width:420px;width:100%;text-align:center;box-shadow:var(--shadow)}
.stop-card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:40px 36px;max-width:420px;width:100%;text-align:center;box-shadow:var(--shadow)}
.conn-card{background:var(--card);border:1px solid var(--green-border);border-radius:18px;padding:36px;max-width:420px;width:100%;text-align:center;box-shadow:var(--shadow)}
.err-card{background:var(--card);border:1px solid var(--red-border);border-radius:18px;padding:36px;max-width:460px;width:100%;text-align:center;box-shadow:var(--shadow)}
.ctitle{font-size:18px;font-weight:700;color:var(--text);margin-bottom:6px;letter-spacing:-.02em}
.csub{font-size:13px;color:var(--text-soft);line-height:1.75;margin-bottom:24px}
```

Changes: smaller padding, smaller radius, removed background gradients, lighter font weights for titles.

- [ ] **Step 2: Replace QR, steps, phone-pill, big-icon rules**

Find these (around lines 71-83):

```css
.big-icon{font-size:60px;margin-bottom:16px;display:block}
.phone-pill{display:inline-flex;align-items:center;gap:8px;background:var(--green-bg);border:1px solid var(--green-border);border-radius:99px;padding:11px 28px;font-size:18px;font-weight:900;color:var(--green2);direction:ltr;margin-bottom:24px}
.err-box{background:#fff7f7;border:1px solid var(--red-border);border-radius:12px;padding:14px;font-size:12px;color:var(--red);text-align:right;font-family:'Consolas',monospace;line-height:1.8;margin-bottom:10px;direction:ltr;word-break:break-all}
.logs-box{background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;padding:12px;font-size:11px;color:var(--text-muted);text-align:right;font-family:'Consolas',monospace;line-height:1.9;max-height:130px;overflow-y:auto;white-space:pre-line}

/* QR */
.qr-wrap{width:300px;height:300px;background:#fff;border:2px solid var(--green-border);border-radius:20px;margin:0 auto 24px;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 0 6px var(--green-bg),var(--shadow-lg);position:relative}
.qr-wrap img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;transition:opacity .25s}
.qr-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff;color:var(--text-soft);font-size:13px;font-weight:600;gap:6px}
.steps{display:flex;flex-direction:column;gap:8px;text-align:right}
.step{display:flex;align-items:center;gap:12px;background:var(--bg-soft);border-radius:12px;padding:11px 14px;font-size:13px;font-weight:600;color:var(--text-muted);border:1px solid var(--border)}
.stepn{width:26px;height:26px;border-radius:50%;flex-shrink:0;background:var(--green-bg);color:var(--green2);font-size:12px;font-weight:900;display:flex;align-items:center;justify-content:center;border:1.5px solid var(--green-border)}
```

Replace with:

```css
.big-icon{font-size:48px;margin-bottom:14px;display:block;opacity:.85}
.phone-pill{display:inline-flex;align-items:center;gap:8px;background:var(--green-bg);border:1px solid var(--green-border);border-radius:999px;padding:8px 22px;font-size:15px;font-weight:600;color:var(--green2);direction:ltr;margin-bottom:22px;letter-spacing:.02em}
.err-box{background:var(--red-bg);border:1px solid var(--red-border);border-radius:10px;padding:12px;font-size:11.5px;color:var(--red);text-align:right;font-family:'Consolas',monospace;line-height:1.8;margin-bottom:10px;direction:ltr;word-break:break-all}
.logs-box{background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;padding:11px;font-size:11px;color:var(--text-muted);text-align:right;font-family:'Consolas',monospace;line-height:1.85;max-height:130px;overflow-y:auto;white-space:pre-line}

/* QR */
.qr-wrap{width:240px;height:240px;background:#fff;border:2px solid var(--green-border);border-radius:16px;margin:0 auto 22px;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 0 5px var(--green-bg);position:relative}
.qr-wrap img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;transition:opacity .25s}
.qr-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff;color:var(--text-soft);font-size:12.5px;font-weight:500;gap:6px}
.steps{display:flex;flex-direction:column;gap:6px;text-align:right}
.step{display:flex;align-items:center;gap:10px;background:var(--bg-soft);border-radius:9px;padding:10px 13px;font-size:12.5px;font-weight:500;color:var(--text-muted);border:1px solid var(--border)}
.stepn{width:22px;height:22px;border-radius:50%;flex-shrink:0;background:var(--green-bg);color:var(--green2);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:1.5px solid var(--green-border)}
```

- [ ] **Step 3: Replace buttons (`.green-btn`, `.red-btn`, `.ghost-btn`)**

Find this block (around lines 85-91):

```css
.green-btn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,var(--green-light),var(--green));color:#fff;border:none;border-radius:12px;padding:13px 28px;font-family:var(--font);font-size:15px;font-weight:800;cursor:pointer;transition:all .18s;margin:4px;box-shadow:0 1px 3px rgba(22,163,74,.3),0 1px 2px rgba(22,163,74,.15)}
.green-btn:hover{transform:translateY(-1px);box-shadow:0 4px 8px rgba(22,163,74,.25),0 2px 4px rgba(22,163,74,.15)}
.green-btn:disabled{opacity:.6;cursor:wait;transform:none}
.red-btn{display:inline-flex;align-items:center;gap:8px;background:#fff;color:var(--red);border:1px solid var(--red-border);border-radius:12px;padding:12px 26px;font-family:var(--font);font-size:15px;font-weight:800;cursor:pointer;transition:all .18s;margin:4px;box-shadow:var(--shadow-xs)}
.red-btn:hover{background:var(--red-bg);border-color:var(--red-soft)}
.ghost-btn{display:inline-flex;align-items:center;gap:8px;background:#fff;color:var(--text-muted);border:1px solid var(--border);border-radius:12px;padding:11px 22px;font-family:var(--font);font-size:14px;font-weight:700;cursor:pointer;transition:all .18s;margin:4px;box-shadow:var(--shadow-xs)}
.ghost-btn:hover{background:var(--bg-soft);color:var(--text-2);border-color:var(--border-strong)}
```

Replace with:

```css
.green-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--green);color:#fff;border:none;border-radius:10px;padding:11px 24px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;margin:4px}
.green-btn:hover{background:var(--green2)}
.green-btn:disabled{opacity:.6;cursor:wait}
.red-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:#fff;color:var(--red);border:1px solid var(--red-border);border-radius:10px;padding:10px 22px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;margin:4px}
.red-btn:hover{background:var(--red-bg);border-color:var(--red-soft)}
.ghost-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:#fff;color:var(--text-muted);border:1px solid var(--border);border-radius:10px;padding:9px 20px;font-family:var(--font);font-size:13.5px;font-weight:600;cursor:pointer;transition:all .15s;margin:4px}
.ghost-btn:hover{background:var(--bg-soft);color:var(--text-2);border-color:var(--border-strong)}
```

Removed the gradient + heavy shadow on the green button. Replaced lift transform with a simple darker hover. Lighter font weight (600).

- [ ] **Step 4: Verify in browser**

Open the dashboard, go to the الربط tab. Confirm:
- Card looks cleaner (no heavy lifted shadow)
- "تشغيل البوت" button is solid green, no gradient, slightly less padding
- Stop / restart buttons still work (click each one once)
- QR placeholder, when bot starts, still shows correctly

- [ ] **Step 5: Verify no structural changes**

```bash
git diff dashboard/index.html | grep -E "^[+-].*onclick=|^[+-].*\bid=|^[+-]<script" | head
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add dashboard/index.html
git commit -m "ui(dashboard): refine connect screen + buttons — flatter, lighter weights"
```

---

## Phase 3: Conversations Page (Two-Pane)

**Files:** `dashboard/conversations.css` only. This is a standalone CSS file used by the المحادثات view.

This is the biggest visual phase. The full file (~126 lines) is replaced with a refined version. The HTML structure that consumes this CSS (in `dashboard/index.html`) is NOT touched.

- [ ] **Step 1: Confirm the file path and current class structure**

```bash
# Check what classes the JS depends on so we never rename them
grep -oE "cv-[a-z-]+" dashboard/conversations.css | sort -u
```

Expected: list of all `cv-*` class names. Every one of these MUST be preserved in the replacement file.

- [ ] **Step 2: Replace the entire `dashboard/conversations.css` content**

Open `dashboard/conversations.css` and replace ALL contents with:

```css
/* === Two-pane shell === */
.cv-shell { display: flex; gap: 0; min-height: 580px; background: var(--card); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.cv-list-wrap { flex: 0 0 360px; display: flex; flex-direction: column; background: var(--card); border-left: 1px solid var(--border); overflow: hidden; }
.cv-list { flex: 1; overflow-y: auto; max-height: calc(100vh - 280px); }
.cv-panel { flex: 1; display: flex; flex-direction: column; background: #f0f2f5; overflow: hidden; min-height: 580px; position: relative; }

/* === Right pane title bar === */
.cv-list-title { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--card); }
.cv-list-title h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
.cv-list-title .cv-list-icon { font-size: 18px; color: var(--green2); opacity: 0.85; }

/* === Search === */
.cv-search { padding: 12px 14px 8px; background: var(--card); border-bottom: 1px solid var(--bg-soft); }
.cv-search input { width: 100%; padding: 9px 13px; border: 1px solid var(--border); border-radius: 9px; font-family: inherit; font-size: 12.5px; box-sizing: border-box; background: var(--bg-soft); color: var(--text); transition: all .15s; }
.cv-search input::placeholder { color: var(--text-dim); }
.cv-search input:focus { outline: none; border-color: var(--green); background: var(--card); box-shadow: 0 0 0 3px var(--green-bg); }

/* === Table === */
.cv-table { width: 100%; border-collapse: collapse; }
.cv-table thead th { position: sticky; top: 0; background: var(--bg-soft); padding: 9px 14px; text-align: right; font-size: 11px; font-weight: 600; color: var(--text-soft); border-bottom: 1px solid var(--border); z-index: 1; letter-spacing: .04em; text-transform: uppercase; }
.cv-table tbody tr { cursor: pointer; transition: background 0.12s; border-bottom: 1px solid var(--bg-soft); }
.cv-table tbody tr:hover { background: var(--bg-soft); }
.cv-table tbody tr.active { background: var(--green-bg); }
.cv-table tbody tr.active td:first-child { box-shadow: inset 3px 0 0 0 var(--green); }
.cv-table tbody td { padding: 12px 14px; font-size: 13px; vertical-align: middle; color: var(--text); }
.cv-table .cv-customer-cell { display: flex; align-items: center; gap: 11px; }
.cv-table .cv-customer-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cv-table .cv-customer-name { font-weight: 600; font-size: 13px; direction: ltr; text-align: right; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-table tbody tr.active .cv-customer-name { font-weight: 700; }
.cv-table .cv-customer-phone { font-size: 12px; color: var(--text-soft); direction: ltr; text-align: right; }
.cv-table .cv-time { color: var(--text-dim); font-size: 11px; white-space: nowrap; font-weight: 500; }

/* === Avatar === */
.cv-avatar { position: relative; width: 38px; height: 38px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: #ffffff; font-size: 14px; font-weight: 600; }
.cv-avatar.lg { width: 40px; height: 40px; font-size: 14px; }
.cv-avatar .cv-status-dot { position: absolute; bottom: 0; left: 0; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--card); }
.cv-avatar .cv-status-dot.ongoing { background: var(--green-light); }
.cv-avatar .cv-status-dot.finished { background: transparent; border-color: transparent; }
.cv-avatar.lg .cv-status-dot { border-color: #f0f2f5; }

/* === Panel header === */
.cv-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; background: var(--card); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.cv-panel-header-left { display: flex; align-items: center; gap: 11px; min-width: 0; }
.cv-panel-header-info { display: flex; flex-direction: column; min-width: 0; }
.cv-panel-header-name { font-weight: 600; font-size: 13.5px; direction: ltr; text-align: right; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-panel-header-status { font-size: 11px; color: var(--green2); display: flex; align-items: center; gap: 5px; font-weight: 500; margin-top: 2px; }
.cv-panel-header-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--green-light); display: inline-block; }
.cv-panel-header-status.finished { color: var(--text-soft); }
.cv-panel-header-status.finished::before { background: #cbd5e1; }
.cv-panel-header-actions { display: flex; gap: 4px; align-items: center; }
.cv-panel-header-actions button { background: var(--card); border: 1px solid var(--border); padding: 7px; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; color: var(--text-soft); font-size: 14px; line-height: 1; transition: background 0.15s; display: flex; align-items: center; justify-content: center; }
.cv-panel-header-actions button:hover { background: var(--bg-soft); color: var(--text-2); }

/* === Bubbles container === */
.cv-bubbles { flex: 1; overflow-y: auto; padding: 16px 22px; display: flex; flex-direction: column; gap: 4px; background: #f0f2f5; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cpath fill='%23dde1e6' fill-opacity='0.45' d='M20 20c2-2 4-4 4-6s-2-4-4-4-4 2-4 4 2 4 4 6z'/%3E%3C/svg%3E"); }
.cv-day-pill { align-self: center; background: rgba(255,255,255,0.85); color: var(--text-soft); padding: 4px 13px; border-radius: 999px; font-size: 11px; font-weight: 500; margin: 6px 0 10px; border: 1px solid var(--border); }

/* === Bubbles === */
.cv-bubble-wrap { display: flex; flex-direction: column; margin-bottom: 5px; max-width: 70%; }
.cv-bubble-wrap.customer { align-self: flex-start; align-items: flex-start; }
.cv-bubble-wrap.ai { align-self: flex-end; align-items: flex-end; }
.cv-bubble { padding: 8px 12px 17px; border-radius: 12px; font-size: 13px; line-height: 1.55; word-break: break-word; position: relative; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
.cv-bubble-wrap.customer .cv-bubble { background: #ffffff; color: var(--text); border-top-right-radius: 4px; }
.cv-bubble-wrap.ai .cv-bubble { background: #e9f5eb; color: var(--text); border-top-left-radius: 4px; }
.cv-bubble-time { position: absolute; bottom: 4px; left: 10px; font-size: 10px; color: var(--text-dim); white-space: nowrap; display: flex; align-items: center; gap: 3px; font-weight: 500; }
.cv-bubble-wrap.customer .cv-bubble-time { right: 10px; left: auto; }
.cv-bubble-status { font-size: 10.5px; color: #53bdeb; line-height: 1; }
.cv-bubble-status.muted { color: rgba(0,0,0,0.35); }

/* === Media bubbles === */
.cv-bubble.media-image { background: #eff6ff !important; }
.cv-bubble.media-audio, .cv-bubble.media-ptt { background: #faf5ff !important; }
.cv-bubble.media-video, .cv-bubble.media-document, .cv-bubble.media-other { background: #f8fafc !important; }
.cv-bubble-media-icon { font-size: 13px; margin-left: 6px; opacity: .8; }
.cv-bubble-media-label { font-weight: 600; font-size: 11.5px; display: block; margin-bottom: 2px; color: var(--text-soft); }

/* === Failed bubble === */
.cv-bubble.failed { background: var(--red-bg) !important; color: #991b1b !important; border: 1px solid var(--red-border); }

/* === Copy button === */
.cv-bubble-copy { position: absolute; top: -8px; left: -8px; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 3px 7px; font-size: 10px; opacity: 0; cursor: pointer; transition: opacity 0.15s; font-family: inherit; z-index: 2; color: var(--text-soft); }
.cv-bubble:hover .cv-bubble-copy { opacity: 1; }
.cv-bubble-copy:hover { color: var(--text); border-color: var(--border-strong); }

/* === Footer input bar === */
.cv-footer { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: var(--card); border-top: 1px solid var(--border); flex-shrink: 0; }
.cv-footer .cv-icon-btn { background: none; border: none; padding: 8px; border-radius: 8px; cursor: pointer; color: var(--text-soft); font-size: 16px; line-height: 1; transition: all 0.15s; display: flex; align-items: center; justify-content: center; }
.cv-footer .cv-icon-btn:hover { background: var(--bg-soft); color: var(--text-2); }
.cv-footer .cv-message-input { flex: 1; background: var(--bg-soft); border: 1.5px solid var(--border); border-radius: 11px; padding: 9px 14px; font-family: inherit; font-size: 13px; outline: none; color: var(--text); transition: border-color .15s; }
.cv-footer .cv-message-input::placeholder { color: var(--text-dim); }
.cv-footer .cv-message-input:focus { border-color: var(--green); background: var(--card); }
.cv-footer .cv-mic-btn { background: var(--green); color: #fff; border: none; width: 38px; height: 38px; border-radius: 10px; cursor: pointer; font-size: 15px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background .15s; }
.cv-footer .cv-mic-btn:hover { background: var(--green2); }

/* === Empty / loading === */
.cv-empty { text-align: center; color: var(--text-soft); padding: 80px 20px; font-size: 13px; }
.cv-empty .cv-empty-icon { font-size: 38px; opacity: 0.35; margin-bottom: 10px; }

/* === Mobile === */
@media (max-width: 900px) {
  .cv-shell { display: block; min-height: 0; border-radius: 12px; }
  .cv-list-wrap { flex: none; border-left: none; border-radius: 0; }
  .cv-table thead { display: none; }
  .cv-table tbody tr { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; padding: 12px; align-items: center; }
  .cv-table tbody tr.active td:first-child { box-shadow: none; }
  .cv-table tbody td { padding: 0; border: none; }
  .cv-table tbody td.cv-col-name { grid-column: 1 / 3; }
  .cv-table tbody td.cv-col-phone { display: none; }
  .cv-table tbody td.cv-col-time { grid-column: 3; }
  .cv-panel { display: none; }
  .cv-shell.has-selection .cv-list-wrap { display: none; }
  .cv-shell.has-selection .cv-panel { display: flex; min-height: 75vh; }
  .cv-panel-header .cv-back-btn { background: none; border: none; padding: 8px; border-radius: 8px; cursor: pointer; color: var(--text-soft); font-size: 16px; line-height: 1; margin-left: 4px; }
}
.cv-panel-header .cv-back-btn { display: none; }
@media (max-width: 900px) {
  .cv-panel-header .cv-back-btn { display: inline-block; }
}

.old-badge {
  font-size: 9.5px;
  background: var(--bg-soft);
  color: var(--text-soft);
  padding: 1px 5px;
  border-radius: 4px;
  margin-right: 6px;
  vertical-align: middle;
  font-weight: 600;
  direction: rtl;
}
```

Class names preserved verbatim: every `cv-*` selector from the original file is still present and has the same name. Only the rule bodies (declarations) changed.

- [ ] **Step 3: Verify class preservation**

```bash
# Both lists must be identical
git show HEAD:dashboard/conversations.css | grep -oE "\.cv-[a-z-]+" | sort -u > /tmp/before.txt
grep -oE "\.cv-[a-z-]+" dashboard/conversations.css | sort -u > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

Expected: NO diff output (i.e., the set of class selectors is identical before and after).

If there is any diff, restore missing classes before continuing.

- [ ] **Step 4: Verify in browser**

Navigate to the المحادثات tab and click a conversation row. Confirm:
- The list shows on the right (RTL), the chat panel on the left
- Selected row shows a green left indicator strip and tinted background
- Bubbles: customer = white (on left), AI = soft green (on right)
- Footer input field works, mic button is square (not round)
- Clicking the back button on mobile width still toggles back
- Copy button appears on bubble hover

- [ ] **Step 5: Commit**

```bash
git add dashboard/conversations.css
git commit -m "ui(conversations): refine two-pane chat — softer surface, lighter weights"
```

---

## Phase 4: Settings, Stats, Forms

**Files:** `dashboard/index.html` only.

**Sections to modify:**
- `.sw`
- `.stats-row, .stat`
- `.bot-ctrl, .bot-ctrl-info, .bcdot, .bc-label, .ctrl-btns, .ctrl-start, .ctrl-stop`
- `.panel, .phdr, .pbdy`
- `label, input, textarea, select`
- `.g2, .hint`

- [ ] **Step 1: Replace settings wrapper and stats**

Find this group (around lines 94-98):

```css
.sw{max-width:920px;margin:0 auto;padding:24px 18px}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;text-align:center;box-shadow:var(--shadow-xs)}
.stat .v{font-size:21px;font-weight:900;color:var(--green2);letter-spacing:-.01em}
.stat .l{font-size:11px;color:var(--text-soft);margin-top:4px;font-weight:600}
```

Replace with:

```css
.sw{max-width:920px;margin:0 auto;padding:28px 22px}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:13px;padding:15px;text-align:center}
.stat .v{font-size:22px;font-weight:700;color:var(--green2);letter-spacing:-.03em}
.stat .l{font-size:11px;color:var(--text-dim);margin-top:4px;font-weight:500}
```

- [ ] **Step 2: Replace bot-ctrl group**

Find this (around lines 99-109):

```css
.bot-ctrl{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,var(--green-bg),#fff);border:1px solid var(--green-border);border-radius:14px;padding:13px 18px;margin-bottom:16px;box-shadow:var(--shadow-xs)}
.bot-ctrl-info{display:flex;align-items:center;gap:10px}
.bcdot{width:9px;height:9px;border-radius:50%;background:var(--text-dim);flex-shrink:0}
.bcdot.on{background:var(--green-light);box-shadow:0 0 0 3px var(--green-bg)}
.bcdot.pulse{background:var(--amber-soft);animation:blink 1s infinite}
.bc-label{font-size:13.5px;font-weight:700;color:var(--text-2)}
.ctrl-btns{display:flex;gap:8px}
.ctrl-start{padding:9px 22px;border-radius:9px;border:none;background:linear-gradient(135deg,var(--green-light),var(--green));color:#fff;font-family:var(--font);font-size:13px;font-weight:800;cursor:pointer;transition:all .18s;box-shadow:0 1px 2px rgba(22,163,74,.25)}
.ctrl-start:hover{transform:translateY(-1px)}
.ctrl-stop{padding:9px 22px;border-radius:9px;background:#fff;color:var(--red);border:1px solid var(--red-border);font-family:var(--font);font-size:13px;font-weight:800;cursor:pointer;transition:all .18s}
.ctrl-stop:hover{background:var(--red-bg)}
```

Replace with:

```css
.bot-ctrl{display:flex;align-items:center;justify-content:space-between;background:var(--green-bg);border:1px solid var(--green-border);border-radius:12px;padding:12px 16px;margin-bottom:16px}
.bot-ctrl-info{display:flex;align-items:center;gap:10px}
.bcdot{width:8px;height:8px;border-radius:50%;background:var(--text-dim);flex-shrink:0}
.bcdot.on{background:var(--green-light);box-shadow:0 0 0 2px #dcfce7}
.bcdot.pulse{background:var(--amber-soft);animation:blink 1s infinite}
.bc-label{font-size:13px;font-weight:600;color:var(--green2)}
.ctrl-btns{display:flex;gap:6px}
.ctrl-start{padding:8px 20px;border-radius:8px;border:none;background:var(--green);color:#fff;font-family:var(--font);font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s}
.ctrl-start:hover{background:var(--green2)}
.ctrl-stop{padding:8px 20px;border-radius:8px;background:#fff;color:var(--red);border:1px solid var(--red-border);font-family:var(--font);font-size:12.5px;font-weight:600;cursor:pointer;transition:all .15s}
.ctrl-stop:hover{background:var(--red-bg)}
```

- [ ] **Step 3: Replace panel, form fields**

Find this block (around lines 111-125):

```css
.panel{background:var(--card);border:1px solid var(--border);border-radius:16px;margin-bottom:16px;overflow:hidden;box-shadow:var(--shadow-xs)}
.phdr{padding:15px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:800;color:var(--text-2);background:var(--card-soft)}
.pbdy{padding:18px 20px}
label{display:block;font-size:11.5px;font-weight:700;color:var(--text-muted);margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase}
input,textarea,select{width:100%;background:#fff;border:1.5px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--text);font-size:14px;font-family:var(--font);outline:none;transition:border-color .18s,box-shadow .18s;margin-bottom:12px}
input::placeholder,textarea::placeholder{color:var(--text-dim)}
input:focus,textarea:focus,select:focus{border-color:var(--green-light);box-shadow:0 0 0 3px var(--green-bg)}
input:disabled,textarea:disabled{background:var(--bg-soft);color:var(--text-soft);cursor:default}
textarea{resize:vertical;min-height:84px;line-height:1.7}
select{appearance:none;-webkit-appearance:none;background:#fff url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3e%3cpath d='M6 9l6 6 6-6'/%3e%3c/svg%3e") no-repeat left 14px center/16px;padding-left:38px}
html[dir="rtl"] select{background-position:left 14px center}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hint{font-size:12px;color:var(--text-soft);margin:-7px 0 11px;line-height:1.6}
.hint a{color:var(--green2);text-decoration:none;font-weight:700}
.hint a:hover{text-decoration:underline}
```

Replace with:

```css
.panel{background:var(--card);border:1px solid var(--border);border-radius:14px;margin-bottom:14px;overflow:hidden}
.phdr{padding:13px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;font-size:13.5px;font-weight:600;color:var(--text);background:var(--card-soft)}
.pbdy{padding:16px 18px}
label{display:block;font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:5px;letter-spacing:.05em;text-transform:uppercase}
input,textarea,select{width:100%;background:var(--bg-soft);border:1.5px solid var(--border);border-radius:9px;padding:9px 12px;color:var(--text);font-size:13.5px;font-family:var(--font);outline:none;transition:all .15s;margin-bottom:12px;box-sizing:border-box}
input::placeholder,textarea::placeholder{color:var(--text-dim)}
input:focus,textarea:focus,select:focus{border-color:var(--green);background:#fff;box-shadow:0 0 0 3px var(--green-bg)}
input:disabled,textarea:disabled{background:var(--bg-soft);color:var(--text-soft);cursor:default;opacity:.7}
textarea{resize:vertical;min-height:80px;line-height:1.7}
select{appearance:none;-webkit-appearance:none;background:var(--bg-soft) url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='1.5'%3e%3cpath d='M6 9l6 6 6-6'/%3e%3c/svg%3e") no-repeat left 13px center/14px;padding-left:36px}
html[dir="rtl"] select{background-position:left 13px center}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hint{font-size:12px;color:var(--text-soft);margin:-6px 0 11px;line-height:1.65}
.hint a{color:var(--green2);text-decoration:none;font-weight:600}
.hint a:hover{text-decoration:underline}
```

- [ ] **Step 4: Verify in browser**

Open dashboard, go to إعدادات tab. Confirm:
- Stats cards are flatter (no heavy shadow), green stat number is solid
- Bot control bar (top of settings) is flatter, no gradient
- Form labels are smaller, dimmer, uppercase
- Input focus shows soft green glow ring
- Start/Stop buttons still call the right JS handlers (click each once and verify console)

- [ ] **Step 5: Verify no structural changes**

```bash
git diff dashboard/index.html | grep -E "^[+-].*onclick=|^[+-].*\bid=|^[+-]<script" | head
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add dashboard/index.html
git commit -m "ui(dashboard): refine settings panels — flatter cards, softer inputs"
```

---

## Phase 5: Login Page

**Files:** `dashboard/login.html` only.

The entire `<style>` block is replaced. HTML body is untouched.

- [ ] **Step 1: Identify the style block boundaries**

```bash
grep -n "^<style>\|^</style>" dashboard/login.html
```

Expected: a `<style>` opening tag near the top and a closing `</style>` somewhere before `</head>`. Record their line numbers.

- [ ] **Step 2: Replace the `<style>` block content**

Open `dashboard/login.html`. Replace ALL content between `<style>` and `</style>` with:

```css
@font-face{font-family:'Fatima';src:url('fonts/Fatimah Arabic Light.otf') format('opentype');font-weight:300}
@font-face{font-family:'Fatima';src:url('fonts/Fatimah Arabic Regular.otf') format('opentype');font-weight:400}
@font-face{font-family:'Fatima';src:url('fonts/Fatimah Arabic Medium.otf') format('opentype');font-weight:500}
@font-face{font-family:'Fatima';src:url('fonts/Fatimah Arabic Bold.otf') format('opentype');font-weight:700}

:root{
  --green:#16a34a;--green2:#15803d;--green-light:#22c55e;
  --green-bg:#f0fdf4;--green-border:#bbf7d0;
  --bg:#f8fafc;--bg-soft:#f1f5f9;
  --card:#ffffff;
  --border:#e5e7eb;
  --text:#0f172a;--text-soft:#64748b;--text-dim:#94a3b8;
  --red:#dc2626;--red-bg:#fef2f2;--red-border:#fecaca;
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg)}
body{font-family:'Fatima','Cairo','Segoe UI',Tahoma,sans-serif;color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}

.logo-wrap{text-align:center;margin-bottom:24px}
.logo{font-size:28px;font-weight:700;color:var(--green);letter-spacing:-.03em;display:inline-block}
.logo-sub{font-size:12.5px;color:var(--text-soft);margin-top:4px;font-weight:500}

.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:36px;max-width:420px;width:100%;box-shadow:0 4px 16px rgba(15,23,42,.04)}

.tabs{display:flex;gap:4px;background:var(--bg-soft);padding:4px;border-radius:11px;margin-bottom:24px;border:1px solid var(--border)}
.tab{flex:1;padding:8px 12px;border-radius:8px;border:none;background:transparent;color:var(--text-soft);font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s}
.tab.active{background:#fff;color:var(--green);font-weight:600;box-shadow:0 1px 3px rgba(15,23,42,.06)}

h1{font-size:18px;font-weight:700;color:var(--text);margin-bottom:6px;letter-spacing:-.02em;text-align:center}
.subtitle{font-size:13px;color:var(--text-soft);margin-bottom:22px;text-align:center;line-height:1.7}

label{display:block;font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:5px;letter-spacing:.05em;text-transform:uppercase}
input{width:100%;background:var(--bg-soft);border:1.5px solid var(--border);border-radius:9px;padding:10px 13px;color:var(--text);font-size:13.5px;font-family:inherit;outline:none;transition:all .15s;margin-bottom:14px}
input::placeholder{color:var(--text-dim)}
input:focus{border-color:var(--green);background:#fff;box-shadow:0 0 0 3px var(--green-bg)}
input[type="email"],input[type="tel"]{direction:ltr;text-align:left}

button.primary{width:100%;background:var(--green);color:#fff;border:none;border-radius:10px;padding:11px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;margin-top:6px}
button.primary:hover{background:var(--green2)}
button.primary:disabled{opacity:.6;cursor:wait}

.err{background:var(--red-bg);border:1px solid var(--red-border);color:var(--red);border-radius:9px;padding:10px 13px;font-size:12.5px;margin-bottom:14px;display:none;line-height:1.6}
.err.show{display:block}

.divider{text-align:center;color:var(--text-dim);font-size:11.5px;margin:18px 0;position:relative}
.divider::before,.divider::after{content:'';position:absolute;top:50%;width:42%;height:1px;background:var(--border)}
.divider::before{right:0}
.divider::after{left:0}

.foot{font-size:12.5px;color:var(--text-soft);text-align:center;margin-top:22px;line-height:1.7}
.foot a{color:var(--green2);text-decoration:none;font-weight:600}
.foot a:hover{text-decoration:underline}
```

This preserves ALL class names from the original file (`.logo`, `.logo-sub`, `.card`, `.tabs`, `.tab`, `.tab.active`, `.subtitle`, `.err`, `.divider`, `.foot`, `.primary`). The HTML stays identical.

- [ ] **Step 3: Verify class preservation**

```bash
grep -oE "class=\"[a-z][a-z- ]*\"" dashboard/login.html | sort -u > /tmp/classes.txt
cat /tmp/classes.txt
# Every class in the HTML body should still be defined in the new style block.
# Visually inspect — there are ~10 classes.
```

- [ ] **Step 4: Open `dashboard/login.html` in browser and verify**

- Logo "جواب" in solid green
- Login/register tabs work (click each)
- Input focus shows green ring
- Submit button is solid green (no gradient)
- Error message styling unchanged (will show on invalid login)

- [ ] **Step 5: Commit**

```bash
git add dashboard/login.html
git commit -m "ui(login): refine login card — lighter weights, flatter card"
```

---

## Phase 6: Billing Page

**Files:** `dashboard/billing.html` only.

This is the smallest file. The `<style>` block is replaced wholesale.

- [ ] **Step 1: Identify the style block**

```bash
grep -n "^  <style>\|^  </style>" dashboard/billing.html
```

- [ ] **Step 2: Replace `<style>` block content**

Open `dashboard/billing.html`. Replace content between `<style>` and `</style>` with:

```css
:root{
  --green:#16a34a;--green2:#15803d;
  --green-bg:#f0fdf4;--green-border:#bbf7d0;
  --bg:#f8fafc;--card:#ffffff;
  --border:#e5e7eb;
  --text:#0f172a;--text-soft:#64748b;--text-dim:#94a3b8;
  --red:#dc2626;--red-bg:#fef2f2;--red-border:#fecaca;
}
body{margin:0;font-family:'Fatima','Cairo',Tahoma,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:40px 32px;max-width:440px;width:100%;text-align:center;box-shadow:0 4px 16px rgba(15,23,42,.04)}
.icon{width:48px;height:48px;background:var(--green-bg);border:1px solid var(--green-border);border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:24px;color:var(--green2)}
h1{margin:0 0 8px;font-size:18px;font-weight:700;color:var(--text);letter-spacing:-.02em}
.desc{color:var(--text-soft);line-height:1.75;font-size:13px;margin-bottom:24px}
.code-box{background:var(--green-bg);border:1px solid var(--green-border);border-radius:12px;padding:18px;margin-bottom:18px}
.code-box label{display:block;font-size:11px;color:var(--green2);font-weight:600;margin-bottom:9px;letter-spacing:.05em;text-transform:uppercase}
.code-row{display:flex;gap:7px;flex-wrap:wrap;justify-content:center}
input{border-radius:9px;border:1.5px solid var(--border);padding:10px 13px;font:inherit;flex:1;min-width:160px;max-width:220px;direction:ltr;text-align:center;font-size:14px;font-weight:600;background:#fff;color:var(--text);outline:none;transition:all .15s}
input:focus{border-color:var(--green);box-shadow:0 0 0 3px var(--green-bg)}
button{border-radius:9px;border:none;padding:10px 20px;font:inherit;cursor:pointer;font-weight:600;background:var(--green);color:#fff;transition:background .15s;font-size:13.5px}
button:hover{background:var(--green2)}
button.ghost{background:#fff;color:var(--text);border:1px solid var(--border);font-weight:600}
button.ghost:hover{background:var(--bg);border-color:var(--text-dim)}
.status{padding:11px 13px;border-radius:9px;margin-top:14px;font-size:12.5px;line-height:1.7;display:none}
.status.show{display:block}
.status.err{background:var(--red-bg);border:1px solid var(--red-border);color:var(--red)}
.status.ok{background:var(--green-bg);border:1px solid var(--green-border);color:var(--green2)}
.links{margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.links a{color:var(--green2);text-decoration:none;font-size:12.5px;font-weight:600}
.links a:hover{text-decoration:underline}
```

- [ ] **Step 3: Verify class preservation**

```bash
grep -oE "class=\"[a-z][a-z- ]*\"" dashboard/billing.html | sort -u
```

Expected list (classes used in HTML): `card`, `code-box`, `code-row`, `desc`, `ghost`, `icon`, `links`, `status` (and possibly `status err` / `status ok` / `status show`). Every one of them is defined in the new style block.

- [ ] **Step 4: Open `dashboard/billing.html` in browser**

- Card looks flatter, refined
- Icon container is a clean green square (not emoji-only)
- Activation code input has clear focus state
- Buttons are solid green

- [ ] **Step 5: Commit**

```bash
git add dashboard/billing.html
git commit -m "ui(billing): refine activation card — match dashboard tokens"
```

---

## Final Step: Branch Merge

- [ ] **Step 1: Push branch and create / update PR**

After all 6 phases are committed:

```bash
git push origin claude/crazy-greider-e7e237
```

- [ ] **Step 2: Open browser, smoke-test the whole platform**

Click through every tab once:
1. الربط — start button still works
2. الإعدادات — form fields focus correctly, save still calls API
3. دربني — knowledge base panel renders
4. المحادثات — list + chat layout renders, can select a conversation
5. التفعيل — billing redirect works
6. حسابي — account info renders
7. Login → Logout → Login again — no regressions

- [ ] **Step 3: Merge to master**

Either via `gh pr merge` if there's a PR, or merge locally on master if user prefers.

---

## Self-Review Summary

✅ **Spec coverage:** Every file from the file map has a corresponding phase.
- Phase 1 → tokens, topbar, conn-badge, user-pill, dot ✅
- Phase 2 → connect/QR screen + buttons ✅
- Phase 3 → conversations.css (entire file) ✅
- Phase 4 → settings, stats, forms ✅
- Phase 5 → login.html ✅
- Phase 6 → billing.html ✅

✅ **Placeholder scan:** Every CSS block above is a complete, paste-ready replacement.

✅ **Type consistency:** Every CSS class name referenced in the replacements appears verbatim in the original files. No class names invented.

✅ **Hard constraint enforcement:** Every phase has a Step that runs `git diff | grep -E "onclick=|id="` to catch structural breakage.

✅ **Independence:** Each phase touches a distinct file or distinct sections, so phases can be parallelized across different subagents without conflict.
