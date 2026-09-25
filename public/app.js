// Panel del Gestor VPS: se actualiza cada 5 s mientras la pestaña está visible.
const REFRESH_MS = 5_000;
const LOGS_FOLLOW_MS = 3_000;
const HISTORY_POINTS = 720;

const $ = (id) => document.getElementById(id);
const num = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });
const logTime = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

const state = {
  containers: [],
  history: [],
  needHistory: true,
  sort: { key: "project", dir: 1 },
  pending: new Map(), // id → acción en curso
  filter: "",
  project: "",
  status: "",
};

// ---------- API ----------

class NetworkError extends Error {}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  } catch {
    throw new NetworkError("Se perdió la conexión con el servidor");
  }
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Sesión vencida");
  }
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return res;
}

// ---------- Refresco ----------

let timer = null;
let loading = false;

async function refresh() {
  if (loading) return;
  loading = true;
  const withHistory = state.needHistory;
  try {
    const data = await (await api(`/api/overview${withHistory ? "?history=1" : ""}`)).json();
    if (withHistory) {
      state.history = data.history ?? [];
      state.needHistory = false;
    } else {
      addPoint(data.host?.point);
    }
    state.containers = data.containers;
    renderSystem(data.system);
    renderHost(data.host);
    renderProjects();
    renderContainers();
    $("updated").textContent = `Actualizado ${new Date(data.time).toLocaleTimeString("es-CL")}`;
    $("error").hidden = true;
  } catch (err) {
    $("error").textContent = `No se pudo actualizar: ${err.message}. Reintentando…`;
    $("error").hidden = false;
  } finally {
    loading = false;
  }
}

function addPoint(point) {
  const last = state.history.at(-1);
  if (!point || (last && point.t <= last.t)) return;
  state.history.push(point);
  if (state.history.length > HISTORY_POINTS) state.history.shift();
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(timer);
    return;
  }
  // Al volver, se pide el historial completo para no dejar un hueco en los gráficos.
  state.needHistory = true;
  refresh();
  startTimer();
});

// ---------- Servidor ----------

function renderSystem(sys) {
  $("system").textContent = [sys.name, sys.os].filter(Boolean).join(" · ");
  $("docker-version").textContent = sys.docker ?? "—";
}

function renderHost(h) {
  if (!h) return;

  setMetric("cpu", h.cpu, h.cpu == null ? "—" : pct(h.cpu));
  $("cpu-sub").textContent = `${h.cores} núcleos · carga ${h.load.map((n) => num.format(n)).join(" / ")}`;

  const memPct = (h.mem.used / h.mem.total) * 100;
  setMetric("mem", memPct, pct(memPct));
  $("mem-sub").textContent = `${bytes(h.mem.used)} de ${bytes(h.mem.total)} · libre ${bytes(h.mem.available)}`;

  if (h.disk) {
    const diskPct = (h.disk.used / (h.disk.used + h.disk.available)) * 100;
    setMetric("disk", diskPct, pct(diskPct));
    $("disk-sub").textContent = `${bytes(h.disk.used)} de ${bytes(h.disk.total)} · libre ${bytes(h.disk.available)}`;
  }
  $("swap").textContent = h.mem.swapTotal ? `${bytes(h.mem.swapUsed)} de ${bytes(h.mem.swapTotal)}` : "Sin swap";
  $("uptime").textContent = duration(h.uptime);

  if (h.net) {
    $("net-value").textContent = `↓ ${rate(h.net.rx)}`;
    $("net-sub").textContent = `↑ ${rate(h.net.tx)} de subida`;
  }

  const hist = state.history;
  sparkline($("cpu-spark"), [hist.map((p) => p.cpu)], 100);
  sparkline($("mem-spark"), [hist.map((p) => p.mem)], 100);
  sparkline($("net-spark"), [hist.map((p) => p.rx), hist.map((p) => p.tx)]);
  if (hist.length > 1) {
    const minutes = Math.round((hist.at(-1).t - hist[0].t) / 60_000);
    $("history-span").textContent = minutes >= 59 ? "Gráficos: última hora" : `Gráficos: últimos ${Math.max(1, minutes)} min`;
  }
}

