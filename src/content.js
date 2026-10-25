// Motor da extensão. Roda dentro da aba do YouTube e continua trabalhando
// mesmo que o popup seja fechado. O popup só envia comandos e lê o status.
(() => {
  "use strict";
  if (window.__lcEngine) return;
  window.__lcEngine = true;

  const VERSION = "0.1.5";
  const REQ = "__LC_REQ__", RES = "__LC_RES__";

  const CFG = {
    settleMs: 500,          // espera antes de conferir a lista após cada grupo
    minEff: 0.90,           // aceitação mínima do YouTube; abaixo disso desacelera/troca de método
    goodEff: 0.98,          // aceitação boa (2 grupos seguidos): acelera
    coolOffMs: 10000,       // pausa fixa após um grupo ruim
    maxAttemptsPerId: 4,    // depois disso o vídeo é considerado "teimoso"
    maxBatches: 2000,
    maxRetries: 3,
    maxFailuresInRow: 12,
    useParams: true         // envia removeLikeParams do YouTube (método "um por vez")
  };
  // conc = pedidos simultâneos | delay = pausa entre pedidos | bulk = vídeos por pedido | batch = vídeos por grupo
  const LEVELS = [
    { conc: 1,  delay: [1200, 2000], bulk: 5,  batch: 50 },
    { conc: 1,  delay: [500, 900],   bulk: 10, batch: 50 },
    { conc: 1,  delay: [150, 300],   bulk: 20, batch: 100 },
    { conc: 2,  delay: [100, 200],   bulk: 25, batch: 100 },
    { conc: 3,  delay: [60, 160],    bulk: 30, batch: 100 },
    { conc: 6,  delay: [0, 30],      bulk: 40, batch: 200 },
    { conc: 12, delay: [0, 0],       bulk: 50, batch: 300 }
  ];
  const SPEEDS = { safe: 2, normal: 4, turbo: 5, max: 6 };   // nível máximo de cada modo
  const MAX_CONC = 12;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // ====== UTILITÁRIOS ======
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = ([a, b]) => Math.floor(a + Math.random() * (b - a));
  const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
  const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  // Em aba oculta o navegador limita timers a ~1s: pausas curtas são puladas.
  const pace = async ms => { if (document.hidden && ms < 1000) return; await sleep(ms); };
  const txt = v => v == null ? "" : typeof v === "string" ? v
    : (v.simpleText ?? v.content ?? (Array.isArray(v.runs) ? v.runs.map(r => r.text).join("") : ""));

  // Percorre a árvore em pré-ordem (mantém a ordem dos itens da lista).
  const scanTree = (root, fn) => {
    const stack = [root]; let guard = 0;
    while (stack.length && guard++ < 500000) {
      const n = stack.pop();
      if (!n || typeof n !== "object") continue;
      fn(n);
      const vals = [];
      for (const k in n) { const v = n[k]; if (v && typeof v === "object") vals.push(v); }
      for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
    }
  };
  const findObj = (o, key, d = 0) => {
    if (!o || typeof o !== "object" || d > 14) return null;
    if (o[key] && typeof o[key] === "object") return o[key];
    for (const k in o) { const r = findObj(o[k], key, d + 1); if (r) return r; }
    return null;
  };
  const findStr = (o, key, d = 0) => {
    if (!o || typeof o !== "object" || d > 14) return "";
    if (typeof o[key] === "string") return o[key];
    for (const k in o) { const r = findStr(o[k], key, d + 1); if (r) return r; }
    return "";
  };
  const findToken = (o, d = 0) => {
    if (!o || typeof o !== "object" || d > 10) return null;
    if (o.continuationCommand?.token) return o.continuationCommand.token;
    for (const k in o) { const r = findToken(o[k], d + 1); if (r) return r; }
    return null;
  };

  // ====== ESTADO ======
  let busy = false, stopReq = false, paused = false, scope = "list";
  const M = { msg: "", kind: "info", until: 0, scope: "list" };
  const say = (m, kind = "info", ms = 0) => { M.msg = m; M.kind = kind; M.scope = scope; M.until = ms ? Date.now() + ms : 0; };
  const progress = m => { if (Date.now() > M.until) { M.msg = m; M.kind = "info"; M.scope = scope; } };
  const whilePaused = async () => { while (paused && !stopReq) await sleep(150); };

  const S = {
    phase: "idle", seq: 0, source: "", listId: "", listTitle: "",
    speed: "turbo", lvl: SPEEDS.turbo, method: "removelike",
    order: [], idx: new Map(), meta: new Map(), known: new Set(), titles: new Map(), params: new Map(), setIds: new Map(),
    channels: new Map(), metaStats: { withCh: 0, withAge: 0 },
    targets: [], goal: 0, removed: new Set(), stuck: new Set(), attempts: {},
    listTotal: 0, expected: 0, failures: 0, failuresInRow: 0, lat: 0, eff: null, effBy: {}, good: 0, bad: 0, dead: 0,
    batchNo: 0, startedAt: 0, fatal: false, releaseLock: null
  };
  const U = { phase: "idle", seq: 0, items: new Map(), total: 0, done: 0, failed: 0 };
  const P = { phase: "idle", seq: 0, items: new Map() };

  // ====== DIAGNÓSTICO (sem cookies, tokens ou dados de login) ======
  const D = {
    cfgKeys: {}, pages: [], batches: [], feeds: [], errors: [], okBodies: [], badBodies: [], metaSamples: [],
    req: { total: 0, status: {}, network: 0, latMin: null, latMax: null }, paramsFound: 0
  };
  const dErr = (where, msg) => {
    if (D.errors.length < 30) D.errors.push({ t: new Date().toISOString().slice(11, 19), where, msg: String(msg).slice(0, 200) });
  };

  // ====== API INTERNA DO YOUTUBE ======
  let C = null;
  const getCfgOnce = () => new Promise(resolve => {
    const id = Math.random().toString(36).slice(2);
    const done = v => { clearTimeout(t); window.removeEventListener("message", on); resolve(v); };
    const on = e => { if (e.source === window && e.data && e.data.type === RES && e.data.id === id) done(e.data.cfg || null); };
    const t = setTimeout(() => done(null), 1500);
    window.addEventListener("message", on);
    window.postMessage({ type: REQ, id }, location.origin);
  });
  const initApi = async () => {
    for (let i = 0; i < 20; i++) {
      const c = await getCfgOnce();
      if (c && c.INNERTUBE_API_KEY && c.INNERTUBE_CONTEXT) {
        C = c;
        D.cfgKeys = { clientVersion: c.INNERTUBE_CONTEXT?.client?.clientVersion, hl: c.INNERTUBE_CONTEXT?.client?.hl, loggedIn: c.LOGGED_IN, sessionIndex: c.SESSION_INDEX };
        return;
      }
      await sleep(400);
    }
    throw new Error("Não achei a configuração do YouTube. Recarregue a aba (F5) e tente de novo.");
  };
  const sha1 = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const getCookie = n => document.cookie.split("; ").find(c => c.startsWith(n + "="))?.slice(n.length + 1);

  let authCache = { ts: 0, value: "" };
  const authHeader = async () => {
    const ts = Math.floor(Date.now() / 1000);
    if (authCache.ts === ts) return authCache.value;
    const origin = location.origin, parts = [];
    const defs = [
      ["SAPISIDHASH", getCookie("SAPISID") || getCookie("__Secure-3PAPISID")],
      ["SAPISID1PHASH", getCookie("__Secure-1PAPISID")],
      ["SAPISID3PHASH", getCookie("__Secure-3PAPISID")]
    ];
    for (const [name, val] of defs) if (val) parts.push(`${name} ${ts}_${await sha1(`${ts} ${val} ${origin}`)}`);
    authCache = { ts, value: parts.join(" ") };
    return authCache.value;
  };
  const buildHeaders = async () => {
    const h = {
      "Content-Type": "application/json",
      "Authorization": await authHeader(),
      "X-Goog-AuthUser": String(C.SESSION_INDEX ?? 0),
      "X-Origin": location.origin,
      "X-Youtube-Client-Name": String(C.INNERTUBE_CONTEXT_CLIENT_NAME ?? 1),
      "X-Youtube-Client-Version": C.INNERTUBE_CONTEXT_CLIENT_VERSION,
      "X-Goog-Visitor-Id": C.VISITOR_DATA,
      "X-Goog-PageId": C.DELEGATED_SESSION_ID,
      "X-Youtube-Bootstrap-Logged-In": "true"
    };
    Object.keys(h).forEach(k => (h[k] == null || h[k] === "undefined") && delete h[k]);
    return h;
  };
  const api = async (path, payload) =>
    fetch(`/youtubei/v1/${path}?key=${C.INNERTUBE_API_KEY}&prettyPrint=false`, {
      method: "POST", credentials: "include", headers: await buildHeaders(),
      body: JSON.stringify({ context: C.INNERTUBE_CONTEXT, ...payload })
    });

  const browseJson = async (payload, tag) => {
    const t0 = performance.now();
    let data = null, status = 0;
    for (let t = 0; t < 3 && !data; t++) {
      try {
        const res = await api("browse", payload);
        status = res.status;
        if (!res.ok) throw new Error("HTTP " + res.status);
        data = await res.json();
      } catch (e) {
        dErr("browse " + tag, e.message);
        if (t === 2) throw new Error("O YouTube não respondeu (" + e.message + ").");
        await sleep(800 * (t + 1));
      }
    }
    return { data, status, ms: Math.round(performance.now() - t0) };
  };

  // ====== LEITURA DE VÍDEOS (canal e idade de cada um) ======
  const collect = (o, out, d = 0) => {
    if (!o || typeof o !== "object" || d > 12) return;
    if (typeof o.content === "string") out.push(o.content);
    if (typeof o.simpleText === "string") out.push(o.simpleText);
    if (typeof o.text === "string") out.push(o.text);
    for (const k in o) collect(o[k], out, d + 1);
  };
  const findChannelId = (o, d = 0) => {
    if (!o || typeof o !== "object" || d > 14) return "";
    const b = o.browseEndpoint?.browseId || o.browseId;
    if (typeof b === "string" && /^UC/.test(b)) return b;
    for (const k in o) { const r = findChannelId(o[k], d + 1); if (r) return r; }
    return "";
  };
  const UNIT_DAYS = { segundo: 1 / 86400, minuto: 1 / 1440, hora: 1 / 24, dia: 1, semana: 7, mes: 30, meses: 30, ano: 365,
    second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
  const ageDays = text => {
    const n = norm(text);
    let m = n.match(/\bha\s+(\d+)\s*(segundo|minuto|hora|dia|semana|meses|mes|ano)s?\b/);
    if (!m) m = n.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/);
    return m ? parseInt(m[1], 10) * (UNIT_DAYS[m[2]] ?? 0) : null;
  };
  const NOT_CHANNEL_RE = /visualiza|views|assistindo|watching|inscritos|subscribers|\bha\s+\d+|\bago\b/;
  const buildMeta = (texts, chName, chId) => {
    let age = null;
    for (const t of texts) { const a = ageDays(t); if (a !== null) { age = a; break; } }
    if (!chName) chName = texts.find(t => t && !NOT_CHANNEL_RE.test(norm(t))) || "";
    return { ch: chName, chId, age, raw: texts.slice(0, 5) };
  };
  const lockupMeta = n => {
    const rows = n.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
    const texts = []; let chName = "";
    rows.forEach((r, ri) => (r.metadataParts || []).forEach(p => {
      const c = p.text?.content;
      if (c) { texts.push(c); if (!chName && ri === 0 && !NOT_CHANNEL_RE.test(norm(c))) chName = c; }
    }));
    if (!texts.length) collect(n.metadata?.lockupMetadataViewModel?.metadata, texts);
    return buildMeta(texts, chName, findChannelId(n.metadata));
  };
  const rendererMeta = pv => {
    const texts = []; collect(pv.videoInfo, texts);
    const run = pv.shortBylineText?.runs?.[0];
    return buildMeta(texts, run?.text || "", run?.navigationEndpoint?.browseEndpoint?.browseId || "");
  };

  const HEADER_RE = /(\d[\d.,\s\u00a0]*)\s*v[ií]deos?/i;
  const scanHeader = (n, d = 0) => {
    if (!n || d > 12) return 0;
    if (typeof n === "string") { if (n.length > 80) return 0; const m = n.match(HEADER_RE); return m ? parseInt(m[1].replace(/\D/g, ""), 10) || 0 : 0; }
    if (typeof n !== "object") return 0;
    let best = 0; for (const k in n) best = Math.max(best, scanHeader(n[k], d + 1)); return best;
  };

  const parseVideos = (data, info, first) => {
    const ids = new Map();
    const idsBySetVideoId = new Map();
    let next = null, fallback = null, paramsHere = 0;
    // Entradas apagadas/privadas podem vir sem videoId. O setVideoId identifica
    // a posição na lista e ainda permite removê-la via edit_playlist.
    const unavailableKey = setVideoId => `__LC_SET__${setVideoId}`;
    const addMeta = (id, m) => {
      const old = S.meta.get(id);
      if (!old || (!old.ch && m.ch) || (old.age == null && m.age != null)) S.meta.set(id, m);
      if (D.metaSamples.length < 6 && !D.metaSamples.some(x => x.id === id)) {
        D.metaSamples.push({ id, title: (ids.get(id) || "").slice(0, 30), ch: m.ch, hasChId: !!m.chId, age: m.age, raw: m.raw });
      }
    };
    const addRenderer = (r, kind) => {
      if (!r || typeof r !== "object") return;
      const setVideoId = r.setVideoId || findStr(r, "setVideoId");
      const videoId = r.videoId || r.navigationEndpoint?.watchEndpoint?.videoId || findStr(r, "videoId");
      const id = videoId || (setVideoId ? unavailableKey(setVideoId) : "");
      if (!id) return;
      info[kind] = (info[kind] || 0) + 1;
      if (!videoId) info.unavailable++;
      // Se o menu foi encontrado antes do cartão completo, troca a chave
      // provisória pela ID real sem contar a mesma entrada duas vezes.
      if (videoId && setVideoId) {
        const provisional = unavailableKey(setVideoId);
        if (ids.has(provisional)) {
          ids.delete(provisional); S.setIds.delete(provisional); S.meta.delete(provisional);
        }
      }
      if (!ids.has(id)) ids.set(id, txt(r.title) || "Vídeo indisponível ou excluído");
      if (setVideoId) { S.setIds.set(id, setVideoId); idsBySetVideoId.set(setVideoId, id); }
      addMeta(id, rendererMeta(r));
    };
    const addSetOnly = setVideoId => {
      if (!setVideoId || idsBySetVideoId.has(setVideoId)) return;
      const id = unavailableKey(setVideoId);
      idsBySetVideoId.set(setVideoId, id);
      info.unavailable++;
      if (!ids.has(id)) ids.set(id, "Vídeo indisponível ou oculto");
      S.setIds.set(id, setVideoId);
      addMeta(id, buildMeta([], "", ""));
    };
    scanTree(data, n => {
      const pv = n.playlistVideoRenderer;
      addRenderer(pv, "playlistVideoRenderer");
      addRenderer(n.playlistPanelVideoRenderer, "playlistPanelVideoRenderer");
      addRenderer(n.unavailableVideoRenderer, "unavailableVideoRenderer");
      const vr = n.videoRenderer;
      if (vr && (vr.setVideoId || findStr(vr, "setVideoId"))) addRenderer(vr, "videoRenderer");
      // Alguns layouts expõem o item oculto somente pelo comando do menu.
      // A ação contém o setVideoId, suficiente para removê-lo da playlist.
      const edit = n.playlistEditEndpoint;
      if (Array.isArray(edit?.actions)) edit.actions.forEach(a => addSetOnly(a?.setVideoId));
      if (typeof n.contentId === "string" && /VIDEO/.test(n.contentType || "")) {
        info.lockup++;
        if (!ids.has(n.contentId)) ids.set(n.contentId, n.metadata?.lockupMetadataViewModel?.title?.content || "");
        const sv = findStr(n, "setVideoId");
        if (sv) S.setIds.set(n.contentId, sv);
        addMeta(n.contentId, lockupMeta(n));
      }
      const le = n.likeEndpoint;
      if (le && le.status === "INDIFFERENT" && le.target?.videoId && le.removeLikeParams && !S.params.has(le.target.videoId)) {
        S.params.set(le.target.videoId, le.removeLikeParams); paramsHere++;
      }
      if (n.continuationItemRenderer && !next) { const tk = findToken(n.continuationItemRenderer); if (tk) { next = tk; info.tokenFrom = "continuationItemRenderer"; } }
      if (!fallback && n.continuationCommand?.token) fallback = n.continuationCommand.token;
    });
    if (!next && fallback) { next = fallback; info.tokenFrom = "fallback"; }
    if (first) {
      info.headerTotal = scanHeader(data.header) || scanHeader(data.sidebar);
      if (info.headerTotal) S.expected = Math.max(S.expected, info.headerTotal);
    }
    info.params = paramsHere; D.paramsFound += paramsHere; info.items = ids.size;
    ids.forEach((t, id) => { S.known.add(id); if (t) S.titles.set(id, t); });
    return { ids: [...ids.keys()], token: next };
  };

  // Parâmetro que corresponde a “Mostrar vídeos indisponíveis” do YouTube.
  // Ele deve acompanhar também as continuações, ou os ocultos voltam a sumir
  // depois da primeira página.
  const SHOW_UNAVAILABLE_PARAMS = "wgYCCAA=";
  const fetchVideoPage = async (listId, token, tag, n, record) => {
    const payload = token
      ? { continuation: token, params: SHOW_UNAVAILABLE_PARAMS }
      : { browseId: "VL" + listId, params: SHOW_UNAVAILABLE_PARAMS };
    const { data, status, ms } = await browseJson(payload, tag + " p" + n);
    const info = { tag, page: n, status, ms, lockup: 0, playlistVideoRenderer: 0, playlistPanelVideoRenderer: 0, videoRenderer: 0,
      unavailable: 0, items: 0, tokenFrom: null, headerTotal: 0, params: 0 };
    const r = parseVideos(data, info, !token);
    if (record) { if (D.pages.length >= 30) D.pages.shift(); D.pages.push(info); }
    return r;
  };

  // Lê a lista inteira na ordem em que o YouTube mostra.
  const listAll = async (listId, tag) => {
    const all = [], seenIds = new Set(), seenTok = new Set();
    let token = null, n = 0;
    while (!stopReq) {
      n++;
      const p = await fetchVideoPage(listId, token, tag, n, true);
      let added = 0;
      p.ids.forEach(id => { if (!seenIds.has(id)) { seenIds.add(id); all.push(id); added++; } });
      token = p.token;
      if (!token || seenTok.has(token) || !added) break;
      seenTok.add(token);
    }
    return all;
  };
  // Lê só o começo da lista (pelo menos `need` itens).
  const peek = async (listId, need) => {
    const out = [], seenTok = new Set();
    let token = null, n = 0;
    while (!stopReq && out.length < need) {
      n++;
      const p = await fetchVideoPage(listId, token, "conferencia", n, false);
      out.push(...p.ids);
      token = p.token;
      if (!token || seenTok.has(token) || !p.ids.length) break;
      seenTok.add(token);
    }
    return out;
  };

  const chanKey = m => m?.chId || m?.ch || "";
  const buildChannels = all => {
    S.channels = new Map(); let withCh = 0, withAge = 0;
    for (const id of all) {
      const m = S.meta.get(id); if (!m) continue;
      if (m.age != null) withAge++;
      const k = chanKey(m); if (!k) continue;
      withCh++;
      const c = S.channels.get(k) || { name: m.ch || k, count: 0 };
      if ((!c.name || c.name === k) && m.ch) c.name = m.ch;
      c.count++; S.channels.set(k, c);
    }
    S.metaStats = { withCh, withAge };
  };

  // ====== FILTROS ======
  const cleanFilter = f => {
    f = f || {};
    return {
      mode: ["all", "channel", "period", "pos"].includes(f.mode) ? f.mode : "all",
      chan: new Set(Array.isArray(f.chan) ? f.chan.filter(x => typeof x === "string").slice(0, 20000) : []),
      invert: !!f.invert,
      dir: f.dir === "within" ? "within" : "older",
      num: clampInt(f.num, 1, 100000, 1),
      unitDays: [1, 7, 30, 365].includes(Number(f.unitDays)) ? Number(f.unitDays) : 365,
      pos: f.pos === "oldest" ? "oldest" : "recent",
      posN: clampInt(f.posN, 1, 1000000, 100)
    };
  };
  const computeTargets = F => {
    const o = S.order;
    if (F.mode === "all") return o.slice();
    if (F.mode === "channel") {
      if (!F.chan.size) return [];
      return o.filter(id => { const k = chanKey(S.meta.get(id)); return k && (F.chan.has(k) !== F.invert); });
    }
    if (F.mode === "period") {
      const lim = F.num * F.unitDays;
      return o.filter(id => {
        const a = S.meta.get(id)?.age;
        if (a == null) return false;               // sem data conhecida: nunca remove
        return F.dir === "older" ? a >= lim : a < lim;
      });
    }
    const n = Math.min(F.posN, o.length);
    return F.pos === "recent" ? o.slice(0, n) : o.slice(o.length - n);
  };

  // ====== REMOÇÃO ======
  let cooldownUntil = 0;
  const waitCooldown = async () => { while (Date.now() < cooldownUntil && !stopReq) await sleep(200); };

  const send = async (path, payload, check, sampleId) => {
    for (let attempt = 0; attempt < CFG.maxRetries && !stopReq; attempt++) {
      await waitCooldown();
      const t0 = performance.now();
      try {
        const res = await api(path, payload);
        const txt0 = await res.text();
        D.req.total++; D.req.status[res.status] = (D.req.status[res.status] || 0) + 1;
        if (res.ok) {
          let b = null; try { b = JSON.parse(txt0); } catch {}
          const ms = performance.now() - t0;
          S.lat = S.lat ? S.lat * 0.8 + ms * 0.2 : ms;
          D.req.latMin = D.req.latMin === null ? ms : Math.min(D.req.latMin, ms);
          D.req.latMax = D.req.latMax === null ? ms : Math.max(D.req.latMax, ms);
          if (D.okBodies.length < 4) D.okBodies.push({ path, id: sampleId, body: txt0.slice(0, 300) });
          return check(b) ? "ok" : "fail";
        }
        if (D.badBodies.length < 5) D.badBodies.push({ path, status: res.status, body: txt0.slice(0, 200) });
        if (res.status === 401 || res.status === 403) return "auth";
        if (res.status === 429 || res.status >= 500) {
          const wait = Math.min(60000, 4000 * 2 ** attempt);
          cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
          say(`O YouTube pediu calma (erro ${res.status}). Esperando ${Math.round(wait / 1000)}s...`, "warn", wait);
          continue;
        }
        return "fail";
      } catch (e) {
        D.req.network++; dErr(path, e.message);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + 1200);
      }
    }
    return "fail";
  };

  const isUnavailableKey = id => typeof id === "string" && id.startsWith("__LC_SET__");
  const likeReq = id => {
    // Sem videoId o endpoint de curtida não pode agir; edit_playlist é usado depois.
    if (isUnavailableKey(id)) return Promise.resolve("fail");
    const payload = { target: { videoId: id } };
    const p = CFG.useParams && S.params.get(id);
    if (p) payload.params = p;
    return send("like/removelike", payload, () => true, id);
  };
  // Em "Curtidos" sempre remove pelo id do vídeo. Nas demais listas usa o setVideoId quando o YouTube informa.
  const actionFor = id => {
    const sv = S.setIds.get(id);
    if (isUnavailableKey(id) && sv) return { action: "ACTION_REMOVE_VIDEO", setVideoId: sv };
    return S.source !== "LL" && sv
      ? { action: "ACTION_REMOVE_VIDEO", setVideoId: sv }
      : { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: id };
  };
  const editReq = ids => send("browse/edit_playlist", { playlistId: S.listId, actions: ids.map(actionFor) },
    b => !b?.status || b.status === "STATUS_SUCCEEDED", ids[0]);

  const MTH = { removelike: "um por vez", editplaylist: "em grupo" };
  const methodsFor = () => S.source === "LL" ? ["removelike", "editplaylist"] : ["editplaylist"];
  const lowerSpeedLevel = level => level >= SPEEDS.max ? SPEEDS.turbo
    : level >= SPEEDS.turbo ? SPEEDS.normal : level >= SPEEDS.normal ? SPEEDS.safe : 0;
  const speedLabel = level => level >= SPEEDS.max ? "MAX" : level >= SPEEDS.turbo ? "Turbo"
    : level >= SPEEDS.normal ? "Normal" : "Seguro";

  const removeBatch = async (ids, mth) => {
    const jobs = mth === "editplaylist" ? chunk(ids, LEVELS[S.lvl].bulk) : ids.map(id => [id]);
    let i = 0;
    const worker = async n => {
      while (!stopReq && i < jobs.length) {
        await whilePaused();
        if (stopReq) break;
        if (n >= LEVELS[S.lvl].conc) { await sleep(200); continue; }
        if (i >= jobs.length) break;
        const job = jobs[i++];
        progress(`Removendo ${job.length > 1 ? job.length + " vídeos" : (S.titles.get(job[0]) || job[0])} (${MTH[mth]})`);
        const r = mth === "editplaylist" ? await editReq(job) : await likeReq(job[0]);
        if (r === "ok") S.failuresInRow = 0;
        else if (r === "auth") {
          S.fatal = true; stopReq = true;
          say("O YouTube recusou o login. Recarregue a página (F5) e tente de novo.", "error");
          break;
        } else {
          S.failures++;
          if (++S.failuresInRow >= CFG.maxFailuresInRow) {
            S.fatal = true; stopReq = true;
            say("Muitas falhas seguidas, então parei para não forçar. Clique em 'Copiar diagnóstico' e me envie.", "error");
            break;
          }
        }
        const [a, b] = LEVELS[S.lvl].delay;
        if (b > 0) await pace(rand([a, b]));
      }
    };
    await Promise.all(Array.from({ length: MAX_CONC }, (_, n) => worker(n)));
  };

  // Controle adaptativo: confere a aceitação real e ajusta método e velocidade.
  const adapt = (eff, mth) => {
    S.effBy[mth] = eff;
    const cap = SPEEDS[S.speed], pc = Math.round(eff * 100);
    const other = methodsFor().find(m => m !== mth);
    S.dead = eff < 0.05 ? S.dead + 1 : 0;
    if (eff < CFG.minEff) {
      S.good = 0; S.bad++;
      // Primeiro reduz um plano inteiro de velocidade (MAX → Turbo → Normal
      // → Seguro). Assim a recuperação não fica insistindo no ritmo que falhou.
      const nextLevel = lowerSpeedLevel(S.lvl);
      if (nextLevel < S.lvl) {
        const from = speedLabel(S.lvl);
        S.lvl = nextLevel;
        // Quando houver outro endpoint disponível, troca-o junto com a queda
        // de velocidade. Isso evita repetir no mesmo endpoint um item que ele
        // simplesmente não consegue remover (como um vídeo indisponível).
        const switchMethod = other && S.effBy[other] === undefined;
        if (switchMethod) S.method = other;
        S.effBy = {};
        cooldownUntil = Math.max(cooldownUntil, Date.now() + CFG.coolOffMs);
        say(`O YouTube aceitou só ${pc}%. Vou baixar de ${from} para ${speedLabel(S.lvl)}${switchMethod ? ` e testar ${MTH[other]}` : ""}; aguardando 10s antes de continuar.`, "warn", CFG.coolOffMs);
      } else if (other && S.effBy[other] === undefined) {
        S.method = other;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + CFG.coolOffMs);
        say(`O YouTube aceitou só ${pc}% nesse ritmo. Vou testar outro jeito de remover (${MTH[other]}) após 10s.`, "warn", CFG.coolOffMs);
      } else if (other && S.effBy[other] > eff + 0.1) {
        S.method = other;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + CFG.coolOffMs);
        say(`Mudando para o jeito "${MTH[other]}", que está funcionando melhor. Vou aguardar 10s.`, "warn", CFG.coolOffMs);
      } else {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + CFG.coolOffMs);
        say("Mesmo no modo Seguro o YouTube está recusando. Vou aguardar 10s antes de tentar de novo.", "warn", CFG.coolOffMs);
      }
    } else {
      S.bad = 0;
      if (eff >= CFG.goodEff) { if (++S.good >= 2 && S.lvl < cap) { S.lvl++; S.good = 0; } }
      else S.good = 0;
    }
  };

  const acquireLock = () => { try { navigator.locks?.request("lc-keepalive", () => new Promise(r => { S.releaseLock = r; })); } catch {} };
  const releaseLock = () => { try { S.releaseLock?.(); } catch {} S.releaseLock = null; };

  const readList = async (source, listId, title) => {
    busy = true; stopReq = false; paused = false; scope = "list";
    S.source = source; S.listId = listId; S.listTitle = title; S.phase = "reading";
    S.order = []; S.idx = new Map(); S.meta = new Map(); S.known = new Set(); S.titles = new Map();
    S.params = new Map(); S.setIds = new Map(); S.channels = new Map(); S.metaStats = { withCh: 0, withAge: 0 };
    S.targets = []; S.goal = 0; S.removed = new Set(); S.stuck = new Set(); S.attempts = {};
    S.listTotal = 0; S.expected = 0; S.failures = 0; S.failuresInRow = 0; S.eff = null; S.effBy = {};
    S.good = 0; S.bad = 0; S.dead = 0; S.batchNo = 0; S.startedAt = 0; S.fatal = false;
    S.method = source === "LL" ? "removelike" : "editplaylist";
    D.pages.length = 0; D.batches.length = 0; D.metaSamples.length = 0;
    say("Lendo a sua lista. Isso não altera nada...");
    try {
      await initApi();
      const all = await listAll(listId, "leitura");
      if (stopReq) { S.phase = "idle"; say("Leitura interrompida.", "warn"); return; }
      if (!all.length) { S.phase = "idle"; say("Essa lista está vazia.", "warn"); return; }
      S.order = all; S.idx = new Map(all.map((id, i) => [id, i])); S.listTotal = all.length;
      buildChannels(all);
      S.seq++; S.phase = "ready";
      const unavailable = all.filter(isUnavailableKey).length;
      say(`Pronto! Encontrei ${all.length} vídeos${unavailable ? `, incluindo ${unavailable} indisponível${unavailable === 1 ? "" : "is"}` : ""}${S.expected > all.length ? ` (o YouTube informa ~${S.expected}; os demais podem estar indisponíveis)` : ""}.`, "ok");
    } catch (e) {
      S.phase = "error"; dErr("ler", e.message); say(e.message, "error");
    } finally { busy = false; }
  };

  const startRun = async () => {
    busy = true; stopReq = false; paused = false; scope = "list";
    S.phase = "running"; S.startedAt = Date.now(); S.failuresInRow = 0; S.fatal = false;
    S.removed = new Set(); S.stuck = new Set(); S.attempts = {}; S.batchNo = 0; S.goal = S.targets.length;
    say("Removendo. Pode fechar esta janelinha: eu continuo trabalhando na aba do YouTube.", "info", 4000);
    acquireLock();
    let pending = S.targets.slice(), finished = false;
    try {
      await initApi();
      while (!stopReq && pending.length && S.batchNo < CFG.maxBatches) {
        await whilePaused();
        S.batchNo++;
        const ids = pending.slice(0, LEVELS[S.lvl].batch);
        const mth = S.method, lvlUsed = S.lvl, t0 = Date.now();
        S.phase = "running";
        await waitCooldown();
        await removeBatch(ids, mth);
        if (stopReq) break;

        // Conferência: lê a lista só até a posição mais profunda deste grupo.
        S.phase = "verifying";
        await sleep(CFG.settleMs);
        let maxI = 0; for (const id of ids) maxI = Math.max(maxI, S.idx.get(id) ?? 0);
        let below = 0; for (const r of S.removed) if ((S.idx.get(r) ?? Infinity) < maxI) below++;
        const list = await peek(S.listId, Math.max(60, maxI - below + 41));
        if (stopReq) break;
        const present = new Set(list);
        let still = 0;
        for (const id of ids) {
          if (present.has(id)) {
            still++;
            S.attempts[id] = (S.attempts[id] || 0) + 1;
            if (S.attempts[id] >= CFG.maxAttemptsPerId) S.stuck.add(id);
          } else S.removed.add(id);
        }
        S.eff = ids.length ? 1 - still / ids.length : 1;
        D.batches.push({ n: S.batchNo, method: mth, level: lvlUsed + 1, size: ids.length, removed: ids.length - still,
          eff: +S.eff.toFixed(2), sec: +((Date.now() - t0) / 1000).toFixed(1) });
        adapt(S.eff, mth);
        pending = pending.filter(id => !S.removed.has(id) && !S.stuck.has(id));
      }
      finished = !stopReq && !pending.length;
    } catch (e) {
      S.fatal = true; dErr("executar", e.message); say("Deu erro: " + e.message, "error");
    } finally {
      S.phase = "done"; busy = false; paused = false; releaseLock();
      const n = S.removed.size;
      if (!S.fatal) {
        if (finished) say(S.stuck.size
          ? `Terminei! ${n} removidos. ${S.stuck.size} não saíram (podem ser privados, apagados ou de outra pessoa).`
          : `Terminei! ${n} removidos.`, "ok");
        else say(`Parado. ${n} já foram removidos.`, "warn");
      }
    }
  };

  // ====== INSCRIÇÕES E PLAYLISTS ======
  const extractInitialData = html => {
    const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  const feedLog = (tag, src, status, r, data) => {
    if (D.feeds.length >= 20) D.feeds.shift();
    D.feeds.push({ tag, src, status, added: r.added, hasToken: !!r.token, kinds: r.kinds, topKeys: Object.keys(data || {}).slice(0, 10) });
  };

  const parseSubs = (data, items) => {
    let token = null, fallback = null, added = 0;
    const kinds = { channelRenderer: 0, lockup: 0, subscribeButton: 0 };
    const add = (id, name, sub, params) => {
      if (typeof id !== "string" || !/^UC[\w-]{10,}$/.test(id)) return;
      const o = items.get(id);
      if (!o) { items.set(id, { id, name: name || "", sub: sub || "", params: params || "" }); added++; }
      else {
        if (!o.name && name) o.name = name;
        if (!o.sub && sub) o.sub = sub;
        if (!o.params && params) o.params = params;
      }
    };
    scanTree(data, n => {
      const c = n.channelRenderer || n.gridChannelRenderer;
      if (c && c.channelId) {
        kinds.channelRenderer++;
        add(c.channelId, txt(c.title), txt(c.subscriberCountText) || txt(c.videoCountText), findObj(c, "unsubscribeEndpoint")?.params);
      }
      if (typeof n.contentId === "string" && /CHANNEL/.test(n.contentType || "")) {
        kinds.lockup++;
        add(n.contentId, txt(n.metadata?.lockupMetadataViewModel?.title), "", findObj(n, "unsubscribeEndpoint")?.params);
      }
      const sb = n.subscribeButtonRenderer;
      if (sb && sb.subscribed === true && sb.channelId) {
        kinds.subscribeButton++;
        add(sb.channelId, "", "", findObj(sb, "unsubscribeEndpoint")?.params);
      }
      if (n.continuationItemRenderer && !token) token = findToken(n.continuationItemRenderer);
      if (!fallback && n.continuationCommand?.token) fallback = n.continuationCommand.token;
    });
    return { added, token: token || fallback, kinds };
  };

  const parsePlaylists = (data, items) => {
    let token = null, fallback = null, added = 0;
    const kinds = { playlistRenderer: 0, lockup: 0 };
    const add = (id, title, sub) => {
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{10,}$/.test(id) || /^RD/.test(id)) return;
      if (!items.has(id)) { items.set(id, { id, title: title || id, sub: sub || "" }); added++; }
    };
    scanTree(data, n => {
      const p = n.playlistRenderer || n.gridPlaylistRenderer;
      if (p && p.playlistId) { kinds.playlistRenderer++; add(p.playlistId, txt(p.title), txt(p.videoCountText) || txt(p.videoCountShortText)); }
      if (typeof n.contentId === "string" && /PLAYLIST/.test(n.contentType || "")) {
        kinds.lockup++; add(n.contentId, txt(n.metadata?.lockupMetadataViewModel?.title), "");
      }
      if (n.continuationItemRenderer && !token) token = findToken(n.continuationItemRenderer);
      if (!fallback && n.continuationCommand?.token) fallback = n.continuationCommand.token;
    });
    return { added, token: token || fallback, kinds };
  };

  // Lê um "feed" (inscrições, playlists): tenta a API e, se vier vazio, a página HTML.
  const loadFeed = async (browseId, htmlPath, items, parse, tag) => {
    let first = null;
    try { first = await browseJson({ browseId }, tag); } catch (e) { dErr(tag, e.message); }
    let r = first ? parse(first.data, items) : { added: 0, token: null, kinds: {} };
    if (first) feedLog(tag, "api", first.status, r, first.data);
    if (!items.size) {
      try {
        const res = await fetch(htmlPath, { credentials: "include" });
        const d = extractInitialData(await res.text());
        if (d) { r = parse(d, items); feedLog(tag, "html", res.status, r, d); }
        else dErr(tag, "ytInitialData não encontrado na página");
      } catch (e) { dErr(tag + " html", e.message); }
    }
    const seen = new Set(); let token = r.token, n = 0;
    while (token && !stopReq && n < 400) {
      if (seen.has(token)) break;
      seen.add(token); n++;
      const { data, status } = await browseJson({ continuation: token }, tag + " p" + n);
      r = parse(data, items); feedLog(tag, "api-cont", status, r, data);
      if (!r.added) break;
      token = r.token;
    }
  };

  const fetchSubs = async () => {
    U.items = new Map();
    await loadFeed("FEchannels", "/feed/channels", U.items, parseSubs, "inscricoes");
    U.seq++;
  };
  const loadSubs = async () => {
    busy = true; stopReq = false; paused = false; scope = "subs";
    U.phase = "loading"; U.done = 0; U.failed = 0; U.total = 0;
    say("Carregando seus canais inscritos...");
    try {
      await initApi();
      await fetchSubs();
      U.phase = U.items.size ? "ready" : "empty";
      if (stopReq) say(`Leitura interrompida. Carreguei ${U.items.size} canais.`, "warn");
      else if (U.items.size) say(`Pronto! Você está inscrito em ${U.items.size} canais.`, "ok");
      else say("Não encontrei nenhum canal. Clique em 'Copiar diagnóstico' e me envie.", "warn");
    } catch (e) { U.phase = "error"; dErr("inscricoes", e.message); say(e.message, "error"); }
    finally { busy = false; }
  };

  const unsubscribe = async ids => {
    busy = true; stopReq = false; paused = false; scope = "subs";
    U.phase = "working"; U.total = ids.length; U.done = 0; U.failed = 0;
    const params = new Map(ids.map(id => [id, U.items.get(id)?.params || ""]));
    const names = new Map(ids.map(id => [id, U.items.get(id)?.name || id]));
    let i = 0, fails = 0, failMsg = "";
    try {
      await initApi();
      const worker = async () => {
        while (!stopReq && i < ids.length) {
          await whilePaused();
          if (stopReq) break;
          const id = ids[i++];
          progress(`Cancelando inscrição: ${names.get(id)}`);
          const payload = { channelIds: [id] };
          if (params.get(id)) payload.params = params.get(id);
          const r = await send("subscription/unsubscribe", payload, () => true, id);
          if (r === "ok") { U.done++; fails = 0; }
          else if (r === "auth") { stopReq = true; failMsg = "O YouTube recusou o login. Recarregue a página (F5) e tente de novo."; break; }
          else { U.failed++; if (++fails >= 8) { stopReq = true; failMsg = "Muitas falhas seguidas, então parei. Clique em 'Copiar diagnóstico' e me envie."; break; } }
          await pace(rand([300, 700]));
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const tried = ids.slice(0, i);
      // Conferência: relê as inscrições e conta só quem realmente saiu.
      stopReq = false;
      say("Conferindo no YouTube o que foi cancelado...", "info");
      await sleep(1200);
      await fetchSubs();
      const gone = tried.filter(id => !U.items.has(id)).length;
      U.done = gone; U.failed = tried.length - gone;
      if (failMsg) say(`${failMsg} (${gone} cancelamentos confirmados)`, "error");
      else if (gone === ids.length) say(`Pronto! ${gone} inscrições canceladas.`, "ok");
      else say(`${gone} canceladas. ${ids.length - gone} continuam na lista (o YouTube pode demorar para atualizar ou o pedido foi recusado).`, "warn");
    } catch (e) { dErr("cancelar inscricao", e.message); say("Deu erro: " + e.message, "error"); }
    finally { U.phase = U.items.size ? "ready" : "empty"; busy = false; paused = false; }
  };

  const loadPlaylists = async () => {
    busy = true; stopReq = false; scope = "pls";
    P.phase = "loading"; P.items = new Map();
    say("Procurando as suas playlists...");
    try {
      await initApi();
      await loadFeed("FEplaylist_aggregation", "/feed/playlists", P.items, parsePlaylists, "playlists");
      P.items.delete("LL"); P.items.delete("WL");
      P.seq++; P.phase = P.items.size ? "ready" : "empty";
      say(P.items.size ? `Encontrei ${P.items.size} playlists.` : "Não encontrei playlists. Abra uma playlist no YouTube e use 'Playlist aberta agora'.", P.items.size ? "ok" : "warn");
    } catch (e) { P.phase = "error"; dErr("playlists", e.message); say(e.message, "error"); }
    finally { busy = false; }
  };

  // ====== STATUS E COMANDOS DO POPUP ======
  const calcEta = () => {
    const done = S.removed.size, left = Math.max(0, S.goal - done);
    const mins = S.startedAt ? (Date.now() - S.startedAt) / 60000 : 0;
    let rate = mins > 0.05 && done >= 30 ? done / mins : 0;
    const estimated = !rate;
    if (!rate) { const L = LEVELS[S.lvl]; rate = 60000 / (((S.lat || 400) + (L.delay[0] + L.delay[1]) / 2) / L.conc + 150); }
    return { left, rate, estimated, eta: left / rate * 60 };
  };
  const snapshot = () => {
    const e = calcEta();
    return {
      v: VERSION, busy, msg: M.msg, kind: M.kind, msgScope: M.scope,
      list: { phase: S.phase, source: S.source, listId: S.listId, title: S.listTitle, seq: S.seq, known: S.known.size,
        listTotal: S.listTotal, expected: S.expected, goal: S.goal, done: S.removed.size, left: e.left, rate: Math.round(e.rate),
        estimated: e.estimated, eta: e.eta, eff: S.eff, lvl: S.lvl, levels: LEVELS.length, speed: S.speed, paused,
        stuck: S.stuck.size, method: S.method },
      subs: { phase: U.phase, seq: U.seq, loaded: U.items.size, total: U.total, done: U.done, failed: U.failed },
      pls: { phase: P.phase, seq: P.seq, count: P.items.size }
    };
  };
  const short = id => ({ id, title: (S.titles.get(id) || "").slice(0, 30) });
  const report = () => ({
    script: VERSION, generatedAt: new Date().toISOString(),
    env: { userAgent: navigator.userAgent, path: location.pathname + location.search, lang: navigator.language, hasSapisid: !!getCookie("SAPISID") },
    ytcfg: D.cfgKeys, config: { ...CFG },
    state: {
      source: S.source, phase: S.phase, listTotal: S.listTotal, goal: S.goal, expectedByHeader: S.expected, removedReal: S.removed.size,
      stuck: S.stuck.size, method: S.method, level: S.lvl + 1, effBy: S.effBy, lastEff: S.eff, batches: S.batchNo, failures: S.failures,
      avgLatencyMs: Math.round(S.lat), paramsFound: D.paramsFound, channelsInList: S.channels.size,
      videosWithChannel: S.metaStats.withCh, videosWithAge: S.metaStats.withAge,
      subsLoaded: U.items.size, subsPhase: U.phase, playlistsLoaded: P.items.size
    },
    requests: { ...D.req, latMin: D.req.latMin && Math.round(D.req.latMin), latMax: D.req.latMax && Math.round(D.req.latMax) },
    batches: D.batches.slice(-40), listPages: D.pages, feeds: D.feeds, metaSamples: D.metaSamples,
    samples: { stuck: [...S.stuck].slice(0, 10).map(short), okResponses: D.okBodies, errorResponses: D.badBodies },
    errors: D.errors
  });

  const needFree = () => { if (busy) throw new Error("Já existe uma tarefa em andamento. Espere terminar ou clique em Parar."); };
  const handlers = {
    ping: async () => {
      const c = await getCfgOnce();
      return { version: VERSION, path: location.pathname, listParam: new URLSearchParams(location.search).get("list") || "",
        ready: !!(c && c.INNERTUBE_API_KEY), loggedIn: c ? c.LOGGED_IN !== false : true };
    },
    status: () => ({ status: snapshot() }),
    read: ({ source, listId, title }) => {
      needFree();
      if (!["LL", "WL", "PL"].includes(source)) throw new Error("Lista inválida.");
      const id = source === "PL" ? String(listId || "") : source;
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) throw new Error("Playlist inválida.");
      readList(source, id, String(title || "").slice(0, 80));
      return {};
    },
    preview: ({ filter }) => {
      const F = cleanFilter(filter), t = computeTargets(F);
      return { count: t.length, total: S.order.length, unknown: F.mode === "period" ? S.order.length - S.metaStats.withAge : 0 };
    },
    channels: () => ({ items: [...S.channels.entries()].map(([k, c]) => ({ k, name: c.name, count: c.count })) }),
    start: ({ filter, speed }) => {
      needFree();
      if (S.phase !== "ready") throw new Error("Leia a lista primeiro.");
      if (own(SPEEDS, speed)) { S.speed = speed; S.lvl = SPEEDS[speed]; S.effBy = {}; }
      S.targets = computeTargets(cleanFilter(filter));
      if (!S.targets.length) throw new Error("Nada para remover com esse filtro.");
      startRun();
      return { goal: S.targets.length };
    },
    speed: ({ speed }) => {
      if (!own(SPEEDS, speed)) throw new Error("Velocidade inválida.");
      S.speed = speed; S.lvl = SPEEDS[speed]; S.effBy = {};
      return {};
    },
    pause: () => { paused = !paused; return { paused }; },
    stop: () => { stopReq = true; paused = false; return {}; },
    subsLoad: () => { needFree(); loadSubs(); return {}; },
    subsList: () => ({ items: [...U.items.values()].map(({ id, name, sub }) => ({ id, name, sub })) }),
    subsUnsub: ({ ids }) => {
      needFree();
      if (!Array.isArray(ids)) throw new Error("Lista inválida.");
      const ok = [...new Set(ids)].filter(id => typeof id === "string" && U.items.has(id)).slice(0, 5000);
      if (!ok.length) throw new Error("Nenhum canal selecionado.");
      unsubscribe(ok);
      return { count: ok.length };
    },
    plsLoad: () => { needFree(); loadPlaylists(); return {}; },
    plsList: () => ({ items: [...P.items.values()] }),
    diag: () => ({ report: report() })
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.cmd !== "string" || !own(handlers, msg.cmd)) return;
    Promise.resolve().then(() => handlers[msg.cmd](msg))
      .then(r => sendResponse({ ok: true, ...r }), e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  });
})();
