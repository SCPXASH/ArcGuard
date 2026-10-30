/* Arc Guard 3D simulator.
 *
 * A virtual, editable room rendered with Three.js. Three virtual ultrasonic sensors measure
 * distance by casting a cone of rays (~15 deg beam) into the scene. A virtual device runs the
 * same scheduling and detection rules as the ESP32 firmware (a port of
 * firmware/ArcGuard/detector.cpp) and talks to the backend over /ws/device with the firmware's
 * JSON protocol, announcing "simulated": true.
 *
 * /sim?mode=live turns the same page into a live room view: it does not act as a device; it
 * shows the connected device's real readings on the room model, checks the fixed sensors'
 * placement against reality, and uses the real scan to size the room.
 *
 * Coordinates: the room is edited in "map" coordinates, the same as the dashboard map —
 * x = cm to the right of the device, y = cm to the front, angles 0 = right, 90 = front,
 * 180 = left, 270 = rear. In Three.js world space that is world.x = -x, world.z = y
 * (the camera looks along +z from behind the device, so screen-right is world -x).
 */
import * as THREE from "three";
import { OrbitControls } from "/static/vendor/three/OrbitControls.js";

// ------------------------------------------------------------------ constants (match firmware/config.h)
const RANGE_MIN = 2, RANGE_MAX = 400;
const ECHO_TIMEOUT_MS = 25, NO_RESPONSE_MS = 8, PING_GAP_MS = 12;
const SERVO_MS_PER_DEG = 2, SERVO_ATTACH_WAIT = 600;
const TELEMETRY_MS = 200, HEARTBEAT_MS = 2000;
const CAL_SAMPLES_FIXED = 20, CAL_SWEEPS_SCAN = 5, CAL_MIN_SAMPLES = 3, CAL_TIMEOUT_MS = 120000;
const MAX_POINTS_BATCH = 24;
const BEAM_HALF_DEG = 7.5;
const DEVICE_H = 30;          // scanning sensor height (device stand)
const WALL_H = 250;

const DEFAULTS = {
  s1_enabled: true, s2_enabled: true, s3_enabled: true, s3_uart: false, temp_c: 25,
  tau_abs_cm: 15, k_sigma: 4, confirm_count: 3, t_min_ms: 300, rate_min_cms: 30, dwell_s: 10,
  jump_cm: 80, pattern_k: 15, fault_count: 10, cooldown_s: 3,
  scanning: true, scan_min: 0, scan_max: 180, scan_step: 5, settle_ms: 40, scan_confirm_sweeps: 2, shift_window_deg: 30,
  buzzer_enabled: true, buzz_on_movement: true, buzz_on_anomaly: true, buzzer_passive: false,
};
const cfg = { ...DEFAULTS };
const cells = () => Math.floor((cfg.scan_max - cfg.scan_min) / cfg.scan_step) + 1;
const angleOf = (i) => cfg.scan_min + i * cfg.scan_step;
const dirOf = (deg) => { const a = (deg * Math.PI) / 180; return new THREE.Vector3(-Math.cos(a), 0, Math.sin(a)); };
const toWorld = (x, y, h = 0) => new THREE.Vector3(-x, h, y);
const r1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const norm360 = (a) => ((Math.round(a) % 360) + 360) % 360;

// ------------------------------------------------------------------ detector (port of detector.cpp)
function median(a) {
  const t = [...a].sort((x, y) => x - y), n = t.length;
  return n % 2 ? t[(n - 1) / 2] : 0.5 * (t[n / 2 - 1] + t[n / 2]);
}
function robust(v) {
  const b = median(v);
  return [b, Math.max(1, 1.4826 * median(v.map((x) => Math.abs(x - b))))];
}
const newFixed = () => ({ base: NaN, sigma: 0, calibrated: false, hist: [], last: NaN, prev: NaN, lastMs: 0, lastOor: false,
  delta: 0, changed: false, st: "IDLE", cnt: 0, back: 0, tStart: 0, coolUntil: 0, moveCoolUntil: 0, suddenCoolUntil: 0,
  maxRate: 0, movementSent: false, anomalySent: false, invalidRun: 0, fault: false, cal: [] });
const newCell = () => ({ base: NaN, sigma: 0, last: NaN, prevD: NaN, oor: false, valid: false, changed: false,
  prevSweepChanged: false, cnt: 0, tStart: 0, anomalySent: false, cal: [] });

class Detector {
  constructor(emit) {
    this.emit = emit;
    this.fixed = [newFixed(), newFixed()];
    this.scan = Array.from({ length: 181 }, newCell);
    this.s3InvalidRun = 0; this.s3Fault = false; this.s3Last = NaN; this.s3LastOor = false; this.s3LastAngle = -1;
    this.sweepId = 0; this.calibrating = false; this.calDone = false; this.calStart = 0; this.calSweeps = 0;
    this.sweepNew = 0; this.s3MoveCool = 0; this.patternCool = 0;
  }
  tau(sigma) { return Math.max(cfg.tau_abs_cm, cfg.k_sigma * sigma); }
  cool(now) { return now + cfg.cooldown_s * 1000; }

  startCalibration(now) {
    this.calibrating = true; this.calDone = false; this.calStart = now; this.calSweeps = 0;
    for (const f of this.fixed) Object.assign(f, { cal: [], calibrated: false, st: "IDLE", cnt: 0, back: 0 });
    this.scan = Array.from({ length: 181 }, newCell);
  }
  calProgress() {
    if (!this.calibrating) return 100;
    let parts = 0, done = 0;
    if (cfg.s1_enabled) { parts++; done += Math.min(1, this.fixed[0].cal.length / CAL_SAMPLES_FIXED); }
    if (cfg.s2_enabled) { parts++; done += Math.min(1, this.fixed[1].cal.length / CAL_SAMPLES_FIXED); }
    if (cfg.s3_enabled && cfg.scanning) { parts++; done += Math.min(1, this.calSweeps / CAL_SWEEPS_SCAN); }
    return parts ? Math.floor((100 * done) / parts) : 100;
  }
  takeCalibrationDone() { const d = this.calDone; this.calDone = false; return d; }
  tick(now) {
    if (!this.calibrating) return;
    const anyFeed = cfg.s1_enabled || cfg.s2_enabled || (cfg.s3_enabled && cfg.scanning);
    if (!anyFeed || now - this.calStart > CAL_TIMEOUT_MS) this.finish();
  }
  fixedComplete(i, enabled) { const f = this.fixed[i]; return !enabled || f.cal.length >= CAL_SAMPLES_FIXED || f.fault; }
  finish() {
    for (const f of this.fixed) {
      if (f.cal.length >= CAL_MIN_SAMPLES) { [f.base, f.sigma] = robust(f.cal); f.calibrated = true; }
      f.st = "IDLE"; f.prev = NaN;
    }
    for (let i = 0; i < cells(); i++) {
      const c = this.scan[i];
      if (c.cal.length >= CAL_MIN_SAMPLES) [c.base, c.sigma] = robust(c.cal);
      c.changed = c.prevSweepChanged = false; c.cnt = 0;
    }
    this.calibrating = false; this.calDone = true;
  }

  updateFixed(idx, kind, cm, now) {
    const f = this.fixed[idx], sensor = idx + 1;
    if (kind === "none") {
      if (++f.invalidRun >= cfg.fault_count && !f.fault) {
        f.fault = true;
        this.emit("ANOMALY", "SENSOR_FAULT", sensor, NaN, f.base, NaN, -1, NaN);
      }
      return;
    }
    f.invalidRun = 0; f.fault = false;
    const d = kind === "oor" ? RANGE_MAX : cm;
    f.lastOor = kind === "oor";
    f.hist.push(d); if (f.hist.length > 3) f.hist.shift();
    const m = median(f.hist);
    const dt = (now - f.lastMs) / 1000;
    f.prev = f.last; f.last = m; f.lastMs = now;

    if (this.calibrating) {
      if (f.cal.length < CAL_SAMPLES_FIXED) f.cal.push(d);
      const fixedDone = this.fixedComplete(0, cfg.s1_enabled) && this.fixedComplete(1, cfg.s2_enabled);
      const scanDone = !(cfg.s3_enabled && cfg.scanning) || this.calSweeps >= CAL_SWEEPS_SCAN;
      if ((fixedDone && scanDone) || now - this.calStart > CAL_TIMEOUT_MS) this.finish();
      return;
    }
    if (!f.calibrated) return;

    f.delta = m - f.base;
    f.changed = Math.abs(f.delta) > this.tau(f.sigma);
    const rate = !Number.isNaN(f.prev) && dt > 0 && dt < 2 ? (m - f.prev) / dt : 0;

    if (!Number.isNaN(f.prev) && Math.abs(m - f.prev) > cfg.jump_cm && now >= f.suddenCoolUntil) {
      this.emit("ANOMALY", "SUDDEN_CHANGE", sensor, m, f.base, f.delta, -1, rate);
      f.suddenCoolUntil = this.cool(now);
    }
    switch (f.st) {
      case "IDLE":
        if (f.changed) { f.st = "CANDIDATE"; f.cnt = 1; f.tStart = now; f.maxRate = Math.abs(rate); }
        break;
      case "CANDIDATE":
        if (!f.changed) { f.st = "IDLE"; break; }
        f.cnt++; f.maxRate = Math.max(f.maxRate, Math.abs(rate));
        if (f.cnt >= cfg.confirm_count && now - f.tStart >= cfg.t_min_ms) {
          f.st = "ACTIVE"; f.back = 0; f.movementSent = f.anomalySent = false;
          if (f.maxRate >= cfg.rate_min_cms) {
            this.emit("MOVEMENT", "MOTION", sensor, m, f.base, f.delta, -1, f.maxRate);
            f.movementSent = true; f.moveCoolUntil = this.cool(now);
          }
        }
        break;
      case "ACTIVE":
        if (f.changed) {
          f.back = 0;
          if (Math.abs(rate) >= cfg.rate_min_cms && now >= f.moveCoolUntil) {
            this.emit("MOVEMENT", "MOTION", sensor, m, f.base, f.delta, -1, rate);
            f.movementSent = true; f.moveCoolUntil = this.cool(now);
          }
          if (!f.anomalySent && now - f.tStart >= cfg.dwell_s * 1000 && Math.abs(rate) < cfg.rate_min_cms) {
            this.emit("ANOMALY", f.delta < 0 ? "OBJECT_APPEARED" : "OBJECT_DISAPPEARED", sensor, m, f.base, f.delta, -1, rate);
            f.anomalySent = true;
          }
        } else if (++f.back >= cfg.confirm_count) {
          if (!f.movementSent && !f.anomalySent) this.emit("MOVEMENT", "TRANSIENT", sensor, m, f.base, f.delta, -1, f.maxRate);
          f.st = "COOLDOWN"; f.coolUntil = this.cool(now);
        }
        break;
      case "COOLDOWN":
        if (now >= f.coolUntil) f.st = "IDLE";
        break;
    }
  }

