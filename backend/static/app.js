/* Arc Guard dashboard — plain JavaScript, no build step.
 * Live data arrives on /ws/dashboard; history, events and settings use the REST API.
 * Nothing here invents readings: every number shown comes from the backend.
 */
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const nf = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const cm = (v, d = 1) => (v === null || v === undefined ? "—" : `${nf(v, d)} cm`);
const pad = (n) => String(n).padStart(2, "0");
const hms = (ts) => { const t = new Date(ts * 1000); return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`; };
const ymd = (ts) => { const t = new Date(ts * 1000); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 2) return "just now";
  if (s < 60) return `${Math.floor(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return ymd(ts);
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const KIND_LABEL = {
  MOTION: "Movement (fast change)", TRANSIENT: "Brief movement", SHIFT: "Movement across scan",
  RADIAL: "Movement toward/away", OBJECT_APPEARED: "Object appeared", OBJECT_DISAPPEARED: "Object disappeared",
  SUDDEN_CHANGE: "Sudden change", PATTERN: "Unusual pattern", SENSOR_FAULT: "Sensor fault",
};
const SENSOR_NAME = { 1: "Sensor 1", 2: "Sensor 2", 3: "Sensor 3" };
const COLORS = { s1: "#fbbf24", s2: "#60a5fa", s3: "#34d399", move: "#60a5fa", anom: "#fb923c", base: "#64748b", bad: "#f87171" };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `${res.status} ${res.statusText}`);
  return body;
}

function toast(title, text, cls = "") {
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>`;
  $("#toasts").prepend(el);
  setTimeout(() => el.remove(), 6000);
  while ($("#toasts").children.length > 4) $("#toasts").lastChild.remove();
}

// ------------------------------------------------------------------ state
const S = {
  status: null, sensors: { 1: {}, 2: {}, 3: {} }, scanState: {}, scan: new Map(), baseline: null,
  settings: null, meta: null, schema: null, events: [], linkUp: false, tab: "dashboard", newEvents: 0,
  radarRange: 300, anWindow: 2, evOffset: 0, evTotal: 0, recentEventMarks: [], hist: { 1: [], 2: [] },
  layout: { s1_angle: 215, s2_angle: 325, s1_x: -10, s1_y: -8, s2_x: 10, s2_y: -8, s1_name: "Zone A", s2_name: "Zone B" },
  notices: [], rooms: [], activeRoom: null,
};

// ------------------------------------------------------------------ tabs
function showTab(name) {
  if (!$(`#tab-${name}`)) name = "dashboard";
  S.tab = name;
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "events") { S.newEvents = 0; renderBadge(); loadEvents(); }
  if (name === "analytics") loadAnalytics();
  if (name === "settings") loadSettings();
  if (name === "dashboard") requestAnimationFrame(resizeRadar);
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.goto)));
function renderBadge() {
  const b = $("#newBadge");
  b.hidden = S.newEvents === 0;
  b.textContent = S.newEvents;
}

