/**
 * Browser-facing HTML pages in the Feelgood design — used by the endpoints a
 * human actually SEES (OAuth flow errors, the landing page). Self-contained:
 * dark glassmorphism card over animated blurry blobs, atelier logo via
 * GET /logo.png, German copy. JSON stays the contract for API clients; these
 * pages are only returned where a browser is the consumer.
 */

export type PageVariant = "ok" | "error" | "loading" | "info";

const VARIANT_ICON: Record<PageVariant, string> = {
  ok: `<div class="icon ok"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" fill="none"/><path fill="none" d="M14 27l8 8 16-17"/></svg></div>`,
  error: `<div class="icon error"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" fill="none"/><path fill="none" d="M17 17l18 18M35 17l-18 18"/></svg></div>`,
  loading: `<div class="icon loading"><div class="spinner"></div></div>`,
  info: `<div class="icon info"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" fill="none"/><path fill="none" d="M26 16v2M26 24v14"/></svg></div>`,
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface PageOptions {
  title: string;
  heading: string;
  message: string;
  variant: PageVariant;
  /** Small mono detail line (e.g. an error code). */
  detail?: string;
  /** Small badge next to the wordmark (e.g. the version). */
  badge?: string;
}

export function renderPageHtml(opts: PageOptions): string {
  const detail = opts.detail
    ? `<p class="detail">${escapeHtml(opts.detail)}</p>`
    : "";
  const badge = opts.badge ? `<span class="badge">${escapeHtml(opts.badge)}</span>` : "";

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" href="/logo.png" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    background: #0b0b0b;
    color: #fff;
    font-family: "Sora", "Segoe UI", system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; position: relative;
  }
  /* Animated blurry blobs (Feelgood blurple family) */
  .blob { position: absolute; border-radius: 50%; filter: blur(90px); opacity: .32; pointer-events: none; }
  .blob.b1 { width: 480px; height: 480px; background: #5865F2; top: -120px; left: -100px; animation: drift1 22s ease-in-out infinite alternate; }
  .blob.b2 { width: 420px; height: 420px; background: #7289DA; bottom: -140px; right: -80px; animation: drift2 26s ease-in-out infinite alternate; }
  .blob.b3 { width: 320px; height: 320px; background: #3b2f8f; top: 45%; left: 60%; animation: drift3 19s ease-in-out infinite alternate; }
  @keyframes drift1 { to { transform: translate(120px, 80px) scale(1.15); } }
  @keyframes drift2 { to { transform: translate(-100px, -70px) scale(1.2); } }
  @keyframes drift3 { to { transform: translate(-80px, 60px) scale(0.85); } }
  /* Subtle grid like the app */
  .grid { position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
    background-size: 50px 50px; }
  /* Glass card */
  .card {
    position: relative; z-index: 1;
    background: rgba(0,0,0,.55);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 20px;
    padding: 44px 48px;
    max-width: 440px; width: calc(100% - 48px);
    text-align: center;
    animation: rise .5s ease-out both;
    box-shadow: 0 24px 80px rgba(0,0,0,.45);
  }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); } }
  .logo { width: 72px; height: 72px; margin-bottom: 14px; user-select: none; }
  .wordmark { display: flex; align-items: baseline; justify-content: center; gap: 7px; margin-bottom: 26px; }
  .wordmark b { font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
  .wordmark span { font-size: 12px; font-weight: 500; color: #7289DA; }
  .badge { font-size: 10px; color: rgba(255,255,255,.45); background: rgba(255,255,255,.08);
    border-radius: 999px; padding: 2px 8px; margin-left: 4px; }
  h1 { font-size: 19px; font-weight: 600; margin-bottom: 10px; }
  p.message { font-size: 13.5px; line-height: 1.6; color: rgba(255,255,255,.55); }
  p.detail { margin-top: 14px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
    color: rgba(255,255,255,.35); word-break: break-all; }
  .foot { margin-top: 28px; font-size: 10.5px; color: rgba(255,255,255,.25); }
  /* Status icons */
  .icon { width: 52px; height: 52px; margin: 0 auto 18px; }
  .icon svg { width: 100%; height: 100%; }
  .icon svg circle { stroke-width: 2.5; stroke-dasharray: 160; stroke-dashoffset: 160; animation: draw .6s ease-out .15s forwards; }
  .icon svg path { stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 60; stroke-dashoffset: 60; animation: draw .45s ease-out .55s forwards; }
  .icon.ok svg { stroke: #4ade80; } .icon.error svg { stroke: #f87171; } .icon.info svg { stroke: #7289DA; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  .spinner { width: 44px; height: 44px; margin: 4px auto; border-radius: 50%;
    border: 3px solid rgba(255,255,255,.12); border-top-color: #5865F2;
    animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
  <div class="grid"></div>
  <main class="card">
    <img class="logo" src="/logo.png" alt="" draggable="false"
         onerror="this.style.display='none'" />
    <div class="wordmark"><b>atelier</b><span>by feelgood</span>${badge}</div>
    ${VARIANT_ICON[opts.variant]}
    <h1>${escapeHtml(opts.heading)}</h1>
    <p class="message">${escapeHtml(opts.message)}</p>
    ${detail}
    <div class="foot">atelier-api · Feelgood Community</div>
  </main>
</body>
</html>`;
}

/** Full HTML Response (browser-facing endpoints only). */
export function htmlPage(opts: PageOptions, status = 200): Response {
  return new Response(renderPageHtml(opts), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Styled error page for the browser-visited OAuth endpoints. */
export function htmlAuthError(status: number, message: string, code?: string): Response {
  return htmlPage(
    {
      title: "atelier — Anmeldung fehlgeschlagen",
      heading: "Anmeldung fehlgeschlagen",
      message,
      variant: "error",
      detail: code,
    },
    status,
  );
}