  updateScan(cell, angle, kind, cm, now) {
    const c = this.scan[cell];
    this.s3LastAngle = angle;
    if (kind === "none") {
      c.valid = false;
      if (++this.s3InvalidRun >= cfg.fault_count && !this.s3Fault) {
        this.s3Fault = true;
        this.emit("ANOMALY", "SENSOR_FAULT", 3, NaN, NaN, NaN, angle, NaN);
      }
      return;
    }
    this.s3InvalidRun = 0; this.s3Fault = false;
    const d = kind === "oor" ? RANGE_MAX : cm;
    c.oor = kind === "oor"; c.valid = true; c.prevD = c.last; c.last = d;
    this.s3Last = d; this.s3LastOor = c.oor;
    if (this.calibrating) { if (c.cal.length < CAL_SWEEPS_SCAN) c.cal.push(d); return; }
    if (Number.isNaN(c.base)) return;

    const delta = d - c.base, tau = this.tau(c.sigma);
    const changed = Math.abs(delta) > tau, wasChanged = c.prevSweepChanged;
    c.changed = changed;
    if (!changed) { c.cnt = 0; c.anomalySent = false; return; }
    if (c.cnt === 0) c.tStart = now;
    c.cnt = Math.min(255, c.cnt + 1);

    if (!wasChanged) {
      this.sweepNew++;
      const win = Math.max(1, Math.floor(cfg.shift_window_deg / cfg.scan_step));
      let neighbour = false;
      for (let j = cell - win; j <= cell + win; j++) {
        if (j < 0 || j === cell || j >= cells()) continue;
        if (this.scan[j].prevSweepChanged) { neighbour = true; break; }
      }
      if (neighbour && now >= this.s3MoveCool) {
        this.emit("MOVEMENT", "SHIFT", 3, d, c.base, delta, angle, NaN);
        this.s3MoveCool = this.cool(now);
      }
    } else if (!Number.isNaN(c.prevD) && Math.abs(d - c.prevD) >= Math.max(tau, 20) && now >= this.s3MoveCool) {
      this.emit("MOVEMENT", "RADIAL", 3, d, c.base, delta, angle, NaN);
      this.s3MoveCool = this.cool(now);
    }
    if (!c.anomalySent && c.cnt >= cfg.scan_confirm_sweeps && now - c.tStart >= cfg.dwell_s * 1000) {
      // one object covers several neighbouring angles (beam ~15 deg wide): report it once
      let reported = false;
      for (const dir of [-1, 1]) {
        for (let j = cell + dir; j >= 0 && j < cells() && this.scan[j].changed; j += dir) {
          if (this.scan[j].anomalySent) { reported = true; break; }
        }
      }
      if (!reported) this.emit("ANOMALY", delta < 0 ? "OBJECT_APPEARED" : "OBJECT_DISAPPEARED", 3, d, c.base, delta, angle, NaN);
      c.anomalySent = true;
    }
  }

  endSweep(now) {
    this.sweepId++;
    if (this.calibrating) {
      this.calSweeps++;
      const fixedDone = this.fixedComplete(0, cfg.s1_enabled) && this.fixedComplete(1, cfg.s2_enabled);
      if ((fixedDone && this.calSweeps >= CAL_SWEEPS_SCAN) || now - this.calStart > CAL_TIMEOUT_MS) this.finish();
      return;
    }
    if (this.sweepNew >= cfg.pattern_k && now >= this.patternCool) {
      this.emit("ANOMALY", "PATTERN", 3, NaN, NaN, this.sweepNew, -1, NaN);
      this.patternCool = this.cool(now);
    }
    this.sweepNew = 0;
    for (let i = 0; i < cells(); i++) this.scan[i].prevSweepChanged = this.scan[i].changed;
  }
  resetScanLayout() { this.scan = Array.from({ length: 181 }, newCell); }
}

// ------------------------------------------------------------------ mode
// /sim            -> simulator: this page IS the device (virtual sensors, sends data as "simulated")
// /sim?mode=live  -> live room view: shows the connected device's real readings on the room model
const PARAMS = new URLSearchParams(location.search);
const LIVE = PARAMS.get("mode") === "live";
document.body.classList.toggle("live", LIVE);
if (LIVE) {
  document.title = "Arc Guard — Live Room";
  document.getElementById("title").textContent = "ARC GUARD · LIVE ROOM";
  const b = document.getElementById("banner");
  b.className = "banner live";
  b.textContent = "LIVE ROOM VIEW — beams and scan show the connected device's readings. Editing the model only changes the map; it never sends sensor data.";
}

// ------------------------------------------------------------------ scene
const view = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1017);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 8000);
camera.position.set(0, 560, -470);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 90);
controls.maxPolarAngle = Math.PI * 0.48;
controls.update();
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1f28, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(-200, 600, -150);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, far: 2500 });
scene.add(sun);

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });

// ------------------------------------------------------------------ environment model
// room: distance from the device to each wall (the device need not be in the middle of the room)
const env = {
  name: null,     // saved room on the backend, or null while unsaved
  room: { left: 250, right: 250, front: 300, rear: 150 },
  items: [],      // { type, x, y, rot, w, h, d, group }
  sensors: {
    1: { x: -10, y: -8, angle: 215, h: 30, name: "Zone A" },
    2: { x: 10, y: -8, angle: 325, h: 30, name: "Zone B" },
  },
};
function normaliseRoom(r = {}) {
  const half = r.width ? r.width / 2 : undefined;  // older layouts stored a centred width
  return { left: r.left ?? half ?? 250, right: r.right ?? half ?? 250, front: r.front ?? 300, rear: r.rear ?? 150 };
}
let targets = [];       // meshes the ultrasonic rays can hit
let wallMeshes = [];
const roomGroup = new THREE.Group();
scene.add(roomGroup);

function buildRoom() {
  for (const c of [...roomGroup.children]) { roomGroup.remove(c); c.geometry?.dispose(); }
  wallMeshes = [];
  const { left: L, right: Rt, front: F, rear: Rr } = env.room;
  const W = L + Rt, depth = F + Rr, zc = (F - Rr) / 2, xc = -(Rt - L) / 2;  // world x of the room centre
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, depth), std(0x1b2533, { roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(xc, 0, zc);
  floor.receiveShadow = true;
  roomGroup.add(floor);
  const gridLines = [];  // 1 m grid, aligned with the device
  for (let x = -Math.floor(L / 100) * 100; x <= Rt; x += 100) gridLines.push(-x, 0.3, -Rr, -x, 0.3, F);
  for (let z = -Math.floor(Rr / 100) * 100; z <= F; z += 100) gridLines.push(L, 0.3, z, -Rt, 0.3, z);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(gridLines, 3));
  roomGroup.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x24364b })));
  const wall = (w, d, x, z, opacity) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, d), std(0x3a4d66, { transparent: true, opacity, roughness: 0.9 }));
    m.position.set(x, WALL_H / 2, z);
    m.receiveShadow = true;
    roomGroup.add(m);
    wallMeshes.push(m);
  };
  wall(W + 8, 4, xc, F + 2, 0.75);         // front
  wall(W + 8, 4, xc, -Rr - 2, 0.2);        // rear (see-through: the camera is behind it)
  wall(4, depth, L + 2, zc, 0.35);         // left wall (world +x)
  wall(4, depth, -Rt - 2, zc, 0.35);       // right wall (world -x)
  refreshTargets();
}
const bounds = () => {
  const m = 15, { left: L, right: Rt, front: F, rear: Rr } = env.room;
  return { xMin: -L + m, xMax: Rt - m, yMin: -Rr + m, yMax: F - m };
};

