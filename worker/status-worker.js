/**
 * Boardli status page — Cloudflare Worker
 *
 * scheduled(): probes each endpoint and folds the result into a rolling
 *              90-day aggregate held in a single KV key.
 * fetch():     renders the public status page from that same key.
 *
 * One KV read + one KV write per cron tick, one KV read per page view.
 */

const SITES = [
  { id: "website", name: "Website", url: "https://boardli.ai", blurb: "Public site and marketing pages" },
  { id: "app", name: "Application", url: "https://app.boardli.ai", blurb: "Board portal, meetings, documents" },
  { id: "api", name: "API", url: "https://api.boardli.ai/health", blurb: "Backend services and integrations" },
];

const KEY = "state";
const DAYS = 90;
const TIMEOUT_MS = 10000;

const today = (d = new Date()) => d.toISOString().slice(0, 10);

function lastDays(n) {
  const out = [];
  const base = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(today(new Date(base - i * 86400000)));
  return out;
}

async function probe(site) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(site.url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Boardli-Status/1.0 (+https://status.boardli.ai)" },
    });
    return { up: res.status >= 200 && res.status < 400, code: res.status, ms: Date.now() - started };
  } catch (err) {
    return { up: false, code: 0, ms: Date.now() - started, error: String(err && err.name) };
  } finally {
    clearTimeout(timer);
  }
}

async function readState(env) {
  const raw = await env.STATUS.get(KEY, { type: "json" });
  return raw && raw.days ? raw : { updatedAt: null, current: {}, days: {} };
}

async function runChecks(env) {
  const state = await readState(env);
  const day = today();
  const results = await Promise.all(SITES.map(probe));

  state.days[day] = state.days[day] || {};
  SITES.forEach((site, i) => {
    const r = results[i];
    state.current[site.id] = { up: r.up, code: r.code, ms: r.ms, at: new Date().toISOString() };
    const bucket = state.days[day][site.id] || { ok: 0, fail: 0, ms: 0, n: 0 };
    bucket[r.up ? "ok" : "fail"] += 1;
    if (r.up) { bucket.ms += r.ms; bucket.n += 1; }
    state.days[day][site.id] = bucket;
  });

  // Drop anything outside the retention window so the key stays small.
  const keep = new Set(lastDays(DAYS));
  for (const d of Object.keys(state.days)) if (!keep.has(d)) delete state.days[d];

  state.updatedAt = new Date().toISOString();
  await env.STATUS.put(KEY, JSON.stringify(state));
  return state;
}

