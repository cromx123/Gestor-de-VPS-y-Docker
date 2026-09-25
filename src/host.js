// Métricas del host: se leen de su /proc (montado en solo lectura) cada 5 s y se guarda la última hora.
import { readFile, statfs } from "node:fs/promises";

const PROC = process.env.HOST_PROC || "/proc";
const INTERVAL = 5_000;
const HISTORY_POINTS = 720; // 1 hora
// Solo interfaces reales: fuera loopback, puentes de Docker y veth.
const VIRTUAL_IFACE = /^(lo|docker\d*|br-|veth|virbr)/;

const read = (file) => readFile(`${PROC}/${file}`, "utf8");

let prev = null;
let latest = null;
const history = [];

async function cpu() {
  const lines = (await read("stat")).split("\n");
  // cpu  user nice system idle iowait irq softirq steal
  const v = lines[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return {
    idle: v[3] + v[4],
    total: v.reduce((a, b) => a + b, 0),
    cores: lines.filter((l) => /^cpu\d+ /.test(l)).length,
  };
}

async function memory() {
  const m = {};
  for (const line of (await read("meminfo")).split("\n")) {
    const [key, value] = line.split(":");
    if (value) m[key] = Number.parseInt(value, 10) * 1024;
  }
  return {
    total: m.MemTotal,
    used: m.MemTotal - m.MemAvailable,
    available: m.MemAvailable,
    swapTotal: m.SwapTotal,
    swapUsed: m.SwapTotal - m.SwapFree,
  };
}

// /proc/1/net es el espacio de red del host (el /proc/net del contenedor sería el suyo).
async function network() {
  let rx = 0;
  let tx = 0;
  for (const line of (await read("1/net/dev")).split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || VIRTUAL_IFACE.test(name.trim())) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0];
    tx += f[8];
  }
  return { rx, tx };
}

// "/" del contenedor es un overlay sobre el disco del host, así que statfs entrega el disco real.
async function disk() {
  const s = await statfs("/");
  const used = (s.blocks - s.bfree) * s.bsize;
  const available = s.bavail * s.bsize;
  return { total: s.blocks * s.bsize, used, available };
}

async function sample() {
  const [c, mem, net, dsk, loadavg, uptime] = await Promise.all([
    cpu(),
    memory(),
    network().catch(() => null),
    disk().catch(() => null),
    read("loadavg"),
    read("uptime"),
  ]);
  const now = Date.now();
  let cpuPct = null;
  let rates = null;
  if (prev) {
    const seconds = (now - prev.time) / 1000;
    const total = c.total - prev.cpu.total;
    cpuPct = total > 0 ? (1 - (c.idle - prev.cpu.idle) / total) * 100 : 0;
    if (net && prev.net) {
      rates = { rx: Math.max(0, (net.rx - prev.net.rx) / seconds), tx: Math.max(0, (net.tx - prev.net.tx) / seconds) };
    }
  }
  prev = { time: now, cpu: c, net };

  let point = null;
  if (cpuPct !== null) {
    point = {
      t: now,
      cpu: round1(cpuPct),
      mem: round1((mem.used / mem.total) * 100),
      rx: Math.round(rates?.rx ?? 0),
      tx: Math.round(rates?.tx ?? 0),
    };
    history.push(point);
    if (history.length > HISTORY_POINTS) history.shift();
  }

  latest = {
    cpu: cpuPct === null ? null : round1(cpuPct),
    cores: c.cores,
    load: loadavg.trim().split(/\s+/).slice(0, 3).map(Number),
    uptime: Math.floor(Number.parseFloat(uptime)),
    mem,
    disk: dsk,
    net: rates,
    point,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

function safeSample() {
  sample().catch((err) => console.error("Error leyendo métricas del host:", err.message));
}

export function start() {
  safeSample();
  // Segunda muestra al segundo para tener % de CPU apenas arranca.
  setTimeout(safeSample, 1_000);
  setInterval(safeSample, INTERVAL);
}

export const current = () => latest;
export const getHistory = () => history;
