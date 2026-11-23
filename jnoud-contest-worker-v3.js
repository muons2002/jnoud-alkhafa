// جنود الخفاء — مسابقة التوقعات v3: محرك خفيف + لوحة تحكم + سجل أعضاء ولوحة شرف
// KV binding: CONTEST_KV
// التخزين: v3:cfg (إعداد المسابقة الحالية) | v3:e:<match>:<id> (توقع) | v3:res (النتائج)
//          v3:stats (سجل الأعضاء: مشاركات/إصابات/بطولات) | v3:hist (أرشيف المسابقات)
// /state تُخدَم من كاش الحافة 45 ثانية: قراءات KV محدودة مهما زاد عدد الزوار.
// /list القديم يظل يعمل من مفاتيح v2 (e:z:/e:a:) لصفحة مسابقة 23 نوفمبر الأرشيفية.
const ADMIN_HASH = "f7b769a7278e520d5b9a92df3ff6625600ca25e64fc33d0256beda4e8ea38a76";

function cors(extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Key",
    "Content-Type": "application/json; charset=utf-8"
  }, extra || {});
}
function clean(s, n) {
  return String(s == null ? "" : s).replace(/[<>&"']/g, "").trim().slice(0, n);
}
function goal(v) {
  const x = parseInt(v, 10);
  if (isNaN(x)) return 0;
  return Math.max(0, Math.min(15, x));
}
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function isAdmin(req) {
  const k = req.headers.get("X-Key") || "";
  if (!k) return false;
  return (await sha256(k)) === ADMIN_HASH;
}
async function readAll(env, prefix, cap) {
  const out = [];
  let cursor;
  do {
    const page = await env.CONTEST_KV.list({ prefix: prefix, cursor: cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await env.CONTEST_KV.get(k.name, "json");
      if (v) out.push(v);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && out.length < (cap || 1000));
  return out;
}
function hallFrom(stats) {
  const arr = Object.keys(stats || {}).map(n => Object.assign({ name: n }, stats[n]));
  const by = f => arr.slice().sort((a, b) => (f(b) - f(a)) || (a.p - b.p)).filter(x => f(x) > 0).slice(0, 10);
  return {
    players: by(x => x.p),
    champs: by(x => x.champ),
    snipers: by(x => x.hit)
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });

    // ---------- الحالة الكاملة للصفحة (من الكاش 45 ثانية) ----------
    if (url.pathname === "/state" && req.method === "GET") {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + "/state", { method: "GET" });
      let hit = await cache.match(cacheKey);
      if (hit) return hit;
      const cfg = await env.CONTEST_KV.get("v3:cfg", "json");
      const res = (await env.CONTEST_KV.get("v3:res", "json")) || {};
      const stats = (await env.CONTEST_KV.get("v3:stats", "json")) || {};
      const hist = (await env.CONTEST_KV.get("v3:hist", "json")) || [];
      const entries = {};
      if (cfg && cfg.matches) {
        for (const m of cfg.matches) {
          const list = await readAll(env, "v3:e:" + m.k + ":");
          list.sort((a, b) => a.ts - b.ts);
          entries[m.k] = list;
        }
      }
      const body = JSON.stringify({ cfg: cfg, entries: entries, results: res, hall: hallFrom(stats), hist: hist });
      const resp = new Response(body, { headers: cors({ "Cache-Control": "public, max-age=45" }) });
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    // ---------- تسجيل توقع ----------
    if (url.pathname === "/enter" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: cors() });
      }
      const cfg = await env.CONTEST_KV.get("v3:cfg", "json");
      if (!cfg || !cfg.open) {
        return new Response(JSON.stringify({ error: "closed" }), { status: 403, headers: cors() });
      }
      const m = clean(b.m, 8);
      const match = (cfg.matches || []).find(x => x.k === m);
      if (!match) {
        return new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: cors() });
      }
      const deadline = (match.kickoff || 0) - (match.closeMin || 10) * 60000;
      if (match.kickoff && Date.now() > deadline) {
        return new Response(JSON.stringify({ error: "closed" }), { status: 403, headers: cors() });
      }
      const id = clean(b.id, 40);
      const name = clean(b.name, 30);
      if (!id || !name) {
        return new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: cors() });
      }
      const key = "v3:e:" + m + ":" + id;
      const prev = await env.CONTEST_KV.get(key, "json");
      const rec = { id: id, name: name, h: goal(b.h), w: goal(b.w), ts: prev && prev.ts ? prev.ts : Date.now() };
      await env.CONTEST_KV.put(key, JSON.stringify(rec));
      return new Response(JSON.stringify({ ok: true }), { headers: cors() });
    }

    // ---------- التوافق: /list القديم لصفحة الأرشيف ----------
    if (url.pathname === "/list" && req.method === "GET") {
      const result = {};
      for (const m of ["z", "a"]) {
        const out = await readAll(env, "e:" + m + ":");
        out.sort((x, y) => x.ts - y.ts);
        result[m] = out.slice(0, 1000);
      }
      return new Response(JSON.stringify(result), { headers: cors() });
    }

    // ---------- الإدارة ----------
    if (url.pathname.startsWith("/admin/")) {
      if (!(await isAdmin(req))) {
        return new Response(JSON.stringify({ error: "auth" }), { status: 401, headers: cors() });
      }
      let b = {};
      if (req.method === "POST") { try { b = await req.json(); } catch (e) { b = {}; } }

      if (url.pathname === "/admin/create" && req.method === "POST") {
        const matches = (b.matches || []).slice(0, 12).map((x, i) => ({
          k: "m" + (i + 1),
          home: clean(x.home, 30),
          away: clean(x.away, 30),
          when: clean(x.when, 40),
          kickoff: parseInt(x.kickoff, 10) || 0,
          closeMin: Math.max(0, Math.min(120, parseInt(x.closeMin, 10) || 10))
        })).filter(x => x.home && x.away);
        if (!matches.length) {
          return new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: cors() });
        }
        // مسح توقعات ونتائج المسابقة السابقة (السجل والأرشيف محفوظان)
        const old = await env.CONTEST_KV.get("v3:cfg", "json");
        if (old && old.matches) {
          for (const m of old.matches) {
            const keys = await readAllKeys(env, "v3:e:" + m.k + ":");
            for (const k of keys) await env.CONTEST_KV.delete(k);
          }
        }
        const cfg = {
          id: "c" + Date.now(),
          title: clean(b.title, 60) || "مسابقة التوقعات",
          sub: clean(b.sub, 80),
          matches: matches,
          open: true,
          scored: false,
          created: Date.now()
        };
        await env.CONTEST_KV.put("v3:cfg", JSON.stringify(cfg));
        await env.CONTEST_KV.put("v3:res", JSON.stringify({}));
        return new Response(JSON.stringify({ ok: true, cfg: cfg }), { headers: cors() });
      }

      if (url.pathname === "/admin/toggle" && req.method === "POST") {
        const cfg = await env.CONTEST_KV.get("v3:cfg", "json");
        if (!cfg) return new Response(JSON.stringify({ error: "nocfg" }), { status: 404, headers: cors() });
        cfg.open = !!b.open;
        await env.CONTEST_KV.put("v3:cfg", JSON.stringify(cfg));
        return new Response(JSON.stringify({ ok: true, open: cfg.open }), { headers: cors() });
      }

      if (url.pathname === "/admin/results" && req.method === "POST") {
        const cfg = await env.CONTEST_KV.get("v3:cfg", "json");
        if (!cfg) return new Response(JSON.stringify({ error: "nocfg" }), { status: 404, headers: cors() });
        if (cfg.scored) return new Response(JSON.stringify({ error: "scored" }), { status: 409, headers: cors() });
        const res = {};
        for (const m of cfg.matches) {
          const r = (b.results || {})[m.k];
          if (r) res[m.k] = { h: goal(r.h), w: goal(r.w) };
        }
        if (!Object.keys(res).length) {
          return new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: cors() });
        }
        await env.CONTEST_KV.put("v3:res", JSON.stringify(res));
        // حساب الفائزين وتحديث سجل الأعضاء والأرشيف — مرة واحدة
        const stats = (await env.CONTEST_KV.get("v3:stats", "json")) || {};
        const winners = {}, champs = {};
        for (const m of cfg.matches) {
          const list = await readAll(env, "v3:e:" + m.k + ":");
          list.sort((a, b2) => a.ts - b2.ts);
          const R = res[m.k];
          const exact = R ? list.filter(e => e.h === R.h && e.w === R.w) : [];
          winners[m.k] = exact.map(e => e.name);
          champs[m.k] = exact.length ? exact[0].name : null;
          for (const e of list) {
            const s = stats[e.name] || { p: 0, hit: 0, champ: 0 };
            s.p += 1;
            if (R && e.h === R.h && e.w === R.w) s.hit += 1;
            stats[e.name] = s;
          }
          if (exact.length) {
            const s = stats[exact[0].name] || { p: 0, hit: 0, champ: 0 };
            s.champ += 1;
            stats[exact[0].name] = s;
          }
        }
        await env.CONTEST_KV.put("v3:stats", JSON.stringify(stats));
        const hist = (await env.CONTEST_KV.get("v3:hist", "json")) || [];
        hist.unshift({
          id: cfg.id, title: cfg.title, date: cfg.created,
          matches: cfg.matches.map(m => ({ home: m.home, away: m.away, res: res[m.k] || null })),
          winners: winners, champs: champs
        });
        await env.CONTEST_KV.put("v3:hist", JSON.stringify(hist.slice(0, 50)));
        cfg.scored = true;
        cfg.open = false;
        await env.CONTEST_KV.put("v3:cfg", JSON.stringify(cfg));
        return new Response(JSON.stringify({ ok: true, winners: winners, champs: champs }), { headers: cors() });
      }

      if (url.pathname === "/admin/migrate" && req.method === "POST") {
        // ترحيل لمرة واحدة: مسابقة 23 نوفمبر 2026 من مفاتيح v2 إلى السجل والأرشيف
        const stats = (await env.CONTEST_KV.get("v3:stats", "json")) || {};
        if (stats.__migrated1) return new Response(JSON.stringify({ ok: true, already: true }), { headers: cors() });
        const RES = { z: { h: 1, w: 2 }, a: { h: 0, w: 2 } };
        const META = { z: { home: "الجونة", away: "الزمالك" }, a: { home: "الأهلي", away: "بيراميدز" } };
        const winners = {}, champs = {};
        for (const m of ["z", "a"]) {
          const list = await readAll(env, "e:" + m + ":");
          list.sort((a, b2) => a.ts - b2.ts);
          const R = RES[m];
          const exact = list.filter(e => e.h === R.h && e.w === R.w);
          winners[m] = exact.map(e => e.name);
          champs[m] = exact.length ? exact[0].name : null;
          for (const e of list) {
            const s = stats[e.name] || { p: 0, hit: 0, champ: 0 };
            s.p += 1;
            if (e.h === R.h && e.w === R.w) s.hit += 1;
            stats[e.name] = s;
          }
          if (exact.length) stats[exact[0].name].champ += 1;
        }
        stats.__migrated1 = { p: 0, hit: 0, champ: 0 };
        await env.CONTEST_KV.put("v3:stats", JSON.stringify(stats));
        const hist = (await env.CONTEST_KV.get("v3:hist", "json")) || [];
        hist.push({
          id: "c20261123", title: "مسابقة التوقعات — الإثنين ٢٣ نوفمبر", date: Date.UTC(2026, 10, 23),
          matches: ["z", "a"].map(m => ({ home: META[m].home, away: META[m].away, res: RES[m] })),
          winners: winners, champs: champs
        });
        await env.CONTEST_KV.put("v3:hist", JSON.stringify(hist.slice(0, 50)));
        return new Response(JSON.stringify({ ok: true, winners: winners, champs: champs }), { headers: cors() });
      }

      return new Response(JSON.stringify({ error: "nf" }), { status: 404, headers: cors() });
    }

    return new Response("jnoud-contest v3 ok", { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
  }
};

async function readAllKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.CONTEST_KV.list({ prefix: prefix, cursor: cursor, limit: 1000 });
    for (const k of page.keys) out.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}
