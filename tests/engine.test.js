// Teste do motor (src/content.js) contra um YouTube SIMULADO.
// Valida a lógica (leitura, filtros, remoção com verificação, inscrições).
// NÃO prova que o YouTube real aceita os mesmos formatos de resposta.
// Uso: node tests/engine.test.js
const vm = require("vm"), fs = require("fs"), path = require("path"), assert = require("assert");
const code = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");

// ---------- YouTube falso ----------
const ucid = n => "UC" + String(n).padStart(22, "x");
const server = {
  likes: [], pl: [], subs: [], actions: []
};
for (let i = 0; i < 8; i++) server.likes.push({ id: "vid" + String(i).padStart(8, "0"), ch: i < 4 ? "Canal A" : "Canal B", age: i < 4 ? "há 3 anos" : "há 2 dias" });
server.likes.push({ sv: "LL_DELETED", unavailable: true });
for (let i = 0; i < 5; i++) server.pl.push({ id: "pvd" + String(i).padStart(8, "0"), sv: "SV" + i });
server.pl.push({ sv: "PL_DELETED", unavailable: true });
for (let i = 0; i < 5; i++) server.subs.push({ id: ucid(i), name: "Canal Inscrito " + i });

const lockup = v => ({ lockupViewModel: { contentId: v.id, contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: { lockupMetadataViewModel: {
  title: { content: "Título " + v.id }, metadata: { contentMetadataViewModel: { metadataRows: [
    { metadataParts: [{ text: { content: v.ch } }] },
    { metadataParts: [{ text: { content: "10 mil visualizações" } }, { text: { content: v.age } }] }] } } } } } });
const unavailableItem = v => ({ playlistVideoRenderer: { setVideoId: v.sv, title: { runs: [{ text: "Deleted video" }] } } });
const likeItem = v => v.unavailable ? unavailableItem(v) : lockup(v);
const plItem = v => v.unavailable ? unavailableItem(v) : ({ playlistVideoRenderer: { videoId: v.id, setVideoId: v.sv, title: { runs: [{ text: "T " + v.id }] },
  shortBylineText: { runs: [{ text: "Canal C" }] }, videoInfo: { runs: [{ text: "1 mil visualizações" }, { text: " • " }, { text: "há 3 dias" }] } } });
const chanItem = c => ({ channelRenderer: { channelId: c.id, title: { simpleText: c.name }, subscriberCountText: { simpleText: "1 mil inscritos" },
  subscribeButton: { subscribeButtonRenderer: { subscribed: true, channelId: c.id, onUnsubscribeEndpoints: [{ unsubscribeEndpoint: { channelIds: [c.id], params: "P" + c.id.slice(-2) } }] } } } });
const cont = t => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: t } } } });
const page = (arr, off, prefix, mapFn, size = 3) => {
  const items = arr.slice(off, off + size).map(mapFn);
  if (off + size < arr.length) items.push(cont(prefix + ":" + (off + size)));
  return { contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } };
};

async function fakeFetch(url, opts = {}) {
  const u = String(url), body = opts.body ? JSON.parse(opts.body) : {};
  const res = o => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes("browse/edit_playlist")) {
    server.actions.push({ playlistId: body.playlistId, actions: body.actions });
    for (const a of body.actions) {
      if (a.action === "ACTION_REMOVE_VIDEO") {
        server.pl = server.pl.filter(v => v.sv !== a.setVideoId);
        server.likes = server.likes.filter(v => v.sv !== a.setVideoId);
      }
      else server.likes = server.likes.filter(v => v.id !== a.removedVideoId);
    }
    return res({ status: "STATUS_SUCCEEDED" });
  }
  if (u.includes("like/removelike")) { server.likes = server.likes.filter(v => v.id !== body.target.videoId); return res({}); }
  if (u.includes("subscription/unsubscribe")) { server.subs = server.subs.filter(c => !body.channelIds.includes(c.id)); return res({}); }
  if (u.includes("/browse")) {
    const c = body.continuation || "";
    const off = c ? parseInt(c.split(":")[1], 10) : 0;
    const visible = body.params === "wgYCCAA=";
    const onlyAvailable = items => visible ? items : items.filter(x => !x.unavailable);
    if (body.browseId === "VLLL" || c.startsWith("L:")) return res(page(onlyAvailable(server.likes), off, "L", likeItem));
    if (body.browseId === "VLPLteste12345" || c.startsWith("P:")) return res(page(onlyAvailable(server.pl), off, "P", plItem));
    if (body.browseId === "FEchannels" || c.startsWith("S:")) return res(page(server.subs, off, "S", chanItem));
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => "404" };
}

