"""Arc Guard device simulator — for developing the dashboard without hardware.

It connects to /ws/device exactly like the ESP32 and speaks the same protocol, but
announces itself with "simulated": true. The backend stores everything it sends with
source='simulated' and the dashboard shows a SIMULATED DATA banner, so simulated
readings can never be mistaken for real measurements.

Usage (from the backend folder, with the backend running):
    python simulator.py [--host 127.0.0.1] [--port 8000]
Scenario (repeats every 60 s): a person walks across the scan arc, a box is left in
Sensor 1's zone, and something briefly passes Sensor 2.
"""
import argparse
import asyncio
import json
import math
import random
import time

import websockets

from app.settings_schema import DEFAULTS


def room_profile(angle: float) -> float:
    """Distance to the walls of a 3 m x 2 m room, sensor at the middle of one long wall."""
    a = math.radians(angle)
    dx, dy = math.cos(a), math.sin(a)
    t_side = 150 / abs(dx) if abs(dx) > 1e-6 else 1e9
    t_far = 200 / dy if dy > 1e-6 else 1e9
    return min(t_side, t_far, 400.0)


class SimDevice:
    def __init__(self):
        self.settings = dict(DEFAULTS)
        self.start = time.monotonic()
        self.calibrating_until = 0.0
        self.angle_idx = 0
        self.direction = 1
        self.sweep = 0
        self.points: list[list] = []
        self.last = {1: 180.0, 2: 250.0, 3: None}
        self.base = {1: 180.0, 2: 250.0}
        self.sent_flags: set[str] = set()
        self.events_m = self.events_a = 0

    def ms(self) -> int:
        return int((time.monotonic() - self.start) * 1000)

    def cells(self) -> list[int]:
        s = self.settings
        return list(range(s["scan_min"], s["scan_max"] + 1, s["scan_step"]))

    # ---- world model -------------------------------------------------------
    def scenario_t(self) -> float:
        return (time.monotonic() - self.start) % 60

    def walker_angle(self) -> float | None:
        t = self.scenario_t()
        return 150 - (t - 8) * 15 if 8 <= t <= 16 else None  # 150 deg -> 30 deg over 8 s, at 150 cm

    def fixed_distance(self, sid: int) -> float:
        t = self.scenario_t()
        d = self.base[sid] + random.gauss(0, 1.2)
        if sid == 1 and 20 <= t <= 38:
            d = 80 + random.gauss(0, 1.0)      # box left in zone A
        if sid == 2 and 44 <= t <= 45.5:
            d = 110 + random.gauss(0, 2.0)     # something passes zone B
        return round(d, 1)

    def scan_distance(self, angle: int) -> float:
        d = room_profile(angle)
        w = self.walker_angle()
        if w is not None and abs(angle - w) <= 8:
            d = min(d, 150.0)
        return round(d + random.gauss(0, 1.5), 1)

    # ---- protocol ----------------------------------------------------------
    def calibrating(self) -> bool:
        return time.monotonic() < self.calibrating_until

    def event(self, category: str, kind: str, sensor: int, d=None, b=None, angle=None, rate=None) -> dict:
        if category == "MOVEMENT":
            self.events_m += 1
        else:
            self.events_a += 1
        ev = {"type": "event", "t": self.ms(), "category": category, "kind": kind, "sensor": sensor}
        if d is not None:
            ev["d"] = d
        if b is not None:
            ev.update(b=b, delta=round(d - b, 1) if d is not None else None)
        if angle is not None:
            ev["angle"] = angle
        if rate is not None:
            ev["rate"] = rate
        return ev

    def scenario_events(self) -> list[dict]:
        """Events the detector would raise for the scripted scenario (once per 60 s cycle)."""
        if self.calibrating():
            return []
        t = self.scenario_t()
        cycle = int((time.monotonic() - self.start) // 60)
        out = []

        def once(tag: str, cond: bool, ev_fn):
            key = f"{cycle}:{tag}"
            if cond and key not in self.sent_flags:
                self.sent_flags.add(key)
                out.append(ev_fn())

        w = self.walker_angle()
        once("walk1", w is not None and w < 120, lambda: self.event("MOVEMENT", "SHIFT", 3, 150.0, round(room_profile(int(w)), 1), int(w)))
        once("walk2", w is not None and w < 60, lambda: self.event("MOVEMENT", "SHIFT", 3, 150.0, round(room_profile(int(w)), 1), int(w)))
        once("box_in", 20.5 <= t, lambda: self.event("MOVEMENT", "MOTION", 1, self.last[1], self.base[1], rate=95.0))
        once("box_dwell", 31 <= t, lambda: self.event("ANOMALY", "OBJECT_APPEARED", 1, self.last[1], self.base[1]))
        once("pass2", 45.6 <= t, lambda: self.event("MOVEMENT", "TRANSIENT", 2, 110.0, self.base[2], rate=120.0))
        return out

    def telemetry(self) -> dict:
        s = self.settings
        cal = self.calibrating()
        sensors = []
        for sid, en_key in ((1, "s1_enabled"), (2, "s2_enabled")):
            if s[en_key]:
                self.last[sid] = self.fixed_distance(sid)
            d = self.last[sid]
            delta = round(d - self.base[sid], 1)
            changed = abs(delta) > max(s["tau_abs_cm"], s["k_sigma"] * 1.2)
            sensors.append({"id": sid, "status": "DISABLED" if not s[en_key] else ("CALIBRATING" if cal else "OK"),
                            "d": d, "oor": False, "b": None if cal else self.base[sid], "sigma": 1.2,
                            "delta": None if cal else delta, "state": "ACTIVE" if changed and not cal else "IDLE",
                            "changed": changed and not cal})
        scanning = s["s3_enabled"] and s["scanning"]
        cells = self.cells()
        if scanning:
            for _ in range(2):  # ~2 scan steps per 200 ms frame
                self.angle_idx = max(0, min(self.angle_idx, len(cells) - 1))
                a = cells[self.angle_idx]
                d = self.scan_distance(a)
                b = None if cal else round(room_profile(a), 1)
                changed = b is not None and abs(d - b) > s["tau_abs_cm"]
                self.points.append([a, d, b, int(changed), 0, 1])
                self.last[3] = d
                at_end = (self.direction > 0 and self.angle_idx >= len(cells) - 1) or (self.direction < 0 and self.angle_idx == 0)
                if at_end:
                    self.direction = -self.direction
                    self.sweep += 1
                self.angle_idx += self.direction if len(cells) > 1 else 0
        sensors.append({"id": 3, "status": "DISABLED" if not s["s3_enabled"] else ("CALIBRATING" if cal else ("OK" if s["scanning"] else "IDLE")),
                        "d": self.last[3], "oor": False, "angle": cells[min(self.angle_idx, len(cells) - 1)]})
        msg = {"type": "telemetry", "t": self.ms(), "scanning": scanning, "calibrating": cal,
               "cal_progress": 100 if not cal else int(100 * (1 - (self.calibrating_until - time.monotonic()) / 5)),
               "angle": cells[min(self.angle_idx, len(cells) - 1)], "dir": self.direction, "sweep": self.sweep,
               "sensors": sensors, "points": self.points}
        self.points = []
        return msg

    def baseline(self) -> dict:
        cells = self.cells()
        return {"type": "baseline",
                "fixed": [{"id": 1, "b": self.base[1], "sigma": 1.2}, {"id": 2, "b": self.base[2], "sigma": 1.2}],
                "scan": {"min": self.settings["scan_min"], "step": self.settings["scan_step"],
                         "b": [round(room_profile(a), 1) for a in cells], "sigma": [1.5] * len(cells)}}

    def handle(self, msg: dict) -> list[dict]:
        out = []
        if msg.get("type") == "settings":
            old = dict(self.settings)
            self.settings.update({k: v for k, v in (msg.get("settings") or {}).items() if k in DEFAULTS})
            note = None
            if any(old[k] != self.settings[k] for k in ("scan_min", "scan_max", "scan_step")):
                self.angle_idx, self.direction = 0, 1
                self.calibrating_until = time.monotonic() + 5
                note = "recalibrating"
            out.append({"type": "ack", "id": msg.get("id"), "ok": True, "note": note, "settings": self.settings})
        elif msg.get("type") == "command":
            cmd = msg.get("cmd")
            ok = True
            if cmd == "calibrate":
                self.calibrating_until = time.monotonic() + 5
            elif cmd in ("scan_start", "scan_stop"):
                self.settings["scanning"] = cmd == "scan_start"
            elif cmd not in ("buzzer_test", "silence"):
                ok = False
            out.append({"type": "ack", "id": msg.get("id"), "ok": ok, "note": cmd, "settings": self.settings})
        return out


async def run(host: str, port: int) -> None:
    url = f"ws://{host}:{port}/ws/device"
    while True:
        dev = SimDevice()
        dev.calibrating_until = time.monotonic() + 5
        try:
            async with websockets.connect(url) as ws:
                print(f"[sim] connected to {url} (SIMULATED device)")
                await ws.send(json.dumps({"type": "hello", "fw": "sim-1.0.0", "mac": "SI:MU:LA:TE:D0:00", "ip": "127.0.0.1",
                                          "reset_reason": "POWERON", "simulated": True, "settings": dev.settings}))
                was_cal, last_hb = True, 0.0

                async def receiver():
                    async for raw in ws:
                        for reply in dev.handle(json.loads(raw)):
                            await ws.send(json.dumps(reply))

                recv = asyncio.create_task(receiver())
                try:
                    while True:
                        await ws.send(json.dumps(dev.telemetry()))
                        if was_cal and not dev.calibrating():
                            await ws.send(json.dumps(dev.baseline()))
                        was_cal = dev.calibrating()
                        for ev in dev.scenario_events():
                            print(f"[sim] event {ev['category']} {ev['kind']} S{ev['sensor']}")
                            await ws.send(json.dumps(ev))
                        if time.monotonic() - last_hb >= 2:
                            last_hb = time.monotonic()
                            await ws.send(json.dumps({"type": "heartbeat", "t": dev.ms(), "uptime_s": dev.ms() // 1000,
                                                      "rssi": random.randint(-62, -55), "heap": 210000,
                                                      "events_movement": dev.events_m, "events_anomaly": dev.events_a}))
                        await asyncio.sleep(0.2)
                finally:
                    recv.cancel()
        except (OSError, websockets.ConnectionClosed) as e:
            print(f"[sim] connection problem ({e}); retrying in 3 s")
            await asyncio.sleep(3)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    try:
        asyncio.run(run(args.host, args.port))
    except KeyboardInterrupt:
        pass
