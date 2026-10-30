"""Live state shared between the ESP32 connection and dashboard connections.

The ESP32 talks to /ws/device; every browser talks to /ws/dashboard. The hub
stores what arrives, keeps the latest state in memory for instant snapshots, and
relays settings/commands to the device, tracking their acknowledgement.
"""
import asyncio
import json
import time
import uuid
from typing import Any

from fastapi import WebSocket

from .db import Database
from .settings_schema import DEFAULTS, merged

# Fixed-sensor placement relative to the device, in the scan convention:
# x = cm to the right, y = cm to the front, angle 0 = right, 90 = front, 180 = left, 270 = rear.
LAYOUT_DEFAULTS = {"s1_angle": 215, "s2_angle": 325, "s1_x": -10, "s1_y": -8, "s2_x": 10, "s2_y": -8,
                   "s1_name": "Zone A", "s2_name": "Zone B"}
OFFLINE_AFTER_S = 6.0      # no message for this long -> device offline
# "Was this sensor moved?" heuristic: a fixed sensor whose view has differed from its baseline,
# steadily (no movement), for this long probably was moved or has something parked in front of it.
MOVED_AFTER_S = 30.0
MOVED_MAX_SPREAD_CM = 6.0
STORE_FIXED_EVERY_S = 1.0  # fixed-sensor readings are downsampled to 1 Hz in the DB


