/**
 * Browser-facing HTML pages in the Feelgood design — used by the endpoints a
 * human actually SEES (OAuth flow errors, the landing page). Matches the
 * desktop login: hero video backdrop (GET /hero.webm) under a gradient veil,
 * big atelier branding on the left, a glass status card on the right; logo via
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
  /* Hero video backdrop + gradient veil + subtle grid (matches the app login) */
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }
  .veil { position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: linear-gradient(to bottom, rgba(11,11,11,.78), rgba(11,11,11,.62) 45%, rgba(11,11,11,.92)); }
  .grid { position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: .5;
    background-image: linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
    background-size: 50px 50px; }
  /* Split stage: big branding left, card right */
  .stage { position: relative; z-index: 1; width: 100%; max-width: 1080px;
    padding: 0 56px; display: flex; align-items: center; justify-content: space-between; gap: 56px; }
  .brand { display: flex; flex-direction: column; align-items: flex-start; gap: 16px;
    animation: rise .5s ease-out both; }
  .brand .logo { width: 104px; height: 104px; user-select: none; }
  .wordmark { display: flex; align-items: baseline; gap: 12px; }
  .wordmark b { font-size: 46px; font-weight: 600; letter-spacing: -.02em; line-height: 1; }
  .wordmark span { font-size: 16px; font-weight: 500; color: #7289DA; }
  .badge { font-size: 11px; color: rgba(255,255,255,.5); background: rgba(255,255,255,.08);
    border-radius: 999px; padding: 3px 9px; align-self: center; }
  .tag { font-size: 15px; line-height: 1.5; color: rgba(255,255,255,.55); max-width: 360px; }
  /* Glass card */
  .card {
    position: relative;
    background: rgba(0,0,0,.55);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 20px;
    padding: 40px 44px;
    width: 380px; flex-shrink: 0;
    text-align: center;
    animation: rise .5s ease-out .08s both;
    box-shadow: 0 24px 80px rgba(0,0,0,.45);
  }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); } }
  h1 { font-size: 19px; font-weight: 600; margin-bottom: 10px; }
  p.message { font-size: 13.5px; line-height: 1.6; color: rgba(255,255,255,.55); }
  p.detail { margin-top: 14px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
    color: rgba(255,255,255,.35); word-break: break-all; }
  .foot { margin-top: 26px; font-size: 10.5px; color: rgba(255,255,255,.25); }
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
  /* Stack on narrow viewports */
  @media (max-width: 780px) {
    .stage { flex-direction: column; gap: 32px; padding: 0 24px; text-align: center; }
    .brand { align-items: center; }
    .tag { display: none; }
    .card { width: 100%; max-width: 400px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .brand, .card { animation: none; }
  }
</style>
</head>
<body>
  <video class="bg" autoplay loop muted playsinline aria-hidden="true"
         onerror="this.style.display='none'">
    <source src="/hero.webm" type="video/webm" />
  </video>
  <div class="veil"></div>
  <div class="grid"></div>
  <div class="stage">
    <div class="brand">
      <img class="logo" src="/logo.png" alt="" draggable="false"
           onerror="this.style.display='none'" />
      <div class="wordmark"><b>atelier</b><span>by feelgood</span>${badge}</div>
      <p class="tag">Sync-Server der atelier-Desktop-App.</p>
    </div>
    <main class="card">
      ${VARIANT_ICON[opts.variant]}
      <h1>${escapeHtml(opts.heading)}</h1>
      <p class="message">${escapeHtml(opts.message)}</p>
      ${detail}
      <div class="foot">atelier-api · Feelgood Community</div>
    </main>
  </div>
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
