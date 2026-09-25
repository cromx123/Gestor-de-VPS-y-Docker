// Cliente mínimo de la API de Docker por el socket unix (sin dependencias).
import http from "node:http";

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
// Versión mínima que acepta el Docker de la VPS; incluye stats "one-shot".
const API = "/v1.44";
const INFO_TTL = 10 * 60_000;

export class DockerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function request(method, path, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path: API + path, method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new DockerError(504, "Docker no respondió a tiempo")));
    req.on("error", (err) =>
      reject(err instanceof DockerError ? err : new DockerError(502, `No se pudo conectar con Docker (${err.code ?? err.message})`)),
    );
    req.end();
  });
}

async function call(method, path, timeout) {
  const res = await request(method, path, timeout);
  if (res.status >= 400) {
    let message = res.body.toString("utf8");
    try {
      message = JSON.parse(message).message ?? message;
    } catch {}
    throw new DockerError(res.status, message);
  }
  return res;
}

async function json(path, timeout) {
  const { body } = await call("GET", path, timeout);
  return JSON.parse(body.toString("utf8"));
}

const containerPath = (id) => `/containers/${encodeURIComponent(id)}`;

export const listContainers = () => json("/containers/json?all=true");
export const inspect = (id) => json(`${containerPath(id)}/json`);
// one-shot: responde al tiro con una sola muestra (el % de CPU se calcula entre dos llamadas).
export const stats = (id) => json(`${containerPath(id)}/stats?stream=false&one-shot=true`);

let infoCache = { at: 0, data: null };
export async function systemInfo() {
  if (!infoCache.data || Date.now() - infoCache.at > INFO_TTL) {
    infoCache = { at: Date.now(), data: await json("/info") };
  }
  return infoCache.data;
}

const ACTIONS = { start: "/start", stop: "/stop?t=10", restart: "/restart?t=10" };

export async function action(id, name) {
  const suffix = ACTIONS[name];
  if (!suffix) throw new DockerError(400, "Acción desconocida");
  // 304 = ya estaba en ese estado; no es un error.
  await call("POST", containerPath(id) + suffix, 60_000);
}

export async function logs(id, tail) {
  const container = await inspect(id);
  const { body } = await call("GET", `${containerPath(id)}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`);
  return container.Config?.Tty ? body.toString("utf8") : demux(body);
}

// Sin TTY, Docker mezcla stdout y stderr en tramas con 8 bytes de cabecera (el largo va en los últimos 4).
function demux(buf) {
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}
