"use strict";
(() => {
  const E = {};
  document.querySelectorAll("[id]").forEach(n => { E[n.id] = n; });
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const LS = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
  };
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const fmtTime = sec => {
    if (!isFinite(sec) || sec <= 0) return "--";
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    return h ? `${h}h ${m}min` : m ? `${m}min ${s}s` : `${s}s`;
  };

  // ====== Tema ======
  const THEMES = ["auto", "light", "dark"];
  const THEME_LABEL = { auto: "Tema: automático", light: "Tema: claro", dark: "Tema: escuro" };
  let theme = THEMES.includes(LS.get("lc-theme", "auto")) ? LS.get("lc-theme", "auto") : "auto";
  const applyTheme = () => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
    E.theme.textContent = THEME_LABEL[theme];
  };
  E.theme.addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; LS.set("lc-theme", theme); applyTheme(); });
  applyTheme();

  // ====== Apoio via Pix ======
  const PIX_KEY = "4a9c4dc6-2f3e-4ce7-b405-904796c313c8";
  const copy = async value => {
    try { await navigator.clipboard.writeText(value); return true; } catch {}
    const ta = mk("textarea"); ta.value = value; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    ta.remove(); return ok;
  };
  E.donate.addEventListener("click", () => E.donateDialog.showModal());
  E.donateClose.addEventListener("click", () => E.donateDialog.close());
  E.donateDialog.addEventListener("click", e => { if (e.target === E.donateDialog) E.donateDialog.close(); });
  E.copyPix.addEventListener("click", async () => {
    const ok = await copy(PIX_KEY);
    E.pixStatus.textContent = ok ? "Chave Pix copiada." : "Não consegui copiar. Selecione a chave e copie manualmente.";
  });

  // ====== Comunicação com a aba do YouTube ======
  let tabId = null;
  const send = (cmd, data = {}) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { cmd, ...data }, res => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!res || !res.ok) return reject(new Error((res && res.error) || "Sem resposta da página."));
      resolve(res);
    });
  });
  // O Chrome não adiciona content scripts retroativamente quando a extensão é
  // atualizada. Ao abrir o popup, conectamos a aba atual sem exigir F5.
  const connectToYouTube = async () => {
    if (tabId == null || !chrome.scripting?.executeScript) throw new Error("Não foi possível conectar à aba.");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/page-bridge.js"],
      world: "MAIN",
      injectImmediately: true
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"],
      injectImmediately: true
    });
  };
  const run = async (cmd, data) => { try { return await send(cmd, data); } catch (e) { flash(e.message); return null; } };

  let flashTimer = 0;
  const flash = m => {
    const box = E.tab_active_msg();
    box.textContent = m; box.className = "msg error"; box.hidden = false;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { box.hidden = true; }, 6000);
  };
  E.tab_active_msg = () => (tab === "subs" ? E.subsMsg : E.listMsg);

  // ====== Estado do popup ======
  const TAB_SRC = { likes: "LL", later: "WL", playlists: "PL" };
  let tab = LS.get("lc-tab", "likes");
  if (!["likes", "later", "playlists", "subs"].includes(tab)) tab = "likes";
  let info = null, st = null;
  let speed = LS.get("lc-speed", "turbo");

  const SPEEDS = {
    safe: ["Seguro", "Remove um vídeo por vez, com pausas. É o mais lento, mas o mais tranquilo para a sua conta. Use se o YouTube estiver recusando pedidos."],
    normal: ["Normal", "Remove alguns vídeos ao mesmo tempo, com pequenas pausas. Equilíbrio entre velocidade e segurança. Boa escolha para a maioria das listas."],
    turbo: ["Turbo", "Remove vários vídeos ao mesmo tempo, quase sem pausa. Bem rápido. O programa confere se o YouTube aceitou de verdade e desacelera sozinho se houver problemas."],
    max: ["MAX", "Velocidade máxima: muitos pedidos em paralelo, com dezenas de vídeos por pedido. É o que mais chama a atenção do YouTube. Se falhar, desacelera sozinho."]
  };
  if (!SPEEDS[speed]) speed = "turbo";

  // ====== Velocidade ======
  const speedBtns = {};
  Object.entries(SPEEDS).forEach(([k, [label, desc]]) => {
    const b = mk("button", "chip", label); b.type = "button"; b.title = desc;
    b.addEventListener("click", async () => { speed = k; LS.set("lc-speed", k); paintSpeed(); await run("speed", { speed: k }); });
    speedBtns[k] = b; E.speedRow.appendChild(b);
  });
  const paintSpeed = () => {
    Object.entries(speedBtns).forEach(([k, b]) => b.setAttribute("aria-pressed", String(k === speed)));
    E.speedDesc.textContent = SPEEDS[speed][1];
  };
  paintSpeed();

  // ====== Filtros (aba lista) ======
  const F = { mode: "all", chan: new Set(), invert: false, dir: "older", num: 1, unitDays: 365, pos: "recent", posN: 100 };
  const payload = () => ({ ...F, chan: [...F.chan] });
  let chanItems = [], chanQ = "", built = -1, count = 0, previewTimer = 0, previewSeq = 0;
  const PANES = { all: E.fAll, channel: E.fChan, period: E.fPeriod, pos: E.fPos };

  const paintMode = () => {
    $$("#fTabs .chip").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === F.mode)));
    Object.entries(PANES).forEach(([k, p]) => { p.hidden = k !== F.mode; });
  };
  $$("#fTabs .chip").forEach(b => b.addEventListener("click", () => { F.mode = b.dataset.mode; paintMode(); schedulePreview(); }));

  const renderChan = () => {
    const q = norm(chanQ);
    const arr = chanItems.filter(c => !q || norm(c.name).includes(q)).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    E.chList.replaceChildren();
    if (!chanItems.length) { E.chList.appendChild(mk("div", "empty", "Não consegui identificar os canais desta lista. Use 'Copiar diagnóstico' e me envie.")); return; }
    if (!arr.length) { E.chList.appendChild(mk("div", "empty", "Nenhum canal com esse nome.")); return; }
    arr.slice(0, 300).forEach(c => {
      const row = mk("label", "row"), cb = mk("input"); cb.type = "checkbox"; cb.dataset.k = c.k; cb.checked = F.chan.has(c.k);
      row.append(cb, mk("span", "nm", c.name || c.k), mk("span", "sub", String(c.count)));
      E.chList.appendChild(row);
    });
    if (arr.length > 300) E.chList.appendChild(mk("div", "empty", `Mostrando 300 de ${arr.length}. Use a busca para achar outros.`));
  };
  E.chList.addEventListener("change", e => {
    const cb = e.target.closest("input[type=checkbox]"); if (!cb) return;
    cb.checked ? F.chan.add(cb.dataset.k) : F.chan.delete(cb.dataset.k);
    schedulePreview();
  });
  E.chSearch.addEventListener("input", () => { chanQ = E.chSearch.value; renderChan(); });
  E.chInvert.addEventListener("change", () => { F.invert = E.chInvert.checked; schedulePreview(); });
  E.chClear.addEventListener("click", () => { F.chan.clear(); renderChan(); schedulePreview(); });
  E.perDir.addEventListener("change", () => { F.dir = E.perDir.value; schedulePreview(); });
  E.perNum.addEventListener("input", () => { F.num = Math.max(1, parseInt(E.perNum.value, 10) || 1); schedulePreview(); });
  E.perUnit.addEventListener("change", () => { F.unitDays = parseInt(E.perUnit.value, 10); schedulePreview(); });
  E.posSel.addEventListener("change", () => { F.pos = E.posSel.value; schedulePreview(); });
  E.posNum.addEventListener("input", () => { F.posN = Math.max(1, parseInt(E.posNum.value, 10) || 1); schedulePreview(); });

  const schedulePreview = () => {
    disarm(); clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const my = ++previewSeq;
      const r = await run("preview", { filter: payload() });
      if (!r || my !== previewSeq) return;
      count = r.count;
      let t = `Vão ser removidos: ${r.count} de ${r.total} vídeos`;
      if (F.mode === "period" && r.unknown > 0) t += ` (não consegui ver a data de ${r.unknown}; esses ficam)`;
      if (F.mode === "channel" && !F.chan.size) t = "Marque pelo menos um canal na lista.";
      E.countLine.textContent = t;
      paintStart();
    }, 120);
  };

  // ====== Confirmação em dois cliques (sem janelas pop-up) ======
  const armed = { start: 0, unsub: 0 };
  const isArmed = k => Date.now() < armed[k];
  const disarm = () => { armed.start = 0; armed.unsub = 0; paintStart(); paintUnsub(); };
  const paintStart = () => {
    E.btnStart.disabled = count < 1;
    E.btnStart.textContent = isArmed("start") ? `Clique de novo para confirmar (${count})` : (count ? `Iniciar (${count})` : "Nada para remover");
    E.btnStart.className = "btn wide " + (isArmed("start") ? "danger" : "primary");
  };
  E.btnStart.addEventListener("click", async () => {
    if (!isArmed("start")) { armed.start = Date.now() + 6000; paintStart(); setTimeout(paintStart, 6100); return; }
    armed.start = 0;
    await run("start", { filter: payload(), speed });
    tick();
  });

  // ====== Aba lista: botões ======
  const plSelected = () => {
    const v = E.plSel.value;
    if (v === "__open__") return { id: info?.listParam && !/^(LL|WL)$/.test(info.listParam) ? info.listParam : "", title: "Playlist aberta" };
    return { id: /^[A-Za-z0-9_-]{2,64}$/.test(v) ? v : "", title: E.plSel.options[E.plSel.selectedIndex]?.text || "" };
  };
  const readCurrent = async () => {
    const src = TAB_SRC[tab], pl = plSelected();
    await run("read", { source: src, listId: src === "PL" ? pl.id : src, title: src === "PL" ? pl.title : "" });
    tick();
  };
  E.btnRead.addEventListener("click", readCurrent);
  E.btnAgain.addEventListener("click", readCurrent);
  E.btnStopRead.addEventListener("click", async () => { await run("stop"); tick(); });
  E.btnStop.addEventListener("click", async () => { await run("stop"); tick(); });
  E.btnPause.addEventListener("click", async () => { await run("pause"); tick(); });
  E.plLoad.addEventListener("click", async () => { await run("plsLoad"); tick(); });

  // ====== Inscrições ======
  let subs = [], subsSeq = -1, subsQ = "";
  const sel = new Set();
  const renderSubs = () => {
    const q = norm(subsQ);
    const arr = subs.filter(c => !q || norm(c.name).includes(q));
    E.subsList.replaceChildren();
    if (!subs.length) E.subsList.appendChild(mk("div", "empty", "Clique em “Carregar canais” para ver as suas inscrições."));
    else if (!arr.length) E.subsList.appendChild(mk("div", "empty", "Nenhum canal com esse nome."));
    arr.slice(0, 500).forEach(c => {
      const row = mk("label", "row"), cb = mk("input"); cb.type = "checkbox"; cb.dataset.id = c.id; cb.checked = sel.has(c.id);
      row.append(cb, mk("span", "nm", c.name || c.id));
      if (c.sub) row.append(mk("span", "sub", c.sub));
      E.subsList.appendChild(row);
    });
    if (arr.length > 500) E.subsList.appendChild(mk("div", "empty", `Mostrando 500 de ${arr.length}. Use a busca para filtrar.`));
    paintSubsCount();
  };
  const visibleSubs = () => { const q = norm(subsQ); return subs.filter(c => !q || norm(c.name).includes(q)); };
  const paintSubsCount = () => {
    const known = new Set(subs.map(c => c.id));
    [...sel].forEach(id => { if (!known.has(id)) sel.delete(id); });
    const busy = st?.busy;
    E.subsCount.textContent = subs.length
      ? `${subs.length} canais carregados · ${sel.size} marcados${subsQ ? ` · ${visibleSubs().length} visíveis` : ""}`
      : (st?.subs?.phase === "loading" ? `Carregando... ${st.subs.loaded} canais` : "Nenhum canal carregado.");
    E.subsSearch.disabled = !subs.length;
    E.subsAll.disabled = !subs.length || busy;
    E.subsClear.disabled = !sel.size || busy;
    paintUnsub();
  };
  const paintUnsub = () => {
    const busy = st?.busy;
    E.subsUnsub.disabled = !sel.size || busy;
    E.subsUnsub.textContent = isArmed("unsub") ? `Clique de novo para confirmar (${sel.size} canais)` : (sel.size ? `Cancelar inscrição em ${sel.size} canais` : "Cancelar inscrição nos marcados");
  };
  E.subsList.addEventListener("change", e => {
    const cb = e.target.closest("input[type=checkbox]"); if (!cb) return;
    cb.checked ? sel.add(cb.dataset.id) : sel.delete(cb.dataset.id);
    disarm(); paintSubsCount();
  });
  E.subsSearch.addEventListener("input", () => { subsQ = E.subsSearch.value; renderSubs(); });
  E.subsAll.addEventListener("click", () => { visibleSubs().forEach(c => sel.add(c.id)); disarm(); renderSubs(); });
  E.subsClear.addEventListener("click", () => { sel.clear(); disarm(); renderSubs(); });
  E.subsLoad.addEventListener("click", async () => { await run("subsLoad"); tick(); });
  E.subsStop.addEventListener("click", async () => { await run("stop"); tick(); });
  E.subsUnsub.addEventListener("click", async () => {
    if (!isArmed("unsub")) { armed.unsub = Date.now() + 6000; paintUnsub(); setTimeout(paintUnsub, 6100); return; }
    armed.unsub = 0;
    await run("subsUnsub", { ids: [...sel] });
    tick();
  });
  let subsFetching = false;
  const loadSubsList = async () => {
    if (subsFetching) return;
    subsFetching = true;
    try {
      const seq = st.subs.seq;
      const r = await run("subsList");
      if (r) { subs = r.items; subsSeq = seq; renderSubs(); }
    } finally { subsFetching = false; }
  };

  // ====== Mensagens ======
  const showMsg = (node, on, text, kind) => {
    node.hidden = !on;
    if (on) { node.textContent = text; node.className = "msg " + (kind === "info" ? "" : kind || ""); }
  };

  // ====== Renderização principal ======
  const INTRO = {
    likes: "Remove vídeos da sua lista de “Gostei”. Primeiro eu só leio a lista, sem apagar nada. Depois você escolhe o que remover.",
    later: "Remove vídeos da sua lista “Assistir mais tarde”. Primeiro eu só leio a lista, sem apagar nada. Depois você escolhe o que remover.",
    playlists: "Remove vídeos de uma playlist. Primeiro eu só leio a lista, sem apagar nada. Só funciona em playlists que são suas."
  };

  const renderTabs = () => {
    $$("#tabs .tab").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    E.paneList.hidden = tab === "subs";
    E.paneSubs.hidden = tab !== "subs";
    E.plPicker.hidden = tab !== "playlists";
  };
  $$("#tabs .tab").forEach(b => b.addEventListener("click", () => {
    tab = b.dataset.tab; LS.set("lc-tab", tab); disarm(); renderTabs(); if (st) render();
  }));

  const renderPlaylists = async () => {
    if (tab !== "playlists" || !st) return;
    const key = st.pls.seq + ":" + (info?.listParam || "");
    if (E.plSel.dataset.key !== key) {
      E.plSel.dataset.key = key;
      const keep = E.plSel.value;
      const r = st.pls.count ? await run("plsList") : { items: [] };
      E.plSel.replaceChildren();
      const hasOpen = info?.listParam && !/^(LL|WL)$/.test(info.listParam);
      const o = mk("option", "", hasOpen ? "Playlist aberta agora" : "Playlist aberta agora (abra uma no YouTube)");
      o.value = "__open__"; o.disabled = !hasOpen; E.plSel.appendChild(o);
      (r?.items || []).forEach(p => { const x = mk("option", "", p.title + (p.sub ? ` (${p.sub})` : "")); x.value = p.id; E.plSel.appendChild(x); });
      const has = [...E.plSel.options].some(x => x.value === keep && !x.disabled);
      E.plSel.value = has ? keep : (hasOpen ? "__open__" : (E.plSel.options[1]?.value || "__open__"));
    }
    E.plHint.textContent = st.pls.phase === "loading" ? "Procurando..." : (st.pls.count ? `${st.pls.count} playlists` : "");
    E.plLoad.disabled = st.busy;
  };
  E.plSel.addEventListener("change", () => { disarm(); if (st) render(); });

  const renderList = () => {
    const L = st.list, src = TAB_SRC[tab], pl = tab === "playlists" ? plSelected() : { id: "" };
    const mine = L.source === src && (src !== "PL" || L.listId === pl.id);
    const active = mine && ["reading", "running", "verifying"].includes(L.phase);
    const busyOther = st.busy && !active;
    let view = "intro";
    if (mine) view = L.phase === "reading" ? "reading" : L.phase === "ready" ? "ready"
      : (L.phase === "running" || L.phase === "verifying") ? "run" : L.phase === "done" ? "done" : "intro";

    E.vIntro.hidden = view !== "intro"; E.vReading.hidden = view !== "reading"; E.vReady.hidden = view !== "ready";
    E.vRun.hidden = view !== "run"; E.vDone.hidden = view !== "done";
    E.speedBox.hidden = !(view === "ready" || view === "run");
    if (view === "ready") E.speedSlotReady.appendChild(E.speedBox);
    if (view === "run") E.speedSlotRun.appendChild(E.speedBox);

    if (view === "intro") {
      E.introText.textContent = INTRO[tab] || "";
      const blocked = tab === "playlists" && !pl.id;
      E.btnRead.disabled = busyOther || blocked;
      showMsg(E.introNote, busyOther || blocked,
        busyOther ? "Há outra tarefa em andamento. Espere terminar ou clique em Parar na aba dela."
          : "Escolha uma playlist acima (ou abra uma no YouTube).", "warn");
    }
    if (view === "reading") E.readText.textContent = `Lendo a sua lista... ${L.known} vídeos até agora.`;
    if (view === "ready") {
      if (built !== L.seq) {
        built = L.seq; F.mode = "all"; F.chan.clear(); F.invert = false; chanQ = ""; E.chSearch.value = ""; E.chInvert.checked = false;
        run("channels").then(r => { chanItems = r?.items || []; renderChan(); });
        paintMode(); schedulePreview();
      }
      paintStart();
    }
    if (view === "run") {
      const pct = L.goal ? Math.min(100, Math.floor(L.done / L.goal * 100)) : 0;
      E.stFound.textContent = L.listTotal; E.stDone.textContent = L.done; E.stLeft.textContent = L.left;
      E.stRate.textContent = L.estimated ? "--" : L.rate;
      E.bar.style.width = pct + "%";
      E.runInfo.textContent = `${pct}% · faltam ${L.estimated ? "~" : ""}${fmtTime(L.eta)}` +
        (L.eff === null ? "" : ` · aceitação ${Math.round(L.eff * 100)}% · velocidade ${L.lvl + 1}/${L.levels}`);
      E.btnPause.textContent = L.paused ? "Retomar" : "Pausar";
    }
    if (view === "done") E.doneText.textContent = st.msg;

    // Mensagem de status (só da aba/lista atual)
    const show = mine && st.msgScope === "list" && view !== "done" && view !== "intro" && view !== "reading" && !!st.msg;
    showMsg(E.listMsg, show || (view === "intro" && mine && L.phase === "error" && !!st.msg), st.msg, st.kind);
    paintSpeed();
  };

  const renderSubsPane = () => {
    const U = st.subs;
    const working = U.phase === "working", loading = U.phase === "loading";
    E.subsLoad.disabled = st.busy;
    E.subsLoad.textContent = subs.length ? "Recarregar canais" : "Carregar canais";
    E.subsRun.hidden = !working;
    E.subsUnsub.hidden = working;
    if (working) {
      const done = U.done + U.failed, pct = U.total ? Math.min(100, Math.floor(done / U.total * 100)) : 0;
      E.subsBar.style.width = pct + "%";
      E.subsRunText.textContent = `${done} de ${U.total} · ${U.done} cancelados${U.failed ? ` · ${U.failed} com falha` : ""}`;
    }
    if (subsSeq !== U.seq && U.loaded >= 0 && !loading && !working && U.seq > 0) loadSubsList();
    else paintSubsCount();
    const show = st.msgScope === "subs" && !!st.msg;
    showMsg(E.subsMsg, show, st.msg, st.kind);
  };

  const render = () => {
    if (!st) return;
    renderTabs();
    if (tab === "subs") renderSubsPane(); else { renderPlaylists(); renderList(); }
  };

  // ====== Atualização periódica ======
  let polling = false;
  const tick = async () => {
    if (polling || tabId == null) return;
    polling = true;
    try { const r = await send("status"); st = r.status; render(); }
    catch { E.app.hidden = true; showGate("A conexão com a aba do YouTube foi perdida. Recarregue a aba (F5) e abra a extensão de novo.", "Recarregar a aba", () => chrome.tabs.reload(tabId).then(() => window.close())); }
    finally { polling = false; }
  };

  // ====== Tela de aviso (fora do YouTube etc.) ======
  const showGate = (msg, label, fn) => {
    E.gate.hidden = false; E.gateMsg.textContent = msg; E.gateBtn.textContent = label;
    E.gateBtn.onclick = fn; E.app.hidden = true;
  };

  // ====== Diagnóstico ======
  E.diag.addEventListener("click", async () => {
    const r = await run("diag");
    if (!r) return;
    const text = JSON.stringify(r.report, null, 2);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
    if (!ok) {
      const ta = mk("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch {} ta.remove();
    }
    const box = E.tab_active_msg();
    box.textContent = ok ? "Diagnóstico copiado! É só colar na conversa." : "Não consegui copiar o diagnóstico.";
    box.className = "msg " + (ok ? "ok" : "error"); box.hidden = false;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { box.hidden = true; }, 5000);
  });

  // ====== Início ======
  const init = async () => {
    renderTabs(); paintMode();
    let t = null;
    try { [t] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch {}
    tabId = t?.id ?? null;
    const url = t?.url || "";
    if (tabId == null || (url && !/^https:\/\/(?:[a-z0-9-]+\.)?youtube\.com\//i.test(url))) {
      showGate("Abra o YouTube para usar a limpeza. Eu trabalho dentro da página do YouTube.", "Abrir o YouTube",
        () => { chrome.tabs.create({ url: "https://www.youtube.com/playlist?list=LL" }); window.close(); });
      return;
    }
    try { info = await send("ping"); }
    catch {
      try {
        await connectToYouTube();
        info = await send("ping");
      } catch {
        showGate("Ainda não consigo falar com esta aba. Recarregue a página do YouTube e abra a extensão de novo.", "Recarregar a aba",
          () => { chrome.tabs.reload(tabId).then(() => window.close()); });
        return;
      }
    }
    if (!info.loggedIn) { showGate("Você não está logado no YouTube. Entre na sua conta e abra a extensão de novo.", "Ir para o YouTube", () => { chrome.tabs.update(tabId, { url: "https://www.youtube.com" }); window.close(); }); return; }
    E.gate.hidden = true; E.app.hidden = false;
    await run("speed", { speed });
    await tick();
    setInterval(tick, 700);
  };
  init();
})();