function setMetric(id, value, text) {
  $(`${id}-value`).textContent = text;
  const bar = $(`${id}-bar`);
  bar.style.width = `${Math.min(100, Math.max(0, value ?? 0))}%`;
  bar.className = value == null ? "" : value >= 90 ? "crit" : value >= 75 ? "warn" : "ok";
}

function sparkline(el, series, max) {
  const W = 300;
  const H = 48;
  const n = series[0].length;
  if (n < 2) {
    el.innerHTML = "";
    return;
  }
  const top = max ?? Math.max(1, ...series.flat());
  const line = (values) =>
    values.map((v, i) => `${i ? "L" : "M"}${((i / (n - 1)) * W).toFixed(1)},${(H - 1 - (v / top) * (H - 2)).toFixed(1)}`).join("");
  const first = line(series[0]);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${first}L${W},${H}L0,${H}Z"/>
    ${series.map((s, i) => `<path class="line line-${i}" d="${i ? line(s) : first}"/>`).join("")}
  </svg>`;
}

// ---------- Contenedores ----------

const STATE_LABEL = {
  running: "Activo", exited: "Detenido", created: "Creado", restarting: "Reiniciándose",
  paused: "En pausa", dead: "Muerto", removing: "Eliminándose",
};
const HEALTH_LABEL = { healthy: "sano", unhealthy: "no sano", starting: "iniciando" };
const PENDING_LABEL = { start: "Iniciando…", stop: "Deteniendo…", restart: "Reiniciando…" };
const STATE_ORDER = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 };

const hasProblem = (c) => c.health === "unhealthy" || c.state === "restarting" || c.state === "dead";

function kind(c) {
  if (c.state === "running") return c.health === "unhealthy" ? "crit" : c.health === "starting" ? "warn" : "ok";
  if (c.state === "restarting" || c.state === "paused") return "warn";
  if (c.state === "dead") return "crit";
  return "idle";
}

function stateLabel(c) {
  const pending = state.pending.get(c.id);
  if (pending) return PENDING_LABEL[pending];
  const base = STATE_LABEL[c.state] ?? c.state;
  return c.health ? `${base} · ${HEALTH_LABEL[c.health]}` : base;
}

function renderProjects() {
  const select = $("project");
  const projects = [...new Set(state.containers.map((c) => c.project ?? "—"))].sort();
  const current = [...select.options].slice(1).map((o) => o.value);
  if (current.join("|") === projects.join("|")) return;
  const selected = select.value;
  select.innerHTML =
    `<option value="">Todos los proyectos</option>` +
    projects.map((p) => `<option value="${esc(p)}">${esc(p === "—" ? "Sin proyecto" : p)}</option>`).join("");
  select.value = projects.includes(selected) ? selected : "";
  state.project = select.value;
}

function visibleContainers() {
  const q = state.filter.trim().toLowerCase();
  return state.containers
    .filter((c) => !q || [c.name, c.image, c.project ?? ""].some((s) => s.toLowerCase().includes(q)))
    .filter((c) => !state.project || (c.project ?? "—") === state.project)
    .filter((c) => {
      if (state.status === "running") return c.state === "running";
      if (state.status === "stopped") return c.state !== "running";
      if (state.status === "problems") return hasProblem(c);
      return true;
    })
    .sort(compare);
}

function compare(a, b) {
  const { key, dir } = state.sort;
  const byName = a.name.localeCompare(b.name);
  let r = 0;
  if (key === "name") r = byName;
  else if (key === "project") r = (a.project ?? "~").localeCompare(b.project ?? "~");
  else if (key === "state") r = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
  else r = (a[key] ?? -1) - (b[key] ?? -1);
  return r * dir || byName;
}

function renderContainers() {
  const all = state.containers;
  const running = all.filter((c) => c.state === "running").length;
  const problems = all.filter(hasProblem).length;
  $("counts").textContent = `${running} activos de ${all.length}${problems ? ` · ${problems} con problemas` : ""}`;

  for (const button of document.querySelectorAll("th button[data-sort]")) {
    const th = button.closest("th");
    if (button.dataset.sort === state.sort.key) th.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  }

  const list = visibleContainers();
  $("rows").innerHTML = list.length ? list.map(row).join("") : `<tr><td colspan="6" class="empty">Sin resultados</td></tr>`;
}

function row(c) {
  const running = c.state === "running" || c.state === "restarting";
  const disabled = state.pending.has(c.id) ? " disabled" : "";
  const buttons = [`<button type="button" class="btn btn-sm" data-action="logs">Logs</button>`];
  if (running) {
    buttons.push(`<button type="button" class="btn btn-sm" data-action="restart"${disabled}>Reiniciar</button>`);
    if (!c.protected) buttons.push(`<button type="button" class="btn btn-sm btn-danger" data-action="stop"${disabled}>Detener</button>`);
  } else {
    buttons.push(`<button type="button" class="btn btn-sm" data-action="start"${disabled}>Iniciar</button>`);
  }
  const meta = [c.project ?? "sin proyecto", ...c.ports].join(" · ");
  const mem = c.mem == null ? "—" : bytes(c.mem) + (c.memLimit ? ` / ${bytes(c.memLimit)}` : "");
  const tag = c.protected ? ` <span class="tag" title="No se puede detener desde aquí">protegido</span>` : "";
  const statusKind = state.pending.has(c.id) ? "warn" : kind(c);
  return `<tr data-id="${esc(c.id)}"${c.state === "running" ? "" : ` class="is-stopped"`}>
    <td data-label="Nombre"><div class="name">${esc(c.name)}${tag}</div><div class="muted small">${esc(meta)}</div></td>
    <td data-label="Estado"><span class="status status-${statusKind}"><i aria-hidden="true"></i>${esc(stateLabel(c))}</span>
      <div class="muted small">${esc(translateStatus(c.status))}</div></td>
    <td data-label="CPU" class="num">${c.cpu == null ? "—" : pct(c.cpu)}</td>
    <td data-label="RAM" class="num">${esc(mem)}</td>
    <td data-label="Imagen" class="image" title="${esc(c.image)}">${esc(c.image)}</td>
    <td class="actions">${buttons.join("")}</td>
  </tr>`;
}

// ---------- Acciones ----------

const CONFIRM = {
  restart: (c) => ({
    title: `¿Reiniciar ${c.name}?`,
    text:
      c.name === "proxy_principal"
        ? "Todos los sitios y este panel se cortan unos segundos mientras vuelve."
        : "Se detiene y vuelve a arrancar. Queda sin servicio unos segundos.",
    ok: "Reiniciar",
  }),
  stop: (c) => ({
    title: `¿Detener ${c.name}?`,
    text: "Queda apagado hasta que lo inicies de nuevo desde aquí.",
    ok: "Detener",
    danger: true,
  }),
};
const DONE = { start: "iniciado", stop: "detenido", restart: "reiniciado" };

async function runAction(c, action) {
  const question = CONFIRM[action]?.(c);
  if (question && !(await ask(question))) return;
  state.pending.set(c.id, action);
  renderContainers();
  try {
    await api(`/api/containers/${encodeURIComponent(c.id)}/${action}`, { method: "POST", body: "{}" });
    toast(`${c.name} ${DONE[action]}`);
  } catch (err) {
    toast(
      err instanceof NetworkError
        ? `${err.message}. Si reiniciaste el proxy o el gestor, vuelve en unos segundos.`
        : `${c.name}: ${err.message}`,
      true,
    );
  } finally {
    state.pending.delete(c.id);
    renderContainers();
    refresh();
  }
}

function ask({ title, text, ok, danger }) {
  const dialog = $("confirm");
  const okButton = $("confirm-ok");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  okButton.textContent = ok;
  okButton.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  return new Promise((resolve) => {
    let confirmed = false;
    okButton.onclick = () => {
      confirmed = true;
      dialog.close();
    };
    $("confirm-cancel").onclick = () => dialog.close();
    dialog.onclose = () => resolve(confirmed);
    dialog.showModal();
    $("confirm-cancel").focus();
  });
}

// ---------- Logs ----------

const logs = { container: null, timer: null };

async function openLogs(c) {
  logs.container = c;
  $("logs-name").textContent = c.name;
  $("logs-text").textContent = "Cargando…";
  $("logs").showModal();
  await loadLogs(true);
  setFollow();
}

async function loadLogs(scrollToEnd = false) {
  const pre = $("logs-text");
  const atEnd = scrollToEnd || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  try {
    const res = await api(`/api/containers/${encodeURIComponent(logs.container.id)}/logs?tail=${$("logs-tail").value}`);
    const text = await res.text();
    // Fecha de Docker (UTC, con nanosegundos) → hora local corta.
    pre.textContent =
      text.replace(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) /gm, (match, iso) => {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? match : `${logTime.format(date)}  `;
      }) || "(sin logs)";
  } catch (err) {
    pre.textContent = `No se pudieron cargar los logs: ${err.message}`;
  }
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

function setFollow() {
  clearInterval(logs.timer);
  logs.timer = $("logs-follow").checked && $("logs").open ? setInterval(() => loadLogs(), LOGS_FOLLOW_MS) : null;
}

// ---------- Utilidades ----------

let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("toast-error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 8_000 : 4_000);
}

function bytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${num.format(n >= 100 || i === 0 ? Math.round(n) : n)} ${units[i]}`;
}

