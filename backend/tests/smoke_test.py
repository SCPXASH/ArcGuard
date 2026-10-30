"""End-to-end smoke test: backend + simulator must be running.

    python -m uvicorn app.main:app --port 8000      (terminal 1)
    python simulator.py                              (terminal 2)
    python tests/smoke_test.py [--port 8000]         (terminal 3)

Checks every REST endpoint, the dashboard WebSocket, the settings round trip
(dashboard -> backend -> device -> ack) and command acknowledgement.
"""
import argparse
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request

import websockets

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8000)
BASE = f"http://127.0.0.1:{ap.parse_args().port}"
failures = 0


def call(method: str, path: str, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if r.headers.get_content_type() == "application/json" else raw.decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{' - ' + detail if detail else ''}")


async def main() -> None:
    # wait for the simulated device and its calibration
    for _ in range(40):
        _, st = call("GET", "/api/status")
        if st["device"]["online"] and not st["device"]["calibrating"]:
            break
        await asyncio.sleep(0.5)
    check("device online", st["device"]["online"], f"system={st['system']}")
    check("device flagged simulated", st["device"]["simulated"] is True)

    code, html = call("GET", "/")
    check("dashboard page served", code == 200 and "ARC GUARD" in html)

    _, snap = call("GET", "/api/snapshot")
    check("snapshot has 3 sensors", len(snap["sensors"]) == 3)
    check("scan points received", len(snap["scan"]) > 0, f"{len(snap['scan'])} angles")
    check("baseline received", bool(snap["baseline"] and snap["baseline"].get("scan")))

    await asyncio.sleep(1.5)
    _, rd = call("GET", "/api/readings?sensor=1&minutes=5")
    check("fixed readings stored", len(rd["readings"]) > 0, f"{len(rd['readings'])} rows")
    check("readings marked simulated", all(r["source"] == "simulated" for r in rd["readings"]))
    _, rd3 = call("GET", "/api/readings?sensor=3&minutes=5")
    check("scan readings stored with angle", len(rd3["readings"]) > 0 and rd3["readings"][-1]["angle_deg"] is not None)

    _, sc = call("GET", "/api/scan/latest")
    check("latest scan endpoint", len(sc["points"]) > 0)

    code, bad = call("PUT", "/api/settings", {"scan_step": 99})
    check("invalid setting rejected", code == 422, bad.get("detail", ""))
    code, bad = call("PUT", "/api/settings", {"nonsense": 1})
    check("unknown setting rejected", code == 422)

    async with websockets.connect(BASE.replace("http", "ws") + "/ws/dashboard") as ws:
        first = json.loads(await ws.recv())
        check("dashboard WS snapshot", first["type"] == "snapshot")

        code, put = call("PUT", "/api/settings", {"tau_abs_cm": 22, "cooldown_s": 4})
        check("settings accepted + sent", code == 200 and put["sent"] and put["meta"]["state"] == "PENDING")
        got_ack = got_frame = False
        deadline = time.time() + 5
        while time.time() < deadline and not got_ack:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
            got_frame |= msg["type"] == "frame"
            if msg["type"] == "ack" and msg["settings"]["meta"]["state"] == "APPLIED":
                got_ack = msg["settings"]["settings"]["tau_abs_cm"] == 22
        deadline = time.time() + 3
        while time.time() < deadline and not got_frame:  # telemetry arrives every 200 ms
            got_frame = json.loads(await asyncio.wait_for(ws.recv(), 3))["type"] == "frame"
        check("live frames pushed", got_frame)
        check("device acknowledged settings (APPLIED)", got_ack)

        code, cmd = call("POST", "/api/commands/buzzer_test")
        check("command sent", code == 200 and cmd["sent"])
        acked = False
        deadline = time.time() + 5
        while time.time() < deadline and not acked:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
            acked = msg["type"] == "ack" and msg.get("command") == "buzzer_test" and msg["ok"]
        check("command acknowledged", acked)
        code, _ = call("POST", "/api/commands/self_destruct")
        check("unknown command rejected", code == 404)

    call("PUT", "/api/settings", {"tau_abs_cm": 15, "cooldown_s": 3})  # restore defaults

    print("waiting up to 60 s for scenario events...")
    deadline = time.time() + 62
    total = 0
    while time.time() < deadline:
        _, ev = call("GET", "/api/events?limit=5")
        total = ev["total"]
        if total >= 3:
            break
        await asyncio.sleep(2)
    check("events stored", total >= 3, f"{total} events")
    _, ev = call("GET", "/api/events?category=MOVEMENT&limit=1")
    check("event filter by category", all(e["category"] == "MOVEMENT" for e in ev["events"]))
    if ev["events"]:
        eid = ev["events"][0]["id"]
        code, _ = call("POST", f"/api/events/{eid}/ack")
        _, ev2 = call("GET", f"/api/events?status=ACKNOWLEDGED&limit=50")
        check("event acknowledge", code == 200 and any(e["id"] == eid for e in ev2["events"]))
    code, csv_text = call("GET", "/api/events.csv")
    check("CSV export", code == 200 and csv_text.startswith("id,date,time"))
    _, hist = call("GET", "/api/events/histogram?minutes=10")
    check("event histogram", len(hist["buckets"]) > 0)

    print(f"\n{'ALL CHECKS PASSED' if not failures else f'{failures} CHECK(S) FAILED'}")
    sys.exit(1 if failures else 0)


asyncio.run(main())
