"""SQLite storage. One connection guarded by a lock; every write is small."""
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,             -- unix seconds (server clock)
    sensor_id INTEGER NOT NULL,
    distance_cm REAL,             -- NULL when invalid
    valid INTEGER NOT NULL,
    out_of_range INTEGER NOT NULL DEFAULT 0,
    baseline_cm REAL,
    delta_cm REAL,
    angle_deg INTEGER,
    source TEXT NOT NULL          -- 'real' | 'simulated'
);
CREATE INDEX IF NOT EXISTS ix_readings_sensor_ts ON readings(sensor_id, ts);

CREATE TABLE IF NOT EXISTS scan_points (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    sweep_id INTEGER,
    angle_deg INTEGER NOT NULL,
    distance_cm REAL,
    baseline_cm REAL,
    changed INTEGER NOT NULL,
    out_of_range INTEGER NOT NULL,
    valid INTEGER NOT NULL,
    source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_scan_ts ON scan_points(ts);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    sensor_id INTEGER NOT NULL,
    category TEXT NOT NULL,       -- MOVEMENT | ANOMALY
    kind TEXT NOT NULL,
    distance_cm REAL,
    baseline_cm REAL,
    delta_cm REAL,
    angle_deg INTEGER,
    rate_cms REAL,
    status TEXT NOT NULL DEFAULT 'NEW',   -- NEW | ACKNOWLEDGED
    source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS device_status (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    online INTEGER NOT NULL,
    rssi INTEGER,
    uptime_s INTEGER,
    free_heap INTEGER,
    reset_reason TEXT,
    source TEXT
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

EVENT_COLS = ["id", "ts", "sensor_id", "category", "kind", "distance_cm", "baseline_cm", "delta_cm",
              "angle_deg", "rate_cms", "status", "source"]


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA_SQL)
        self.lock = threading.Lock()

    # ---- key/value ----
    def get_kv(self, key: str, default: Any = None) -> Any:
        row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_kv(self, key: str, value: Any) -> None:
        with self.lock:
            self.conn.execute("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                              (key, json.dumps(value)))
            self.conn.commit()

    # ---- writes ----
    def insert_readings(self, rows: list[tuple]) -> None:
        if not rows:
            return
        with self.lock:
            self.conn.executemany(
                "INSERT INTO readings(ts, sensor_id, distance_cm, valid, out_of_range, baseline_cm, delta_cm, angle_deg, source)"
                " VALUES(?,?,?,?,?,?,?,?,?)", rows)
            self.conn.commit()

    def insert_scan_points(self, rows: list[tuple]) -> None:
        if not rows:
            return
        with self.lock:
            self.conn.executemany(
                "INSERT INTO scan_points(ts, sweep_id, angle_deg, distance_cm, baseline_cm, changed, out_of_range, valid, source)"
                " VALUES(?,?,?,?,?,?,?,?,?)", rows)
            self.conn.commit()

    def insert_event(self, ev: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            cur = self.conn.execute(
                "INSERT INTO events(ts, sensor_id, category, kind, distance_cm, baseline_cm, delta_cm, angle_deg, rate_cms, source)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (ev["ts"], ev["sensor_id"], ev["category"], ev["kind"], ev.get("distance_cm"), ev.get("baseline_cm"),
                 ev.get("delta_cm"), ev.get("angle_deg"), ev.get("rate_cms"), ev["source"]))
            self.conn.commit()
            return {**ev, "id": cur.lastrowid, "status": "NEW"}

    def insert_status(self, ts: float, online: bool, info: dict[str, Any], source: str) -> None:
        with self.lock:
            self.conn.execute(
                "INSERT INTO device_status(ts, online, rssi, uptime_s, free_heap, reset_reason, source) VALUES(?,?,?,?,?,?,?)",
                (ts, int(online), info.get("rssi"), info.get("uptime_s"), info.get("heap"), info.get("reset_reason"), source))
            self.conn.commit()

    def ack_event(self, event_id: int) -> bool:
        with self.lock:
            cur = self.conn.execute("UPDATE events SET status='ACKNOWLEDGED' WHERE id=?", (event_id,))
            self.conn.commit()
            return cur.rowcount > 0

    def purge(self, readings_days: float = 7, scan_days: float = 2) -> None:
        now = time.time()
        with self.lock:
            self.conn.execute("DELETE FROM readings WHERE ts < ?", (now - readings_days * 86400,))
            self.conn.execute("DELETE FROM scan_points WHERE ts < ?", (now - scan_days * 86400,))
            self.conn.execute("DELETE FROM device_status WHERE ts < ?", (now - readings_days * 86400,))
            self.conn.commit()

    # ---- reads ----
    def readings(self, sensor_id: int | None, since: float, until: float, limit: int) -> list[dict]:
        q = "SELECT ts, sensor_id, distance_cm, valid, out_of_range, baseline_cm, delta_cm, angle_deg, source FROM readings WHERE ts BETWEEN ? AND ?"
        args: list[Any] = [since, until]
        if sensor_id:
            q += " AND sensor_id=?"
            args.append(sensor_id)
        q += " ORDER BY ts DESC LIMIT ?"
        args.append(limit)
        return [dict(r) for r in reversed(self.conn.execute(q, args).fetchall())]

    def events(self, filters: dict[str, Any], limit: int, offset: int) -> tuple[list[dict], int]:
        where, args = [], []
        for col in ("sensor_id", "category", "kind", "status", "source"):
            if filters.get(col) is not None:
                where.append(f"{col}=?")
                args.append(filters[col])
        if filters.get("since") is not None:
            where.append("ts >= ?")
            args.append(filters["since"])
        if filters.get("until") is not None:
            where.append("ts <= ?")
            args.append(filters["until"])
        w = (" WHERE " + " AND ".join(where)) if where else ""
        total = self.conn.execute(f"SELECT COUNT(*) FROM events{w}", args).fetchone()[0]
        rows = self.conn.execute(f"SELECT {', '.join(EVENT_COLS)} FROM events{w} ORDER BY ts DESC LIMIT ? OFFSET ?",
                                 [*args, limit, offset]).fetchall()
        return [dict(r) for r in rows], total

    def event_counts(self) -> dict[str, Any]:
        rows = self.conn.execute("SELECT category, COUNT(*) n, MAX(ts) last FROM events GROUP BY category").fetchall()
        out = {"MOVEMENT": 0, "ANOMALY": 0, "last_ts": None}
        for r in rows:
            out[r["category"]] = r["n"]
            out["last_ts"] = max(out["last_ts"] or 0, r["last"] or 0) or None
        return out

    def event_histogram(self, since: float, bucket_s: int) -> list[dict]:
        rows = self.conn.execute(
            "SELECT CAST(ts / ? AS INTEGER) * ? AS b, category, COUNT(*) n FROM events WHERE ts >= ? GROUP BY b, category ORDER BY b",
            (bucket_s, bucket_s, since)).fetchall()
        return [dict(r) for r in rows]

    def latest_scan(self, since: float) -> list[dict]:
        rows = self.conn.execute(
            "SELECT angle_deg, distance_cm, baseline_cm, changed, out_of_range, valid, ts, sweep_id FROM scan_points"
            " WHERE id IN (SELECT MAX(id) FROM scan_points WHERE ts >= ? GROUP BY angle_deg) ORDER BY angle_deg",
            (since,)).fetchall()
        return [dict(r) for r in rows]
