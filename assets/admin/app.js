/* atelier-api admin dashboard — vanilla client. Talks to /api/v1/admin/web/*
 * (cookie-authed). No build step. */
(() => {
  "use strict";
  const API = "/api/v1/admin/web";
  const view = document.getElementById("view");
  const titleEl = document.getElementById("title");
  const subEl = document.getElementById("subtitle");

  /* ----------------------------------------------------------- helpers */
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  function fmtBytes(n) {
    if (n == null) return "–";
    if (n < 1024) return n + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + " " + u[i];
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmtTime(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function fmtDate(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    return d.toLocaleDateString("de-DE") + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function ago(iso) {
    if (!iso) return "–";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "gerade eben";
    if (s < 3600) return "vor " + Math.floor(s / 60) + " Min";
    if (s < 86400) return "vor " + Math.floor(s / 3600) + " Std";
    return "vor " + Math.floor(s / 86400) + " Tagen";
  }

  let toastTimer;
  function toast(msg, kind) {
    let box = document.querySelector(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  async function api(path, opts) {
    const res = await fetch(API + path, { credentials: "same-origin", ...(opts || {}) });
    if (res.status === 401) { location.href = "/admin"; throw new Error("unauthorized"); }
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await res.json().catch(() => ({})) : null;
    if (!res.ok) throw new Error((body && body.error) || ("HTTP " + res.status));
    return body;
  }

  const STATUS_LABEL = { done: "fertig", error: "Fehler", running: "läuft", queued: "wartet" };
  function badge(status) {
    return '<span class="badge badge-' + esc(status) + '"><span class="dot"></span>' +
      esc(STATUS_LABEL[status] || status) + "</span>";
  }
  function loading() { view.innerHTML = '<div class="empty"><span class="spinner"></span></div>'; }
  function errorView(e) { view.innerHTML = '<div class="card"><div class="empty">Fehler: ' + esc(e.message) + "</div></div>"; }

  /* ----------------------------------------------------------- overview */
  async function viewOverview() {
    setHead("Übersicht", "Server-Status, Speicher und Kennzahlen");
    loading();
    let d;
    try { d = await api("/overview"); } catch (e) { return errorView(e); }
    const c = d.counts, st = d.storage;
    const tile = (label, value, unit, extra) =>
      '<div class="stat"><div class="glow"></div><div class="label">' + esc(label) + "</div>" +
      '<div class="value">' + esc(value) + (unit ? '<span class="unit">' + esc(unit) + "</span>" : "") + "</div>" +
      (extra ? '<div class="extra">' + esc(extra) + "</div>" : "") + "</div>";
    view.innerHTML =
      '<div class="grid cols-4">' +
        tile("Speicher gesamt", fmtBytes(st.totalBytes), "", st.cas.files + st.builds.files + st.tmp.files + " Dateien") +
        tile("Assets (CAS)", c.assets, "", fmtBytes(st.cas.bytes)) +
        tile("Builds", c.builds.done, "fertig", st.builds.files + " ZIPs · " + fmtBytes(st.builds.bytes)) +
        tile("Packs", c.packs, "", c.revisions + " Revisionen") +
      "</div>" +
      '<div class="grid cols-4" style="margin-top:18px">' +
        tile("Nutzer", c.users.total, "", c.users.approved + " freigeschaltet") +
        tile("Wartet auf Freigabe", c.users.pending, "", c.users.locked + " gesperrt") +
        tile("Version", d.version, "", "läuft seit " + uptime(d.uptimeSec)) +
        tile("tmp (Uploads)", fmtBytes(st.tmp.bytes), "", st.tmp.files + " Dateien") +
      "</div>" +
      '<div class="card" style="margin-top:18px"><div class="card-h"><h2>Speicher-Aufschlüsselung</h2>' +
        '<span class="hint mono">' + esc(st.root) + "</span></div>" +
        bar("CAS-Assets", st.cas.bytes, st.totalBytes) +
        bar("Build-Artefakte", st.builds.bytes, st.totalBytes) +
        bar("Temporär (tmp)", st.tmp.bytes, st.totalBytes) +
      "</div>";
  }
  function uptime(s) {
    if (s < 60) return Math.floor(s) + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function bar(label, val, total) {
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;
    return '<div style="margin:12px 0"><div class="spread" style="margin-bottom:6px">' +
      '<span style="font-size:13px">' + esc(label) + "</span>" +
      '<span class="muted mono" style="font-size:12px">' + fmtBytes(val) + " · " + pct + "%</span></div>" +
      '<div style="height:8px;border-radius:8px;background:rgba(255,255,255,.06);overflow:hidden">' +
      '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#5865f2,#7289da)"></div></div></div>';
  }

  /* --------------------------------------------------------------- logs */
  let sse = null;
  function closeSse() { if (sse) { sse.close(); sse = null; } }

  async function viewLogs() {
    setHead("Logs", "Server-Logs (live) und Aktivitätsprotokoll");
    view.innerHTML =
      '<div class="tabs"><div class="tab active" data-tab="server">Server-Logs</div>' +
      '<div class="tab" data-tab="activity">Aktivität</div></div><div id="logpane"></div>';
    view.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => {
        view.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        t.dataset.tab === "server" ? logServer() : logActivity();
      }));
    logServer();
  }

  async function logServer() {
    closeSse();
    const pane = document.getElementById("logpane");
    pane.innerHTML = '<div class="card"><div class="card-h"><h2>Server-Logs</h2>' +
      '<span class="hint">live · letzte 500 Zeilen</span></div><div class="logbox" id="logbox"></div></div>';
    const boxEl = document.getElementById("logbox");
    const render = (e) => {
      const atBottom = boxEl.scrollHeight - boxEl.scrollTop - boxEl.clientHeight < 40;
      const line = document.createElement("div");
      line.className = "log-line " + e.level;
      line.innerHTML = '<span class="t">' + fmtTime(e.ts) + '</span><span class="s">' + esc(e.scope) +
        '</span><span class="m">' + esc(e.msg) + "</span>";
      boxEl.appendChild(line);
      while (boxEl.childElementCount > 600) boxEl.firstChild.remove();
      if (atBottom) boxEl.scrollTop = boxEl.scrollHeight;
    };
    try {
      const d = await api("/logs");
      (d.items || []).forEach(render);
      boxEl.scrollTop = boxEl.scrollHeight;
    } catch (e) { boxEl.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; return; }
    // live tail
    sse = new EventSource(API + "/logs/stream");
    sse.onmessage = (ev) => { try { render(JSON.parse(ev.data)); } catch (_) {} };
    sse.onerror = () => {};
  }

  async function logActivity() {
    closeSse();
    const pane = document.getElementById("logpane");
    pane.innerHTML = '<div class="card"><div class="empty"><span class="spinner"></span></div></div>';
    let d;
    try { d = await api("/activity?limit=200"); } catch (e) { pane.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + "</div></div>"; return; }
    const rows = (d.items || []).map((a) =>
      "<tr><td class='muted mono'>" + fmtDate(a.ts) + "</td><td><b>" + esc(a.type) + "</b></td>" +
      "<td class='mono'>" + esc(a.actorDiscordId) + "</td><td class='muted mono' style='font-size:11px'>" +
      esc(JSON.stringify(a.data || {})) + "</td></tr>").join("");
    pane.innerHTML = '<div class="card"><div class="card-h"><h2>Aktivität</h2><span class="hint">' +
      (d.items ? d.items.length : 0) + " Einträge</span></div>" +
      (rows ? '<table class="table"><thead><tr><th>Zeit</th><th>Aktion</th><th>Akteur</th><th>Details</th></tr></thead><tbody>' +
        rows + "</tbody></table>" : '<div class="empty">Noch keine Aktivität.</div>') + "</div>";
  }

  /* -------------------------------------------------------------- packs */
  async function viewPacks() {
    setHead("Packs & Builds", "Server-Builds erzeugen und Pakete herunterladen");
    loading();
    let d;
    try { d = await api("/packs"); } catch (e) { return errorView(e); }
    if (!d.packs.length) { view.innerHTML = '<div class="card"><div class="empty">Noch keine Packs.</div></div>'; return; }
    const rows = d.packs.map((p) =>
      '<tr style="cursor:pointer" data-pack="' + esc(p.packId) + '">' +
      "<td><b>" + esc(p.name) + "</b><div class='muted mono' style='font-size:11px'>" + esc(p.slug) + "</div></td>" +
      "<td class='mono'>" + esc(p.ownerDiscordId) + "</td>" +
      "<td>" + (p.headRevision || "–") + "</td>" +
      "<td>" + (p.hasBuildConfig ? '<span class="badge badge-running"><span class="dot"></span>angepasst</span>' : '<span class="muted">Standard</span>') + "</td>" +
      "<td style='text-align:right'><span class='muted'>öffnen ›</span></td></tr>").join("");
    view.innerHTML = '<div class="card"><div class="card-h"><h2>Alle Packs</h2><span class="hint">' +
      d.packs.length + ' Packs</span></div><table class="table"><thead><tr><th>Pack</th><th>Owner</th>' +
      "<th>Head-Rev</th><th>Build-Config</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>";
    view.querySelectorAll("[data-pack]").forEach((r) =>
      r.addEventListener("click", () => { location.hash = "#pack/" + r.dataset.pack; }));
  }

  async function viewPack(packId) {
    setHead("Pack", "Builds & fxmanifest");
    loading();
    let d;
    try { d = await api("/packs/" + encodeURIComponent(packId)); } catch (e) { return errorView(e); }
    const p = d.pack;
    const cfg = d.buildConfig || {};
    const revRows = d.revisions.length ? d.revisions.map((r) => {
      const b = d.builds.find((x) => x.revision === r.revision);
      const dl = b && b.status === "done"
        ? '<a class="btn btn-sm btn-primary" href="' + API + "/builds/" + esc(b.buildId) + '/download">ZIP laden</a>' : "";
      const st = b ? badge(b.status) : '<span class="muted">kein Build</span>';
      const sz = b && b.sizeBytes ? "<span class='muted mono' style='font-size:11px'>" + fmtBytes(b.sizeBytes) + "</span>" : "";
      return "<tr><td><b>r" + r.revision + "</b>" + (r.revision === p.headRevision ? ' <span class="badge badge-done"><span class="dot"></span>head</span>' : "") +
        "<div class='muted' style='font-size:11px'>" + esc(r.message || "") + "</div></td>" +
        "<td>" + (r.drawableCount != null ? r.drawableCount : "–") + "</td>" +
        "<td class='muted mono' style='font-size:11px'>" + esc(r.dlcName || "–") + "</td>" +
        "<td>" + st + " " + sz + "</td>" +
        "<td style='text-align:right'><div class='row' style='justify-content:flex-end'>" +
        '<button class="btn btn-sm" data-build="' + r.revision + '">' + (b ? "neu bauen" : "bauen") + "</button>" + dl +
        "</div></td></tr>";
    }).join("") : "";
    view.innerHTML =
      '<div class="back" id="back">‹ zurück zu Packs</div>' +
      '<div class="card"><div class="card-h"><h2>' + esc(p.name) + '</h2><span class="hint mono">' + esc(p.slug) + "</span></div>" +
      (revRows ? '<table class="table"><thead><tr><th>Revision</th><th>Drawables</th><th>DLC</th><th>Build</th><th></th></tr></thead><tbody>' +
        revRows + "</tbody></table>" : '<div class="empty">Dieser Pack hat noch keine Revisionen.</div>') + "</div>" +
      // fxmanifest editor
      '<div class="card"><div class="card-h"><h2>fxmanifest & Build-Config</h2>' +
        '<span class="hint">gilt für Server-Builds dieses Packs</span></div>' +
        '<div class="field"><label>Resource-Name (optional)</label>' +
        '<input type="text" id="resName" placeholder="Standard: DLC-Name" value="' + esc(cfg.resourceName || "") + '">' +
        '<div class="desc">Überschreibt den Ordner-/Resource-Namen. Leer = Standard.</div></div>' +
        '<div class="field"><label>fxmanifest.lua Template</label>' +
        '<textarea id="fxTpl" spellcheck="false" placeholder="' + esc(d.defaultTemplate) + '">' + esc(cfg.fxmanifestTemplate || "") + "</textarea>" +
        '<div class="desc">Platzhalter <span class="mono">{{files}}</span> (Stream-Globs) und <span class="mono">{{data_files}}</span> ' +
        '(Shop-Meta-Zeilen) werden beim Build ersetzt. Leer = Standard-Manifest (byte-identisch zum Desktop-Build).</div></div>' +
        '<div class="row"><button class="btn btn-primary" id="saveCfg">Speichern</button>' +
        '<button class="btn" id="rebuildCfg">Speichern & Head neu bauen</button>' +
        '<button class="btn" id="loadDefault">Default einfügen</button>' +
        '<button class="btn" id="resetCfg">Zurücksetzen</button></div>' +
      "</div>";
    document.getElementById("back").addEventListener("click", () => { location.hash = "#packs"; });
    view.querySelectorAll("[data-build]").forEach((btn) =>
      btn.addEventListener("click", () => triggerBuild(packId, Number(btn.dataset.build), btn)));
    document.getElementById("loadDefault").addEventListener("click", () => { document.getElementById("fxTpl").value = d.defaultTemplate; });
    document.getElementById("saveCfg").addEventListener("click", () => saveCfg(packId, false));
    document.getElementById("rebuildCfg").addEventListener("click", () => saveCfg(packId, true, p.headRevision));
    document.getElementById("resetCfg").addEventListener("click", () => resetCfg(packId));
  }

  async function saveCfg(packId, rebuild, headRev) {
    const resourceName = document.getElementById("resName").value.trim();
    const fxmanifestTemplate = document.getElementById("fxTpl").value;
    try {
      await api("/packs/" + encodeURIComponent(packId) + "/build-config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceName, fxmanifestTemplate }),
      });
      toast("Build-Config gespeichert", "ok");
      if (rebuild) {
        if (!headRev) { toast("Keine Revision zum Bauen", "err"); return; }
        await api("/packs/" + encodeURIComponent(packId) + "/builds", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: "head", force: true }),
        });
        toast("Neuer Build gestartet — gleich im Build-Tab", "ok");
      }
      viewPack(packId);
    } catch (e) { toast(e.message, "err"); }
  }
  async function resetCfg(packId) {
    try {
      await api("/packs/" + encodeURIComponent(packId) + "/build-config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceName: "", fxmanifestTemplate: "" }),
      });
      toast("Auf Standard zurückgesetzt", "ok"); viewPack(packId);
    } catch (e) { toast(e.message, "err"); }
  }
  async function triggerBuild(packId, revision, btn) {
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await api("/packs/" + encodeURIComponent(packId) + "/builds", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, force: true }),
      });
      toast("Build " + (r.build.status === "done" ? "fertig" : "gestartet") + " (r" + revision + ")", "ok");
      pollPack(packId);
    } catch (e) { toast(e.message, "err"); btn.disabled = false; btn.textContent = "bauen"; }
  }
  // Refresh the pack view a few times so queued/running builds settle to done.
  let pollTimer;
  function pollPack(packId) {
    clearInterval(pollTimer);
    let n = 0;
    pollTimer = setInterval(async () => {
      if (location.hash !== "#pack/" + packId || ++n > 12) { clearInterval(pollTimer); return; }
      try {
        const d = await api("/packs/" + encodeURIComponent(packId));
        const inFlight = d.builds.some((b) => b.status === "queued" || b.status === "running");
        if (!inFlight) { clearInterval(pollTimer); viewPack(packId); }
      } catch (_) { clearInterval(pollTimer); }
    }, 2500);
    viewPack(packId);
  }

  /* ------------------------------------------------------------- builds */
  async function viewBuilds() {
    setHead("Pakete", "Alle Server-Builds zum Herunterladen");
    loading();
    let d;
    try { d = await api("/builds"); } catch (e) { return errorView(e); }
    if (!d.builds.length) { view.innerHTML = '<div class="card"><div class="empty">Noch keine Builds erzeugt.</div></div>'; return; }
    const rows = d.builds.map((b) =>
      "<tr><td><b>" + esc(b.packName || b.packId) + "</b></td><td>r" + b.revision + "</td><td>" + badge(b.status) + "</td>" +
      "<td class='mono'>" + (b.sizeBytes ? fmtBytes(b.sizeBytes) : "–") + "</td>" +
      "<td class='muted'>" + ago(b.finishedAt) + "</td><td style='text-align:right'>" +
      (b.status === "done" ? '<a class="btn btn-sm btn-primary" href="' + API + "/builds/" + esc(b.buildId) + '/download">ZIP laden</a>' :
        b.status === "error" ? "<span class='muted' title='" + esc(b.error || "") + "'>fehlgeschlagen</span>" : "<span class='muted'>…</span>") +
      "</td></tr>").join("");
    view.innerHTML = '<div class="card"><div class="card-h"><h2>Server-Builds</h2><span class="hint">' +
      d.builds.length + ' Builds</span></div><table class="table"><thead><tr><th>Pack</th><th>Rev</th><th>Status</th>' +
      "<th>Größe</th><th>fertig</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  /* -------------------------------------------------------------- users */
  async function viewUsers() {
    setHead("Nutzer", "Freigaben und Sperren");
    loading();
    let d;
    try { d = await api("/users"); } catch (e) { return errorView(e); }
    const rows = d.users.map((u) => {
      const av = u.avatar ? '<img src="' + esc(u.avatar) + '" style="width:26px;height:26px;border-radius:50%">' :
        '<div style="width:26px;height:26px;border-radius:50%;background:#5865f2"></div>';
      const st = u.status === "approved" ? '<span class="badge badge-done"><span class="dot"></span>frei</span>' :
        u.status === "locked" ? '<span class="badge badge-error"><span class="dot"></span>gesperrt</span>' :
        '<span class="badge badge-queued"><span class="dot"></span>wartet</span>';
      let act = "";
      if (u.status !== "approved") act += '<button class="btn btn-sm btn-primary" data-approve="' + esc(u.discordId) + '">freischalten</button> ';
      if (u.status !== "locked") act += '<button class="btn btn-sm" data-lock="' + esc(u.discordId) + '">sperren</button>';
      return "<tr><td><div class='row'>" + av + "<b>" + esc(u.username) + "</b></div></td>" +
        "<td class='mono'>" + esc(u.discordId) + "</td><td>" + st + "</td>" +
        "<td>" + (u.role === "admin" ? '<span class="badge badge-running"><span class="dot"></span>admin</span>' : "member") + "</td>" +
        "<td style='text-align:right'>" + act + "</td></tr>";
    }).join("");
    view.innerHTML = '<div class="card"><div class="card-h"><h2>Nutzer</h2><span class="hint">' +
      d.users.length + ' gesamt</span></div><table class="table"><thead><tr><th>Name</th><th>Discord-ID</th>' +
      "<th>Status</th><th>Rolle</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>";
    const act = async (id, path, label) => {
      try { await api("/users/" + encodeURIComponent(id) + path, { method: "POST", headers: { "content-type": "application/json" } });
        toast(label, "ok"); viewUsers(); } catch (e) { toast(e.message, "err"); }
    };
    view.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => act(b.dataset.approve, "/approve", "Freigeschaltet")));
    view.querySelectorAll("[data-lock]").forEach((b) => b.addEventListener("click", () => act(b.dataset.lock, "/lock", "Gesperrt")));
  }

  /* ------------------------------------------------------------- router */
  function setHead(title, sub) { titleEl.textContent = title; subEl.textContent = sub || ""; }
  function setActive(route) {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.route === route));
  }

  function route() {
    closeSse();
    const h = location.hash.replace(/^#/, "") || "overview";
    if (h.startsWith("pack/")) { setActive("packs"); return viewPack(h.slice(5)); }
    setActive(h);
    switch (h) {
      case "logs": return viewLogs();
      case "packs": return viewPacks();
      case "builds": return viewBuilds();
      case "users": return viewUsers();
      default: return viewOverview();
    }
  }

  document.querySelectorAll(".nav-item").forEach((n) =>
    n.addEventListener("click", () => { location.hash = "#" + n.dataset.route; }));
  window.addEventListener("hashchange", route);
  route();
})();
