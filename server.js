// Servidor sem dependências: serve o diário e guarda os dados num ficheiro JSON.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) { console.error("Falta definir APP_PASSWORD."); process.exit(1); }
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("sess:" + PASSWORD).digest("hex");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "data.json");
const PREFIX = "tarefas-diarias-v1";
const SESSION_MS = 30 * 24 * 3600 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
let store = {};
try { store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch (e) {}

let writing = false, dirty = false;
function persist() {
  if (writing) { dirty = true; return; }
  writing = true;
  const tmp = FILE + ".tmp";
  fs.writeFile(tmp, JSON.stringify(store), err => {
    if (err) { console.error(err); writing = false; return; }
    fs.rename(tmp, FILE, err2 => {
      if (err2) console.error(err2);
      writing = false;
      if (dirty) { dirty = false; persist(); }
    });
  });
}

const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function makeToken() { const exp = String(Date.now() + SESSION_MS); return exp + "." + sign(exp); }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split(".");
  return !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
const authed = req => validToken(cookies(req).sid);

const fails = new Map();
function ipOf(req) { return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
function blocked(ip) {
  const f = fails.get(ip); if (!f) return false;
  if (Date.now() - f.t > 15 * 60 * 1000) { fails.delete(ip); return false; }
  return f.n >= 10;
}
function failed(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 15 * 60 * 1000) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; }

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > max) { reject(new Error("grande")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const headers = extra => Object.assign({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store"
}, extra);
const send = (res, code, body, type, extra) => { res.writeHead(code, headers(Object.assign({ "Content-Type": type }, extra))); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");

const loginPage = msg => `<!DOCTYPE html><html lang="pt-PT"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Diário de Trabalho</title><style>
:root{--bg:#f6f5f1;--card:#fff;--tx:#1f2328;--bd:#e4e2dc;--ac:#2f6f5e;--dg:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#15181a;--card:#1f2326;--tx:#e8e8e6;--bd:#2d3236;--ac:#5fb59d;--dg:#e57368}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--tx);font:16px/1.5 system-ui,sans-serif}
form{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:24px;width:min(340px,90vw)}
h1{font-size:1.3rem;margin:0 0 14px}input,button{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--bd);margin-bottom:10px;box-sizing:border-box}
input{background:var(--bg);color:var(--tx)}button{background:var(--ac);border-color:var(--ac);color:#fff;cursor:pointer}
p{color:var(--dg);margin:0 0 10px;font-size:.9rem}</style></head><body>
<form method="post" action="/login"><h1>Diário de Trabalho</h1>${msg ? "<p>" + msg + "</p>" : ""}
<input type="password" name="password" placeholder="Palavra-passe" autocomplete="current-password" autofocus required>
<button type="submit">Entrar</button></form></body></html>`;

const syncJs = fs.readFileSync(path.join(__dirname, "public", "sync.js"));
function indexHtml() {
  const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const data = JSON.stringify(store).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return html.replace(/<head>/i, `<head>\n<script>window.__SD__=${data};</script>\n<script src="/sync.js"></script>`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/healthz") return send(res, 200, "ok", "text/plain");

    if (p === "/login" && req.method === "POST") {
      const ip = ipOf(req);
      if (blocked(ip)) return send(res, 429, loginPage("Demasiadas tentativas. Tenta daqui a 15 minutos."), "text/html; charset=utf-8");
      const body = new URLSearchParams(await readBody(req, 4096));
      if (safeEq(body.get("password") || "", PASSWORD)) {
        fails.delete(ip);
        return send(res, 303, "", "text/plain", {
          Location: "/",
          "Set-Cookie": `sid=${makeToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`
        });
      }
      failed(ip);
      return send(res, 401, loginPage("Palavra-passe errada."), "text/html; charset=utf-8");
    }
    if (p === "/login") return send(res, 200, loginPage(""), "text/html; charset=utf-8");
    if (p === "/logout") return send(res, 303, "", "text/plain", { Location: "/login", "Set-Cookie": "sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });

    if (!authed(req)) {
      if (p.startsWith("/api/")) return json(res, 401, { error: "auth" });
      return send(res, 303, "", "text/plain", { Location: "/login" });
    }

    if (p === "/" || p === "/index.html") return send(res, 200, indexHtml(), "text/html; charset=utf-8");
    if (p === "/sync.js") return send(res, 200, syncJs, "application/javascript; charset=utf-8");
    if (p === "/api/data" && req.method === "GET") return json(res, 200, store);

    if (p === "/api/sync" && req.method === "POST") {
      let b;
      try { b = JSON.parse(await readBody(req, 4 * 1024 * 1024)); } catch (e) { return json(res, 400, { error: "json" }); }
      const ok = k => typeof k === "string" && k.startsWith(PREFIX) && k.length < 100;
      if (b && b.set && typeof b.set === "object")
        Object.keys(b.set).forEach(k => { if (ok(k) && typeof b.set[k] === "string" && b.set[k].length < 2e6) store[k] = b.set[k]; });
      if (b && Array.isArray(b.del)) b.del.forEach(k => { if (ok(k)) delete store[k]; });
      persist();
      return json(res, 200, { ok: true });
    }

    send(res, 404, "Não encontrado", "text/plain; charset=utf-8");
  } catch (e) {
    console.error(e);
    try { send(res, 500, "Erro", "text/plain"); } catch (_) {}
  }
});

server.listen(PORT, () => console.log("Diário a correr na porta " + PORT + ", dados em " + FILE));