/* ---------- rendering ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function dayClass(bucket) {
  if (!bucket || bucket.ok + bucket.fail === 0) return "none";
  if (bucket.fail === 0) return "ok";
  const ratio = bucket.fail / (bucket.ok + bucket.fail);
  return ratio >= 0.5 ? "down" : "partial";
}

function uptimeFor(state, id, days) {
  let ok = 0, fail = 0;
  for (const d of days) {
    const b = state.days[d] && state.days[d][id];
    if (b) { ok += b.ok; fail += b.fail; }
  }
  const total = ok + fail;
  return total ? (ok / total) * 100 : null;
}

function avgMs(state, id, days) {
  let ms = 0, n = 0;
  for (const d of days) {
    const b = state.days[d] && state.days[d][id];
    if (b) { ms += b.ms; n += b.n; }
  }
  return n ? Math.round(ms / n) : null;
}

function render(state) {
  const days = lastDays(DAYS);
  const rows = SITES.map((site) => {
    const cur = state.current[site.id];
    const up = cur ? cur.up : null;
    const pct = uptimeFor(state, site.id, days);
    const ms = avgMs(state, site.id, days);
    const bars = days
      .map((d) => {
        const b = state.days[d] && state.days[d][site.id];
        const cls = dayClass(b);
        const label = cls === "none" ? `${d} — no data` : `${d} — ${b.ok} ok, ${b.fail} failed`;
        return `<span class="bar ${cls}" title="${esc(label)}"></span>`;
      })
      .join("");
    return `
      <li class="svc">
        <div class="svc-head">
          <div class="svc-id">
            <span class="dot ${up === null ? "none" : up ? "ok" : "down"}" aria-hidden="true"></span>
            <div>
              <h2>${esc(site.name)}</h2>
              <p class="blurb">${esc(site.blurb)}</p>
            </div>
          </div>
          <div class="svc-meta">
            <span class="state ${up === null ? "none" : up ? "ok" : "down"}">${up === null ? "No data" : up ? "Operational" : "Down"}</span>
            ${ms === null ? "" : `<span class="num">${ms} ms avg</span>`}
          </div>
        </div>
        <div class="bars" role="img" aria-label="${esc(site.name)} daily availability, last ${DAYS} days">${bars}</div>
        <div class="scale">
          <span>${DAYS} days ago</span>
          <span class="rule"></span>
          <span class="pct">${pct === null ? "no data yet" : pct.toFixed(2) + "% uptime"}</span>
          <span class="rule"></span>
          <span>Today</span>
        </div>
      </li>`;
  }).join("");

  // Incidents are derived from the same aggregate: any day with a failed check.
  const incidents = [];
  for (const d of [...days].reverse()) {
    const perSite = state.days[d];
    if (!perSite) continue;
    const hit = SITES.filter((s) => perSite[s.id] && perSite[s.id].fail > 0);
    if (hit.length) {
      incidents.push({
        date: d,
        items: hit.map((s) => ({ name: s.name, fail: perSite[s.id].fail, total: perSite[s.id].fail + perSite[s.id].ok })),
      });
    }
    if (incidents.length >= 10) break;
  }
  const incidentHtml = incidents.length
    ? incidents.map((i) => `
        <li class="inc">
          <span class="inc-date">${esc(i.date)}</span>
          <span class="inc-body">${i.items.map((x) => `${esc(x.name)} — ${x.fail} failed check${x.fail === 1 ? "" : "s"} of ${x.total}`).join("<br>")}</span>
        </li>`).join("")
    : `<li class="inc none-inc">No incidents recorded in the last ${DAYS} days.</li>`;

  const anyDown = SITES.some((s) => state.current[s.id] && state.current[s.id].up === false);
  const anyData = SITES.some((s) => state.current[s.id]);
  const banner = !anyData ? { cls: "none", text: "Awaiting first check" }
    : anyDown ? { cls: "down", text: "Some systems are experiencing issues" }
    : { cls: "ok", text: "All systems operational" };

  const checked = state.updatedAt
    ? new Date(state.updatedAt).toUTCString().replace("GMT", "UTC")
    : "—";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boardli Status</title>
<meta name="description" content="Live availability and 90-day history for Boardli's website, application and API.">
<meta name="theme-color" content="#102A43" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F0F4F8" media="(prefers-color-scheme: light)">
<link rel="icon" href="https://raw.githubusercontent.com/Boardli/status/master/assets/boardli-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  /* One family, weight contrast — product register: display faces belong on
     brand surfaces, not on a utility page people read during an incident. */
  :root {
    color-scheme: light dark;
    --ink:        #102A43;
    --ink-2:      #334E68;
    --ink-3:      #627D98;
    --line:       #D9E2EC;
    --surface:    #FFFFFF;
    --bg:         #F0F4F8;
    --accent:     #1992D4;
    --ok:         #0B8457;
    --ok-soft:    #C6F1DE;
    --down:       #C4314B;
    --down-soft:  #FFD5DC;
    --partial:    #B76E00;
    --none:       #CBD4DE;
    --radius:     10px;
    --ease:       cubic-bezier(0.22, 1, 0.36, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #F0F4F8; --ink-2: #BCCCDC; --ink-3: #829AB1;
      --line: #243B53; --surface: #16283D; --bg: #0B1B2B;
      --accent: #5ED0FA; --ok: #3EBD93; --ok-soft: #14453B;
      --down: #FF7D8C; --down-soft: #4A1D28; --partial: #F0B429; --none: #2C3F55;
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink-2);
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }

  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 2.25rem; }
  .brand { display: flex; align-items: center; gap: 0.625rem; text-decoration: none; }
  .brand img { height: 26px; width: auto; display: block; }
  .brand span { font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }
  .home { color: var(--ink-3); text-decoration: none; font-size: 0.875rem; font-weight: 500; transition: color 180ms var(--ease); }
  .home:hover { color: var(--accent); }

  h1 { font-size: 1.75rem; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; color: var(--ink); margin: 0 0 0.4rem; text-wrap: balance; }
  .lede { margin: 0 0 2rem; color: var(--ink-3); max-width: 60ch; }

  /* Status banner: a solid, unambiguous statement. The one place on this page
     that earns full saturation — it is the answer most visitors came for. */
  .banner {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 1.125rem 1.25rem; border-radius: var(--radius);
    font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.01em;
    margin-bottom: 2.25rem; color: #fff; background: var(--ink-3);
  }
  .banner.ok   { background: var(--ok); }
  .banner.down { background: var(--down); }
  .banner.none { background: var(--ink-3); }
  .banner .pip { width: 8px; height: 8px; border-radius: 50%; flex: none; background: rgba(255,255,255,0.9); }
  @media (prefers-color-scheme: dark) {
    .banner { color: #06131F; }
  }

  /* Services: a divided list, not a stack of identical cards. */
  ul.svcs { list-style: none; margin: 0; padding: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .svc { padding: 1.25rem 1.25rem 1.125rem; }
  .svc + .svc { border-top: 1px solid var(--line); }
  .svc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.875rem; }
  .svc-id { display: flex; align-items: flex-start; gap: 0.625rem; min-width: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 0.5rem; flex: none; background: var(--none); }
  .dot.ok { background: var(--ok); } .dot.down { background: var(--down); }
  .svc h2 { font-size: 0.9375rem; font-weight: 600; color: var(--ink); margin: 0; letter-spacing: -0.005em; }
  .blurb { margin: 0.1rem 0 0; font-size: 0.8125rem; color: var(--ink-3); }
  .svc-meta { text-align: right; flex: none; }
  .state { display: block; font-size: 0.8125rem; font-weight: 500; }
  .state.ok { color: var(--ok); } .state.down { color: var(--down); } .state.none { color: var(--ink-3); }
  .num { display: block; font-size: 0.8125rem; color: var(--ink-3); font-variant-numeric: tabular-nums; }

  /* 90-day availability strip — the actual information on a status page. */
  .bars { display: flex; gap: 2px; height: 34px; align-items: stretch; }
  .bar { flex: 1 1 0; min-width: 2px; border-radius: 2px; background: var(--none); transition: transform 160ms var(--ease); }
  .bar.ok { background: var(--ok); } .bar.partial { background: var(--partial); } .bar.down { background: var(--down); }
  .bar:hover { transform: scaleY(1.12); }

  /* Scale line: uptime sits inline between two rules, so the number is read
     as a property of the strip above it rather than a detached statistic. */
  .scale { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; font-size: 0.6875rem; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .scale .rule { flex: 1 1 auto; height: 1px; background: var(--line); }
  .scale .pct { flex: none; font-weight: 500; }

  /* Past incidents */
  h3 { font-size: 0.9375rem; font-weight: 600; color: var(--ink); margin: 2.25rem 0 0.75rem; letter-spacing: -0.005em; }
  ul.incs { list-style: none; margin: 0; padding: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .inc { display: flex; gap: 1rem; padding: 0.875rem 1.25rem; font-size: 0.8125rem; }
  .inc + .inc { border-top: 1px solid var(--line); }
  .inc-date { flex: none; width: 6.5rem; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .inc-body { color: var(--ink-2); }
  .none-inc { color: var(--ink-3); }

  footer { margin-top: 2.25rem; display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; font-size: 0.75rem; color: var(--ink-3); }
  footer a { color: var(--ink-3); text-decoration: none; }
  footer a:hover { color: var(--accent); text-decoration: underline; }

  @media (max-width: 30rem) {
    .wrap { padding: 1.75rem 1rem 3rem; }
    .bars { height: 26px; }
    .blurb { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
    .bar:hover { transform: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="brand" href="https://boardli.ai">
      <img src="https://raw.githubusercontent.com/Boardli/status/master/assets/boardli-logo.webp" alt="Boardli">
    </a>
    <a class="home" href="https://app.boardli.ai/login">Sign in &rarr;</a>
  </header>

  <h1>System status</h1>
  <p class="lede">Live availability for the Boardli website, application and API, with ${DAYS} days of history. Checked automatically every minute.</p>

  <div class="banner ${banner.cls}"><span class="pip"></span>${esc(banner.text)}</div>

  <ul class="svcs">${rows}</ul>

  <h3>Past incidents</h3>
  <ul class="incs">${incidentHtml}</ul>

  <footer>
    <span>Last checked ${esc(checked)}</span>
    <span>Subscribe via <a href="/api/status.json">JSON</a> &middot; <a href="https://boardli.ai">Boardli</a></span>
  </footer>
</div>
</body>
</html>`;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status.json") {
      const state = await readState(env);
      return Response.json(
        { updatedAt: state.updatedAt, sites: SITES.map((s) => ({ id: s.id, name: s.name, ...(state.current[s.id] || {}) })) },
        { headers: { "cache-control": "public, max-age=30", "access-control-allow-origin": "*" } }
      );
    }

    // Manual trigger, same code path as the cron, for verification.
    if (url.pathname === "/__check") {
      const state = await runChecks(env);
      return Response.json({ ran: true, updatedAt: state.updatedAt, current: state.current });
    }

    const state = await readState(env);
    return new Response(render(state), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=30",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
    });
  },
};