// ------------------------------------------------------------------ websocket
let ws = null;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/dashboard`);
  ws.onopen = () => { S.linkUp = true; renderLink(); };
  ws.onclose = () => { S.linkUp = false; renderLink(); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    handle(msg);
  };
}

function handle(msg) {
  switch (msg.type) {
    case "snapshot":
      S.status = msg.status;
      msg.sensors.forEach((s) => (S.sensors[s.id] = s));
      S.scanState = msg.scan_state;
      S.scan = new Map(msg.scan.map((p) => [p.angle, p]));
      S.baseline = msg.baseline;
      applySettingsPayload(msg.settings);
      S.events = msg.events;
      if (msg.layout) { S.layout = msg.layout; fillLayoutForm(); }
      S.notices = msg.notices || [];
      S.activeRoom = msg.active_room ?? null;
      renderNotices();
      loadRooms();
      renderAll();
      break;
    case "frame":
      msg.sensors.forEach((s) => (S.sensors[s.id] = s));
      S.scanState = msg.scan_state;
      if (S.status) { S.status.device = msg.device; S.status.last_update = msg.ts; }
      msg.points.forEach((p) => S.scan.set(p.angle, p));
      pushLive(msg);
      pushHist(msg);
      renderSensors();
      renderKpis();
      if (S.tab === "analytics") updateAngleChart();
      break;
    case "status":
      S.status = msg.status;
      if (msg.sensors) msg.sensors.forEach((s) => (S.sensors[s.id] = s));
      renderKpis();
      renderSensors();
      break;
    case "event":
      onEvent(msg.event);
      if (msg.status) S.status = msg.status;
      renderKpis();
      break;
    case "event_ack":
      S.events.forEach((e) => { if (e.id === msg.id) e.status = "ACKNOWLEDGED"; });
      if (S.tab === "events") loadEvents();
      break;
    case "notices":
      S.notices = msg.notices;
      renderNotices();
      break;
    case "rooms":
      S.rooms = msg.rooms;
      S.activeRoom = msg.active;
      renderRooms();
      break;
    case "layout":
      S.layout = msg.layout;
      fillLayoutForm();
      renderSensors();
      break;
    case "baseline":
      S.baseline = msg.baseline;
      if (S.tab === "analytics") updateAngleChart();
      break;
    case "settings":
      applySettingsPayload(msg);
      break;
    case "ack":
      applySettingsPayload(msg.settings);
      cmdLog(`${msg.ok ? "✓" : "✗"} ESP32 acknowledged ${msg.command || "settings"}${msg.note && msg.note !== msg.command ? ` (${msg.note})` : ""}`);
      if (msg.command) toast("ESP32 confirmed", msg.command.replace("_", " "), msg.ok ? "" : "err");
      break;
  }
}

function renderLink() {
  const p = $("#pillLink");
  p.className = `pill ${S.linkUp ? "ok" : "bad"}`;
  p.textContent = S.linkUp ? "● backend" : "● backend lost";
}

// ------------------------------------------------------------------ KPIs
function renderKpis() {
  const st = S.status;
  if (!st) return;
  const dev = st.device;
  const sys = st.system;
  const sysCls = { MONITORING: "ok", CALIBRATING: "warn", DEGRADED: "warn", OFFLINE: "bad" }[sys] || "dim";
  $("#pillSystem").className = `pill ${sysCls}`;
  $("#pillSystem").textContent = sys;
  $("#simBanner").hidden = !dev.simulated;

  setK("#kSystem", sys, sysCls);
  $("#kSystemSub").textContent = dev.fw ? `fw ${dev.fw} · reset: ${dev.reset_reason || "?"}` : " ";
  $("#kSystemSub").className = dev.reset_reason === "BROWNOUT" ? "c-warn" : "";
  setK("#kDevice", dev.online ? "Online" : "Offline", dev.online ? "ok" : "bad");
  $("#kDeviceSub").textContent = dev.online ? `since ${dev.connected_at ? hms(dev.connected_at) : "—"}${dev.ip ? " · " + dev.ip : ""}` : `last seen ${ago(dev.last_seen)}`;
  const rssi = dev.rssi;
  const q = !dev.online || rssi === null || rssi === undefined || rssi === 0 ? null : rssi > -60 ? "Strong" : rssi > -72 ? "Good" : rssi > -82 ? "Weak" : "Poor";
  setK("#kWifi", dev.online ? (q || "Connected") : "Disconnected", !dev.online ? "bad" : q === "Weak" || q === "Poor" ? "warn" : "ok");
  $("#kWifiSub").textContent = dev.online && rssi ? `${rssi} dBm` : " ";
  $("#kActive").textContent = dev.online ? st.active_sensors : 0;
  const mon = !dev.online ? ["Stopped", "bad"] : dev.calibrating ? [`Calibrating ${dev.cal_progress ?? 0}%`, "warn"] : ["Active", "ok"];
  setK("#kMonitor", mon[0], mon[1]);
  $("#kMonitorSub").textContent = dev.online ? (S.scanState.scanning ? "scanning 0–180°" : "scan stopped") : " ";
  $("#kMove").textContent = st.events_movement;
  $("#kAnom").textContent = st.events_anomaly;
  $("#kLastAct").textContent = st.last_activity ? hms(st.last_activity) : "—";
  $("#kLastActSub").textContent = st.last_activity ? ago(st.last_activity) : "no events yet";
  $("#kLastUpd").textContent = st.last_update ? hms(st.last_update) : "—";
  $("#kLastUpdSub").textContent = st.last_update ? ago(st.last_update) : "no data yet";
}
function setK(sel, text, cls) {
  const el = $(sel);
  el.textContent = text;
  el.className = cls ? `c-${cls}` : "";
}

// ------------------------------------------------------------------ sensor panels
const STATUS_CLS = { OK: "ok", CALIBRATING: "warn", FAULT: "bad", DISABLED: "dim", OFFLINE: "bad", IDLE: "dim", "NO DATA": "dim" };
function thresholdFor(sigma) {
  if (!S.settings) return null;
  return Math.max(S.settings.tau_abs_cm, S.settings.k_sigma * (sigma || 0));
}
function detectChip(s) {
  if (s.status !== "OK") return `<span class="state-chip">—</span>`;
  if (s.state === "ACTIVE") return `<span class="state-chip alert">CHANGE DETECTED</span>`;
  if (s.state === "CANDIDATE") return `<span class="state-chip cand">Checking…</span>`;
  if (s.state === "COOLDOWN") return `<span class="state-chip">Cooldown</span>`;
  return `<span class="state-chip">No change</span>`;
}
function distText(s) {
  if (s.d === null || s.d === undefined) return s.status === "FAULT" ? "No response" : "—";
  if (s.oor) return `&gt;${nf(400, 0)}<small> cm (no echo)</small>`;
  return `${nf(s.d)}<small> cm</small>`;
}
function renderSensors() {
  for (const id of [1, 2]) {
    const s = S.sensors[id] || {};
    const tau = thresholdFor(s.sigma);
    const deltaCls = s.changed ? "c-bad" : "";
    const zone = S.layout[`s${id}_name`], dirDeg = S.layout[`s${id}_angle`];
    const where = `(${S.layout[`s${id}_x`] ?? 0}, ${S.layout[`s${id}_y`] ?? 0}) cm`;
    $(`#panel${id} .info`).innerHTML = `
      <div class="s-head"><h2>Sensor ${id}<small>Fixed · ${esc(zone)} · at ${where} · facing ${dirDeg}°</small></h2>
        <span class="pill ${STATUS_CLS[s.status] || "dim"}">${esc(s.status || "NO DATA")}</span></div>
      <div class="row"><div class="big">${distText(s)}</div>${detectChip(s)}</div>
      <dl>
        <div><dt>Previous</dt><dd>${cm(s.prev)}</dd></div>
        <div><dt>Baseline</dt><dd>${cm(s.b)}</dd></div>
        <div><dt>Deviation</dt><dd class="${deltaCls}">${s.delta === null || s.delta === undefined ? "—" : (s.delta > 0 ? "+" : "") + nf(s.delta) + " cm"}</dd></div>
        <div><dt>Noise level</dt><dd>${cm(s.sigma)}</dd></div>
        <div><dt>Threshold</dt><dd>${tau === null ? "—" : "±" + nf(tau, 0) + " cm"}</dd></div>
        <div><dt>Updated</dt><dd>${s.ts ? ago(s.ts) : "—"}</dd></div>
      </dl>`;
  }
  const s = S.sensors[3] || {};
  const st = S.scanState || {};
  const changedAngles = [...S.scan.values()].filter((p) => p.changed && p.valid).map((p) => p.angle).sort((a, b) => a - b);
  const scanTxt = s.status === "CALIBRATING" ? `Calibrating ${S.status?.device?.cal_progress ?? 0}%` : st.scanning ? `Scanning ${st.dir >= 0 ? "→" : "←"}` : "Stopped";
  const detTxt = s.status !== "OK" ? "—" : changedAngles.length ? `${changedAngles.length} angle(s) changed: ${changedAngles.slice(0, 6).join("°, ")}°${changedAngles.length > 6 ? "…" : ""}` : "No change";
  $("#panel3").innerHTML = `
    <div class="s-head"><h2>Sensor 3<small>Servo-scanned · ${S.settings ? `${S.settings.scan_min}–${S.settings.scan_max}°, step ${S.settings.scan_step}°` : "—"}</small></h2>
      <span class="pill ${STATUS_CLS[s.status] || "dim"}">${esc(s.status || "NO DATA")}</span></div>
    <div class="row"><div class="big">${distText(s)}</div><div class="big">${st.angle ?? "—"}<small>°</small></div></div>
    <dl>
      <div><dt>Scanning</dt><dd>${scanTxt}</dd></div>
      <div><dt>Sweep #</dt><dd>${st.sweep ?? "—"}</dd></div>
      <div><dt>Last full scan</dt><dd>${st.last_sweep_ts ? ago(st.last_sweep_ts) : "—"}</dd></div>
      <div style="grid-column:1/-1"><dt>Detection</dt><dd class="${changedAngles.length ? "c-bad" : ""}">${detTxt}</dd></div>
    </dl>
    <div class="bar" title="Sweep progress"><i style="width:${st.progress ?? 0}%"></i></div>`;
}

// recent readings of the fixed sensors, for the trails on the map and the beam views
const HIST_S = 10;
function pushHist(frame) {
  for (const id of [1, 2]) {
    const s = frame.sensors.find((x) => x.id === id);
    if (!s) continue;
    const h = S.hist[id];
    h.push({ t: frame.ts, d: s.d, oor: s.oor, changed: !!s.changed });
    while (h.length && h[0].t < frame.ts - HIST_S) h.shift();
  }
}

// ------------------------------------------------------------------ room map (top view)
const radar = $("#radar");
const rctx = radar.getContext("2d");
function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  if (!r.width) return false;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  return true;
}
function resizeRadar() { fitCanvas(radar); }
window.addEventListener("resize", resizeRadar);
$$("#radarRange button").forEach((b) => b.addEventListener("click", () => {
  S.radarRange = Number(b.dataset.r);
  $$("#radarRange button").forEach((x) => x.classList.toggle("active", x === b));
}));
const FIXED_COLOR = { 1: [251, 191, 36], 2: [96, 165, 250] };
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const HALF_BEAM = (7.5 * Math.PI) / 180;

// canvas point of a fixed sensor and of a distance along its beam (sensors can sit anywhere in the room)
function fixedGeo(id, geo) {
  const L = S.layout, t = (L[`s${id}_angle`] * Math.PI) / 180;
  const sx = geo.cx + ((L[`s${id}_x`] ?? 0) / geo.rmax) * geo.R, sy = geo.cy - ((L[`s${id}_y`] ?? 0) / geo.rmax) * geo.R;
  return { sx, sy, t, at: (d) => [sx + geo.rad(d) * Math.cos(t), sy - geo.rad(d) * Math.sin(t)] };
}

function drawFixedBeam(ctx, id, geo) {
  const { R, rmax, rad } = geo;
  const s = S.sensors[id] || {};
  if (!s.status || s.status === "DISABLED") return;
  const { sx, sy, t, at } = fixedGeo(id, geo), col = FIXED_COLOR[id];
  const now = Date.now() / 1000;
  const fault = s.status === "FAULT" || s.status === "OFFLINE";
  // beam cone from the sensor's own position
  ctx.fillStyle = rgba(col, fault ? 0.03 : 0.07);
  ctx.strokeStyle = fault ? "rgba(248,113,113,0.7)" : rgba(col, 0.45);
  ctx.setLineDash(fault ? [6, 5] : []);
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, R, -t - HALF_BEAM, -t + HALF_BEAM); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.setLineDash([]);
  // baseline and the ±threshold band around it (changes inside the band are treated as noise)
  if (s.b !== null && s.b !== undefined && !fault) {
    const tau = thresholdFor(s.sigma) ?? 0;
    const r0 = rad(Math.max(0, s.b - tau)), r1 = rad(s.b + tau);
    ctx.fillStyle = "rgba(148,163,184,0.20)";
    ctx.beginPath(); ctx.arc(sx, sy, r1, -t - HALF_BEAM, -t + HALF_BEAM); ctx.arc(sx, sy, r0, -t + HALF_BEAM, -t - HALF_BEAM, true); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#94a3b8"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, rad(s.b), -t - HALF_BEAM, -t + HALF_BEAM); ctx.stroke(); ctx.setLineDash([]);
  }
  // trail of the last few seconds of echoes
  for (const hpt of S.hist[id]) {
    if (hpt.d === null || hpt.d === undefined || hpt.oor) continue;
    const a = Math.max(0.08, 0.55 * (1 - (now - hpt.t) / HIST_S));
    const [x, y] = at(hpt.d);
    ctx.fillStyle = hpt.changed ? `rgba(248,113,113,${a})` : rgba(col, a);
    ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill();
  }
  // current echo: an arc across the beam at the measured distance
  let label2;
  if (fault) {
    label2 = "NO RESPONSE";
  } else if (s.d === null || s.d === undefined) {
    label2 = "—";
  } else if (s.oor) {
    ctx.strokeStyle = "rgba(100,116,139,0.9)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, R, -t - HALF_BEAM, -t + HALF_BEAM); ctx.stroke();
    label2 = "no echo (> 400 cm)";
  } else {
    ctx.strokeStyle = s.changed ? "#f87171" : rgba(col, 1);
    ctx.lineWidth = 4;
    if (s.changed) { ctx.shadowColor = "#f87171"; ctx.shadowBlur = 12; }
    ctx.beginPath(); ctx.arc(sx, sy, rad(s.d), -t - HALF_BEAM * 1.1, -t + HALF_BEAM * 1.1); ctx.stroke();
    ctx.shadowBlur = 0;
    label2 = `${nf(s.d)} cm${s.b !== null && s.b !== undefined ? ` · base ${nf(s.b, 0)}` : ""}`;
  }
  // the sensor itself
  ctx.fillStyle = rgba(col, 1); ctx.strokeStyle = "#0b1017"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#0b1017"; ctx.font = "bold 9px Segoe UI, Arial"; ctx.textAlign = "center"; ctx.fillText(`${id}`, sx, sy + 3);
  // label just beyond the visible end of the beam, kept on the canvas
  const [lx0, ly0] = at(rmax * 0.9);
  const lx = Math.min(geo.w - 70, Math.max(70, lx0)), ly = Math.min(geo.h - 26, Math.max(18, ly0 + (Math.sin(t) < 0 ? 16 : -18)));
  ctx.textAlign = "center";
  ctx.font = "bold 12px Segoe UI, Arial";
  ctx.fillStyle = fault ? "#f87171" : s.changed ? "#f87171" : rgba(col, 1);
  ctx.fillText(`S${id} · ${S.layout[`s${id}_name`]}${s.state === "ACTIVE" ? " · CHANGE" : ""}`, lx, ly);
  ctx.font = "11px Segoe UI, Arial";
  ctx.fillStyle = "#aab6c6";
  ctx.fillText(label2, lx, ly + 14);
}

function drawRadar() {
  requestAnimationFrame(drawRadar);
  if (S.tab !== "dashboard" || !fitCanvas(radar)) return;
  drawGauge(1);
  drawGauge(2);
  const dpr = window.devicePixelRatio || 1;
  const ctx = rctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, radar.width, radar.height);
  ctx.scale(dpr, dpr);
  const w = radar.width / dpr, h = radar.height / dpr;
  const cx = w / 2, cy = h * 0.53, R = Math.min(w / 2 - 40, h * 0.47 - 36);
  const rmax = S.radarRange;
  const rad = (d) => (Math.min(d, rmax) / rmax) * R;
  const pos = (a, d) => { const r = rad(d), t = (a * Math.PI) / 180; return [cx + r * Math.cos(t), cy - r * Math.sin(t)]; };
  const geo = { cx, cy, R, rmax, pos, rad, w, h };

  // front (scan) and rear halves
  ctx.fillStyle = "rgba(63,182,255,0.025)";
  ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI, 2 * Math.PI); ctx.closePath(); ctx.fill();
  ctx.font = "bold 11px Segoe UI, Arial"; ctx.textAlign = "left"; ctx.fillStyle = "#4b5d74";
  ctx.fillText("FRONT — Sensor 3 scan", 10, 18);
  ctx.fillText("REAR — fixed sensors", 10, h - 10);
  ctx.strokeStyle = "#22344a"; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(cx - R - 10, cy); ctx.lineTo(cx + R + 10, cy); ctx.stroke(); ctx.setLineDash([]);
  // grid
  ctx.lineWidth = 1;
  ctx.font = "11px Segoe UI, Arial";
  // narrow screens (phones): label fewer rings and keep rear angle labels clear of the sensor labels
  const narrow = w < 560;
  const ringStep = (R / 4) < ctx.measureText("300 cm").width + 8 ? 2 : 1;
  for (let i = 1; i <= 4; i++) {
    ctx.strokeStyle = i === 4 ? "#2b4a66" : "#1c2b3d";
    ctx.beginPath(); ctx.arc(cx, cy, (R * i) / 4, 0, 2 * Math.PI); ctx.stroke();
    if (i % ringStep) continue;
    ctx.fillStyle = "#5b6b80"; ctx.textAlign = "left";
    ctx.fillText(`${Math.round((rmax * i) / 4)} cm`, cx + (R * i) / 4 + 3, cy + 13);
  }
  const sensorDirs = [1, 2].map((id) => S.layout?.[`s${id}_angle`]).filter((v) => typeof v === "number");
  const angDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  for (let a = 0; a < 360; a += 30) {
    const [x, y] = pos(a, rmax);
    ctx.strokeStyle = "#1a283a"; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    if (narrow && a > 180 && sensorDirs.some((d) => angDist(a, d) <= 35)) continue;
    const [lx, ly] = pos(a, rmax * 1.075);
    ctx.fillStyle = a <= 180 ? "#7b8ba0" : "#56677d"; ctx.textAlign = "center"; ctx.fillText(`${a}°`, lx, ly + 4);
  }
  // active scan range
  if (S.settings) {
    ctx.fillStyle = "rgba(63,182,255,0.04)";
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, -S.settings.scan_max * Math.PI / 180, -S.settings.scan_min * Math.PI / 180);
    ctx.closePath(); ctx.fill();
  }

  // fixed sensors (drawn first so the scan sits on top)
  drawFixedBeam(ctx, 1, geo);
  drawFixedBeam(ctx, 2, geo);

  // scan baseline contour
  const base = [];
  if (S.baseline?.scan?.b) {
    const { min, step, b } = S.baseline.scan;
    b.forEach((d, i) => { if (d !== null) base.push([min + i * step, d]); });
  }
  if (base.length > 1) {
    ctx.strokeStyle = "#64748b"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); base.forEach(([a, d], i) => { const [x, y] = pos(a, d); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.setLineDash([]);
  }

  // scanning beam (≈15° cone) at the current servo angle
  const st = S.scanState || {};
  if (st.scanning && st.angle !== null && st.angle !== undefined) {
    const a = st.angle * Math.PI / 180;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, "rgba(63,182,255,0.35)"); g.addColorStop(1, "rgba(63,182,255,0.03)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, -a - HALF_BEAM, -a + HALF_BEAM); ctx.closePath(); ctx.fill();
    const [x, y] = pos(st.angle, rmax);
    ctx.strokeStyle = "#3fb6ff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
  }

  // latest sweep
  const now = Date.now() / 1000;
  const pts = [...S.scan.values()].filter((p) => now - p.ts < 120).sort((a, b) => a.angle - b.angle);
  ctx.lineWidth = 2; ctx.strokeStyle = "rgba(52,211,153,0.85)";
  ctx.beginPath();
  let pen = false;
  for (const p of pts) {
    if (!p.valid || p.d === null) { pen = false; continue; }
    const [x, y] = pos(p.angle, p.d);
    pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
  for (const p of pts) {
    const age = now - p.ts, alpha = Math.max(0.3, 1 - age / 20);
    if (!p.valid) continue;
    if (p.oor || p.d === null) {
      const [x, y] = pos(p.angle, rmax);
      ctx.fillStyle = `rgba(71,85,105,${alpha})`; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
      continue;
    }
    const [x, y] = pos(p.angle, p.d);
    if (p.changed) {
      ctx.fillStyle = `rgba(248,113,113,${alpha})`; ctx.shadowColor = "#f87171"; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = `rgba(52,211,153,${alpha})`; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
    }
  }
  // recent events pulse (all sensors)
  S.recentEventMarks = S.recentEventMarks.filter((m) => now - m.ts < 8);
  for (const m of S.recentEventMarks) {
    const k = (now - m.ts) / 8;
    const [x, y] = m.fixed ? fixedGeo(m.fixed, geo).at(m.d ?? rmax * 0.5) : pos(m.angle, m.d ?? rmax * 0.5);
    ctx.strokeStyle = m.category === "MOVEMENT" ? `rgba(96,165,250,${1 - k})` : `rgba(251,146,60,${1 - k})`;
    ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 8 + 22 * k, 0, 7); ctx.stroke();
  }
  // device
  ctx.fillStyle = "#0e1520"; ctx.strokeStyle = "#3fb6ff"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(cx - 9, cy - 6, 18, 12); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#3fb6ff"; ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, 7); ctx.fill();
  if (!S.status?.device?.online) {
    ctx.fillStyle = "#8898ad"; ctx.textAlign = "center"; ctx.font = "14px Segoe UI, Arial";
    ctx.fillText("ESP32 offline — showing last received data", cx, cy - R * 0.45);
  }
}

// ------------------------------------------------------------------ beam view (side view of one fixed sensor)
function drawGauge(id) {
  const c = $(`#gauge${id}`);
  if (!c || !fitCanvas(c)) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = c.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.scale(dpr, dpr);
  const w = c.width / dpr;
  const s = S.sensors[id] || {}, col = FIXED_COLOR[id];
  const x0 = 26, x1 = w - 12, mid = 30;
  const span = Math.min(400, Math.max(150, Math.ceil(((s.b ?? 200) * 1.35) / 50) * 50));
  const X = (d) => x0 + (Math.min(d, span) / span) * (x1 - x0);
  const now = Date.now() / 1000;
  // scale
  ctx.font = "10px Segoe UI, Arial"; ctx.fillStyle = "#5b6b80"; ctx.textAlign = "center";
  ctx.strokeStyle = "#22344a"; ctx.lineWidth = 1;
  for (let d = 0; d <= span; d += span > 250 ? 100 : 50) {
    ctx.beginPath(); ctx.moveTo(X(d), mid + 22); ctx.lineTo(X(d), mid + 26); ctx.stroke();
    ctx.fillText(d === 0 ? "0 cm" : `${d}`, X(d), mid + 37);
  }
  // sensor + beam
  ctx.fillStyle = rgba(col, 1); ctx.fillRect(4, mid - 8, 10, 16);
  ctx.fillStyle = rgba(col, 0.09);
  ctx.beginPath(); ctx.moveTo(14, mid - 4); ctx.lineTo(x1, mid - 20); ctx.lineTo(x1, mid + 20); ctx.lineTo(14, mid + 4); ctx.closePath(); ctx.fill();
  if (s.status === "FAULT" || s.status === "OFFLINE" || s.status === "DISABLED") {
    ctx.fillStyle = s.status === "DISABLED" ? "#8898ad" : "#f87171"; ctx.font = "bold 12px Segoe UI, Arial"; ctx.textAlign = "center";
    ctx.fillText(s.status === "DISABLED" ? "Sensor disabled" : "No echo response — check wiring", (x0 + x1) / 2, mid + 4);
    return;
  }
  // baseline ± threshold band
  if (s.b !== null && s.b !== undefined) {
    const tau = thresholdFor(s.sigma) ?? 0;
    ctx.fillStyle = "rgba(148,163,184,0.22)";
    ctx.fillRect(X(Math.max(0, s.b - tau)), mid - 18, X(s.b + tau) - X(Math.max(0, s.b - tau)), 36);
    ctx.strokeStyle = "#94a3b8"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(s.b), mid - 20); ctx.lineTo(X(s.b), mid + 20); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#94a3b8"; ctx.textAlign = "center"; ctx.font = "10px Segoe UI, Arial";
    ctx.fillText("baseline", X(s.b), mid - 22);
  }
  // recent echoes
  for (const hp of S.hist[id]) {
    if (hp.d === null || hp.d === undefined || hp.oor) continue;
    const a = Math.max(0.1, 0.6 * (1 - (now - hp.t) / HIST_S));
    ctx.fillStyle = hp.changed ? `rgba(248,113,113,${a})` : rgba(col, a);
    ctx.fillRect(X(hp.d) - 1, mid - 10, 2, 20);
  }
  // current echo
  if (s.d !== null && s.d !== undefined) {
    if (s.oor) {
      ctx.fillStyle = "#64748b"; ctx.textAlign = "right"; ctx.font = "bold 11px Segoe UI, Arial";
      ctx.fillText("no echo →", x1, mid + 4);
    } else {
      ctx.fillStyle = s.changed ? "#f87171" : rgba(col, 1);
      if (s.changed) { ctx.shadowColor = "#f87171"; ctx.shadowBlur = 10; }
      ctx.fillRect(X(s.d) - 2.5, mid - 16, 5, 32);
      ctx.shadowBlur = 0;
    }
  }
}

