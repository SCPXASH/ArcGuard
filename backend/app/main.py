"""Arc Guard backend: FastAPI app serving the REST API, WebSockets and the dashboard.

Run from the backend folder:
    python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Then open http://localhost:8000 (or http://<laptop-ip>:8000 from a phone).
"""
import asyncio
import csv
import io
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .db import Database
from .hub import Hub
from .settings_schema import SCHEMA, SettingsError

BASE = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("ARCGUARD_DB", BASE / "data" / "arcguard.db"))
STATIC = BASE / "static"
COMMANDS = {"calibrate", "scan_start", "scan_stop", "buzzer_test", "silence"}

db = Database(DB_PATH)
hub = Hub(db)


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.purge()
    task = asyncio.create_task(hub.watchdog())
    yield
    task.cancel()


app = FastAPI(title="Arc Guard API", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_stale_dashboard(request, call_next):
    response = await call_next(request)
    if request.url.path in ("/", "/sim") or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"  # always revalidate after an update
    return response


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/sim", include_in_schema=False)
def simulator_3d() -> FileResponse:
    return FileResponse(STATIC / "sim3d.html")


# ---------------------------------------------------------------- WebSockets
@app.websocket("/ws/device")
async def ws_device(ws: WebSocket) -> None:
    await ws.accept()
    await hub.device_connected(ws)
    try:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict):
                await hub.device_message(msg)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.device_disconnected(ws)


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket) -> None:
    await ws.accept()
    hub.dashboards.add(ws)
    try:
        await ws.send_text(json.dumps(hub.snapshot()))
        while True:
            await ws.receive_text()  # dashboards only listen; keep the socket open
    except WebSocketDisconnect:
        pass
    finally:
        hub.dashboards.discard(ws)


# ---------------------------------------------------------------- REST
def _parse_time(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        raise HTTPException(422, f"invalid date/time '{value}', use ISO format e.g. 2026-10-30 or 2026-10-30T14:00")


@app.get("/api/status")
def get_status() -> dict[str, Any]:
    return hub.status()


@app.get("/api/snapshot")
def get_snapshot() -> dict[str, Any]:
    return hub.snapshot()


@app.get("/api/readings")
def get_readings(sensor: int | None = Query(None, ge=1, le=3), minutes: float = Query(10, gt=0, le=60 * 24 * 7),
                 since: str | None = None, until: str | None = None,
                 limit: int = Query(5000, ge=1, le=50000)) -> dict[str, Any]:
    t1 = _parse_time(until) or time.time()
    t0 = _parse_time(since) or (t1 - minutes * 60)
    return {"readings": db.readings(sensor, t0, t1, limit)}


@app.get("/api/scan/latest")
def get_scan(max_age_s: float = Query(120, gt=0)) -> dict[str, Any]:
    return {"points": db.latest_scan(time.time() - max_age_s), "baseline": hub.baseline, "scan_state": hub.scan_state}


def _event_filters(sensor, category, kind, status, source, date_from, date_to) -> dict[str, Any]:
    until = _parse_time(date_to)
    if date_to and len(date_to) == 10:  # a bare date means "until the end of that day"
        until = (until or 0) + 86399.999
    return {"sensor_id": sensor, "category": category.upper() if category else None, "kind": kind,
            "status": status.upper() if status else None, "source": source,
            "since": _parse_time(date_from), "until": until}


@app.get("/api/events")
def get_events(sensor: int | None = Query(None, ge=1, le=3), category: str | None = None, kind: str | None = None,
               status: str | None = None, source: str | None = None, date_from: str | None = None,
               date_to: str | None = None, limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    rows, total = db.events(_event_filters(sensor, category, kind, status, source, date_from, date_to), limit, offset)
    return {"events": rows, "total": total}


@app.get("/api/events.csv")
def export_events(sensor: int | None = Query(None, ge=1, le=3), category: str | None = None, kind: str | None = None,
                  status: str | None = None, source: str | None = None, date_from: str | None = None,
                  date_to: str | None = None) -> StreamingResponse:
    rows, _ = db.events(_event_filters(sensor, category, kind, status, source, date_from, date_to), 100000, 0)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "date", "time", "sensor", "category", "kind", "distance_cm", "baseline_cm", "delta_cm",
                "angle_deg", "rate_cms", "status", "source"])
    for r in rows:
        dt = datetime.fromtimestamp(r["ts"])
        w.writerow([r["id"], dt.date().isoformat(), dt.strftime("%H:%M:%S"), r["sensor_id"], r["category"], r["kind"],
                    r["distance_cm"], r["baseline_cm"], r["delta_cm"], r["angle_deg"], r["rate_cms"], r["status"], r["source"]])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=arcguard_events.csv"})


@app.get("/api/events/histogram")
def get_histogram(minutes: int = Query(60, ge=1, le=60 * 24 * 7), bucket_s: int = Query(60, ge=10, le=86400)) -> dict[str, Any]:
    return {"buckets": db.event_histogram(time.time() - minutes * 60, bucket_s), "bucket_s": bucket_s}


@app.post("/api/events/{event_id}/ack")
async def ack_event(event_id: int) -> dict[str, Any]:
    if not db.ack_event(event_id):
        raise HTTPException(404, "event not found")
    await hub.broadcast({"type": "event_ack", "id": event_id})
    return {"id": event_id, "status": "ACKNOWLEDGED"}


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return hub.settings_payload() | {"schema": {k: {"type": t.__name__, "default": d, "min": lo, "max": hi}
                                                for k, (t, d, lo, hi) in SCHEMA.items()}}