// ---------- Ambiente do navegador falso ----------
const listeners = [], handlers = [];
const cfg = { INNERTUBE_API_KEY: "k", INNERTUBE_CONTEXT: { client: { clientVersion: "2.0", hl: "pt" } }, LOGGED_IN: true, SESSION_INDEX: "0" };
const ctx = {
  console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, Uint8Array, performance,
  fetch: fakeFetch, crypto: require("crypto").webcrypto, navigator: { userAgent: "teste", language: "pt-BR" },
  document: { cookie: "SAPISID=abc; __Secure-1PAPISID=def", hidden: false },
  location: { origin: "https://www.youtube.com", pathname: "/playlist", search: "?list=LL" },
  chrome: { runtime: { id: "x", onMessage: { addListener: f => handlers.push(f) } } }
};
ctx.window = ctx;
ctx.addEventListener = (t, f) => { if (t === "message") listeners.push(f); };
ctx.removeEventListener = (t, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); };
ctx.postMessage = data => {
  if (data && data.type === "__LC_REQ__") setTimeout(() => listeners.slice().forEach(f => f({ source: realWindow, data: { type: "__LC_RES__", id: data.id, cfg } })), 0);
};
vm.createContext(ctx);
const realWindow = vm.runInContext("window", ctx);   // dentro do vm, window é o proxy global
vm.runInContext(code, ctx);

// Como no Chrome: se o ouvinte não devolve true, não haverá resposta assíncrona.
const call = (cmd, data = {}) => new Promise(r => { if (handlers[0]({ cmd, ...data }, { id: "x" }, r) !== true) r(undefined); });
const status = async () => (await call("status")).status;
const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await status(); if (fn(s)) return s; await new Promise(r => setTimeout(r, 50)); }
  throw new Error("Tempo esgotado. Último status: " + JSON.stringify(await status()));
};

let passed = 0;
const ok = (name, fn) => fn().then(() => { passed++; console.log("  ok  -", name); }, e => { console.error("FALHOU -", name, "\n", e.message); process.exitCode = 1; });

