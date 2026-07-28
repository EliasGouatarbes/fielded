// Minimal, dependency-free HTML wrapper for the OAuth onboarding flow
// (src/shopify/oauth.ts, src/hubspot/oauth.ts) — the only pages a merchant
// ever actually sees during install, so worth a consistent, trustworthy
// look rather than bare unstyled `<h1>` text. No client-side JS or external
// assets/fonts: these render a handful of times per merchant, so a build
// step or UI framework would be pure overhead.
export function renderPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
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
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  p { line-height: 1.55; }
  ul.checklist { list-style: none; padding: 0; margin: 1rem 0; }
  ul.checklist li { padding: 0.3rem 0; }
  .btn {
    display: inline-block;
    background: #ff5c35;
    color: #fff !important;
    text-decoration: none;
    padding: 0.65rem 1.15rem;
    border-radius: 6px;
    font-weight: 600;
    margin-top: 0.5rem;
  }
  code, pre {
    background: #f0f1f3;
    border-radius: 6px;
    font-size: 0.83rem;
  }
  code { padding: 0.15rem 0.4rem; }
  pre { padding: 0.85rem 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .warning { background: #fff4e5; border: 1px solid #f5c66f; border-radius: 8px; padding: 0.75rem 1rem; }
  .muted { color: #666; font-size: 0.88rem; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e6e6; }
    .card { background: #1a1d23; box-shadow: none; border: 1px solid #2a2e37; }
    code, pre { background: #24272e; color: #e6e6e6; }
    .warning { background: #3a2e12; border-color: #6b5220; color: #ffdca8; }
    .muted { color: #9aa0a6; }
    hr { border-top-color: #2a2e37; }
  }
</style>
</head>
<body>
<div class="card">
${bodyHtml}
</div>
</body>
</html>`;
}

export function renderErrorPage(message: string): string {
  return renderPage(
    'Connection failed',
    `<h1>⚠️ Couldn't complete the connection</h1>
    <p>${message}</p>
    <p class="muted">If this keeps happening, get in touch and mention this exact message.</p>`
  );
}
