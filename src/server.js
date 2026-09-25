// Gestor VPS: panel web para ver CPU, RAM, disco, red y los contenedores Docker del servidor.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as auth from "./auth.js";
import * as docker from "./docker.js";
import * as host from "./host.js";
import * as usage from "./usage.js";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");
// No se pueden DETENER desde la web: se cortaría el acceso al propio panel.
const PROTECTED = new Set(
  (process.env.PROTECTED_CONTAINERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const HTML = "text/html; charset=utf-8";
const ASSETS = {
  "/app.js": "text/javascript; charset=utf-8",
  "/login.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Respuestas ----------

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...headers });
  res.end(body);
}

const sendJson = (res, status, data) =>
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8", { "Cache-Control": "no-store" });

function redirect(res, location) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location });
  res.end();
}

async function sendFile(res, name, type) {
  send(res, 200, await readFile(path.join(PUBLIC_DIR, name)), type, { "Cache-Control": "no-cache" });
}

async function readJson(req, limit = 10_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Solicitud demasiado grande");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

// nginx entrega la IP real en X-Real-IP; el contenedor solo es accesible a través de él.
const clientIp = (req) => req.headers["x-real-ip"] || req.socket.remoteAddress || "?";

// ---------- Rutas ----------

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  const { method } = req;

  if (pathname === "/healthz") return send(res, 200, "ok", "text/plain");
  if (method === "GET" && ASSETS[pathname]) return sendFile(res, pathname.slice(1), ASSETS[pathname]);

  const loggedIn = auth.hasSession(req);
  if (method === "GET" && pathname === "/") return loggedIn ? sendFile(res, "index.html", HTML) : redirect(res, "/login");
  if (method === "GET" && pathname === "/login") return loggedIn ? redirect(res, "/") : sendFile(res, "login.html", HTML);
  if (method === "POST" && pathname === "/api/login") return login(req, res);

  if (!pathname.startsWith("/api/")) return send(res, 404, "No encontrado", "text/plain; charset=utf-8");
  if (!loggedIn) return sendJson(res, 401, { error: "Sesión vencida" });
  if (method === "POST" && !auth.sameOrigin(req)) return sendJson(res, 403, { error: "Origen no permitido" });

  if (method === "POST" && pathname === "/api/logout") {
    res.setHeader("Set-Cookie", auth.clearCookie());
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && pathname === "/api/overview") return overview(res, url.searchParams.has("history"));

  const match = pathname.match(/^\/api\/containers\/([^/]+)\/(logs|start|stop|restart)$/);
  if (match && CONTAINER_ID.test(match[1])) {
    const [, id, what] = match;
    if (what === "logs" && method === "GET") return containerLogs(res, id, url.searchParams.get("tail"));
    if (what !== "logs" && method === "POST") return containerAction(req, res, id, what);
  }
  return sendJson(res, 404, { error: "No encontrado" });
}

async function login(req, res) {
  if (!auth.sameOrigin(req)) return sendJson(res, 403, { error: "Origen no permitido" });
  const ip = clientIp(req);
  const wait = auth.lockedFor(ip);
  if (wait) return sendJson(res, 429, { error: `Demasiados intentos. Espera ${Math.ceil(wait / 60_000)} min.` });

  const { password } = await readJson(req);
  if (typeof password !== "string" || !auth.checkPassword(password)) {
    auth.registerFailure(ip);
    console.warn(`[login] fallido desde ${ip}`);
    return sendJson(res, 401, { error: "Contraseña incorrecta" });
  }
  auth.clearFailures(ip);
  console.log(`[login] correcto desde ${ip}`);
  res.setHeader("Set-Cookie", auth.sessionCookie());
  sendJson(res, 200, { ok: true });
}

async function overview(res, withHistory) {
  usage.wanted();
  const [list, info] = await Promise.all([docker.listContainers(), docker.systemInfo()]);
  const current = host.current();
  const memTotal = current?.mem.total ?? info.MemTotal;
  sendJson(res, 200, {
    time: Date.now(),
    system: {
      name: info.Name,
      os: info.OperatingSystem,
      kernel: info.KernelVersion,
      docker: info.ServerVersion,
    },
    host: current,
    history: withHistory ? host.getHistory() : undefined,
    containers: list.map((c) => summarize(c, memTotal)),
  });
}

function summarize(c, memTotal) {
  const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
  const running = c.State === "running";
  const u = running ? usage.of(c.Id) : null;
  const health = c.Status.match(/\((healthy|unhealthy|health: starting)\)/)?.[1] ?? null;
  const ports = (c.Ports ?? [])
    .filter((p) => p.PublicPort)
    .map((p) => `${p.IP && p.IP !== "0.0.0.0" && p.IP !== "::" ? `${p.IP}:` : ""}${p.PublicPort}→${p.PrivatePort}/${p.Type}`);
  return {
    id: c.Id.slice(0, 12),
    name,
    image: c.Image.startsWith("sha256:") ? c.Image.slice(7, 19) : c.Image,
    project: c.Labels?.["com.docker.compose.project"] ?? null,
    state: c.State,
    status: c.Status,
    health: health === "health: starting" ? "starting" : health,
    ports: [...new Set(ports)],
    protected: PROTECTED.has(name),
    cpu: u?.cpu ?? null,
    mem: u?.mem ?? null,
    // Solo si tiene un límite propio (sin límite, Docker informa la RAM total del host).
    memLimit: u?.memLimit && u.memLimit < memTotal ? u.memLimit : null,
  };
}

async function containerLogs(res, id, tailParam) {
  const tail = Math.min(Math.max(Number.parseInt(tailParam, 10) || 300, 10), 5000);
  const text = await docker.logs(id, tail);
  send(res, 200, text.replace(ANSI, ""), "text/plain; charset=utf-8", { "Cache-Control": "no-store" });
}

async function containerAction(req, res, id, what) {
  const container = await docker.inspect(id);
  const name = container.Name.replace(/^\//, "");
  if (what === "stop" && PROTECTED.has(name)) {
    return sendJson(res, 403, { error: `${name} está protegido: detenerlo cortaría el acceso a este panel. Usa Reiniciar.` });
  }
  console.log(`[acción] ${what} ${name} desde ${clientIp(req)}`);
  await docker.action(container.Id, what);
  sendJson(res, 200, { ok: true });
}

// ---------- Arranque ----------

if (!auth.configured()) {
  console.error("Falta ADMIN_PASSWORD en el entorno.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(`${req.method} ${req.url}:`, err.message);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: err.message || "Error interno" });
  }
});

host.start();
server.listen(PORT, () => console.log(`Gestor VPS escuchando en :${PORT}`));

// Node como PID 1 no termina solo con SIGTERM: sin esto, docker stop espera 10 s.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