// ---- item catalogue: every item is built from simple boxes/cylinders so rays hit its real shape
function part(g, item, geo, mat, x, y, z, soft = false) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  m.userData = { item, soft };
  g.add(m);
  return m;
}
const boxGeo = (w, h, d) => new THREE.BoxGeometry(Math.max(1, w), Math.max(1, h), Math.max(1, d));
const CATALOG = {
  box: { label: "Box", w: 50, h: 60, d: 40, build(g, it) { part(g, it, boxGeo(it.w, it.h, it.d), std(0x9a6b3c), 0, it.h / 2, 0); } },
  crate: { label: "Crate", w: 80, h: 90, d: 60, build(g, it) { part(g, it, boxGeo(it.w, it.h, it.d), std(0x7a5a32), 0, it.h / 2, 0); } },
  chair: { label: "Chair", w: 45, h: 90, d: 45, build(g, it) {
    const mat = std(0x374151), seat = it.h * 0.5;
    part(g, it, boxGeo(it.w, 5, it.d), mat, 0, seat, 0);
    part(g, it, boxGeo(it.w, it.h - seat, 5), mat, 0, seat + (it.h - seat) / 2, -it.d / 2 + 2.5);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) part(g, it, boxGeo(4, seat, 4), mat, sx * (it.w / 2 - 3), seat / 2, sz * (it.d / 2 - 3));
  } },
  table: { label: "Table", w: 120, h: 75, d: 70, build(g, it) {
    const mat = std(0x6b4f36);
    part(g, it, boxGeo(it.w, 5, it.d), mat, 0, it.h - 2.5, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) part(g, it, boxGeo(5, it.h - 5, 5), mat, sx * (it.w / 2 - 4), (it.h - 5) / 2, sz * (it.d / 2 - 4));
  } },
  desk: { label: "Desk", w: 140, h: 75, d: 70, build(g, it) {
    const mat = std(0x4a3b2e);
    part(g, it, boxGeo(it.w, 5, it.d), mat, 0, it.h - 2.5, 0);
    part(g, it, boxGeo(40, it.h - 5, it.d - 4), mat, it.w / 2 - 22, (it.h - 5) / 2, 0);     // drawer unit
    part(g, it, boxGeo(4, it.h - 5, it.d - 4), mat, -it.w / 2 + 3, (it.h - 5) / 2, 0);
    part(g, it, boxGeo(it.w - 10, it.h * 0.5, 2), mat, 0, it.h * 0.55, -it.d / 2 + 3);    // modesty panel
  } },
  cabinet: { label: "Cabinet", w: 60, h: 180, d: 45, build(g, it) { part(g, it, boxGeo(it.w, it.h, it.d), std(0x5b4636), 0, it.h / 2, 0); } },
  shelf: { label: "Shelf", w: 90, h: 150, d: 35, build(g, it) {
    const mat = std(0x8b6b4a);
    for (const sx of [-1, 1]) part(g, it, boxGeo(3, it.h, it.d), mat, sx * (it.w / 2 - 1.5), it.h / 2, 0);
    part(g, it, boxGeo(it.w, it.h, 2), mat, 0, it.h / 2, -it.d / 2 + 1);
    for (let k = 0; k < 5; k++) part(g, it, boxGeo(it.w - 6, 2.5, it.d), mat, 0, 1.25 + k * ((it.h - 2.5) / 4), 0);
  } },
  partition: { label: "Partition", w: 150, h: 180, d: 6, build(g, it) { part(g, it, boxGeo(it.w, it.h, it.d), std(0x56708f), 0, it.h / 2, 0); } },
  door: { label: "Door (open)", w: 90, h: 200, d: 5, build(g, it) {
    part(g, it, boxGeo(it.w, it.h, it.d), std(0x8a6a4a), 0, it.h / 2, 0);
    part(g, it, new THREE.SphereGeometry(3, 10, 8), std(0xd4d4d8, { metalness: 0.7 }), it.w / 2 - 8, it.h * 0.5, it.d / 2 + 2);
  } },
  plant: { label: "Plant", w: 40, h: 110, d: 40, build(g, it) {
    const r = Math.min(it.w, it.d) / 2;
    part(g, it, new THREE.CylinderGeometry(r * 0.7, r * 0.55, 30, 16), std(0x92400e), 0, 15, 0);
    part(g, it, new THREE.SphereGeometry(r, 16, 12), std(0x2f7d32, { roughness: 1 }), 0, Math.max(30 + r, it.h - r), 0, true);
    part(g, it, new THREE.CylinderGeometry(2, 2, Math.max(1, it.h - r - 30), 6), std(0x4d7c0f), 0, 30 + (it.h - r - 30) / 2, 0);
  } },
  person: { label: "Person", w: 40, h: 170, d: 30, build(g, it) {
    const body = it.h * 0.82, r = it.w / 2;
    part(g, it, new THREE.CylinderGeometry(r, r * 0.8, body, 20), std(0x8b5cf6, { roughness: 0.95 }), 0, body / 2, 0, true);
    part(g, it, new THREE.SphereGeometry(it.h * 0.075, 20, 16), std(0xf1c27d), 0, body + it.h * 0.075, 0, true);
  } },
};
const RESIZABLE = { w: [10, 400], h: [10, 250], d: [2, 300] };

function buildItem(it) {
  for (const c of [...it.group.children]) { it.group.remove(c); c.geometry?.dispose(); }
  CATALOG[it.type].build(it.group, it);
  it.group.position.copy(toWorld(it.x, it.y));
  it.group.rotation.y = (it.rot * Math.PI) / 180;
}
function addItem(type, x, y, extra = {}) {
  const c = CATALOG[type];
  const given = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null));
  const it = { type, x, y, rot: 0, w: c.w, h: c.h, d: c.d, ...given, group: new THREE.Group() };
  it.group.userData = { itemRoot: it };
  scene.add(it.group);
  env.items.push(it);
  buildItem(it);
  refreshTargets();
  return it;
}
function removeItem(it) {
  scene.remove(it.group);
  env.items.splice(env.items.indexOf(it), 1);
  if (selected?.item === it) select(null);
  refreshTargets();
}
function refreshTargets() {
  targets = [...wallMeshes];
  for (const it of env.items) it.group.traverse((m) => { if (m.isMesh) targets.push(m); });
}
const persons = () => env.items.filter((i) => i.type === "person");

// ---- the device (stand, breadboard, servo + scanning sensor) sits at the origin
const device = new THREE.Group();
scene.add(device);
const stand = new THREE.Mesh(new THREE.BoxGeometry(46, DEVICE_H - 12, 30), std(0x2a2f38));
stand.position.y = (DEVICE_H - 12) / 2;
device.add(stand);
const board = new THREE.Mesh(new THREE.BoxGeometry(40, 2, 24), std(0xeeeeea));
board.position.y = DEVICE_H - 11;
device.add(board);
const esp = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 10), std(0x111111));
esp.position.set(-12, DEVICE_H - 9, 0);
device.add(esp);
const buzzLed = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 2, 16), std(0x222222, { emissive: 0x000000 }));
buzzLed.position.set(14, DEVICE_H - 9, 6);
device.add(buzzLed);
const servoBody = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 12), std(0x1565c0));
servoBody.position.set(0, DEVICE_H, 4);
device.add(servoBody);

function sensorHead(color) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(9, 4.5, 1), std(color)));
  for (const x of [-2.4, 2.4]) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 1.6, 16), std(0xc0c7d0, { metalness: 0.6, roughness: 0.3 }));
    can.rotation.x = Math.PI / 2;
    can.position.set(x, 0, 1.2);
    g.add(can);
  }
  return g;
}
const scanHead = sensorHead(0x2e7d32);
const scanOrigin = new THREE.Vector3(0, DEVICE_H + 6, 4);
scanHead.position.copy(scanOrigin);
scene.add(scanHead);

// ---- fixed sensors 1 and 2: movable, each on a thin mounting post
const SENSOR_COLORS = [0xfbbf24, 0x60a5fa, 0x34d399];
const fixedObjs = {};
for (const id of [1, 2]) {
  const g = new THREE.Group();
  g.userData = { sensorRoot: id };
  const post = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1, 8), std(0x64748b));
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(7, 8, 2, 16), std(0x334155));
  foot.position.y = 1;
  const head = sensorHead(0x1565c0);
  const tag = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 10), new THREE.MeshBasicMaterial({ color: SENSOR_COLORS[id - 1] }));
  for (const m of [post, foot, tag]) g.add(m);
  g.add(head);
  scene.add(g);
  fixedObjs[id] = { g, post, head, tag };
}
function updateSensorObj(id) {
  const s = env.sensors[id], o = fixedObjs[id];
  o.g.position.copy(toWorld(s.x, s.y));
  o.post.scale.y = s.h;
  o.post.position.y = s.h / 2;
  o.head.position.set(0, s.h, 0);
  o.tag.position.set(0, s.h + 6, 0);
  o.g.updateMatrixWorld();
  o.head.lookAt(sensorOrigin(id - 1).add(dirOf(s.angle)));
}
function sensorOrigin(idx) {
  if (idx === 2) return scanOrigin.clone();
  const s = env.sensors[idx + 1];
  return toWorld(s.x, s.y, s.h);
}

// ---- beams and hit markers
function beam(color) {
  const geo = new THREE.ConeGeometry(Math.tan((BEAM_HALF_DEG * Math.PI) / 180), 1, 32, 1, true);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, 0.5);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
  scene.add(mesh);
  const hit = new THREE.Mesh(new THREE.SphereGeometry(3.5, 12, 12), new THREE.MeshBasicMaterial({ color }));
  scene.add(hit);
  return { mesh, hit, flash: 0 };
}
const beams = SENSOR_COLORS.map(beam);
const scanDots = new Map();
const dotGeo = new THREE.SphereGeometry(3, 10, 10);
const dotMatOk = new THREE.MeshBasicMaterial({ color: 0x34d399 });
const dotMatChg = new THREE.MeshBasicMaterial({ color: 0xf87171 });

// ------------------------------------------------------------------ virtual ultrasonic measurement
const raycaster = new THREE.Raycaster();
const ringDirs = 8, ringHalf = (6 * Math.PI) / 180;
const unplugged = [false, false, false];
let softLoss = true;
const servo = { angle: 0, target: 0, attached: false, readyAt: 0 };
const sensorAngle = (s) => (s < 2 ? env.sensors[s + 1].angle : servo.target);  // S3 measures once settled

// Returns { kind: 'ok'|'oor'|'none', cm, point }.
// ideal: what the model predicts for the empty room — no noise, no absorption, people ignored
// (used by the placement check and auto-aim, which compare against the calibrated baseline).
function measure(s, { ideal = false, angle } = {}) {
  if (unplugged[s] && !ideal) return { kind: "none" };
  const o = sensorOrigin(s), dir = dirOf(angle ?? sensorAngle(s));
  const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, dir).normalize();
  const rays = [dir.clone()];
  for (let k = 0; k < ringDirs; k++) {
    const phi = (2 * Math.PI * k) / ringDirs;
    rays.push(dir.clone().multiplyScalar(Math.cos(ringHalf))
      .add(right.clone().multiplyScalar(Math.cos(phi) * Math.sin(ringHalf)))
      .add(up.clone().multiplyScalar(Math.sin(phi) * Math.sin(ringHalf))).normalize());
  }
  let best = Infinity, bestPoint = null;
  raycaster.far = RANGE_MAX + 60;
  for (const r of rays) {
    raycaster.set(o, r);
    for (const h of raycaster.intersectObjects(targets, false)) {
      if (ideal && h.object.userData.item?.type === "person") continue;          // the baseline is taken empty
      if (!ideal && softLoss && h.object.userData.soft && Math.random() < 0.3) break;  // clothing/leaves absorbed it
      if (h.distance < best) { best = h.distance; bestPoint = h.point; }
      break;  // the first surface along the ray returns the echo
    }
  }
  if (!Number.isFinite(best)) return { kind: "oor", cm: RANGE_MAX, point: o.clone().add(dir.multiplyScalar(RANGE_MAX)) };
  const cm = ideal ? best : best + gauss() * (0.6 + best * 0.003);
  if (cm < RANGE_MIN || cm > RANGE_MAX) return { kind: "oor", cm: RANGE_MAX, point: bestPoint };
  return { kind: "ok", cm, point: bestPoint };
}

// ------------------------------------------------------------------ virtual device (port of ArcGuard.ino)
const det = new Detector(onEvent);
const sched = { phase: "ready", slot: 0, active: -1, until: 0, pending: null };
let scanIdx = 0, scanDir = 1;
const lastKind = ["none", "none", "none"];
const lastPoint = [null, null, null];
let pending = [];
let ws = null, wifiOn = true, wsUp = false, replaced = false;
let lastTel = 0, lastHb = 0, eventsM = 0, eventsA = 0;
const t0 = performance.now();
const millis = () => performance.now() - t0;