(async () => {
  console.log("Testes do motor:");
  await ok("ping responde e vê a configuração", async () => {
    const r = await call("ping"); assert(r.ok && r.ready && r.loggedIn, JSON.stringify(r));
  });
  await ok("comando desconhecido é recusado", async () => {
    const r = await call("rm-rf"); assert.strictEqual(r, undefined);
  });

  await ok("inscrições: carrega todos os canais, com paginação", async () => {
    await call("subsLoad");
    const s = await waitFor(x => x.subs.phase === "ready");
    assert.strictEqual(s.subs.loaded, 5);
    const l = await call("subsList");
    assert.strictEqual(l.items.length, 5);
    assert.strictEqual(l.items[0].name, "Canal Inscrito 0");
    assert.strictEqual(l.items[0].sub, "1 mil inscritos");
  });
  await ok("inscrições: cancela 2 canais e confere no servidor", async () => {
    const r = await call("subsUnsub", { ids: [ucid(0), ucid(1), "invalido"] });
    assert.strictEqual(r.count, 2);
    const s = await waitFor(x => x.subs.phase === "ready" && !x.busy);
    assert.strictEqual(server.subs.length, 3);
    assert.strictEqual(s.subs.loaded, 3);
    assert.strictEqual(s.subs.done, 2);
    assert(/2 inscri/.test(s.msg), s.msg);
  });

  await ok("curtidos: lê a lista e separa canais", async () => {
    await call("read", { source: "LL" });
    const s = await waitFor(x => x.list.phase === "ready");
    assert.strictEqual(s.list.listTotal, 9);
    const c = await call("channels");
    assert.strictEqual(JSON.stringify(c.items.map(i => i.count).sort()), "[4,4]");
  });
  await ok("filtros: canal, período e posição contam certo", async () => {
    assert.strictEqual((await call("preview", { filter: { mode: "channel", chan: ["Canal A"] } })).count, 4);
    assert.strictEqual((await call("preview", { filter: { mode: "channel", chan: ["Canal A"], invert: true } })).count, 4);
    assert.strictEqual((await call("preview", { filter: { mode: "period", dir: "older", num: 1, unitDays: 365 } })).count, 4);
    assert.strictEqual((await call("preview", { filter: { mode: "period", dir: "within", num: 1, unitDays: 7 } })).count, 4);
    assert.strictEqual((await call("preview", { filter: { mode: "pos", pos: "recent", posN: 3 } })).count, 3);
    assert.strictEqual((await call("preview", { filter: { mode: "channel", chan: [] } })).count, 0);
  });
  await ok("curtidos: remove só o Canal A e confere que saiu", async () => {
    const r = await call("start", { filter: { mode: "channel", chan: ["Canal A"] }, speed: "turbo" });
    assert(r.ok && r.goal === 4);
    const s = await waitFor(x => x.list.phase === "done");
    assert.strictEqual(s.list.done, 4);
    assert.strictEqual(server.likes.length, 5);
    assert(server.likes.some(v => v.unavailable));
  });

  await ok("curtidos: remove vídeo excluído identificado só por setVideoId", async () => {
    await call("read", { source: "LL" });
    await waitFor(x => x.list.phase === "ready");
    const r = await call("start", { filter: { mode: "all" }, speed: "turbo" });
    assert(r.ok && r.goal === 5);
    const s = await waitFor(x => x.list.phase === "done");
    assert.strictEqual(s.list.done, 5);
    assert.strictEqual(server.likes.length, 0);
  });

  await ok("playlist: usa setVideoId e remove tudo", async () => {
    await call("read", { source: "PL", listId: "PLteste12345", title: "Teste" });
    await waitFor(x => x.list.phase === "ready");
    server.actions.length = 0;
    await call("start", { filter: { mode: "all" }, speed: "normal" });
    const s = await waitFor(x => x.list.phase === "done");
    assert.strictEqual(s.list.done, 6);
    assert.strictEqual(server.pl.length, 0);
    assert(server.actions.length > 0 && server.actions.every(a => a.playlistId === "PLteste12345" && a.actions.every(x => x.action === "ACTION_REMOVE_VIDEO")));
  });

  await ok("recusa tarefas inválidas", async () => {
    assert.strictEqual((await call("read", { source: "XX" })).ok, false);
    assert.strictEqual((await call("read", { source: "PL", listId: "../../x" })).ok, false);
    assert.strictEqual((await call("speed", { speed: "constructor" })).ok, false);
    assert.strictEqual((await call("subsUnsub", { ids: ["UCnaoexiste"] })).ok, false);
  });

  const d = (await call("diag")).report;
  await ok("diagnóstico não contém cookies nem tokens", async () => {
    const t = JSON.stringify(d);
    assert(!/SAPISID=|abc|def/.test(t) || !/cookie/i.test(t));
    assert(!t.includes("SAPISIDHASH"));
  });
  console.log(process.exitCode ? "\nHÁ FALHAS." : `\n${passed} verificações aprovadas.`);
})();
