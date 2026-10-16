// Faz o localStorage da app espelhar-se no servidor (o servidor é a fonte de verdade).
(function () {
  var P = "tarefas-diarias-v1", ls, D = window.__SD__ || {};
  try { ls = window.localStorage; void ls.length; } catch (e) { return; }
  var si = Storage.prototype.setItem, ri = Storage.prototype.removeItem;
  var pend = { set: {}, del: {} }, timer = null, busy = false;
  var mine = function (k) { return String(k).indexOf(P) === 0; };
  var has = function () { return Object.keys(pend.set).length + Object.keys(pend.del).length > 0; };
  function localKeys() { var a = []; for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (mine(k)) a.push(k); } return a; }

  var badgeEl;
  function badge(on) {
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.textContent = "⚠ Sem ligação ao servidor — a tentar de novo";
      badgeEl.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#c0392b;color:#fff;padding:8px 12px;border-radius:10px;font:14px system-ui;text-align:center";
    }
    if (on && !badgeEl.parentNode) (document.body || document.documentElement).appendChild(badgeEl);
    if (!on && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(flush, ms || 600); }
  function flush() {
    if (busy || !has()) return;
    busy = true;
    var sent = pend, body = JSON.stringify({ set: sent.set, del: Object.keys(sent.del) });
    pend = { set: {}, del: {} };
    fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: body.length < 60000, credentials: "same-origin" })
      .then(function (r) {
        if (r.status === 401) { location.reload(); return; }
        if (!r.ok) throw new Error("http");
        busy = false; badge(false); if (has()) schedule();
      })
      .catch(function () {
        Object.keys(sent.set).forEach(function (k) { if (!(k in pend.set) && !(k in pend.del)) pend.set[k] = sent.set[k]; });
        Object.keys(sent.del).forEach(function (k) { if (!(k in pend.set) && !(k in pend.del)) pend.del[k] = 1; });
        busy = false; badge(true); schedule(5000);
      });
  }

  // Arranque: o servidor manda; se estiver vazio, sobe o que existir localmente.
  var sk = Object.keys(D), lk = localKeys();
  if (sk.length) {
    lk.forEach(function (k) { if (!(k in D)) ri.call(ls, k); });
    sk.forEach(function (k) { if (ls.getItem(k) !== D[k]) si.call(ls, k, D[k]); });
  } else if (lk.length) {
    lk.forEach(function (k) { pend.set[k] = ls.getItem(k); });
    schedule(300);
  }

  Storage.prototype.setItem = function (k, v) {
    si.call(this, k, v);
    if (this === ls && mine(k)) { delete pend.del[k]; pend.set[k] = String(v); schedule(); }
  };
  Storage.prototype.removeItem = function (k) {
    ri.call(this, k);
    if (this === ls && mine(k)) { delete pend.set[k]; pend.del[k] = 1; schedule(); }
  };

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { flush(); return; }
    if (busy || has()) return;
    fetch("/api/data", { cache: "no-store", credentials: "same-origin" })
      .then(function (r) { if (r.status === 401) { location.reload(); throw 0; } return r.json(); })
      .then(function (S) {
        if (busy || has()) return;
        var diff = false, keys = Object.keys(S);
        keys.forEach(function (k) { if (ls.getItem(k) !== S[k]) { si.call(ls, k, S[k]); diff = true; } });
        if (keys.length) localKeys().forEach(function (k) { if (!(k in S)) { ri.call(ls, k); diff = true; } });
        if (diff) location.reload();
      })
      .catch(function () {});
  });
})();
