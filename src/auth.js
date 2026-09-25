// Acceso con una sola contraseña. La sesión es una cookie firmada con HMAC.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "gestor_session";
const HOURS = Number(process.env.SESSION_HOURS) || 12;
const PASSWORD = process.env.ADMIN_PASSWORD || "";
// Sin SESSION_SECRET se usa uno al azar: las sesiones se pierden al reiniciar el contenedor.
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");

// Tras 5 intentos fallidos en 15 minutos, esa IP queda bloqueada 15 minutos.
const MAX_FAILURES = 5;
const WINDOW = 15 * 60_000;
const failures = new Map(); // ip → { count, first, lockedUntil }

export const configured = () => PASSWORD.length > 0;

const digest = (s) => createHash("sha256").update(s).digest();

// Se comparan hashes para no filtrar el largo de la contraseña.
export const checkPassword = (input) => timingSafeEqual(digest(input), digest(PASSWORD));

const sign = (value) => createHmac("sha256", SECRET).update(value).digest("base64url");

const COOKIE_FLAGS = "Path=/; HttpOnly; Secure; SameSite=Strict";

export function sessionCookie() {
  const value = `${Date.now() + HOURS * 3_600_000}.${randomBytes(9).toString("base64url")}`;
  return `${COOKIE}=${value}.${sign(value)}; ${COOKIE_FLAGS}; Max-Age=${HOURS * 3600}`;
}

export const clearCookie = () => `${COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`;

export function hasSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return false;
  const i = raw.lastIndexOf(".");
  if (i < 0) return false;
  const value = raw.slice(0, i);
  const sig = Buffer.from(raw.slice(i + 1));
  const expected = Buffer.from(sign(value));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
  return Number(value.split(".")[0]) > Date.now();
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Los POST solo se aceptan desde la propia página (además de SameSite=Strict).
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function lockedFor(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  const now = Date.now();
  if (f.lockedUntil > now) return f.lockedUntil - now;
  if (now - f.first > WINDOW) failures.delete(ip);
  return 0;
}

export function registerFailure(ip) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.first > WINDOW) f = { count: 0, first: now, lockedUntil: 0 };
  f.count++;
  if (f.count >= MAX_FAILURES) f.lockedUntil = now + WINDOW;
  failures.set(ip, f);
}

export const clearFailures = (ip) => failures.delete(ip);

// Limpia IPs viejas para que el mapa no crezca sin fin.
setInterval(() => {
  for (const ip of failures.keys()) lockedFor(ip);
}, WINDOW).unref();