// ------------------------------------------------------------------ charts
Chart.defaults.color = "#8898ad";
Chart.defaults.borderColor = "#1c2b3d";
Chart.defaults.font.family = "Segoe UI, Arial, sans-serif";
const timeTicks = { callback: (v) => hms(v), maxTicksLimit: 6, maxRotation: 0 };
function lineChart(el, datasets, { yTitle = "cm", xType = "time", yMin } = {}) {
  return new Chart(el, {
    type: "line",
    data: { datasets },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 12 } },
        tooltip: { callbacks: { title: (it) => (xType === "time" ? hms(it[0].parsed.x) : `${it[0].parsed.x}°`) } } },
      scales: {
        x: xType === "time" ? { type: "linear", ticks: timeTicks } : { type: "linear", min: 0, max: 180, ticks: { stepSize: 30, callback: (v) => `${v}°` } },
        y: { title: { display: true, text: yTitle }, min: yMin },
      },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.6, tension: 0.15 } },
    },
  });
}
const ds = (label, color, extra = {}) => ({ label, data: [], borderColor: color, backgroundColor: color, spanGaps: false, ...extra });

const live = {
  c1: lineChart($("#cLive1"), [ds("distance", COLORS.s1), ds("baseline", COLORS.base, { borderDash: [5, 4], borderWidth: 1 })], { yMin: 0 }),
  c2: lineChart($("#cLive2"), [ds("distance", COLORS.s2), ds("baseline", COLORS.base, { borderDash: [5, 4], borderWidth: 1 })], { yMin: 0 }),
  c3: lineChart($("#cLive3"), [ds("distance", COLORS.s3, { showLine: false, pointRadius: 1.8 })], { yMin: 0 }),
};
const LIVE_SPAN = 120; // seconds