@app.put("/api/settings")
async def put_settings(partial: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return await hub.update_settings(partial)
    except SettingsError as e:
        raise HTTPException(422, str(e))


@app.get("/api/layout")
def get_layout() -> dict[str, Any]:
    return hub.layout


@app.put("/api/layout")
async def put_layout(partial: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Placement of the fixed sensors, used to draw the room map: direction (deg; 0 = right, 90 = front,
    180 = left, 270 = rear), position relative to the device (x = cm right, y = cm front) and zone name."""
    new = dict(hub.layout)
    for key, value in partial.items():
        if key in ("s1_angle", "s2_angle"):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value < 360:
                raise HTTPException(422, f"'{key}' must be an angle from 0 to 359")
            new[key] = int(value)
        elif key in ("s1_x", "s1_y", "s2_x", "s2_y"):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not -1000 <= value <= 1000:
                raise HTTPException(422, f"'{key}' must be a position from -1000 to 1000 cm")
            new[key] = int(round(value))
        elif key in ("s1_name", "s2_name"):
            if not isinstance(value, str) or not 0 < len(value.strip()) <= 24:
                raise HTTPException(422, f"'{key}' must be 1-24 characters")
            new[key] = value.strip()
        else:
            raise HTTPException(422, f"unknown layout field '{key}'")
    hub.layout = new
    db.set_kv("layout", new)
    await hub.broadcast({"type": "layout", "layout": new})
    return new


# ---------------------------------------------------------------- rooms (saved 3D layouts)
ROOM_NAME_MAX = 40


def _room_names() -> list[str]:
    return db.get_kv("rooms") or []


def _check_room_name(name: str) -> str:
    name = name.strip()
    if not 0 < len(name) <= ROOM_NAME_MAX:
        raise HTTPException(422, f"room name must be 1-{ROOM_NAME_MAX} characters")
    return name


@app.get("/api/rooms")
def list_rooms() -> dict[str, Any]:
    return {"rooms": _room_names(), "active": hub.active_room}


@app.get("/api/rooms/{name}")
def get_room(name: str) -> dict[str, Any]:
    room = db.get_kv(f"room:{_check_room_name(name)}")
    if room is None:
        raise HTTPException(404, "room not found")
    return room


@app.put("/api/rooms/{name}")
async def put_room(name: str, room: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Store a room layout from the 3D view: room size, items, and fixed-sensor placement."""
    name = _check_room_name(name)
    if not isinstance(room.get("room"), dict) or not isinstance(room.get("items", []), list) or len(room.get("items", [])) > 500:
        raise HTTPException(422, "not a room layout (needs 'room', 'items' and 'sensors')")
    if len(json.dumps(room)) > 300_000:
        raise HTTPException(422, "room layout too large")
    db.set_kv(f"room:{name}", room)
    names = _room_names()
    if name not in names:
        db.set_kv("rooms", sorted([*names, name], key=str.lower))
    await hub.broadcast({"type": "rooms", "rooms": _room_names(), "active": hub.active_room})
    return {"saved": name}


@app.delete("/api/rooms/{name}")
async def delete_room(name: str) -> dict[str, Any]:
    name = _check_room_name(name)
    if name not in _room_names():
        raise HTTPException(404, "room not found")
    db.set_kv("rooms", [n for n in _room_names() if n != name])
    db.set_kv(f"room:{name}", None)
    if hub.active_room == name:
        hub.active_room = None
        db.set_kv("active_room", None)
    await hub.broadcast({"type": "rooms", "rooms": _room_names(), "active": hub.active_room})
    return {"deleted": name}


@app.post("/api/rooms/{name}/activate")
async def activate_room(name: str) -> dict[str, Any]:
    """Make a saved room current: the dashboard map takes its fixed-sensor placement."""
    room = get_room(name)
    hub.active_room = name.strip()
    db.set_kv("active_room", hub.active_room)
    sensors = room.get("sensors") or {}
    for sid in ("1", "2"):
        s = sensors.get(sid) or sensors.get(int(sid)) or {}
        for src, dst, lo, hi in (("x", "x", -1000, 1000), ("y", "y", -1000, 1000), ("angle", "angle", 0, 359)):
            if isinstance(s.get(src), (int, float)):
                v = int(round(s[src])) % 360 if src == "angle" else int(max(lo, min(hi, round(s[src]))))
                hub.layout[f"s{sid}_{dst}"] = v
        if isinstance(s.get("name"), str) and s["name"].strip():
            hub.layout[f"s{sid}_name"] = s["name"].strip()[:24]
    db.set_kv("layout", hub.layout)
    await hub.broadcast({"type": "layout", "layout": hub.layout})
    await hub.broadcast({"type": "rooms", "rooms": _room_names(), "active": hub.active_room})
    return {"active": hub.active_room, "layout": hub.layout}


@app.post("/api/notices/{sensor}/dismiss")
async def dismiss_notice(sensor: int) -> dict[str, Any]:
    if not hub.dismiss_notice(sensor):
        raise HTTPException(404, "no such notice")
    await hub.broadcast_notices()
    return {"dismissed": sensor}


@app.post("/api/commands/{cmd}")
async def post_command(cmd: str) -> dict[str, Any]:
    if cmd not in COMMANDS:
        raise HTTPException(404, f"unknown command '{cmd}'")
    result = await hub.command(cmd)
    if not result["sent"]:
        raise HTTPException(409, "ESP32 is offline - command not sent")
    return result
