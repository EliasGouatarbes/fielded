// 12c (functional audit): "contact support" was mentioned on the error page
// and the webhook-failure warning, but pointed nowhere — no actual channel
// existed anywhere in the app. Rendered once, in the shared shell, so every
// page (onboarding, error, and the dashboard) carries it, not just the
// error path — a merchant should have an escape hatch before something
// goes wrong too, not only after.
const SUPPORT_EMAIL = 'elias.gouatarbes@gmail.com';

// Every current call site of renderPage/renderErrorPage passes either a
// static string or a value already validated/derived from a trusted source
// (see src/shopify/oauth.ts's sanitizeShop, HubSpot's own numeric portal id,
// crypto.randomBytes hex keys) — but that was an invariant enforced by
// convention, not by this function, and it broke once (src/hubspot/oauth.ts
// reflected an unvalidated `shop`/`error` query param into renderErrorPage —
// found in the pre-launch security audit). Escaping here makes the shell
// itself safe regardless of what a future call site passes in.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderPageOptions {
  // The onboarding pages (src/shopify/oauth.ts, src/hubspot/oauth.ts) fit
  // comfortably in the default 560px card. The dashboard (src/dashboardPage.ts)
  // needs more room for the deal-rules table — this widens the card rather
  // than introducing a second, divergent layout.
  wide?: boolean;
}

