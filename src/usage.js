// CPU y RAM de cada contenedor. Solo se mide mientras alguien tiene el panel abierto.
import * as docker from "./docker.js";

const INTERVAL = 5_000;
const IDLE_AFTER = 30_000;
const CONCURRENCY = 8;

const prev = new Map(); // id → { cpu, system } de la muestra anterior
const usage = new Map(); // id → { cpu, mem, memLimit }
let lastDemand = 0;
let timer = null;
let busy = false;

export function wanted() {
  lastDemand = Date.now();
  if (timer) return;
  timer = setInterval(tick, INTERVAL);
  // Segunda pasada al segundo: el % de CPU necesita dos muestras.
  tick().then(() => setTimeout(tick, 1_000));
}

export const of = (id) => usage.get(id);

async function tick() {
  if (Date.now() - lastDemand > IDLE_AFTER) {
    clearInterval(timer);
    timer = null;
    prev.clear();
    usage.clear();
    return;
  }
  if (busy) return;
  busy = true;
  try {
    const running = (await docker.listContainers()).filter((c) => c.State === "running");
    const alive = new Set(running.map((c) => c.Id));
    for (const id of usage.keys()) {
      if (!alive.has(id)) {
        usage.delete(id);
        prev.delete(id);
      }
    }
    await eachLimited(running, CONCURRENCY, async (c) => {
      try {
        measure(c.Id, await docker.stats(c.Id));
      } catch {
        usage.delete(c.Id);
      }
    });
  } catch (err) {
    console.error("Error midiendo contenedores:", err.message);
  } finally {
    busy = false;
  }
}

function measure(id, s) {
  const cpu = s.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const system = s.cpu_stats?.system_cpu_usage ?? 0;
  const before = prev.get(id);
  prev.set(id, { cpu, system });

  // RAM como la muestra `docker stats`: uso menos la caché de archivos inactiva.
  const m = s.memory_stats ?? {};
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0;
  usage.set(id, {
    // % del total de la VPS (system_cpu_usage suma todos los núcleos).
    cpu: before && system > before.system ? Math.round(((cpu - before.cpu) / (system - before.system)) * 1000) / 10 : null,
    mem: m.usage == null ? null : Math.max(0, m.usage - cache),
    memLimit: m.limit ?? null,
  });
}

async function eachLimited(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