function applyServoState(now) {
  const want = cfg.s3_enabled && cfg.scanning;
  if (want && !servo.attached) { servo.attached = true; servo.target = angleOf(scanIdx); servo.readyAt = now + SERVO_ATTACH_WAIT; }
  if (!want) servo.attached = false;
}
function resetScan(now) {
  scanIdx = 0; scanDir = 1;
  det.resetScanLayout();
  clearDots();
  if (servo.attached) { servo.target = angleOf(0); servo.readyAt = now + SERVO_ATTACH_WAIT; }
}
function advanceScan(now) {
  const n = cells();
  const atEnd = (scanDir > 0 && scanIdx >= n - 1) || (scanDir < 0 && scanIdx === 0);
  if (atEnd) { det.endSweep(now); scanDir = -scanDir; }
  if (n > 1) scanIdx += scanDir;
  servo.target = angleOf(scanIdx);
  servo.readyAt = now + cfg.scan_step * SERVO_MS_PER_DEG + cfg.settle_ms;
}
function slotEnabled(s) {
  if (s === 0) return cfg.s1_enabled;
  if (s === 1) return cfg.s2_enabled;
  return cfg.s3_enabled && cfg.scanning && servo.attached;
}
function handleResult(s, r, now) {
  lastKind[s] = r.kind;
  lastPoint[s] = r.point || null;
  beams[s].flash = 1;
  if (s < 2) { det.updateFixed(s, r.kind, r.cm, now); return; }
  const a = angleOf(scanIdx);
  det.updateScan(scanIdx, a, r.kind, r.cm, now);
  const c = det.scan[scanIdx];
  if (pending.length < MAX_POINTS_BATCH)
    pending.push([a, r.kind === "ok" ? r1(r.cm) : null, r1(c.base), c.changed && r.kind !== "none" ? 1 : 0, r.kind === "oor" ? 1 : 0, r.kind !== "none" ? 1 : 0]);
  updateDot(a, r, c.changed && r.kind !== "none" && !det.calibrating);
  advanceScan(now);
}
function schedule(now) {
  if (sched.phase === "ready") {
    for (let tries = 0; tries < 3; tries++) {
      const s = sched.slot;
      sched.slot = (sched.slot + 1) % 3;
      if (!slotEnabled(s)) continue;
      if (s === 2 && now < servo.readyAt) continue;
      const r = measure(s);
      // the result becomes available after the real echo time, like the hardware
      const echoMs = r.kind === "ok" ? r.cm * 0.0577 : r.kind === "oor" ? ECHO_TIMEOUT_MS : NO_RESPONSE_MS;
      Object.assign(sched, { phase: "ping", active: s, pending: r, until: now + echoMs });
      return;
    }
  } else if (sched.phase === "ping") {
    if (now >= sched.until) {
      handleResult(sched.active, sched.pending, now);
      Object.assign(sched, { phase: "gap", until: now + PING_GAP_MS });
    }
  } else if (now >= sched.until) {
    sched.phase = "ready";
  }
}

function sensorStatus(s) {
  const en = [cfg.s1_enabled, cfg.s2_enabled, cfg.s3_enabled][s];
  if (!en) return "DISABLED";
  if (s < 2 ? det.fixed[s].fault : det.s3Fault) return "FAULT";
  if (det.calibrating) return "CALIBRATING";
  if (s === 2 && !cfg.scanning) return "IDLE";
  return "OK";
}
function send(obj) {
  if (!wsUp) return false;
  ws.send(JSON.stringify(obj));
  return true;
}
function sendTelemetry(now) {
  const sensors = [0, 1].map((s) => {
    const f = det.fixed[s];
    return { id: s + 1, status: sensorStatus(s), d: lastKind[s] === "none" ? null : r1(f.last), oor: f.lastOor,
      b: f.calibrated ? r1(f.base) : null, sigma: f.calibrated ? r1(f.sigma) : null, delta: f.calibrated ? r1(f.delta) : null,
      state: f.st, changed: f.calibrated && f.changed };
  });
  sensors.push({ id: 3, status: sensorStatus(2), d: lastKind[2] === "none" ? null : r1(det.s3Last), oor: det.s3LastOor, angle: det.s3LastAngle });
  const ok = send({ type: "telemetry", t: Math.round(now), scanning: cfg.s3_enabled && cfg.scanning, calibrating: det.calibrating,
    cal_progress: det.calProgress(), angle: angleOf(scanIdx), dir: scanDir, sweep: det.sweepId, sensors, points: pending });
  if (ok || pending.length >= MAX_POINTS_BATCH) pending = [];
}
function sendBaseline() {
  const b = [], sg = [];
  for (let i = 0; i < cells(); i++) { b.push(r1(det.scan[i].base)); sg.push(r1(det.scan[i].sigma)); }
  send({ type: "baseline",
    fixed: det.fixed.map((f, i) => ({ id: i + 1, b: f.calibrated ? r1(f.base) : null, sigma: f.calibrated ? r1(f.sigma) : null })),
    scan: { min: cfg.scan_min, step: cfg.scan_step, b, sigma: sg } });
}
function sendHello() {
  send({ type: "hello", fw: "sim3d-1.1", mac: "3D:51:4D:00:00:01", ip: "browser", reset_reason: "POWERON", simulated: true, settings: cfg });
  if (!det.calibrating) sendBaseline();
}

function onEvent(category, kind, sensor, d, base, delta, angle, rate) {
  const now = millis();
  if (category === "MOVEMENT") { eventsM++; if (cfg.buzzer_enabled && cfg.buzz_on_movement) buzz(2, 120, 120); }
  else { eventsA++; if (cfg.buzzer_enabled && cfg.buzz_on_anomaly) buzz(3, 350, 200); }
  const ev = { type: "event", t: Math.round(now), category, kind, sensor };
  if (!Number.isNaN(d)) ev.d = r1(d);
  if (!Number.isNaN(base)) ev.b = r1(base);
  if (!Number.isNaN(delta)) ev.delta = r1(delta);
  if (angle >= 0) ev.angle = angle;
  if (!Number.isNaN(rate)) ev.rate = r1(rate);
  send(ev);
  feed(ev);
}

// ---- settings / commands from the backend (same rules as settings.cpp)
const LIMITS = {
  temp_c: [-10, 50], tau_abs_cm: [3, 200], k_sigma: [1, 20], confirm_count: [1, 20], t_min_ms: [0, 10000], rate_min_cms: [1, 1000],
  dwell_s: [1, 3600], jump_cm: [10, 400], pattern_k: [2, 60], fault_count: [2, 100], cooldown_s: [0, 600], scan_min: [0, 179],
  scan_max: [1, 180], scan_step: [1, 30], settle_ms: [10, 1000], scan_confirm_sweeps: [1, 10], shift_window_deg: [5, 90],
};
function applySettings(obj) {
  let recal = false, servoChg = false;
  for (const [k, v] of Object.entries(obj || {})) {
    if (!(k in cfg)) continue;
    let nv = v;
    if (typeof cfg[k] === "boolean") nv = !!v;
    else if (LIMITS[k]) nv = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], Number(v)));
    if (nv === cfg[k]) continue;
    cfg[k] = nv;
    if (["scan_min", "scan_max", "scan_step", "temp_c"].includes(k)) recal = true;
    if (["scanning", "s3_enabled"].includes(k)) servoChg = true;
  }
  if (cfg.scan_max <= cfg.scan_min) { cfg.scan_max = Math.min(180, cfg.scan_min + cfg.scan_step); recal = true; }
  return { recal, servoChg };
}
function onMessage(msg) {
  const now = millis();
  if (msg.type === "settings") {
    const { recal, servoChg } = applySettings(msg.settings);
    if (servoChg) applyServoState(now);
    let note = null;
    if (recal) { resetScan(now); startCalibration("Scan geometry changed — recalibrating"); note = "recalibrating"; }
    if (msg.settings && msg.settings.s3_uart) note = "UART mode has no effect in the simulator";
    send({ type: "ack", id: msg.id, ok: true, note, settings: cfg });
  } else if (msg.type === "command") {
    let ok = true;
    if (msg.cmd === "calibrate") startCalibration("Calibration started from the dashboard");
    else if (msg.cmd === "scan_start" || msg.cmd === "scan_stop") { cfg.scanning = msg.cmd === "scan_start"; applyServoState(now); }
    else if (msg.cmd === "buzzer_test") buzz(1, 300, 0);
    else if (msg.cmd === "silence") buzzQueue = [];
    else ok = false;
    send({ type: "ack", id: msg.id, ok, note: ok ? msg.cmd : "unknown command", settings: cfg });
  }
}