// Minimal, dependency-free HTML wrapper. Originally just for the OAuth
// onboarding flow (the only pages a merchant ever saw, hence "no client-side
// JS or external assets — renders a handful of times per merchant, a build
// step would be pure overhead"). The dashboard page reuses this same shell
// for visual consistency but is the first page in this app with real
// interactivity, so it supplies its own inline `<script>` — that
// justification never applied to *needing JS*, only to not needing a
// framework/bundler for it.
export function renderPage(title: string, bodyHtml: string, options: RenderPageOptions = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f4f5f7;
    color: #1a1a1a;
    margin: 0;
    padding: 3rem 1rem;
    display: flex;
    justify-content: center;
  }
  .card {
    background: #ffffff;
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
    max-width: 560px;
    width: 100%;
    padding: 2rem 2.25rem;
    box-sizing: border-box;
  }
  .card.wide { max-width: 820px; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 0.75rem; }
  p { line-height: 1.55; }
  ul.checklist { list-style: none; padding: 0; margin: 1rem 0; }
  ul.checklist li { padding: 0.3rem 0; }
  .btn {
    display: inline-block;
    background: #ff5c35;
    color: #fff !important;
    text-decoration: none;
    border: none;
    cursor: pointer;
    padding: 0.65rem 1.15rem;
    border-radius: 6px;
    font-weight: 600;
    font-size: 0.95rem;
    margin-top: 0.5rem;
    transition: transform 0.08s ease;
  }
  .btn-secondary {
    background: transparent;
    color: #1a1a1a !important;
    border: 1px solid #d5d8dd;
    transition: transform 0.08s ease;
  }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .btn:active:not(:disabled), .btn-secondary:active:not(:disabled) { transform: scale(0.96); }
  /* Inline loading indicator for a button mid-request (e.g. dashboard's
     "Start historical import") — pure CSS, no external asset, matching this
     app's no-dependency-for-a-handful-of-renders philosophy. */
  .spinner {
    display: inline-block;
    width: 0.8em;
    height: 0.8em;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    vertical-align: -0.15em;
    margin-right: 0.45em;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  code, pre {
    background: #f0f1f3;
    border-radius: 6px;
    font-size: 0.83rem;
  }
  code { padding: 0.15rem 0.4rem; }
  pre { padding: 0.85rem 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .warning { background: #fff4e5; border: 1px solid #f5c66f; border-radius: 8px; padding: 0.75rem 1rem; }
  .error { background: #fdecea; border: 1px solid #f3a9a0; border-radius: 8px; padding: 0.75rem 1rem; color: #7a2018; }
  .muted { color: #666; font-size: 0.88rem; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
  .page-footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; text-align: center; }
  .page-footer a { color: inherit; }
  .page-footer-links { margin-top: 0.4rem; text-align: center; }
  .page-footer-links a { color: inherit; }
  label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.3rem; }
  input[type="text"], input[type="password"], select {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    border: 1px solid #d5d8dd;
    background: #fff;
    color: #1a1a1a;
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
  }
  /* Wraps every table (deal-rules editor, activity feed, connection status)
     rather than letting a wide table force the whole page to scroll
     horizontally on a narrow phone screen — found in the pre-launch audit,
     2026-07-29. The table itself stays a real <table> (no display:block,
     which would break its layout); only this wrapper scrolls. */
  .table-scroll { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.87rem; }
  th, td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { color: #666; font-weight: 600; font-size: 0.8rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .badge-ok { background: #e3f5e9; color: #1c6b3a; }
  .badge-bad { background: #fdecea; color: #7a2018; }
  .badge-neutral { background: #f0f1f3; color: #555; }
  /* Deal-rules editor (src/dashboardPage.ts) — one bordered card per rule
     instead of a cramped multi-column table, so each rule reads as a
     single "if this, then that" statement rather than six unlabeled cells
     a merchant has to cross-reference against a header row above. */
  .rule-card {
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 1rem 1.1rem;
    margin-bottom: 0.85rem;
    background: #fafafa;
  }
  .rule-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
  .rule-number-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 999px;
    background: #ff5c35;
    color: #fff;
    font-size: 0.8rem;
    font-weight: 700;
  }
  .rule-card-actions { display: flex; gap: 0.4rem; }
  .icon-btn {
    background: transparent;
    border: 1px solid #d5d8dd;
    border-radius: 6px;
    width: 2rem;
    height: 2rem;
    line-height: 1;
    cursor: pointer;
    color: #1a1a1a;
    font-size: 0.95rem;
  }
  .icon-btn:disabled { opacity: 0.35; cursor: default; }
  .icon-btn-danger:hover:not(:disabled) { background: #fdecea; border-color: #f3a9a0; color: #7a2018; }
  .rule-row { margin-bottom: 0.75rem; }
  .rule-row:last-child { margin-bottom: 0; }
  .rule-row-label {
    display: block;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #888;
    margin-bottom: 0.4rem;
  }
  .rule-fields { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .rule-field { flex: 1 1 160px; min-width: 140px; }
  .rule-field label { font-size: 0.78rem; font-weight: 500; color: #555; margin-bottom: 0.2rem; }
  .rule-field select, .rule-field input { margin-bottom: 0; }
  .rule-list-actions { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .save-confirmation { color: #1c6b3a; font-size: 0.88rem; font-weight: 600; }
  .empty-state {
    border: 1px dashed #d5d8dd;
    border-radius: 10px;
    padding: 1.1rem 1.25rem;
    margin-bottom: 0.85rem;
  }
  .banner-info { background: #eaf2fe; border: 1px solid #b9d3fb; border-radius: 8px; padding: 0.75rem 1rem; color: #1a3d7c; margin-bottom: 1rem; }
  .banner-info a { color: inherit; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e6e6; }
    .card { background: #1a1d23; box-shadow: none; border: 1px solid #2a2e37; }
    .btn-secondary { color: #e6e6e6 !important; border-color: #3a3f4a; }
    code, pre { background: #24272e; color: #e6e6e6; }
    .warning { background: #3a2e12; border-color: #6b5220; color: #ffdca8; }
    .error { background: #3a1512; border-color: #6b2a20; color: #ffb4a8; }
    .muted { color: #9aa0a6; }
    hr { border-top-color: #2a2e37; }
    .page-footer { border-top-color: #2a2e37; }
    input[type="text"], input[type="password"], select { background: #24272e; color: #e6e6e6; border-color: #3a3f4a; }
    th, td { border-bottom-color: #2a2e37; }
    th { color: #9aa0a6; }
    .badge-ok { background: #123420; color: #6fd897; }
    .badge-bad { background: #3a1512; color: #ffb4a8; }
    .badge-neutral { background: #24272e; color: #9aa0a6; }
    .rule-card { background: #21242b; border-color: #2a2e37; }
    .icon-btn { border-color: #3a3f4a; color: #e6e6e6; }
    .icon-btn-danger:hover:not(:disabled) { background: #3a1512; border-color: #6b2a20; color: #ffb4a8; }
    .rule-row-label { color: #9aa0a6; }
    .rule-field label { color: #9aa0a6; }
    .save-confirmation { color: #6fd897; }
    .empty-state { border-color: #3a3f4a; }
    .banner-info { background: #16233d; border-color: #2c4b86; color: #bcd4fb; }
  }
</style>
</head>
<body>
<div class="card${options.wide ? ' wide' : ''}">
${bodyHtml}
<p class="page-footer muted">Need help? <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
<p class="page-footer-links muted"><a href="/privacy-policy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a> &middot; <a href="/data-processing-agreement">Data Processing Agreement</a></p>
</div>
</body>
</html>`;
}

// `message` is always plain text at every current call site (never HTML
// markup) — escaped unconditionally since some callers build it directly
// from request query params (src/hubspot/oauth.ts's `shop`/`error`), which
// must never be trusted to reach the page unescaped.
export function renderErrorPage(message: string): string {
  return renderPage(
    'Connection failed',
    `<h1>⚠️ Couldn't complete the connection</h1>
    <p>${escapeHtml(message)}</p>`
  );
}