function pushLive(frame) {
  const t = frame.ts;
  for (const id of [1, 2]) {
    const s = frame.sensors.find((x) => x.id === id);
    if (!s) continue;
    const c = live[`c${id}`];
    c.data.datasets[0].data.push({ x: t, y: s.d ?? null });
    c.data.datasets[1].data.push({ x: t, y: s.b ?? null });
  }
  for (const p of frame.points) live.c3.data.datasets[0].data.push({ x: p.ts, y: p.valid ? p.d : null });
  for (const c of Object.values(live)) {
    c.data.datasets.forEach((d) => { while (d.data.length && d.data[0].x < t - LIVE_SPAN) d.data.shift(); });
    if (S.tab === "dashboard") c.update("none");
  }
  if (S.tab === "analytics" && S.anWindow <= 10) appendAnalytics(frame);
}

async function seedLive() {
  try {
    const [r1, r2, r3] = await Promise.all([1, 2, 3].map((id) => api(`/api/readings?sensor=${id}&minutes=2`)));
    live.c1.data.datasets[0].data = r1.readings.map((r) => ({ x: r.ts, y: r.distance_cm }));
    live.c1.data.datasets[1].data = r1.readings.map((r) => ({ x: r.ts, y: r.baseline_cm }));
    live.c2.data.datasets[0].data = r2.readings.map((r) => ({ x: r.ts, y: r.distance_cm }));
    live.c2.data.datasets[1].data = r2.readings.map((r) => ({ x: r.ts, y: r.baseline_cm }));
    live.c3.data.datasets[0].data = r3.readings.map((r) => ({ x: r.ts, y: r.distance_cm }));
    Object.values(live).forEach((c) => c.update("none"));
  } catch (e) { console.warn(e); }
}