class Hub:
    def __init__(self, db: Database):
        self.db = db
        self.device_ws: WebSocket | None = None
        self.dashboards: set[WebSocket] = set()
        self.device: dict[str, Any] = {
            "online": False, "simulated": False, "fw": None, "mac": None, "ip": None,
            "reset_reason": None, "rssi": None, "uptime_s": None, "heap": None,
            "last_seen": None, "connected_at": None, "calibrating": False, "cal_progress": 100,
        }
        self.sensors: dict[int, dict[str, Any]] = {i: {"id": i, "d": None, "prev": None, "b": None, "delta": None,
                                                       "status": "NO DATA", "state": None, "oor": False,
                                                       "changed": False, "ts": None} for i in (1, 2, 3)}
        self.scan_state: dict[str, Any] = {"scanning": False, "angle": None, "dir": 1, "sweep": None,
                                           "last_sweep_ts": None, "progress": 0}
        self.scan: dict[int, dict[str, Any]] = {}
        self.baseline: dict[str, Any] | None = db.get_kv("baseline")
        self.settings: dict[str, Any] = {**DEFAULTS, **(db.get_kv("settings") or {})}
        self.meta: dict[str, Any] = db.get_kv("settings_meta") or {
            "state": "DEFAULT", "updated_at": None, "applied_at": None, "pending_id": None, "initialized": False}
        # where the fixed sensors point (dashboard map only; the firmware does not need it)
        self.layout: dict[str, Any] = {**LAYOUT_DEFAULTS, **(db.get_kv("layout") or {})}
        self.active_room: str | None = db.get_kv("active_room")
        self.notices: dict[int, dict[str, Any]] = {}
        self._watch = {i: {"since": None, "vals": [], "raised": False} for i in (1, 2)}
        self.pending_commands: dict[str, str] = {}
        self.time_offset = 0.0
        self.last_update: float | None = None
        self._last_store = {1: 0.0, 2: 0.0}

    # ------------------------------------------------------------ helpers
    @property
    def source(self) -> str:
        return "simulated" if self.device["simulated"] else "real"

    def device_ts(self, t_ms: Any) -> float:
        return float(t_ms) / 1000.0 + self.time_offset if isinstance(t_ms, (int, float)) else time.time()

    async def broadcast(self, msg: dict[str, Any]) -> None:
        if not self.dashboards:
            return
        data = json.dumps(msg)
        dead = []
        for ws in self.dashboards:
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.dashboards.discard(ws)

    async def send_device(self, msg: dict[str, Any]) -> bool:
        if not self.device_ws or not self.device["online"]:
            return False
        try:
            await self.device_ws.send_text(json.dumps(msg))
            return True
        except Exception:
            return False

    def status(self) -> dict[str, Any]:
        counts = self.db.event_counts()
        active = sum(1 for i, s in self.sensors.items() if s["status"] in ("OK", "CALIBRATING"))
        if not self.device["online"]:
            system = "OFFLINE"
        elif any(s["status"] == "FAULT" for s in self.sensors.values()):
            system = "DEGRADED"
        elif self.device["calibrating"]:
            system = "CALIBRATING"
        else:
            system = "MONITORING"
        return {
            "system": system, "device": self.device, "active_sensors": active,
            "events_movement": counts["MOVEMENT"], "events_anomaly": counts["ANOMALY"],
            "last_activity": counts["last_ts"], "last_update": self.last_update, "server_time": time.time(),
        }

    def settings_payload(self) -> dict[str, Any]:
        return {"settings": self.settings, "meta": self.meta}

    def snapshot(self) -> dict[str, Any]:
        events, _ = self.db.events({}, 25, 0)
        return {
            "type": "snapshot", "status": self.status(), "sensors": list(self.sensors.values()),
            "scan_state": self.scan_state, "scan": sorted(self.scan.values(), key=lambda p: p["angle"]),
            "baseline": self.baseline, "settings": self.settings_payload(), "events": events, "layout": self.layout,
            "active_room": self.active_room, "notices": list(self.notices.values()),
        }

    # ------------------------------------------------------------ device side
    async def device_connected(self, ws: WebSocket) -> None:
        if self.device_ws is not None:
            try:  # 4001 tells a simulator it was replaced so it stops reconnecting; the ESP32 just retries
                await self.device_ws.close(code=4001, reason="replaced by another device")
            except Exception:
                pass
        self.device_ws = ws
        self.device.update(online=True, connected_at=time.time(), last_seen=time.time())

    async def device_disconnected(self, ws: WebSocket) -> None:
        if ws is not self.device_ws:
            return
        self.device_ws = None
        await self.set_offline()

    async def set_offline(self) -> None:
        if not self.device["online"]:
            return
        self.device["online"] = False
        for s in self.sensors.values():
            s["status"] = "OFFLINE"
        self.db.insert_status(time.time(), False, {}, self.source)
        await self.broadcast({"type": "status", "status": self.status(), "sensors": list(self.sensors.values())})

    async def device_message(self, msg: dict[str, Any]) -> None:
        now = time.time()
        was_offline = not self.device["online"]
        self.device["online"] = True
        self.device["last_seen"] = now
        typ = msg.get("type")
        if typ == "hello":
            await self._on_hello(msg)
        elif typ == "telemetry":
            await self._on_telemetry(msg, now)
        elif typ == "event":
            await self._on_event(msg)
        elif typ == "heartbeat":
            self.device.update(rssi=msg.get("rssi"), uptime_s=msg.get("uptime_s"), heap=msg.get("heap"))
            self.db.insert_status(now, True, msg, self.source)
            await self.broadcast({"type": "status", "status": self.status(), "sensors": list(self.sensors.values())})
        elif typ == "baseline":
            self.baseline = {k: msg.get(k) for k in ("fixed", "scan")} | {"ts": now}
            self.db.set_kv("baseline", self.baseline)
            await self.broadcast({"type": "baseline", "baseline": self.baseline})
            for w in self._watch.values():
                w.update(since=None, vals=[], raised=False)
            if self.notices:
                self.notices.clear()
                await self.broadcast_notices()
        elif typ == "ack":
            await self._on_ack(msg)
        if was_offline and typ != "hello":
            await self.broadcast({"type": "status", "status": self.status(), "sensors": list(self.sensors.values())})

    async def _on_hello(self, msg: dict[str, Any]) -> None:
        self.device.update(fw=msg.get("fw"), mac=msg.get("mac"), ip=msg.get("ip"),
                           reset_reason=msg.get("reset_reason"), simulated=bool(msg.get("simulated")))
        self.db.insert_status(time.time(), True, msg, self.source)
        dev_settings = msg.get("settings") or {}
        if self.meta.get("initialized"):
            # the dashboard is the source of truth once the user has saved settings
            if any(dev_settings.get(k) != v for k, v in self.settings.items()):
                await self._push_settings()
            else:
                self._mark_applied(self.settings)
        else:
            self.settings = {**DEFAULTS, **{k: v for k, v in dev_settings.items() if k in DEFAULTS}}
            self.meta["initialized"] = True
            self._mark_applied(self.settings)
        await self.broadcast(self.snapshot())

    async def _on_telemetry(self, msg: dict[str, Any], now: float) -> None:
        if isinstance(msg.get("t"), (int, float)):
            self.time_offset = now - msg["t"] / 1000.0
        self.last_update = now
        self.device.update(calibrating=bool(msg.get("calibrating")), cal_progress=msg.get("cal_progress", 100))
        readings = []
        for s in msg.get("sensors", []):
            sid = s.get("id")
            if sid not in self.sensors:
                continue
            cur = self.sensors[sid]
            d = s.get("d")
            if d is not None and cur["d"] is not None and d != cur["d"]:
                cur["prev"] = cur["d"]
            cur.update(d=d, status=s.get("status", "OK"), oor=bool(s.get("oor")), ts=now)
            for k in ("b", "delta", "state", "changed", "angle", "sigma"):
                if k in s:
                    cur[k] = s[k]
            if sid in (1, 2):
                await self._watch_relocation(sid, cur, now)
            if sid in (1, 2) and now - self._last_store[sid] >= STORE_FIXED_EVERY_S:
                self._last_store[sid] = now
                readings.append((now, sid, d, int(d is not None), int(cur["oor"]), cur.get("b"), cur.get("delta"),
                                 None, self.source))

        # scanning sensor
        st = self.scan_state
        sweep = msg.get("sweep")
        if st["sweep"] is not None and sweep is not None and sweep != st["sweep"]:
            st["last_sweep_ts"] = now
        st.update(scanning=bool(msg.get("scanning")), angle=msg.get("angle"), dir=msg.get("dir", 1), sweep=sweep)
        lo, hi = self.settings["scan_min"], self.settings["scan_max"]
        if st["angle"] is not None and hi > lo:
            frac = (st["angle"] - lo) / (hi - lo)
            st["progress"] = round(100 * (frac if st["dir"] >= 0 else 1 - frac))

        points, scan_rows = [], []
        for p in msg.get("points", []):
            angle, d, b, changed, oor, valid = (list(p) + [None] * 6)[:6]
            point = {"angle": angle, "d": d, "b": b, "changed": bool(changed), "oor": bool(oor),
                     "valid": bool(valid if valid is not None else 1), "ts": now, "sweep": sweep}
            self.scan[angle] = point
            points.append(point)
            scan_rows.append((now, sweep, angle, d, b, int(bool(changed)), int(bool(oor)), int(point["valid"]), self.source))
            readings.append((now, 3, d, int(d is not None), int(bool(oor)), b,
                             (d - b) if (d is not None and b is not None) else None, angle, self.source))
        self.db.insert_readings(readings)
        self.db.insert_scan_points(scan_rows)
        await self.broadcast({"type": "frame", "ts": now, "sensors": list(self.sensors.values()),
                              "scan_state": st, "points": points, "device": self.device})

    async def _on_event(self, msg: dict[str, Any]) -> None:
        ev = {
            "ts": self.device_ts(msg.get("t")), "sensor_id": int(msg.get("sensor", 0)),
            "category": msg.get("category", "ANOMALY"), "kind": msg.get("kind", "UNKNOWN"),
            "distance_cm": msg.get("d"), "baseline_cm": msg.get("b"), "delta_cm": msg.get("delta"),
            "angle_deg": msg.get("angle"), "rate_cms": msg.get("rate"), "source": self.source,
        }
        row = self.db.insert_event(ev)
        await self.broadcast({"type": "event", "event": row, "status": self.status()})

    async def _on_ack(self, msg: dict[str, Any]) -> None:
        ack_id = msg.get("id")
        dev_settings = {k: v for k, v in (msg.get("settings") or {}).items() if k in DEFAULTS}
        cmd = self.pending_commands.pop(ack_id, None) if ack_id else None
        if ack_id and ack_id == self.meta.get("pending_id"):
            self._mark_applied({**self.settings, **dev_settings})
        elif cmd and not self.meta.get("pending_id") and dev_settings:
            self._mark_applied({**self.settings, **dev_settings})  # e.g. scan_start/stop changes "scanning"
        await self.broadcast({"type": "ack", "id": ack_id, "ok": msg.get("ok", False), "note": msg.get("note"),
                              "command": cmd, "settings": self.settings_payload()})

    # ------------------------------------------------------------ "was this sensor moved?"
    async def broadcast_notices(self) -> None:
        await self.broadcast({"type": "notices", "notices": list(self.notices.values())})

    async def _watch_relocation(self, sid: int, cur: dict[str, Any], now: float) -> None:
        """Raise a notice when a fixed sensor's view has stayed different from its baseline, without
        movement, for MOVED_AFTER_S. Ultrasound cannot tell "the sensor was moved" from "something was left
        in front of it", so the notice asks the user rather than guessing."""
        w = self._watch[sid]
        if cur.get("status") != "OK" or not cur.get("changed") or cur.get("d") is None:
            w.update(since=None, vals=[], raised=False)
            if sid in self.notices and cur.get("status") == "OK":
                self.notices.pop(sid)  # back to normal by itself
                await self.broadcast_notices()
            return
        if w["since"] is None:
            w["since"] = now
        w["vals"] = [v for v in w["vals"] if now - v[0] <= 10] + [(now, float(cur["d"]))]
        ds = [v[1] for v in w["vals"]]
        if not w["raised"] and now - w["since"] >= MOVED_AFTER_S and len(ds) >= 5 and max(ds) - min(ds) <= MOVED_MAX_SPREAD_CM:
            w["raised"] = True
            self.notices[sid] = {"sensor": sid, "ts": now, "since": w["since"], "kind": "VIEW_CHANGED",
                                 "d": cur["d"], "b": cur.get("b"), "zone": self.layout.get(f"s{sid}_name")}
            await self.broadcast_notices()

    def dismiss_notice(self, sid: int) -> bool:
        return self.notices.pop(sid, None) is not None  # stays "raised" for this episode, so it won't reappear

    # ------------------------------------------------------------ settings & commands
    def _mark_applied(self, settings: dict[str, Any]) -> None:
        self.settings = settings
        self.meta.update(state="APPLIED", applied_at=time.time(), pending_id=None)
        self.db.set_kv("settings", self.settings)
        self.db.set_kv("settings_meta", self.meta)

    async def _push_settings(self) -> bool:
        pid = uuid.uuid4().hex[:12]
        self.meta.update(state="PENDING", pending_id=pid)
        self.db.set_kv("settings_meta", self.meta)
        return await self.send_device({"type": "settings", "id": pid, "settings": self.settings})

    async def update_settings(self, partial: dict[str, Any]) -> dict[str, Any]:
        self.settings = merged(self.settings, partial)  # raises SettingsError
        self.meta.update(updated_at=time.time(), initialized=True)
        self.db.set_kv("settings", self.settings)
        sent = await self._push_settings()
        payload = self.settings_payload() | {"sent": sent}
        await self.broadcast({"type": "settings", **payload})
        return payload

    async def command(self, cmd: str) -> dict[str, Any]:
        cid = uuid.uuid4().hex[:12]
        self.pending_commands[cid] = cmd
        sent = await self.send_device({"type": "command", "id": cid, "cmd": cmd})
        if not sent:
            self.pending_commands.pop(cid, None)
        return {"id": cid, "command": cmd, "sent": sent}

    # ------------------------------------------------------------ background
    async def watchdog(self) -> None:
        last_purge = 0.0
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            if self.device["online"] and self.device["last_seen"] and now - self.device["last_seen"] > OFFLINE_AFTER_S:
                await self.set_offline()
            if now - last_purge > 3600:
                last_purge = now
                self.db.purge()
