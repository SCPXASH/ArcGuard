# Testing — Arc Guard

## Phase 2 — individual hardware tests

Each sketch is in `firmware/tests/<name>/`. Upload it, open the Serial Monitor at **115200 baud**, and compare with the expected result. Do these **before** uploading the main firmware.

| # | Sketch | What it checks | Expected result | If it fails |
|---|---|---|---|---|
| 1 | `test_sensor1` | Sensor 1 alone (GPIO23/22) | Distance every 200 ms; hand at 10 cm → 1 m changes smoothly; wall reading steady within ±1 cm | `NO RESPONSE` → check VCC (3.3 V), GND, ECHO wire on row 8 |
| 2 | `test_sensor2` | Sensor 2 alone (GPIO19/18) | Same as test 1 | Check rows 13/14 |
| 3 | `test_sensor3` | Sensor 3 alone (GPIO17/16) | Same as test 1 | `NO RESPONSE` and the US-100 jumper is fitted → remove it (pulse mode) |
| 4 | `test_servo` | MG90S on GPIO21 | Goes 0 → 90 → 180 → 90 → 0 (1 s each), then sweeps smoothly in 5° steps | ESP32 restarts (banner reprinted) → USB port too weak: use a power bank or another port |
| 5 | `test_buzzer` | MH-FMD on GPIO4 | Part A (steady LOW) beeps → **active** buzzer; only part B (tone) beeps → **passive** buzzer | Silent in both → check VCC 3.3 V and I/O row 18 |
| 6 | `test_all_sensors` | All three, sequential | One line per cycle with 3 distances; covering one sensor changes only its own value | Value jumps when another sensor is covered → crosstalk: re-aim sensors |
| 7 | `test_scan` | Servo + Sensor 3 together | `angle,distance` lines for 0–180° and back; profile matches the room; an object at ~90° changes only nearby angles | Readings noisy right after each step → increase `SETTLE_MS` |

Record for the report: the buzzer type from test 5 (set *Passive buzzer* in dashboard settings accordingly) and a screenshot of test 7 output.

## Phase 6 — integration / demo test plan

Run with the main firmware, backend and dashboard. Fill in the *Observed* column with what actually happens (this is the table in report section 5.4).

| # | Test | Procedure | Expected dashboard result | Observed |
|---|---|---|---|---|
| 1 | Normal room | Recalibrate, leave the area empty for 5 min | All sensors OK, no events; radar latest sweep lies on the baseline | |
| 2 | Object in S1 zone | Place a box ~1 m in front of Sensor 1 | S1 deviation turns red, state CHANGE DETECTED; MOVEMENT (MOTION) on entry; ANOMALY OBJECT_APPEARED after the dwell time (10 s) | |
| 3 | Object in S2 zone | Same for Sensor 2 | Same, for S2 only | |
| 4 | Object in scan area | Place a box at ~90°, 1.5 m | Red points near 90° on the radar; S3 panel lists changed angles; OBJECT_APPEARED with angle after 2 sweeps + dwell | |
| 5 | Movement across scan | Walk slowly across the arc | Red region moves across angles; MOVEMENT (SHIFT/RADIAL) events with changing angle | |
| 6 | Object removed | Calibrate with a box present, then remove it | OBJECT_DISAPPEARED at that angle (or on that fixed sensor) | |
| 7 | Sensor fault | Unplug Sensor 2's ECHO wire | S2 status FAULT, ANOMALY SENSOR_FAULT; S1 and S3 keep working | |
| 8 | Wi-Fi loss | Turn the hotspot off 30 s, then on | Dashboard shows ESP32 Offline within ~6 s; buzzer still sounds on events; device reconnects by itself and data resumes | |

Also measure for the report:
- **False positives:** number of events in 10 minutes of an empty room.
- **Detection delay:** time from placing an object to the event appearing (event log timestamps).

## Automated backend test

With the backend and `simulator.py` running:
```powershell
python tests\smoke_test.py     # in C:\IOTProject\backend
```
It checks every REST endpoint, the dashboard WebSocket, and the settings/command acknowledgement round trip. Results from the simulator are **not** hardware results and must not be reported as such.