// ---- analytics
const an = {
  a1: lineChart($("#cA1"), [ds("distance", COLORS.s1), ds("baseline", COLORS.base, { borderDash: [5, 4], borderWidth: 1 })], { yMin: 0 }),
  a2: lineChart($("#cA2"), [ds("distance", COLORS.s2), ds("baseline", COLORS.base, { borderDash: [5, 4], borderWidth: 1 })], { yMin: 0 }),
  a3: lineChart($("#cA3"), [ds("distance", COLORS.s3, { showLine: false, pointRadius: 1.5 })], { yMin: 0 }),
  dev: lineChart($("#cDev"), [ds("Sensor 1 Δ", COLORS.s1), ds("Sensor 2 Δ", COLORS.s2), ds("Sensor 3 Δ", COLORS.s3, { showLine: false, pointRadius: 1.5 })], { yTitle: "Δ cm" }),
  angle: lineChart($("#cAngle"), [
    ds("baseline", COLORS.base, { borderDash: [5, 4] }),
    ds("latest sweep", COLORS.s3, { pointRadius: 2 }),
    ds("changed", COLORS.bad, { showLine: false, pointRadius: 5 }),
  ], { xType: "angle", yMin: 0 }),
};
function barChart(el, color) {
  return new Chart(el, {
    type: "bar",
    data: { datasets: [{ data: [], backgroundColor: color, borderRadius: 3 }] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, parsing: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => hms(it[0].parsed.x) } } },
      scales: { x: { type: "linear", ticks: timeTicks, offset: false }, y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "events" } } } },
  });
}
an.move = barChart($("#cMoveHist"), COLORS.move);
an.anom = barChart($("#cAnomHist"), COLORS.anom);

