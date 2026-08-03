import { AppConfig } from "../config";

/**
 * Rendered status view.
 *
 * Two things it deliberately does NOT do:
 *  - It never synthesizes a service-by-region matrix. Microsoft publishes no
 *    public API for per-service-per-region health, so everything shown here is
 *    an incident somebody actually published.
 *  - It never shows a green check for something it did not measure. Absence of
 *    an incident is presented as "nothing reported", not "verified healthy".
 *
 * It refreshes itself on a timer and calls out what changed since the last
 * poll, because the public Azure Status feed is pull-only — there is no push
 * signal to subscribe to.
 */
export function renderStatusView(config: AppConfig): string {
  const mockBadge = config.mock
    ? '<span class="badge mock">Sample data (MOCK mode)</span>'
    : "";
  const refreshMs = Math.max(15000, config.watchIntervalMs);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Azure status | Cloud Status Aggregator</title>
  <style>
    :root{--good:#107c10;--info:#0078d4;--warn:#ff8c00;--critical:#d13438;--na:#8a8886;--line:#edebe9;--text:#201f1e;--muted:#605e5c;--bg:#f8f8f8}
    *{box-sizing:border-box} body{margin:0;font-family:"Segoe UI",Arial,sans-serif;color:var(--text);background:#fff}
    header{padding:24px 32px 16px;border-bottom:1px solid var(--line);background:linear-gradient(#fff,#fafafa)}
    h1{font-size:28px;font-weight:600;margin:0 0 8px}.sub{color:var(--muted);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    .toolbar{display:flex;gap:12px;align-items:center;padding:18px 32px;background:var(--bg);border-bottom:1px solid var(--line);flex-wrap:wrap}
    .segmented{display:inline-flex;border:1px solid #c8c6c4;border-radius:3px;overflow:hidden;background:#fff}.segmented button{border:0;background:#fff;padding:9px 16px;font:inherit;cursor:pointer;border-right:1px solid #c8c6c4}.segmented button:last-child{border-right:0}.segmented button.active{background:#0078d4;color:#fff}
    .button{border:1px solid #8a8886;background:#fff;border-radius:3px;padding:9px 14px;font:inherit;cursor:pointer}.button:hover{background:#f3f2f1}
    .spacer{margin-left:auto}
    .live{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
    .pulse{width:9px;height:9px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 rgba(16,124,16,.6);animation:pulse 2s infinite}
    .pulse.paused{background:var(--na);animation:none}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(16,124,16,.55)}70%{box-shadow:0 0 0 9px rgba(16,124,16,0)}100%{box-shadow:0 0 0 0 rgba(16,124,16,0)}}
    .badge{display:inline-block;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600}.mock{background:#fff4ce;color:#8a5200;border:1px solid #ffaa44}.fork{background:#e5f1fb;color:#004578}.fork.tenant{background:#efe4fb;color:#5c2e91}
    main{padding:22px 32px}
    .banner{display:none;margin-bottom:18px;border-left:4px solid var(--good);background:#eff6ef;padding:14px 16px;font-size:17px}.banner.show{display:block}
    .bannersub{display:block;margin-top:5px;font-size:13px;color:#4a5a4a;font-weight:400}
    .banner.tenant{border-left-color:var(--warn);background:#fff8f0;font-size:14px}
    .forknote{color:var(--muted);font-size:13px;margin:0 0 16px;max-width:980px}
    .good{color:var(--good)}.information{color:var(--info)}.warning{color:var(--warn)}.critical{color:var(--critical)}
    .events{margin-bottom:18px;border:1px solid var(--line);border-radius:6px;overflow:hidden;display:none}.events.show{display:block}
    .events h2{margin:0;font-size:14px;font-weight:600;padding:12px 16px;background:#f3f2f1;border-bottom:1px solid var(--line)}
    .event{display:flex;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);align-items:flex-start;transition:background .6s ease}.event:last-child{border-bottom:0}
    .event.isnew{background:#fff8e6;box-shadow:inset 3px 0 0 var(--warn)}
    .ev-pill{flex:none;font-size:11px;font-weight:700;text-transform:uppercase;padding:3px 9px;border-radius:999px;letter-spacing:.03em}.ev-pill.active{background:#fde7e9;color:#a4262c}.ev-pill.scheduled{background:#e5f1fb;color:#004578}.ev-pill.information{background:#eff6ef;color:#107c10}.ev-pill.resolved{background:#f3f2f1;color:#605e5c}
    .newtag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:var(--warn);color:#fff;border-radius:3px;padding:2px 6px;margin-left:8px;vertical-align:middle}
    .ev-title{font-weight:600;font-size:14px}.ev-meta{color:var(--muted);font-size:12px;margin-top:3px}.ev-meta code{background:#f3f2f1;padding:1px 5px;border-radius:3px;font:12px Consolas,monospace}.ev-summary{color:#323130;font-size:13px;margin-top:6px;line-height:1.4}
    .rh{margin-bottom:18px;border:1px solid var(--line);border-radius:6px;overflow:hidden;display:none}.rh.show{display:block}
    .rh h2{margin:0;font-size:14px;font-weight:600;padding:12px 16px;background:#f3f2f1;border-bottom:1px solid var(--line)}
    .rh .rollup{display:flex;gap:18px;flex-wrap:wrap;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px}
    .rh .chip{display:inline-flex;gap:6px;align-items:center}.rh .chip b{font-size:15px}
    .rh .dot{width:10px;height:10px;border-radius:50%;display:inline-block}.dot.av{background:var(--good)}.dot.un{background:var(--na)}.dot.dg{background:var(--warn)}.dot.ua{background:var(--critical)}
    .rh table.svc{width:100%;border-collapse:collapse;font-size:13px}.rh table.svc th,.rh table.svc td{border-bottom:1px solid var(--line);padding:8px 16px;text-align:left}.rh table.svc th{background:#faf9f8;font-weight:600}.rh table.svc td.n,.rh table.svc th.n{text-align:right;font-variant-numeric:tabular-nums}
    .rh .issues{padding:10px 16px;font-size:13px}.rh .issue-row{padding:6px 0;border-bottom:1px dashed var(--line)}.rh .issue-row:last-child{border-bottom:0}
    .rh .ok{padding:12px 16px;font-size:13px;color:var(--good)}
    .hint{color:var(--muted);font-size:13px;margin:6px 0 0;max-width:980px;line-height:1.5}
    .toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,80px);background:#201f1e;color:#fff;padding:13px 20px;border-radius:6px;font-size:14px;box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;transition:transform .35s ease,opacity .35s ease;z-index:1200;display:flex;gap:12px;align-items:center}
    .toast.show{transform:translate(-50%,0);opacity:1}
    .toast b{color:#ffd166}
    /* Indeterminate progress bar: the only honest feedback for a request whose
       duration we cannot predict (tenant Resource Health paginates over ARM). */
    #progress{position:fixed;top:0;left:0;right:0;height:3px;background:transparent;z-index:1300;pointer-events:none;opacity:0;transition:opacity .2s ease}
    #progress.on{opacity:1}
    #progress i{display:block;height:100%;width:40%;background:linear-gradient(90deg,transparent,var(--info),transparent);animation:slide 1.1s linear infinite}
    @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
    .button[disabled]{opacity:.55;cursor:default}.button[disabled]:hover{background:#fff}
    /* Flash the timestamp so a refresh is visibly acknowledged even when the
       underlying data has not changed. */
    @keyframes flash{0%{background:#fff4ce}100%{background:transparent}}
    .flash{animation:flash 1s ease-out}
    #updated{border-radius:3px;padding:2px 4px}
    .rel{color:var(--muted);font-size:12px}
    /* Skeleton shown while the slow tenant Resource Health call is in flight. */
    .skel-row{height:12px;border-radius:3px;margin:10px 16px;background:linear-gradient(90deg,#f3f2f1 25%,#eae9e8 37%,#f3f2f1 63%);background-size:400% 100%;animation:shimmer 1.4s ease infinite}
    @keyframes shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
    .rh .loading-note{padding:12px 16px;font-size:13px;color:var(--muted)}
    .panel{position:fixed;inset:0;display:none;z-index:1100}.panel.open{display:block}.scrim{position:absolute;inset:0;background:rgba(0,0,0,.25)}.drawer{position:absolute;right:0;top:0;height:100%;width:min(680px,94vw);background:#fff;box-shadow:-8px 0 24px rgba(0,0,0,.2);display:flex;flex-direction:column}.drawer header{padding:16px 20px}.drawer pre{margin:0;padding:18px;overflow:auto;white-space:pre-wrap;font:12px/1.45 Consolas,monospace;flex:1;background:#111;color:#f3f2f1}
  </style>
</head>
<body>
  <div id="progress" aria-hidden="true"><i></i></div>
  <header>
    <h1>Azure status</h1>
    <div class="sub"><span id="updated">Updated —</span><span id="rel" class="rel"></span><span id="forkBadge" class="badge fork">Public view</span>${mockBadge}</div>
  </header>
  <section class="toolbar">
    <div class="segmented" aria-label="Status fork">
      <button id="publicBtn" class="active" data-fork="public">Public</button>
      <button id="tenantBtn" data-fork="tenant">Tenant</button>
    </div>
    <button id="jsonBtn" class="button">View JSON</button>
    <div class="spacer"></div>
    <span class="live"><span id="pulse" class="pulse"></span><span id="liveLabel">Live &mdash; checking every ${Math.round(
      refreshMs / 1000
    )}s</span></span>
    <button id="pauseBtn" class="button">Pause</button>
    <button id="refreshBtn" class="button">Refresh now</button>
  </section>
  <main>
    <div id="forknote" class="forknote"></div>
    <div id="healthyBanner" class="banner">Nothing reported &mdash; no widespread Azure issues are currently published<span class="bannersub">Absence of a published incident is not a health check. Microsoft publishes no per-service, per-region probe.</span></div>
    <div id="tenantBanner" class="banner tenant"></div>
    <section id="incidents" class="events"></section>
    <section id="events" class="events"></section>
    <section id="resourceHealth" class="rh"></section>
    <p id="hint" class="hint"></p>
  </main>

  <div id="toast" class="toast"></div>

  <aside id="jsonPanel" class="panel" aria-hidden="true">
    <div class="scrim" id="closeScrim"></div>
    <section class="drawer">
      <header style="display:flex;justify-content:space-between;align-items:center"><h2 id="jsonTitle" style="margin:0;font-size:16px">Live status JSON</h2><button id="closeJson" class="button">Close</button></header>
      <pre id="jsonPre"></pre>
    </section>
  </aside>

  <script>
    const REFRESH_MS = ${refreshMs};
    const SOURCE_LABELS = {emergingIssues:"Emerging issues",statusFeed:"Azure Status feed",serviceHealth:"Service Health"};
    let fork = "public";
    let currentStatus = null, currentRh = null;
    let seenIds = null;          // null until the first successful load
    let newIds = new Set();      // ids that appeared on the most recent poll
    let paused = false, timer = null, toastTimer = null;
    const el = (id) => document.getElementById(id);
    function esc(s) {
      return String(s == null ? "" : s).replace(/[&\u003c>"]/g, (c) => ({"&":"&amp;","\u003c":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
    }
    function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

    function renderIssueList(wrap, heading, items) {
      if (!items || items.length === 0) { wrap.classList.remove("show"); wrap.innerHTML = ""; return; }
      wrap.classList.add("show");
      wrap.innerHTML = '\u003ch2>' + esc(heading) + ' (' + items.length + ')\u003c/h2>' +
        items.map((e) => {
          const pill = e.status === "active" || e.status === "in-progress" ? "active"
            : (e.status === "scheduled" ? "scheduled"
            : (e.status === "resolved" ? "resolved" : "information"));
          const tid = e.trackingId ? '\u003ccode>' + esc(e.trackingId) + '\u003c/code> \u00b7 ' : "";
          const where = [].concat(e.impactedServices || [], e.impactedRegions || []).slice(0, 6).map(esc).join(", ");
          const src = SOURCE_LABELS[e.source] || e.source;
          const summary = e.summary ? '\u003cdiv class="ev-summary">' + esc(String(e.summary).slice(0, 240)) + '\u003c/div>' : "";
          const fresh = newIds.has(e.id);
          const tag = fresh ? '\u003cspan class="newtag">New\u003c/span>' : "";
          return '\u003cdiv class="event' + (fresh ? " isnew" : "") + '">\u003cspan class="ev-pill ' + pill + '">' + esc(e.status) + '\u003c/span>' +
            '\u003cdiv class="ev-body">\u003cdiv class="ev-title">' + esc(e.title) + tag + '\u003c/div>' +
            '\u003cdiv class="ev-meta">' + tid + esc(cap(e.category)) + (where ? ' \u00b7 ' + where : "") + ' \u00b7 ' + esc(src) + '\u003c/div>' + summary + '\u003c/div>\u003c/div>';
        }).join("");
    }

    function renderResourceHealth(rh) {
      const wrap = el("resourceHealth");
      const isTenant = fork === "tenant";
      if (!isTenant || !rh || !rh.ok || !rh.summary || rh.summary.total === 0) {
        wrap.classList.remove("show"); wrap.innerHTML = ""; return;
      }
      const s = rh.summary;
      const byService = rh.byService || [];
      wrap.classList.add("show");
      let html = '\u003ch2>Live resource availability \u2014 your subscriptions (Layer 3 \u00b7 Resource Health)\u003c/h2>';
      html += '\u003cdiv class="rollup">' +
        '\u003cspan class="chip">\u003cspan class="dot av">\u003c/span>\u003cb>' + s.available + '\u003c/b> Available\u003c/span>' +
        '\u003cspan class="chip">\u003cspan class="dot dg">\u003c/span>\u003cb>' + s.degraded + '\u003c/b> Degraded\u003c/span>' +
        '\u003cspan class="chip">\u003cspan class="dot ua">\u003c/span>\u003cb>' + s.unavailable + '\u003c/b> Unavailable\u003c/span>' +
        '\u003cspan class="chip">\u003cspan class="dot un">\u003c/span>\u003cb>' + s.unknown + '\u003c/b> No active signal\u003c/span>' +
        '\u003cspan class="chip" style="margin-left:auto;color:var(--muted)">' + s.total + ' resources \u00b7 ' + byService.length + ' services\u003c/span>' +
        '\u003c/div>';
      html += '\u003ctable class="svc">\u003cthead>\u003ctr>\u003cth>Service\u003c/th>\u003cth class="n">Total\u003c/th>\u003cth class="n">Available\u003c/th>\u003cth class="n">No signal\u003c/th>\u003cth class="n">Issues\u003c/th>\u003c/tr>\u003c/thead>\u003ctbody>';
      byService.forEach(function (r) {
        const issuesCell = r.issues ? '\u003cb class="critical">' + r.issues + '\u003c/b>' : '0';
        html += '\u003ctr>\u003ctd>' + esc(r.service) + '\u003c/td>\u003ctd class="n">' + r.total + '\u003c/td>\u003ctd class="n">' + r.available + '\u003c/td>\u003ctd class="n">' + r.unknown + '\u003c/td>\u003ctd class="n">' + issuesCell + '\u003c/td>\u003c/tr>';
      });
      html += '\u003c/tbody>\u003c/table>';
      const problems = (rh.resources || []).filter(function (x) { return x.state === "Degraded" || x.state === "Unavailable"; });
      if (problems.length) {
        html += '\u003cdiv class="issues">\u003cb>Resources needing attention\u003c/b>';
        problems.forEach(function (p) {
          const cls = p.state === "Unavailable" ? "critical" : "warning";
          const sum = p.summary ? '\u003cdiv style="color:#323130;margin-top:2px">' + esc(String(p.summary).slice(0, 200)) + '\u003c/div>' : "";
          html += '\u003cdiv class="issue-row">\u003cb class="' + cls + '">' + esc(p.state) + '\u003c/b> \u2014 ' + esc(p.name) +
            ' \u003cspan style="color:var(--muted)">(' + esc(p.service) + ' \u00b7 ' + esc(p.region) + ')\u003c/span>' + sum + '\u003c/div>';
        });
        html += '\u003c/div>';
      } else {
        html += '\u003cdiv class="ok">\u2713 All ' + s.available + ' reporting resources are Available \u2014 no degraded or unavailable resources right now.\u003c/div>';
      }
      wrap.innerHTML = html;
    }

    function showToast(html) {
      const t = el("toast");
      t.innerHTML = html;
      t.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove("show"), 9000);
    }

    function render() {
      const s = currentStatus || { global: [], regional: [], maintenance: [], generatedAt: new Date().toISOString() };
      const all = [].concat(s.global || [], s.regional || [], s.maintenance || []);
      const incidents = all.filter((i) => i.source !== "serviceHealth");
      const events = all.filter((i) => i.source === "serviceHealth");
      const isTenant = fork === "tenant";

      // The timestamp, the fork chrome and the Resource Health card are painted
      // by their own paths (paintTimestamp / paintForkChrome / loadResources) so
      // that a fast status render never clears the in-flight Resource Health
      // skeleton underneath it.
      renderIssueList(el("incidents"), "Active Azure incidents \u2014 public feed", incidents);
      renderIssueList(el("events"), "Service Health events scoped to your subscriptions", events);

      el("healthyBanner").classList.toggle("show", incidents.length === 0);
      const tb = el("tenantBanner");
      tb.classList.toggle("show", isTenant && events.length > 0);
      tb.textContent = "\u25b2 " + events.length + " Service Health event" + (events.length === 1 ? "" : "s") +
        " scoped to your subscriptions \u2014 not shown in the public feed.";

      const liveCount = incidents.length + (isTenant ? events.length : 0);
      el("hint").textContent = liveCount === 0
        ? "Nothing is currently reported by the configured sources. That means Microsoft has published no incident \u2014 it is not a per-service health check."
        : "";
    }

    // --- Loading state ------------------------------------------------------
    // Two requests back this page and they have very different costs: /api/status
    // answers in ~0.3s, while the tenant Resource Health call paginates over ARM
    // and takes ~5s. They are issued independently and rendered as they land, so
    // the fast half of the page never waits on the slow half.
    let inflight = 0;
    function beginRequest() {
      inflight++;
      el("progress").classList.add("on");
      el("refreshBtn").disabled = true;
      el("refreshBtn").textContent = "Refreshing\u2026";
    }
    function endRequest() {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) {
        el("progress").classList.remove("on");
        el("refreshBtn").disabled = false;
        el("refreshBtn").textContent = "Refresh now";
        setLiveLabel();
      }
    }
    function setLiveLabel() {
      el("liveLabel").textContent = paused
        ? "Paused"
        : "Live \u2014 checking every " + Math.round(REFRESH_MS / 1000) + "s";
    }

    // A monotonic token. Switching forks while a slow request is in flight must
    // not let the stale response paint over the newer view.
    let reqSeq = 0;

    // --- Timestamp ----------------------------------------------------------
    // generatedAt is server-side and changes on every request, so it is the
    // honest "as of" time. It is paired with a relative label that ticks every
    // second, so a stalled page is obvious rather than silently stale.
    let lastGeneratedAt = null;
    function paintTimestamp(iso) {
      const changed = iso !== lastGeneratedAt;
      lastGeneratedAt = iso;
      const u = el("updated");
      u.textContent = "Updated " + new Date(iso).toLocaleTimeString();
      if (changed) {
        u.classList.remove("flash");
        void u.offsetWidth;   // restart the animation
        u.classList.add("flash");
      }
      paintRelative();
    }
    function paintRelative() {
      if (!lastGeneratedAt) return;
      const secs = Math.max(0, Math.round((Date.now() - new Date(lastGeneratedAt).getTime()) / 1000));
      el("rel").textContent = secs < 5 ? "just now"
        : (secs < 60 ? "\u00b7 " + secs + "s ago"
        : "\u00b7 " + Math.floor(secs / 60) + "m ago");
    }
    setInterval(paintRelative, 1000);

    // --- Fork switching -----------------------------------------------------
    // Everything that can be known without a round trip is painted immediately,
    // so the click always feels instant even though the data is seconds away.
    function paintForkChrome() {
      const isTenant = fork === "tenant";
      const badge = el("forkBadge");
      badge.textContent = isTenant ? "Tenant view" : "Public view";
      badge.classList.toggle("tenant", isTenant);
      el("forknote").textContent = isTenant
        ? "Tenant view \u2014 Layer 2 (Service Health): service issues, advisories & planned maintenance scoped to your subscriptions, PLUS Layer 3 (Resource Health): live, per-resource availability. This is what the public status page cannot show you."
        : "Public view \u2014 Layer 1 (Azure Status): Azure's subscription-independent feed of widespread incidents & planned maintenance \u2014 the same coarse view anyone sees at status.azure.com. No per-subscription or per-resource health.";
      document.querySelectorAll("[data-fork]").forEach((b) => b.classList.toggle("active", b.dataset.fork === fork));
    }

    function showResourceSkeleton() {
      const wrap = el("resourceHealth");
      wrap.classList.add("show");
      wrap.innerHTML = '\u003ch2>Live resource availability \u2014 your subscriptions (Layer 3 \u00b7 Resource Health)\u003c/h2>' +
        '\u003cdiv class="loading-note">Querying Azure Resource Health across your subscriptions\u2026\u003c/div>' +
        '\u003cdiv class="skel-row" style="width:82%">\u003c/div>' +
        '\u003cdiv class="skel-row" style="width:64%">\u003c/div>' +
        '\u003cdiv class="skel-row" style="width:73%">\u003c/div>';
    }

    // --- Independent loaders ------------------------------------------------
    async function loadStatus(token, isPoll) {
      beginRequest();
      try {
        const res = await fetch("/api/status?fork=" + encodeURIComponent(fork));
        if (token !== reqSeq) return;              // a newer request superseded this
        if (!res.ok) throw new Error("HTTP " + res.status);
        const status = await res.json();
        if (token !== reqSeq) return;
        currentStatus = status;

        const all = [].concat(status.global || [], status.regional || [], status.maintenance || []);
        const ids = new Set(all.map((i) => i.id));
        if (seenIds === null) {
          newIds = new Set();
        } else {
          newIds = new Set([...ids].filter((id) => !seenIds.has(id)));
          const goneCount = [...seenIds].filter((id) => !ids.has(id)).length;
          if (newIds.size > 0) {
            const titles = all.filter((i) => newIds.has(i.id)).slice(0, 2).map((i) => i.title);
            showToast('\u003cb>' + newIds.size + ' new incident' + (newIds.size === 1 ? '' : 's') + '\u003c/b> \u00b7 ' + esc(titles.join(" \u2014 ")).slice(0, 160));
          } else if (goneCount > 0 && isPoll) {
            showToast('\u003cb>' + goneCount + ' incident' + (goneCount === 1 ? '' : 's') + ' cleared\u003c/b>');
          }
        }
        seenIds = ids;
        render();
        paintTimestamp(status.generatedAt);
      } catch (err) {
        if (token !== reqSeq) return;
        el("liveLabel").textContent = "Refresh failed \u2014 retrying";
        if (!currentStatus) {
          el("incidents").classList.add("show");
          el("incidents").innerHTML = '\u003ch2>Failed to load status\u003c/h2>\u003cdiv class="event">' + esc(err.message) + '\u003c/div>';
        }
      } finally {
        endRequest();
      }
    }

    // Resource Health is tenant-only and slow. It is deliberately NOT awaited
    // alongside the status call: a failure or a timeout here must not stop the
    // rest of the page from updating.
    async function loadResources(token) {
      if (fork !== "tenant") { currentRh = null; renderResourceHealth(null); return; }
      showResourceSkeleton();
      beginRequest();
      try {
        const res = await fetch("/api/status/resources?fork=tenant");
        if (token !== reqSeq) return;
        currentRh = res.ok ? await res.json() : null;
        if (token !== reqSeq) return;
        renderResourceHealth(currentRh);
      } catch (err) {
        if (token !== reqSeq) return;
        currentRh = null;
        const wrap = el("resourceHealth");
        wrap.classList.add("show");
        wrap.innerHTML = '\u003ch2>Live resource availability\u003c/h2>\u003cdiv class="loading-note">Could not reach Resource Health: ' + esc(err.message) + '\u003c/div>';
      } finally {
        endRequest();
      }
    }

    function load(opts) {
      const isPoll = !!(opts && opts.poll);
      const token = ++reqSeq;
      paintForkChrome();
      el("liveLabel").textContent = fork === "tenant"
        ? "Loading tenant view\u2026"
        : "Loading\u2026";
      return Promise.all([loadStatus(token, isPoll), loadResources(token)]);
    }

    function schedule() {
      clearInterval(timer);
      if (paused) return;
      timer = setInterval(() => load({ poll: true }), REFRESH_MS);
    }

    function openJson(title, payload) {
      el("jsonTitle").textContent = title;
      el("jsonPre").textContent = payload ? JSON.stringify(payload, null, 2) : "Not available for this view.";
      el("jsonPanel").classList.add("open"); el("jsonPanel").setAttribute("aria-hidden", "false");
    }
    function closeJson() { el("jsonPanel").classList.remove("open"); el("jsonPanel").setAttribute("aria-hidden", "true"); }

    document.addEventListener("click", (e) => {
      const forkBtn = e.target.closest("[data-fork]");
      if (forkBtn) {
        if (forkBtn.dataset.fork === fork) return;   // already here; don't re-baseline
        fork = forkBtn.dataset.fork;
        seenIds = null;   // switching forks changes the population; re-baseline
        newIds = new Set();
        load();
        return;
      }
    });
    el("jsonBtn").onclick = () => openJson("Live status JSON (/api/status?fork=" + fork + ")", currentStatus);
    el("refreshBtn").onclick = () => load({ poll: true });
    el("pauseBtn").onclick = () => {
      paused = !paused;
      el("pauseBtn").textContent = paused ? "Resume" : "Pause";
      el("pulse").classList.toggle("paused", paused);
      setLiveLabel();
      schedule();
    };
    el("closeJson").onclick = el("closeScrim").onclick = closeJson;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeJson(); });

    // Don't hammer the API while the tab is in the background.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { clearInterval(timer); }
      else if (!paused) { load({ poll: true }); schedule(); }
    });

    load().then(schedule);
  </script>
</body>
</html>`;
}