const rate = (n) => `${bytes(n)}/s`;
const pct = (n) => `${num.format(n >= 10 ? Math.round(n) : n)}%`;

function duration(seconds) {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d) return `${d} ${d === 1 ? "día" : "días"}, ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

const UNITS = {
  second: ["segundo", "segundos"], minute: ["minuto", "minutos"], hour: ["hora", "horas"],
  day: ["día", "días"], week: ["semana", "semanas"], month: ["mes", "meses"], year: ["año", "años"],
};

function since(text) {
  if (/^less than a second$/i.test(text)) return "menos de un segundo";
  const about = text.match(/^about an? (\w+)$/i);
  if (about && UNITS[about[1]]) return `cerca de 1 ${UNITS[about[1]][0]}`;
  const m = text.match(/^(\d+) (\w+?)s?$/);
  if (m && UNITS[m[2]]) return `${m[1]} ${UNITS[m[2]][m[1] === "1" ? 0 : 1]}`;
  return text;
}

// Docker entrega el estado en inglés ("Up 3 hours (healthy)", "Exited (0) 2 days ago").
function translateStatus(status) {
  let m = status.match(/^Up (.+?)(?: \(.*\))?$/);
  if (m) return `Encendido hace ${since(m[1])}`;
  m = status.match(/^Exited \((-?\d+)\) (.+) ago$/);
  if (m) return `Salió con código ${m[1]} hace ${since(m[2])}`;
  m = status.match(/^Restarting \((-?\d+)\) (.+) ago$/);
  if (m) return `Falló con código ${m[1]} hace ${since(m[2])}`;
  if (status === "Created") return "Nunca se ha iniciado";
  return status;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// ---------- Eventos ----------

$("rows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const c = state.containers.find((x) => x.id === button.closest("tr").dataset.id);
  if (!c) return;
  if (button.dataset.action === "logs") openLogs(c);
  else runAction(c, button.dataset.action);
});

for (const button of document.querySelectorAll("th button[data-sort]")) {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    state.sort =
      state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === "cpu" || key === "mem" ? -1 : 1 };
    renderContainers();
  });
}

$("filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderContainers();
});
$("project").addEventListener("change", (e) => {
  state.project = e.target.value;
  renderContainers();
});
$("state").addEventListener("change", (e) => {
  state.status = e.target.value;
  renderContainers();
});

$("logs-follow").addEventListener("change", setFollow);
$("logs-tail").addEventListener("change", () => loadLogs(true));
$("logs-refresh").addEventListener("click", () => loadLogs(true));
$("logs-close").addEventListener("click", () => $("logs").close());
$("logs").addEventListener("close", () => {
  clearInterval(logs.timer);
  logs.timer = null;
});

$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } finally {
    location.href = "/login";
  }
});

refresh();
startTimer();