function downsample(points, max = 1500) {
  if (points.length <= max) return points;
  const k = Math.ceil(points.length / max), out = [];
  for (let i = 0; i < points.length; i += k) out.push(points[i]);
  return out;
}

$$("#anWindow button").forEach((b) => b.addEventListener("click", () => {
  S.anWindow = Number(b.dataset.m);
  $$("#anWindow button").forEach((x) => x.classList.toggle("active", x === b));
  loadAnalytics();
}));

async function loadAnalytics() {
  const m = S.anWindow;
  const bucket = m <= 60 ? 60 : 600;
  try {
    const [r1, r2, r3, hist] = await Promise.all([
      ...[1, 2, 3].map((id) => api(`/api/readings?sensor=${id}&minutes=${m}&limit=20000`)),
      api(`/api/events/histogram?minutes=${m}&bucket_s=${bucket}`),
    ]);
    const map = (rows, f) => downsample(rows.map((r) => ({ x: r.ts, y: f(r) })));
    an.a1.data.datasets[0].data = map(r1.readings, (r) => r.distance_cm);
    an.a1.data.datasets[1].data = map(r1.readings, (r) => r.baseline_cm);
    an.a2.data.datasets[0].data = map(r2.readings, (r) => r.distance_cm);
    an.a2.data.datasets[1].data = map(r2.readings, (r) => r.baseline_cm);
    an.a3.data.datasets[0].data = map(r3.readings, (r) => r.distance_cm);
    an.dev.data.datasets[0].data = map(r1.readings, (r) => r.delta_cm);
    an.dev.data.datasets[1].data = map(r2.readings, (r) => r.delta_cm);
    an.dev.data.datasets[2].data = map(r3.readings, (r) => r.delta_cm);
    const now = Date.now() / 1000;
    for (const [chart, cat] of [[an.move, "MOVEMENT"], [an.anom, "ANOMALY"]]) {
      chart.data.datasets[0].data = hist.buckets.filter((b) => b.category === cat).map((b) => ({ x: b.b + bucket / 2, y: b.n }));
      chart.data.datasets[0].barThickness = Math.max(3, Math.min(24, 600 / (m * 60 / bucket)));
      chart.options.scales.x.min = now - m * 60;
      chart.options.scales.x.max = now;
      chart.options.plugins.tooltip.callbacks.title = (it) => `${hms(it[0].parsed.x - bucket / 2)} – ${hms(it[0].parsed.x + bucket / 2)}`;
      chart.update("none");
    }
    $("#anInfo").textContent = `${r1.readings.length + r2.readings.length + r3.readings.length} stored readings in window · fixed sensors stored at 1 Hz`;
    [an.a1, an.a2, an.a3, an.dev].forEach((c) => c.update("none"));
    updateAngleChart();
  } catch (e) { toast("Could not load analytics", e.message, "err"); }
}

function appendAnalytics(frame) {
  const t = frame.ts, span = S.anWindow * 60;
  for (const id of [1, 2]) {
    const s = frame.sensors.find((x) => x.id === id);
    if (!s) continue;
    const c = an[`a${id}`];
    c.data.datasets[0].data.push({ x: t, y: s.d ?? null });
    c.data.datasets[1].data.push({ x: t, y: s.b ?? null });
    an.dev.data.datasets[id - 1].data.push({ x: t, y: s.delta ?? null });
  }
  for (const p of frame.points) {
    an.a3.data.datasets[0].data.push({ x: p.ts, y: p.valid ? p.d : null });
    an.dev.data.datasets[2].data.push({ x: p.ts, y: p.d !== null && p.b !== null ? p.d - p.b : null });
  }
  for (const c of [an.a1, an.a2, an.a3, an.dev]) {
    c.data.datasets.forEach((d) => { while (d.data.length && d.data[0].x < t - span) d.data.shift(); });
    c.update("none");
  }
}

function updateAngleChart() {
  const base = [];
  if (S.baseline?.scan?.b) {
    const { min, step, b } = S.baseline.scan;
    b.forEach((d, i) => base.push({ x: min + i * step, y: d }));
  }
  const pts = [...S.scan.values()].sort((a, b) => a.angle - b.angle);
  an.angle.data.datasets[0].data = base;
  an.angle.data.datasets[1].data = pts.map((p) => ({ x: p.angle, y: p.valid && !p.oor ? p.d : null }));
  an.angle.data.datasets[2].data = pts.filter((p) => p.changed && p.valid && p.d !== null).map((p) => ({ x: p.angle, y: p.d }));
  an.angle.update("none");
}

