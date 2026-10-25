// Roda no mundo da PÁGINA (world: MAIN). Só entrega ao content script
// os valores de configuração que o próprio YouTube já expõe em window.ytcfg.
(() => {
  "use strict";
  const REQ = "__LC_REQ__", RES = "__LC_RES__";
  const KEYS = [
    "INNERTUBE_API_KEY", "INNERTUBE_CONTEXT", "INNERTUBE_CONTEXT_CLIENT_NAME",
    "INNERTUBE_CONTEXT_CLIENT_VERSION", "VISITOR_DATA", "SESSION_INDEX",
    "DELEGATED_SESSION_ID", "LOGGED_IN"
  ];
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.type !== REQ || typeof e.data.id !== "string") return;
    const get = k => window.ytcfg?.get?.(k) ?? window.ytcfg?.data_?.[k];
    const cfg = {};
    for (const k of KEYS) { const v = get(k); if (v !== undefined) cfg[k] = v; }
    let safe = {};
    try { safe = JSON.parse(JSON.stringify(cfg)); } catch {}
    window.postMessage({ type: RES, id: e.data.id, cfg: safe }, location.origin);
  });
})();