function connect() {
  if (!wifiOn) return;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/device`);
  ws.onopen = () => { wsUp = true; sendHello(); };
  ws.onmessage = (m) => { try { onMessage(JSON.parse(m.data)); } catch (e) { console.warn(e); } };
  ws.onclose = (e) => {
    wsUp = false;
    if (e.code === 4001) {  // another device (the real ESP32 or another sim tab) took over the backend
      replaced = true;
      feedNote("Another device connected to the backend — this simulator stopped sending. Toggle Wi-Fi off/on to take over again.");
      return;
    }
    if (wifiOn) setTimeout(connect, 3000);
  };
  ws.onerror = () => ws.close();
}

// ---- buzzer (Web Audio) with the firmware's beep patterns
let audio = null, soundOn = false, buzzQueue = [], buzzing = false;
function buzz(n, on, off) {
  if (buzzQueue.length) return;  // let the current pattern finish
  const t = performance.now();
  for (let i = 0; i < n; i++) buzzQueue.push({ start: t + i * (on + off), end: t + i * (on + off) + on });
}
function buzzerLoop(t) {
  buzzQueue = buzzQueue.filter((b) => b.end > t);
  const active = buzzQueue.some((b) => b.start <= t && t < b.end);
  if (active === buzzing) return;
  buzzing = active;
  buzzLed.material.emissive.setHex(active ? 0xff3b30 : 0x000000);
  ui.buzz.textContent = active ? "BEEP" : "silent";
  ui.buzz.className = active ? "bad" : "muted";
  if (active && soundOn && audio) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 2700; o.type = "square"; g.gain.value = 0.04;
    o.connect(g).connect(audio.destination);
    const dur = Math.max(0.05, (buzzQueue.find((b) => b.start <= t)?.end - t) / 1000);
    o.start(); o.stop(audio.currentTime + dur);
  }
}

// ------------------------------------------------------------------ UI: status + event feed
const $ = (id) => document.getElementById(id);
const ui = { link: $("link"), devState: $("devState"), angle: $("angle"), d: [$("d1"), $("d2"), $("d3")], buzz: $("buzz"),
  walk: $("walk"), feed: $("feed"), inspector: $("inspector"), dirty: $("dirty"), checks: $("checks"), roomName: $("roomName") };
const KIND = { MOTION: "Movement (fast change)", TRANSIENT: "Brief movement", SHIFT: "Movement across scan", RADIAL: "Movement toward/away",
  OBJECT_APPEARED: "Object appeared", OBJECT_DISAPPEARED: "Object disappeared", SUDDEN_CHANGE: "Sudden change", PATTERN: "Unusual pattern",
  SENSOR_FAULT: "Sensor fault" };
const clock = () => new Date().toTimeString().slice(0, 8);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? "—" : `${Math.round(v)} cm`);
function feed(ev) {
  const li = document.createElement("li");
  const where = ev.angle !== undefined && ev.angle !== null ? ` at ${ev.angle}°` : "";
  const d = ev.d ?? ev.distance_cm;
  li.innerHTML = `<span class="t">${clock()}</span><span class="cat ${ev.category}">${ev.category}</span>S${ev.sensor ?? ev.sensor_id} · ${KIND[ev.kind] || ev.kind}${where}${d !== undefined && d !== null ? ` · ${d} cm` : ""}`;
  pushFeed(li);
}
function feedNote(text) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="t">${clock()}</span><span class="muted">${esc(text)}</span>`;
  pushFeed(li);
}
function pushFeed(li) {
  if (ui.feed.firstChild?.classList?.contains("muted") && ui.feed.children.length === 1) ui.feed.innerHTML = "";
  ui.feed.prepend(li);
  while (ui.feed.children.length > 14) ui.feed.lastChild.remove();
}
function renderHud() {
  ui.roomName.textContent = env.name || "unsaved";
  ui.roomName.className = env.name ? "" : "muted";
  if (LIVE) { renderLiveHud(); return; }
  ui.link.textContent = !wifiOn ? "Wi-Fi off" : wsUp ? "connected as device" : replaced ? "replaced by another device" : "connecting…";
  ui.link.className = `pill ${!wifiOn || replaced ? "bad" : wsUp ? "ok" : "warn"}`;
  ui.devState.textContent = det.calibrating ? `Calibrating ${det.calProgress()}%` : "Monitoring";
  ui.devState.className = det.calibrating ? "warn" : "ok";
  ui.angle.textContent = cfg.s3_enabled && cfg.scanning ? `${Math.round(servo.angle)}°` : "stopped";
  for (let s = 0; s < 3; s++) {
    const status = sensorStatus(s);
    let txt;
    if (status === "DISABLED") txt = "disabled";
    else if (lastKind[s] === "none") txt = "NO RESPONSE";
    else if (lastKind[s] === "oor") txt = "> 400 cm";
    else txt = `${(s < 2 ? det.fixed[s].last : det.s3Last).toFixed(1)} cm`;
    const chg = s < 2 ? det.fixed[s].calibrated && det.fixed[s].changed : false;
    ui.d[s].textContent = txt + (s < 2 && det.fixed[s].st === "ACTIVE" ? "  ⚠" : "");
    ui.d[s].className = lastKind[s] === "none" ? "bad" : chg ? "warn" : "";
  }
  renderDirty();
}

// ------------------------------------------------------------------ editing: selection, inspector, edits
let selected = null;  // { item } | { sensor: id }
const selBox = new THREE.BoxHelper(undefined, 0xffcc00);
selBox.visible = false;
scene.add(selBox);
function select(sel) {
  selected = sel;
  if (sel) { selBox.setFromObject(sel.item ? sel.item.group : fixedObjs[sel.sensor].g); selBox.visible = true; }
  else selBox.visible = false;
  renderInspector();
}