// ------------------------------------------------------------------ events
function eventRow(e, full) {
  const dt = `${full ? `<td>${e.id}</td><td>${ymd(e.ts)}</td>` : ""}<td>${hms(e.ts)}</td>`;
  const delta = e.delta_cm === null || e.delta_cm === undefined ? "—" : (e.delta_cm > 0 ? "+" : "") + nf(e.delta_cm);
  const sim = e.source === "simulated" ? `<span class="sim-tag">SIM</span>` : "";
  let tail = "";
  if (full) {
    tail = `<td>${e.status === "NEW" ? "New" : "Acknowledged"}</td><td>${e.status === "NEW" ? `<button class="btn small" data-ack="${e.id}">Acknowledge</button>` : ""}</td>`;
  }
  return `${dt}<td>${SENSOR_NAME[e.sensor_id] || e.sensor_id}${sim}</td><td><span class="cat ${e.category}">${e.category}</span></td>
    <td>${esc(KIND_LABEL[e.kind] || e.kind)}</td><td>${cm(e.distance_cm)}</td><td>${cm(e.baseline_cm)}</td><td>${delta}</td>
    <td>${e.angle_deg === null || e.angle_deg === undefined ? "—" : e.angle_deg + "°"}</td>${tail}`;
}
function renderRecent() {
  const body = $("#recentBody");
  body.innerHTML = S.events.slice(0, 10).map((e) => `<tr>${eventRow(e, false)}</tr>`).join("") ||
    `<tr><td colspan="8" class="muted">No events recorded yet.</td></tr>`;
}
function onEvent(e) {
  S.events.unshift(e);
  S.events = S.events.slice(0, 50);
  renderRecent();
  $("#recentBody tr")?.classList.add("fresh");
  if (e.sensor_id === 3 && e.angle_deg !== null && e.angle_deg !== undefined)
    S.recentEventMarks.push({ angle: e.angle_deg, d: e.distance_cm, ts: Date.now() / 1000, category: e.category });
  else if (e.sensor_id === 1 || e.sensor_id === 2)
    S.recentEventMarks.push({ fixed: e.sensor_id, d: e.distance_cm, ts: Date.now() / 1000, category: e.category });
  const where = e.angle_deg !== null && e.angle_deg !== undefined ? ` at ${e.angle_deg}°` : "";
  toast(`${e.category === "MOVEMENT" ? "Possible movement" : "Anomaly"} · ${SENSOR_NAME[e.sensor_id]}`,
    `${KIND_LABEL[e.kind] || e.kind}${where}${e.distance_cm !== null && e.distance_cm !== undefined ? ` · ${nf(e.distance_cm)} cm` : ""}`, e.category);
  if (S.tab !== "events") { S.newEvents++; renderBadge(); } else if (S.evOffset === 0) loadEvents();
  // Android app: native notification + vibration (no-op in a normal browser)
  try { window.ArcGuardNative?.onEvent(JSON.stringify(e)); } catch { /* bridge unavailable */ }
}

const PAGE = 50;
function evQuery() {
  const p = new URLSearchParams();
  new FormData($("#evFilters")).forEach((v, k) => { if (v) p.set(k, v); });
  return p;
}
async function loadEvents() {
  const q = evQuery();
  $("#evCsv").href = `/api/events.csv?${q}`;
  q.set("limit", PAGE);
  q.set("offset", S.evOffset);
  try {
    const r = await api(`/api/events?${q}`);
    S.evTotal = r.total;
    $("#evBody").innerHTML = r.events.map((e) => `<tr>${eventRow(e, true)}</tr>`).join("") ||
      `<tr><td colspan="12" class="muted">No events match these filters.</td></tr>`;
    const from = r.total ? S.evOffset + 1 : 0, to = Math.min(S.evOffset + PAGE, r.total);
    $("#evPage").textContent = `${from}–${to} of ${r.total}`;
    $("#evPrev").disabled = S.evOffset === 0;
    $("#evNext").disabled = S.evOffset + PAGE >= r.total;
  } catch (e) { toast("Could not load events", e.message, "err"); }
}
$("#evFilters").addEventListener("change", () => { S.evOffset = 0; loadEvents(); });
$("#evReset").addEventListener("click", () => { $("#evFilters").reset(); S.evOffset = 0; loadEvents(); });
$("#evPrev").addEventListener("click", () => { S.evOffset = Math.max(0, S.evOffset - PAGE); loadEvents(); });
$("#evNext").addEventListener("click", () => { S.evOffset += PAGE; loadEvents(); });
$("#evBody").addEventListener("click", async (ev) => {
  const id = ev.target.dataset.ack;
  if (!id) return;
  try { await api(`/api/events/${id}/ack`, { method: "POST" }); loadEvents(); } catch (e) { toast("Acknowledge failed", e.message, "err"); }
});

// ------------------------------------------------------------------ settings
const form = $("#setForm");
const PRESETS = { low: { tau_abs_cm: 30, k_sigma: 6, confirm_count: 4 }, medium: { tau_abs_cm: 15, k_sigma: 4, confirm_count: 3 }, high: { tau_abs_cm: 8, k_sigma: 3, confirm_count: 2 } };

function applySettingsPayload(p) {
  if (!p || !p.settings) return;
  const firstLoad = !S.settings;
  S.settings = p.settings;
  S.meta = p.meta;
  renderSetState();
  if (firstLoad || !formDirty()) fillForm(S.settings);
  renderSensors();
}
async function loadSettings() {
  try {
    const r = await api("/api/settings");
    S.schema = r.schema;
    for (const [k, sc] of Object.entries(r.schema)) {
      const el = form.elements[k];
      if (el && el.type === "number") { if (sc.min !== null) el.min = sc.min; if (sc.max !== null) el.max = sc.max; }
    }
    applySettingsPayload(r);
    if (!formDirty()) fillForm(S.settings);
  } catch (e) { toast("Could not load settings", e.message, "err"); }
}
function fillForm(s) {
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  }
  markDirty();
}
function formValues() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === "checkbox" ? el.checked : el.value === "" ? null : Number(el.value);
  }
  return out;
}
function changedValues() {
  if (!S.settings) return {};
  const v = formValues(), out = {};
  for (const [k, x] of Object.entries(v)) if (x !== null && x !== S.settings[k]) out[k] = x;
  return out;
}
function formDirty() { return Object.keys(changedValues()).length > 0; }
function markDirty() {
  const ch = changedValues();
  for (const el of form.elements) {
    if (!el.name) continue;
    el.closest(".num, .sw-row")?.classList.toggle("dirty", el.name in ch);
  }
  const n = Object.keys(ch).length;
  $("#saveBtn").disabled = n === 0;
  $("#saveMsg").textContent = n ? `${n} unsaved change(s)` : "No unsaved changes.";
  const v = formValues();
  if (v.scan_step > 0 && v.scan_max > v.scan_min) {
    const cells = Math.floor((v.scan_max - v.scan_min) / v.scan_step) + 1;
    const perStep = Math.max(v.scan_step * 2 + v.settle_ms, 55) + 27;
    $("#sweepEstimate").textContent = `≈ ${cells} points per sweep, ≈ ${(cells * perStep / 1000).toFixed(1)} s per sweep (estimate).`;
  }
  const p = Object.entries(PRESETS).find(([, pv]) => Object.entries(pv).every(([k, x]) => v[k] === x));
  $$("#preset button").forEach((b) => b.classList.toggle("active", p && b.dataset.p === p[0]));
}
form.addEventListener("input", markDirty);
$$("#preset button").forEach((b) => b.addEventListener("click", () => {
  for (const [k, v] of Object.entries(PRESETS[b.dataset.p])) form.elements[k].value = v;
  markDirty();
}));
$("#revertBtn").addEventListener("click", () => fillForm(S.settings));
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const ch = changedValues();
  if (!Object.keys(ch).length) return;
  $("#saveBtn").disabled = true;
  try {
    const r = await api("/api/settings", { method: "PUT", body: JSON.stringify(ch) });
    S.settings = r.settings; S.meta = r.meta;
    fillForm(S.settings);
    renderSetState();
    $("#saveMsg").textContent = r.sent ? "Sent — waiting for the ESP32 to confirm…" : "Saved. ESP32 is offline; it will receive the settings when it reconnects.";
  } catch (e) {
    toast("Settings rejected", e.message, "err");
    $("#saveMsg").textContent = e.message;
    markDirty();
  }
});
function renderSetState() {
  const m = S.meta || {};
  const online = S.status?.device?.online;
  const el = $("#setState"), sub = $("#setStateSub");
  if (m.state === "APPLIED") { el.className = "pill ok"; el.textContent = "Applied on ESP32"; sub.textContent = m.applied_at ? `confirmed ${ago(m.applied_at)}` : ""; }
  else if (m.state === "PENDING") { el.className = "pill warn"; el.textContent = "Pending"; sub.textContent = online ? "waiting for ESP32 confirmation" : "ESP32 offline — will apply on reconnect"; }
  else { el.className = "pill dim"; el.textContent = "Defaults"; sub.textContent = "device not seen yet"; }
}

