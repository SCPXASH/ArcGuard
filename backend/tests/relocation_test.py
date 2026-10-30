"""Checks the "was this sensor moved?" notice end to end.

Connects as a (test) device, reports Sensor 1 as steadily changed for 32 s, and expects the
backend to raise a notice; then sends a new baseline (recalibration) and expects it cleared.
    python tests/relocation_test.py [--port 8000]
"""
import argparse
import asyncio
import json
import sys
import urllib.request

import websockets

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8000)
ap.add_argument("--hold", type=float, default=0, help="seconds to keep the notice up before recalibrating")
ARGS = ap.parse_args()
PORT = ARGS.port
BASE = f"http://127.0.0.1:{PORT}"


def notices() -> list:
    with urllib.request.urlopen(BASE + "/api/snapshot", timeout=5) as r:
        return json.loads(r.read())["notices"]


def frame(t: int, d1: float, changed: bool) -> str:
    s1 = {"id": 1, "status": "OK", "d": d1, "oor": False, "b": 214.0, "sigma": 1.0,
          "delta": round(d1 - 214.0, 1), "state": "ACTIVE" if changed else "IDLE", "changed": changed}
    s2 = {"id": 2, "status": "OK", "d": 250.0, "oor": False, "b": 250.0, "sigma": 1.0, "delta": 0.0, "state": "IDLE", "changed": False}
    s3 = {"id": 3, "status": "OK", "d": 200.0, "oor": False, "angle": 90}
    return json.dumps({"type": "telemetry", "t": t, "scanning": True, "calibrating": False, "cal_progress": 100,
                       "angle": 90, "dir": 1, "sweep": 1, "sensors": [s1, s2, s3], "points": []})


async def main() -> int:
    ok = True
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/device") as ws:
        await ws.send(json.dumps({"type": "hello", "fw": "test", "simulated": True, "settings": {}}))
        t = 0
        for i in range(160):  # 32 s at 5 Hz: Sensor 1 steadily reads 132 cm (baseline 214 cm)
            await ws.send(frame(t, 132.0 + (i % 3) * 0.5, True))
            t += 200
            await asyncio.sleep(0.2)
        n = notices()
        good = len(n) == 1 and n[0]["sensor"] == 1
        print(f"[{'PASS' if good else 'FAIL'}] notice raised after 30 s steady change: {n}")
        ok &= good
        for _ in range(int(ARGS.hold * 5)):  # keep reporting while the notice is shown
            await ws.send(frame(t, 132.0, True))
            t += 200
            await asyncio.sleep(0.2)
        await ws.send(json.dumps({"type": "baseline", "fixed": [{"id": 1, "b": 132.0, "sigma": 1.0}], "scan": {"min": 0, "step": 5, "b": [], "sigma": []}}))
        await asyncio.sleep(0.5)
        good = notices() == []
        print(f"[{'PASS' if good else 'FAIL'}] notice cleared by recalibration")
        ok &= good
    return 0 if ok else 1


sys.exit(asyncio.run(main()))