function field(key, label, value, min, max, step = 1) {
  return `<div class="field"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    <input type="number" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;
}
function renderInspector() {
  if (!selected) { ui.inspector.innerHTML = `<span class="sub">Click an item or a sensor to edit it.</span>`; return; }
  const b = bounds();
  if (selected.sensor) {
    const id = selected.sensor, s = env.sensors[id];
    ui.inspector.innerHTML = `<div class="row"><b>Sensor ${id}</b><span class="pill">${esc(s.name)}</span></div>
      ${field("x", "Right (cm)", s.x, Math.floor(b.xMin), Math.ceil(b.xMax), 5)}
      ${field("y", "Front (cm)", s.y, Math.floor(b.yMin), Math.ceil(b.yMax), 5)}
      ${field("angle", "Facing (°)", s.angle, 0, 359, 5)}
      ${field("h", "Height (cm)", s.h, 5, 220, 5)}
      ${LIVE ? `<button id="aimOne" style="width:100%;margin-top:6px">Auto-aim this sensor</button>` : ""}
      <div class="sub" style="margin-top:6px">0° = right, 90° = front, 180° = left, 270° = rear. The dashboard map follows these values. Keep real sensor wires under ~1.5 m.</div>`;
    if (LIVE) $("aimOne").onclick = () => autoAim(id, true);
  } else {
    const it = selected.item, c = CATALOG[it.type];
    ui.inspector.innerHTML = `<div class="row"><b>${c.label}</b><span class="sub">${Math.round(it.x)}, ${Math.round(it.y)} cm</span></div>
      ${field("x", "Right (cm)", Math.round(it.x), Math.floor(b.xMin), Math.ceil(b.xMax), 5)}
      ${field("y", "Front (cm)", Math.round(it.y), Math.floor(b.yMin), Math.ceil(b.yMax), 5)}
      ${field("rot", "Rotate (°)", it.rot, 0, 355, 5)}
      ${field("w", "Width", it.w, ...RESIZABLE.w, 5)}
      ${field("h", "Height", it.h, ...RESIZABLE.h, 5)}
      ${field("d", "Depth", it.d, ...RESIZABLE.d, 1)}
      <div class="btns" style="margin-top:8px"><button id="dupSel">Duplicate</button><button id="delSel">Delete</button></div>`;
    $("dupSel").onclick = duplicateSelected;
    $("delSel").onclick = deleteSelected;
  }
}
ui.inspector.addEventListener("input", (e) => {
  const k = e.target.dataset.k;
  if (!k || !selected) return;
  const v = Number(e.target.value);
  if (Number.isNaN(v)) return;
  ui.inspector.querySelectorAll(`[data-k="${k}"]`).forEach((el) => { if (el !== e.target) el.value = v; });
  if (selected.sensor) {
    const s = env.sensors[selected.sensor];
    s[k] = k === "angle" ? norm360(v) : v;
    updateSensorObj(selected.sensor);
    selBox.setFromObject(fixedObjs[selected.sensor].g);
    edited({ sensor: true });
  } else {
    const it = selected.item;
    it[k] = v;
    buildItem(it);
    refreshTargets();
    selBox.setFromObject(it.group);
    edited();
  }
});
function duplicateSelected() {
  if (!selected?.item) return;
  const it = selected.item, b = bounds();
  const copy = addItem(it.type, Math.min(b.xMax, it.x + 40), Math.min(b.yMax, it.y + 40), { rot: it.rot, w: it.w, h: it.h, d: it.d });
  select({ item: copy });
  edited();
}
function deleteSelected() {
  if (!selected?.item) return;
  removeItem(selected.item);
  edited();
}

// ---- edit bookkeeping: autosave (browser + saved room), layout sync, recalibration (simulator only)
let dirty = false, recalAt = 0, pushTimer = null, saveTimer = null, pushPending = false;
function edited({ sensor = false } = {}) {
  dirty = !LIVE;
  if (!LIVE && $("autoRecal").checked) recalAt = performance.now() + 1500;  // wait until editing pauses
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, 1200);
  if (sensor) { pushPending = true; clearTimeout(pushTimer); pushTimer = setTimeout(pushLayout, 400); }
}
function renderDirty() {
  if (LIVE || (!dirty && !det.calibrating)) { ui.dirty.hidden = true; return; }
  ui.dirty.hidden = false;
  if (det.calibrating) ui.dirty.textContent = "Learning the room (calibrating) — don't move anything until it reaches 100%.";
  else if ($("autoRecal").checked) ui.dirty.textContent = "Room edited — recalibrating as soon as you stop editing.";
  else ui.dirty.textContent = "Room edited since calibration — the device will report the changes as anomalies (a valid test). Press Recalibrate to accept them as the new normal.";
}
function startCalibration(note) {
  if (LIVE) return;
  det.startCalibration(millis());
  clearDots();
  dirty = false;
  recalAt = 0;
  if (note) feedNote(note);
}

function envToJson() {
  return {
    version: 2, name: env.name, room: { ...env.room },
    items: env.items.map(({ type, x, y, rot, w, h, d }) => ({ type, x: Math.round(x), y: Math.round(y), rot, w, h, d })),
    sensors: JSON.parse(JSON.stringify(env.sensors)),
  };
}
function loadEnv(data, { push = true, note, name = null } = {}) {
  for (const it of [...env.items]) removeItem(it);
  env.room = normaliseRoom(data.room);
  env.name = name;
  buildRoom();
  syncRoomInputs();
  for (const it of data.items || []) if (CATALOG[it.type]) addItem(it.type, it.x, it.y, { rot: it.rot || 0, w: it.w, h: it.h, d: it.d });
  for (const id of [1, 2]) if (data.sensors?.[id]) Object.assign(env.sensors[id], data.sensors[id]);
  updateSensorObj(1);
  updateSensorObj(2);
  select(null);
  walking = false;
  ui.walk?.classList.remove("on");
  if (push) pushLayout();
  saveLocal();
  if (note) feedNote(note);
  startCalibration();
  outlineDirty = true;
}
function saveLocal() { try { localStorage.setItem("arcguard.sim.current", JSON.stringify(envToJson())); } catch { /* storage unavailable */ } }
async function autosave() {
  saveLocal();
  if (env.name) {  // keep the saved room on the backend up to date as well
    try { await api(`/api/rooms/${encodeURIComponent(env.name)}`, { method: "PUT", body: JSON.stringify(envToJson()) }); }
    catch { /* offline: kept in this browser */ }
  }
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || r.statusText);
  return body;
}
let layoutPushInFlight = false;
async function pushLayout() {
  const s1 = env.sensors[1], s2 = env.sensors[2];
  layoutPushInFlight = true;
  try {
    await api("/api/layout", { method: "PUT", body: JSON.stringify({
      s1_angle: norm360(s1.angle), s2_angle: norm360(s2.angle),
      s1_x: Math.round(s1.x), s1_y: Math.round(s1.y), s2_x: Math.round(s2.x), s2_y: Math.round(s2.y) }) });
  } catch { /* backend offline: the map catches up on the next save */ }
  layoutPushInFlight = false;
  pushPending = false;
}
// follow Settings -> Sensor placement on the dashboard
async function syncLayout() {
  if (dragging || layoutPushInFlight || pushPending) return;  // never overwrite an edit that is still being saved
  try {
    const l = await api("/api/layout");
    let changed = false;
    for (const id of [1, 2]) {
      const s = env.sensors[id];
      const want = { angle: l[`s${id}_angle`], x: l[`s${id}_x`], y: l[`s${id}_y`] };
      for (const k of ["angle", "x", "y"]) if (want[k] !== undefined && want[k] !== s[k]) { s[k] = want[k]; changed = true; }
      if (l[`s${id}_name`]) s.name = l[`s${id}_name`];
      updateSensorObj(id);
    }
    if (changed) {
      saveLocal();
      if (selected?.sensor) renderInspector();
      startCalibration("Sensor placement changed on the dashboard — recalibrating");
    }
  } catch { /* backend not reachable yet */ }
}

// ------------------------------------------------------------------ presets and saved rooms
const LR = (w) => ({ left: w / 2, right: w / 2 });
const PRESETS = {
  "Demo room (default)": {
    room: { ...LR(500), front: 300, rear: 150 },
    items: [
      { type: "cabinet", x: -200, y: 250 }, { type: "desk", x: 170, y: 255 }, { type: "crate", x: 210, y: -110, w: 50, h: 90, d: 50 },
      { type: "person", x: 150, y: -60 },
    ],
    sensors: { 1: { x: -10, y: -8, angle: 215, h: 30 }, 2: { x: 10, y: -8, angle: 325, h: 30 } },
  },
  "Empty room": {
    room: { ...LR(400), front: 300, rear: 120 },
    items: [{ type: "person", x: 150, y: -60 }],
    sensors: { 1: { x: -10, y: -8, angle: 215, h: 30 }, 2: { x: 10, y: -8, angle: 325, h: 30 } },
  },
  "Office": {
    room: { ...LR(700), front: 400, rear: 200 },
    items: [
      { type: "desk", x: -220, y: 300 }, { type: "chair", x: -220, y: 240 },
      { type: "desk", x: 220, y: 300 }, { type: "chair", x: 220, y: 240 },
      { type: "partition", x: 0, y: 300, rot: 90, w: 140 }, { type: "shelf", x: 320, y: 120, rot: 90 },
      { type: "plant", x: -320, y: 370 }, { type: "cabinet", x: -320, y: 120, rot: 90 },
      { type: "door", x: -150, y: -195 }, { type: "person", x: 250, y: -120 },
    ],
    // S1 watches the door, S2 watches the right-hand rear corner
    sensors: { 1: { x: -150, y: -60, angle: 270, h: 100 }, 2: { x: 200, y: -20, angle: 300, h: 100 } },
  },
  "Lab": {
    room: { ...LR(600), front: 350, rear: 180 },
    items: [
      { type: "table", x: -180, y: 200, w: 180, d: 75, h: 90 }, { type: "table", x: 180, y: 200, w: 180, d: 75, h: 90 },
      { type: "cabinet", x: -270, y: 330 }, { type: "cabinet", x: -200, y: 330 }, { type: "shelf", x: 260, y: 330 },
      { type: "crate", x: 0, y: 320 }, { type: "box", x: -250, y: -140 }, { type: "chair", x: -180, y: 130 },
      { type: "person", x: 200, y: -100 },
    ],
    sensors: { 1: { x: -30, y: -10, angle: 200, h: 40 }, 2: { x: 30, y: -10, angle: 340, h: 40 } },
  },
};
let roomList = [];
async function refreshRooms(active) {
  try {
    const r = await api("/api/rooms");
    roomList = r.rooms;
    const pick = active ?? env.name ?? r.active;
    $("rooms").innerHTML = roomList.length ? roomList.map((n) => `<option ${n === pick ? "selected" : ""}>${esc(n)}</option>`).join("")
      : `<option value="">(no saved rooms yet)</option>`;
    return r;
  } catch { $("rooms").innerHTML = `<option value="">(backend offline)</option>`; return null; }
}
async function loadRoom(name, { note = true } = {}) {
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(name)}`);
    loadEnv(data, { push: false, name, note: note ? `Loaded room "${name}"${LIVE ? "" : " — calibrating"}` : undefined });
    await api(`/api/rooms/${encodeURIComponent(name)}/activate`, { method: "POST" });  // dashboard map takes its sensors
    return true;
  } catch (e) { feedNote(`Could not load room "${name}": ${e.message}`); return false; }
}
async function saveRoomAs(name) {
  name = (name || "").trim();
  if (!name) return;
  env.name = name;
  try {
    await api(`/api/rooms/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(envToJson()) });
    await api(`/api/rooms/${encodeURIComponent(name)}/activate`, { method: "POST" });
    await refreshRooms(name);
    saveLocal();
    feedNote(`Room "${name}" saved — the dashboard now uses it`);
  } catch (e) { feedNote(`Could not save: ${e.message}`); }
}

// ------------------------------------------------------------------ controls wiring
for (const [type, c] of Object.entries(CATALOG)) {
  const b = document.createElement("button");
  b.textContent = c.label;
  b.title = `Add a ${c.label.toLowerCase()} in front of the device`;
  b.onclick = () => {
    const bb = bounds();
    const it = addItem(type, Math.max(bb.xMin, Math.min(bb.xMax, (Math.random() - 0.5) * 160)), Math.min(bb.yMax, 110 + Math.random() * 80));
    select({ item: it });
    edited();
  };
  $("palette").appendChild(b);
}
function syncRoomInputs() {
  $("roomL").value = env.room.left; $("roomRt").value = env.room.right; $("roomF").value = env.room.front; $("roomR").value = env.room.rear;
}
function applyRoomChange() {
  buildRoom();
  const b = bounds();
  for (const it of env.items) { it.x = Math.max(b.xMin, Math.min(b.xMax, it.x)); it.y = Math.max(b.yMin, Math.min(b.yMax, it.y)); buildItem(it); }
  for (const sid of [1, 2]) {
    const s = env.sensors[sid];
    s.x = Math.max(b.xMin, Math.min(b.xMax, s.x)); s.y = Math.max(b.yMin, Math.min(b.yMax, s.y));
    updateSensorObj(sid);
  }
  refreshTargets();
  syncRoomInputs();
  edited({ sensor: true });
}
for (const [id, key, lo, hi] of [["roomL", "left", 50, 1000], ["roomRt", "right", 50, 1000], ["roomF", "front", 50, 1200], ["roomR", "rear", 30, 800]]) {
  $(id).addEventListener("change", (e) => {
    env.room[key] = Math.max(lo, Math.min(hi, Number(e.target.value) || env.room[key]));
    applyRoomChange();
  });
}
$("preset").innerHTML = Object.keys(PRESETS).map((n) => `<option>${esc(n)}</option>`).join("");
$("loadPreset").onclick = () => loadEnv(PRESETS[$("preset").value], { note: `Loaded preset "${$("preset").value}" (unsaved — use Save as… to keep it as a room)` });
$("loadRoom").onclick = () => { const n = $("rooms").value; if (n) loadRoom(n); };
$("saveRoom").onclick = () => {
  if (env.name) { autosave().then(() => feedNote(`Room "${env.name}" saved`)); return; }
  saveRoomAs(prompt("Name this room (e.g. Lab 3, Hostel room):", "") || "");
};
$("saveRoomAs").onclick = () => saveRoomAs(prompt("Save room as:", env.name || "") || "");
$("delRoom").onclick = async () => {
  const n = $("rooms").value;
  if (!n || !confirm(`Delete the saved room "${n}"?`)) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(n)}`, { method: "DELETE" });
    if (env.name === n) env.name = null;
    await refreshRooms();
    feedNote(`Room "${n}" deleted`);
  } catch (e) { feedNote(`Could not delete: ${e.message}`); }
};
$("exportEnv").onclick = () => {
  const blob = new Blob([JSON.stringify(envToJson(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(env.name || "arcguard_room").replace(/[^\w-]+/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$("importEnv").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try { loadEnv(JSON.parse(await f.text()), { note: `Imported "${f.name}" (unsaved — use Save as… to keep it)` }); }
  catch { feedNote("That file is not a valid room layout"); }
};

function toggle(btn, on, textOn, textOff) { btn.classList.toggle("on", on); if (textOn) btn.textContent = on ? textOn : textOff; }
let walking = false, walkT = 0;
ui.walk.onclick = () => {
  if (!persons().length) { feedNote("Add a person first"); return; }
  walking = !walking;
  ui.walk.classList.toggle("on", walking);
};
$("recal").onclick = async () => {
  if (!LIVE) { startCalibration("Calibration started — keep the room unchanged"); return; }
  try { await api("/api/commands/calibrate", { method: "POST" }); feedNote("Recalibration sent to the device — keep the room empty"); }
  catch (e) { feedNote(`Recalibration not sent: ${e.message}`); }
};
$("wifi").onclick = (e) => {
  wifiOn = !wifiOn;
  toggle(e.target, !wifiOn, "Wi-Fi: OFF", "Wi-Fi: on");
  replaced = false;
  if (!wifiOn && ws) ws.close(); else connect();
  feedNote(wifiOn ? "Wi-Fi restored — reconnecting" : "Wi-Fi switched off — detection continues locally");
};
[0, 1, 2].forEach((s) => ($(`u${s + 1}`).onclick = (e) => {
  unplugged[s] = !unplugged[s];
  toggle(e.target, unplugged[s], `S${s + 1} unplugged`, `Unplug S${s + 1}`);
}));
$("sound").onclick = (e) => {
  soundOn = !soundOn;
  if (soundOn && !audio) audio = new AudioContext();
  toggle(e.target, soundOn, "Sound: on", "Sound: off");
};
$("soft").onchange = (e) => (softLoss = e.target.checked);
let showBeams = true;
$("showBeams").onchange = (e) => (showBeams = e.target.checked);
$("showOutline").onchange = () => (outlineDirty = true);

// ---- scripted demo (same situations as the hardware test plan) — simulator only
let demoTimers = [], demoPending = PARAMS.has("demo");
function autoDemo() {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  const at = (ms, fn) => demoTimers.push(setTimeout(fn, ms));
  let box1 = null;
  const p = persons()[0];
  const home = p ? { x: p.x, y: p.y } : null;
  feedNote("Auto demo started");
  at(1000, () => {
    const s = env.sensors[1], a = (s.angle * Math.PI) / 180;
    box1 = addItem("box", s.x + Math.cos(a) * 100, s.y + Math.sin(a) * 100, { h: Math.max(60, s.h + 30) });
    feedNote("Demo: box placed 1 m in front of Sensor 1");
  });
  at(6000, () => { if (p) { walking = true; ui.walk.classList.add("on"); feedNote("Demo: person walks across the scan arc"); } });
  at(24000, () => {
    walking = false; ui.walk.classList.remove("on");
    if (p && home) { p.x = home.x; p.y = home.y; buildItem(p); }
    const a = (70 * Math.PI) / 180;
    addItem("box", Math.cos(a) * 150, Math.sin(a) * 150);
    feedNote("Demo: box left in the scan area at 70°, 1.5 m");
  });
  at(48000, () => { if (box1 && env.items.includes(box1)) removeItem(box1); feedNote("Demo: box removed from Sensor 1 zone"); });
  at(60000, () => feedNote("Auto demo finished — check the dashboard event log"));
}
$("demo").onclick = autoDemo;

// ------------------------------------------------------------------ live room view: real readings from the backend
const live = { status: null, sensors: { 1: {}, 2: {}, 3: {} }, scanState: {}, scan: new Map(), baseline: null, linkUp: false };
let outlineDirty = true;
function connectDashboard() {
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/dashboard`);
  sock.onopen = () => { live.linkUp = true; };
  sock.onclose = () => { live.linkUp = false; setTimeout(connectDashboard, 2000); };
  sock.onerror = () => sock.close();
  sock.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    switch (msg.type) {
      case "snapshot":
        live.status = msg.status;
        msg.sensors.forEach((s) => (live.sensors[s.id] = s));
        live.scanState = msg.scan_state;
        live.scan = new Map(msg.scan.map((p) => [p.angle, p]));
        live.baseline = msg.baseline;
        outlineDirty = true;
        break;
      case "frame":
        msg.sensors.forEach((s) => (live.sensors[s.id] = s));
        live.scanState = msg.scan_state;
        if (live.status) live.status.device = msg.device;
        for (const p of msg.points) { live.scan.set(p.angle, p); liveDot(p); }
        break;
      case "status":
        live.status = msg.status;
        if (msg.sensors) msg.sensors.forEach((s) => (live.sensors[s.id] = s));
        break;
      case "event":
        feed({ ...msg.event, sensor: msg.event.sensor_id, angle: msg.event.angle_deg, d: msg.event.distance_cm });
        break;
      case "baseline":
        live.baseline = msg.baseline;
        outlineDirty = true;
        feedNote("Device finished calibrating — new baseline received");
        break;
      case "layout":
        syncLayout();
        break;
      case "rooms":
        refreshRooms();
        break;
    }
  };
}
function renderLiveHud() {
  const dev = live.status?.device;
  ui.link.textContent = !live.linkUp ? "backend lost" : !dev?.online ? "device offline" : dev.simulated ? "simulator connected" : "ESP32 connected";
  ui.link.className = `pill ${!live.linkUp || !dev?.online ? "bad" : dev.simulated ? "warn" : "ok"}`;
  ui.devState.textContent = !dev?.online ? "—" : dev.calibrating ? `Calibrating ${dev.cal_progress ?? 0}%` : "Monitoring";
  ui.devState.className = dev?.calibrating ? "warn" : dev?.online ? "ok" : "muted";
  ui.angle.textContent = live.scanState?.scanning ? `${live.scanState.angle ?? "—"}°` : "stopped";
  for (let s = 0; s < 3; s++) {
    const r = live.sensors[s + 1] || {};
    ui.d[s].textContent = r.status === "FAULT" ? "NO RESPONSE" : r.d === null || r.d === undefined ? "—" : r.oor ? "> 400 cm" : `${Number(r.d).toFixed(1)} cm`;
    ui.d[s].className = r.status === "FAULT" ? "bad" : r.changed ? "warn" : "";
  }
  renderChecks();
}
// the real distance a fixed sensor sees in the empty room: its calibrated baseline (or the live reading)
function realRef(id) {
  const r = live.sensors[id] || {};
  if (r.status === "FAULT" || r.status === "OFFLINE" || r.status === "DISABLED") return null;
  if (r.b !== null && r.b !== undefined) return { cm: r.b, src: "baseline" };
  if (r.d !== null && r.d !== undefined) return { cm: r.oor ? RANGE_MAX : r.d, src: "live" };
  return null;
}
const modelDist = (id, angle) => measure(id - 1, { ideal: true, angle }).cm;
const tolerance = (cm) => Math.max(15, cm * 0.08);
function renderChecks() {
  let html = "";
  for (const id of [1, 2]) {
    const ref = realRef(id), model = modelDist(id);
    const name = env.sensors[id].name;
    if (!ref) {
      html += `<div class="check"><div class="head"><span>Sensor ${id} · ${esc(name)}</span><span class="muted">no data</span></div>
        <div class="nums">Model predicts ${fmt(model)} · no reading from the real sensor yet</div></div>`;
      continue;
    }
    const diff = model - ref.cm, good = Math.abs(diff) <= tolerance(ref.cm);
    html += `<div class="check ${good ? "good" : "bad"}"><div class="head"><span>Sensor ${id} · ${esc(name)}</span>
      <span class="${good ? "ok" : "bad"}">${good ? "✓ matches" : "✗ mismatch"}</span></div>
      <div class="nums">Model ${fmt(model)} · Real ${fmt(ref.cm)} (${ref.src}) · Δ ${diff > 0 ? "+" : ""}${Math.round(diff)} cm</div>
      ${good ? "" : `<div class="nums">${diff > 0 ? "The model sees further than reality: something real is closer (missing item?), or the direction/position is off." : "The model sees something nearer than reality: an item or wall in the model is too close, or the direction/position is off."}</div>`}</div>`;
  }
  if (ui.checks.innerHTML !== html) ui.checks.innerHTML = html;
}
// Turn a modelled sensor to the direction whose predicted distance best matches the real one.
function autoAim(id, verbose = false) {
  const ref = realRef(id);
  if (!ref) { feedNote(`Auto-aim S${id}: no reading from the real sensor yet`); return; }
  const s = env.sensors[id], start = s.angle;
  let best = start, bestScore = Infinity;
  for (let da = -90; da <= 90; da += 1) {
    const a = norm360(start + da);
    const score = Math.abs(modelDist(id, a) - ref.cm) + 0.05 * Math.abs(da);  // prefer small turns among equal matches
    if (score < bestScore) { bestScore = score; best = a; }
  }
  const err = Math.abs(modelDist(id, best) - ref.cm);
  s.angle = best;
  updateSensorObj(id);
  edited({ sensor: true });
  if (selected?.sensor === id) renderInspector();
  if (err <= tolerance(ref.cm)) feedNote(`Auto-aim S${id}: facing ${best}° (model ${Math.round(modelDist(id, best))} cm vs real ${Math.round(ref.cm)} cm)`);
  else feedNote(`Auto-aim S${id}: best was ${best}° but still ${Math.round(err)} cm off — move the sensor or add the item it is seeing`);
  if (verbose) select({ sensor: id });
}
$("aimBoth").onclick = () => { autoAim(1); autoAim(2); };

// The real scan as points: baseline (empty room) if available, otherwise the latest sweep.
function realScanPoints() {
  const pts = [];
  if (live.baseline?.scan?.b) {
    const { min, step, b } = live.baseline.scan;
    b.forEach((d, i) => { if (d !== null && d < RANGE_MAX - 5) pts.push({ a: min + i * step, d }); });
  }
  if (pts.length < 5) for (const p of [...live.scan.values()].sort((x, y) => x.angle - y.angle)) if (p.valid && !p.oor && p.d !== null) pts.push({ a: p.angle, d: p.d });
  return pts;
}
// Part 4: use the real scan to size the room
$("fitRoom").onclick = () => {
  const pts = realScanPoints();
  if (pts.length < 5) { feedNote("Fit room: no scan from the device yet"); return; }
  const med = (v) => (v.length ? median(v) : null);
  const rightWall = med(pts.filter((p) => p.a <= 15).map((p) => p.d * Math.cos((p.a * Math.PI) / 180)));
  const leftWall = med(pts.filter((p) => p.a >= 165).map((p) => -p.d * Math.cos((p.a * Math.PI) / 180)));
  const frontWall = med(pts.filter((p) => p.a >= 75 && p.a <= 105).map((p) => p.d * Math.sin((p.a * Math.PI) / 180)));
  const changed = [];
  if (rightWall > 50) { env.room.right = Math.round(rightWall); changed.push(`right ${env.room.right} cm`); }
  if (leftWall > 50) { env.room.left = Math.round(leftWall); changed.push(`left ${env.room.left} cm`); }
  if (frontWall > 50) { env.room.front = Math.round(frontWall); changed.push(`front ${env.room.front} cm`); }
  if (!changed.length) { feedNote("Fit room: the scan did not reach any wall (out of range?)"); return; }
  applyRoomChange();
  feedNote(`Fit room to scan: ${changed.join(", ")}. The rear wall is not visible to the scan — set it by hand. Furniture in front of a wall shortens that side.`);
};
// Real scan outline: translucent vertical ribbon through the surfaces Sensor 3 actually sees
const outlineMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
let outline = null;
function rebuildOutline() {
  outlineDirty = false;
  if (outline) { scene.remove(outline); outline.geometry.dispose(); outline = null; }
  if (!LIVE || !$("showOutline").checked) return;
  const pts = realScanPoints().sort((p, q) => p.a - q.a).map((p) => scanOrigin.clone().setY(0).add(dirOf(p.a).multiplyScalar(p.d)));
  const pos = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.distanceTo(b) > 80) continue;  // a gap between different surfaces
    const H = 120;
    pos.push(a.x, 0, a.z, b.x, 0, b.z, b.x, H, b.z, a.x, 0, a.z, b.x, H, b.z, a.x, H, a.z);
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  outline = new THREE.Mesh(g, outlineMat);
  scene.add(outline);
}
function liveDot(p) {
  let m = scanDots.get(p.angle);
  if (!m) { m = new THREE.Mesh(dotGeo, dotMatOk); scene.add(m); scanDots.set(p.angle, m); }
  m.visible = showBeams && p.valid && !p.oor && p.d !== null;
  if (m.visible) m.position.copy(scanOrigin.clone().add(dirOf(p.angle).multiplyScalar(p.d)));
  m.material = p.changed ? dotMatChg : dotMatOk;
}
// beam endpoints from the real readings
function liveBeamState(s) {
  if (s < 2) {
    const r = live.sensors[s + 1] || {};
    if (r.status === "FAULT" || r.d === null || r.d === undefined) return { kind: "none" };
    const d = r.oor ? RANGE_MAX : r.d;
    return { kind: r.oor ? "oor" : "ok", point: sensorOrigin(s).add(dirOf(env.sensors[s + 1].angle).multiplyScalar(d)) };
  }
  const p = live.scan.get(live.scanState?.angle);
  if (!p || !p.valid || p.d === null) return { kind: "oor", point: null };
  return { kind: p.oor ? "oor" : "ok", point: scanOrigin.clone().add(dirOf(p.angle).multiplyScalar(p.oor ? RANGE_MAX : p.d)) };
}

// ---- mouse: select + drag on the floor plane
const mouse = new THREE.Vector2(), pick = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragging = null, grab = { x: 0, y: 0 }, dragMoved = false;
function setMouse(e) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  pick.setFromCamera(mouse, camera);
}
function floorPoint() {
  const p = new THREE.Vector3();
  return pick.ray.intersectPlane(floorPlane, p) ? { x: -p.x, y: p.z } : null;
}
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  setMouse(e);
  const roots = [...env.items.map((i) => i.group), fixedObjs[1].g, fixedObjs[2].g];
  const hit = pick.intersectObjects(roots, true)[0];
  if (!hit) { select(null); return; }
  let o = hit.object;
  while (o && !o.userData.itemRoot && !o.userData.sensorRoot) o = o.parent;
  if (!o) return;
  const sel = o.userData.itemRoot ? { item: o.userData.itemRoot } : { sensor: o.userData.sensorRoot };
  select(sel);
  const fp = floorPoint();
  const cur = sel.item || env.sensors[sel.sensor];
  if (fp) grab = { x: cur.x - fp.x, y: cur.y - fp.y };
  dragging = sel;
  dragMoved = false;
  controls.enabled = false;
});
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  setMouse(e);
  const fp = floorPoint();
  if (!fp) return;
  const b = bounds();
  const x = Math.max(b.xMin, Math.min(b.xMax, fp.x + grab.x)), y = Math.max(b.yMin, Math.min(b.yMax, fp.y + grab.y));
  if (dragging.item) {
    if (Math.hypot(x, y) < 40) return;  // keep items off the device itself
    Object.assign(dragging.item, { x, y });
    buildItem(dragging.item);
    selBox.setFromObject(dragging.item.group);
  } else {
    if (Math.hypot(x, y) < 12) return;
    Object.assign(env.sensors[dragging.sensor], { x: Math.round(x), y: Math.round(y) });
    updateSensorObj(dragging.sensor);
    selBox.setFromObject(fixedObjs[dragging.sensor].g);
  }
  dragMoved = true;
});
window.addEventListener("pointerup", () => {
  if (dragging && dragMoved) {
    refreshTargets();
    // walking a person around is the movement being tested, not a change to the room
    if (!LIVE && dragging.item?.type === "person") saveLocal(); else edited({ sensor: !!dragging.sensor });
    renderInspector();
  }
  dragging = null;
  controls.enabled = true;
});

// ---- keyboard
const keys = new Set();
window.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if ((k === "d") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicateSelected(); return; }
  keys.add(k);
  if ((e.key === "Delete" || e.key === "Backspace") && selected?.item) deleteSelected();
  if ((k === "q" || k === "e") && selected) {
    const step = k === "q" ? 15 : -15;
    if (selected.item) { selected.item.rot = norm360(selected.item.rot + step); buildItem(selected.item); refreshTargets(); selBox.setFromObject(selected.item.group); edited(); }
    else { const s = env.sensors[selected.sensor]; s.angle = norm360(s.angle + step); updateSensorObj(selected.sensor); edited({ sensor: true }); }
    renderInspector();
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
function movePerson(dt) {
  if (LIVE) return;
  const target = selected?.item?.type === "person" ? selected.item : persons()[0];
  if (!target) return;
  const v = 90 * dt, b = bounds();
  let dx = 0, dy = 0;
  if (keys.has("w") || keys.has("arrowup")) dy += v;
  if (keys.has("s") || keys.has("arrowdown")) dy -= v;
  if (keys.has("a") || keys.has("arrowleft")) dx -= v;
  if (keys.has("d") || keys.has("arrowright")) dx += v;
  const clamp = (x, y) => ({ x: Math.max(b.xMin, Math.min(b.xMax, x)), y: Math.max(b.yMin, Math.min(b.yMax, y)) });
  if (dx || dy) {
    walking = false; ui.walk.classList.remove("on");
    const p = clamp(target.x + dx, target.y + dy);
    if (Math.hypot(p.x, p.y) >= 40) { Object.assign(target, p); buildItem(target); }
  }
  if (walking) {
    const p0 = persons()[0];
    walkT += dt * 0.12;  // one pass ~ 8 s
    const a = ((160 - 140 * (0.5 - 0.5 * Math.cos(walkT * Math.PI))) * Math.PI) / 180;
    Object.assign(p0, clamp(Math.cos(a) * 160, Math.sin(a) * 160));
    buildItem(p0);
  }
  if (selected?.item?.type === "person") selBox.setFromObject(selected.item.group);
}

// ------------------------------------------------------------------ visuals per frame
function clearDots() { for (const m of scanDots.values()) scene.remove(m); scanDots.clear(); }
function updateDot(angle, r, changed) {
  let m = scanDots.get(angle);
  if (!m) { m = new THREE.Mesh(dotGeo, dotMatOk); scene.add(m); scanDots.set(angle, m); }
  m.visible = r.kind === "ok" && showBeams;
  if (r.point) m.position.copy(r.point);
  m.material = changed ? dotMatChg : dotMatOk;
}
function updateBeams(dt) {
  for (let s = 0; s < 3; s++) {
    const b = beams[s];
    const o = sensorOrigin(s), a = s < 2 ? env.sensors[s + 1].angle : servo.angle;
    let enabled, kind, p;
    if (LIVE) {
      const st = liveBeamState(s);
      enabled = live.status?.device?.online && (s < 2 ? (live.sensors[s + 1]?.status ?? "") !== "DISABLED" : live.scanState?.scanning);
      kind = st.kind; p = st.point;
    } else {
      enabled = [cfg.s1_enabled, cfg.s2_enabled, cfg.s3_enabled && cfg.scanning][s] && !unplugged[s];
      kind = lastKind[s]; p = lastPoint[s];
    }
    b.mesh.visible = b.hit.visible = !!(showBeams && enabled);
    if (!b.mesh.visible) continue;
    const len = p ? Math.max(5, o.distanceTo(p)) : RANGE_MAX;
    b.mesh.position.copy(o);
    b.mesh.lookAt(o.clone().add(dirOf(a)));
    b.mesh.scale.setScalar(len);
    b.flash = Math.max(0, b.flash - dt * 4);
    b.mesh.material.opacity = LIVE ? 0.16 : 0.1 + 0.18 * b.flash;
    b.hit.visible = b.mesh.visible && kind === "ok" && !!p;
    if (p) b.hit.position.copy(p);
  }
  if (!showBeams) for (const m of scanDots.values()) m.visible = false;
}
function updateServo(dt) {
  if (LIVE) {
    if (live.scanState?.angle !== null && live.scanState?.angle !== undefined) servo.target = live.scanState.angle;
  } else if (!servo.attached) return;
  const maxStep = 600 * dt;  // MG90S ~0.1 s / 60 deg
  const d = servo.target - servo.angle;
  servo.angle += Math.abs(d) <= maxStep ? d : Math.sign(d) * maxStep;
  scanHead.lookAt(scanOrigin.clone().add(dirOf(servo.angle)));
}

// ------------------------------------------------------------------ main loops
function deviceLoop() {
  const now = millis();
  schedule(now);
  det.tick(now);
  if (recalAt && performance.now() >= recalAt && !dragging) startCalibration("Room edited — recalibrating to learn the new layout");
  if (det.takeCalibrationDone()) {
    sendBaseline();
    feedNote("Calibration complete — baseline learned");
    clearDots();
    if (demoPending) { demoPending = false; autoDemo(); }
  }
  if (now - lastTel >= TELEMETRY_MS) { lastTel = now; sendTelemetry(now); }
  if (now - lastHb >= HEARTBEAT_MS) {
    lastHb = now;
    send({ type: "heartbeat", t: Math.round(now), uptime_s: Math.floor(now / 1000), rssi: -55 - Math.floor(Math.random() * 6),
      heap: 210000, events_movement: eventsM, events_anomaly: eventsA });
  }
}

let last = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  movePerson(dt);
  updateServo(dt);
  updateBeams(dt);
  if (!LIVE) buzzerLoop(t);
  if (outlineDirty) rebuildOutline();
  renderer.render(scene, camera);
}
setInterval(renderHud, 250);
setInterval(() => { if (LIVE) outlineDirty = true; }, 3000);  // the latest sweep keeps changing

// ------------------------------------------------------------------ boot
async function boot() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("arcguard.sim.current") || "null"); } catch { /* ignore */ }
  const rooms = await refreshRooms();
  const presetName = PARAMS.get("preset") && Object.keys(PRESETS).find((n) => n.toLowerCase().startsWith(PARAMS.get("preset").toLowerCase()));
  if (presetName) {
    // ?preset=Office etc. loads that room and moves the fixed sensors (and the dashboard map) to match
    loadEnv(PRESETS[presetName], { note: `Loaded preset "${presetName}"` });
  } else if (PARAMS.has("demo")) {
    loadEnv(PRESETS["Demo room (default)"], { push: false, note: "Calibrating — keep the room as it is for ~20 s" });
  } else if (PARAMS.get("room") || rooms?.active) {
    const name = PARAMS.get("room") || rooms.active;
    if (!(await loadRoom(name, { note: false }))) loadEnv(saved || PRESETS["Demo room (default)"], { push: false });
    feedNote(`Room "${env.name ?? name}"`);
  } else {
    loadEnv(saved || PRESETS["Demo room (default)"], { push: false, name: saved?.name ?? null,
      note: LIVE ? undefined : "Calibrating — keep the room as it is for ~20 s" });
  }
  await syncLayout();
  setInterval(syncLayout, 3000);
  if (LIVE) {
    connectDashboard();
    const sel = Number(PARAMS.get("select"));
    if (sel === 1 || sel === 2) select({ sensor: sel });
    feedNote("Live view: arrange the model to match the real room, then check the placement panel");
  } else {
    applyServoState(millis());
    setInterval(deviceLoop, 4);
    connect();
  }
  requestAnimationFrame(frame);
}
boot();