// ---- "was this sensor moved?" notices
function renderNotices() {
  $("#notices").innerHTML = S.notices.map((n) => {
    const mins = Math.max(1, Math.round((Date.now() / 1000 - n.since) / 60));
    return `<div class="notice-card"><div><b>Sensor ${n.sensor} (${esc(n.zone || "")})'s view changed and has stayed changed for ${mins} min.</b><br>
      <span class="muted">It now reads ${cm(n.d)} instead of its baseline ${cm(n.b)}, without movement. Was the sensor moved, or has something been left in front of it?</span></div>
      <div class="acts">
        <button class="btn" data-notice-cmd="calibrate">Sensor was moved: recalibrate</button>
        <a class="btn primary" href="/sim?mode=live&select=${n.sensor}" target="_blank">Update its position (live 3D) ↗</a>
        <button class="btn ghost" data-notice-dismiss="${n.sensor}">Something was left there — dismiss</button>
      </div></div>`;
  }).join("");
}
$("#notices").addEventListener("click", async (ev) => {
  const t = ev.target;
  try {
    if (t.dataset.noticeCmd) { await api(`/api/commands/${t.dataset.noticeCmd}`, { method: "POST" }); toast("Recalibrating", "Keep the area empty for ~20 s."); }
    if (t.dataset.noticeDismiss) await api(`/api/notices/${t.dataset.noticeDismiss}/dismiss`, { method: "POST" });
  } catch (e) { toast("Not done", e.message, "err"); }
});

// ---- saved rooms (made in the 3D view)
async function loadRooms() {
  try { const r = await api("/api/rooms"); S.rooms = r.rooms; S.activeRoom = r.active; renderRooms(); } catch { /* offline */ }
}
function renderRooms() {
  $("#roomPick").innerHTML = S.rooms.length ? S.rooms.map((n) => `<option ${n === S.activeRoom ? "selected" : ""}>${esc(n)}</option>`).join("")
    : `<option value="">(none yet — save one in the 3D view)</option>`;
  $("#roomInfo").textContent = S.activeRoom ? `Current room: ${S.activeRoom}` : "No saved room in use";
  $("#mapRoom").textContent = `${S.activeRoom ? `room “${S.activeRoom}” · ` : ""}front: Sensor 3 scan (0–180°) · fixed Sensors 1 & 2 at their placement`;
}
$("#roomActivate").addEventListener("click", async () => {
  const n = $("#roomPick").value;
  if (!n) return;
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(n)}/activate`, { method: "POST" });
    S.layout = r.layout; fillLayoutForm(); renderSensors();
    toast("Room in use", `${n}: sensor placement loaded. Recalibrate if the device was just moved here.`);
  } catch (e) { toast("Could not use room", e.message, "err"); }
});

// ---- sensor placement (map only)
const layoutForm = $("#layoutForm");
function fillLayoutForm() {
  if (layoutForm.contains(document.activeElement)) return;  // don't overwrite while typing
  for (const [k, v] of Object.entries(S.layout)) if (layoutForm.elements[k]) layoutForm.elements[k].value = v;
}
layoutForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = {};
  for (const k of ["s1_angle", "s2_angle", "s1_x", "s1_y", "s2_x", "s2_y"]) body[k] = Number(layoutForm.elements[k].value);
  for (const k of ["s1_name", "s2_name"]) body[k] = layoutForm.elements[k].value;
  try {
    S.layout = await api("/api/layout", { method: "PUT", body: JSON.stringify(body) });
    toast("Sensor placement saved", "The room map now uses these directions.");
    renderSensors();
  } catch (e) { toast("Placement rejected", e.message, "err"); }
});

function cmdLog(text) {
  const el = $("#cmdLog");
  el.innerHTML = `<div>${hms(Date.now() / 1000)} ${esc(text)}</div>` + el.innerHTML;
  while (el.children.length > 6) el.lastChild.remove();
}
$$("[data-cmd]").forEach((b) => b.addEventListener("click", async () => {
  const cmd = b.dataset.cmd;
  b.disabled = true;
  try {
    await api(`/api/commands/${cmd}`, { method: "POST" });
    cmdLog(`→ sent ${cmd}`);
  } catch (e) {
    cmdLog(`✗ ${cmd}: ${e.message}`);
    toast("Command not sent", e.message, "err");
  } finally { setTimeout(() => (b.disabled = false), 800); }
}));

// ------------------------------------------------------------------ boot
function renderAll() { renderKpis(); renderSensors(); renderRecent(); renderLink(); }
setInterval(() => {
  const t = new Date();
  $("#clock").textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  renderKpis();
  if (S.tab === "settings") renderSetState();
}, 1000);
setInterval(renderSensors, 2000);
resizeRadar();
requestAnimationFrame(drawRadar);
connect();
seedLive();
loadSettings();
if (location.hash.length > 1) showTab(location.hash.slice(1));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// Android app: header button to change the backend address / app options
if (window.ArcGuardNative) {
  const b = document.createElement("button");
  b.className = "pill dim app-btn";
  b.textContent = "⚙ App";
  b.title = "Arc Guard app: backend address, notifications";
  b.addEventListener("click", () => window.ArcGuardNative.openSettings());
  document.querySelector(".top-status")?.prepend(b);
}
