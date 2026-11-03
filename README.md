# Arc Guard — Ultrasonic Motion Detection & 180° Room Scanning

A camera-free room monitor built from **exactly**:

| Part | Qty | Role |
|---|---:|---|
| ESP32-WROOM-32U (38-pin DevKit) | 1 | Processing, Wi-Fi |
| HC-SR04 (3–5.5 V multi-mode version) | 2 | Fixed Sensor 1 and Sensor 2 |
| US-100-type 5-pin ultrasonic module | 1 | Sensor 3, mounted on the servo |
| Tower Pro MG90S servo (180°) | 1 | Sweeps Sensor 3 |
| MH-FMD buzzer module | 1 | Local alarm |

The ESP32 measures distances, learns a baseline for every direction, and reports **possible movement** and **environmental anomalies** (it does not identify people). A Python backend stores everything in SQLite and serves a live web dashboard with a radar-style scan map, charts, an event log and settings that are applied on the device.

```
Sensors + servo ──> ESP32 firmware (scheduling, filtering, baseline, detection, buzzer)
                         │  Wi-Fi, WebSocket JSON (/ws/device)
                         ▼
               FastAPI backend ──> SQLite (backend/data/arcguard.db)
                         │  WebSocket (/ws/dashboard) + REST (/api/...)
                         ▼
               Web dashboard (any browser on the same network)
```

---

## Project structure

```
IOTProject/
├── README.md                     ← you are here
├── docs/
│   ├── WIRING.md                 pin map + step-by-step breadboard assembly
│   ├── TESTING.md                Phase-2 hardware tests + Phase-6 demo test plan
│   ├── TROUBLESHOOTING.md        common problems and fixes
│   └── diagrams/                 make_diagrams.py → svg/ and png/ (wiring, architecture, ...)
├── firmware/
│   ├── platformio.ini            PlatformIO build (optional; Arduino IDE also works)
│   ├── ArcGuard/                 main firmware (open ArcGuard.ino in Arduino IDE)
│   │   ├── ArcGuard.ino          setup/loop, measurement scheduler, telemetry, commands
│   │   ├── config.h              pins and timing constants
│   │   ├── secrets.example.h     copy to secrets.h: Wi-Fi + laptop IP
│   │   ├── settings.h/.cpp       runtime settings, saved in flash (NVS)
│   │   ├── ultrasonic.h/.cpp     interrupt-timed, non-blocking echo measurement (+ US-100 UART mode)
│   │   ├── detector.h/.cpp       calibration, movement/anomaly state machines
│   │   ├── alarm.h/.cpp          non-blocking buzzer patterns
│   │   └── net.h/.cpp            Wi-Fi + WebSocket client with auto-reconnect
│   └── tests/                    7 Phase-2 test sketches (one folder each)
├── backend/
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py               FastAPI app: REST API, WebSockets, serves the dashboard
│   │   ├── hub.py                live state, settings/command relay + acknowledgement
│   │   ├── db.py                 SQLite schema and queries
│   │   └── settings_schema.py    setting defaults and limits (mirrors firmware)
│   ├── static/                   dashboard: index.html, app.js, styles.css, vendor/chart.umd.min.js
│   ├── simulator.py              scripted fake device for development (data marked SIMULATED)
│   ├── static/sim3d.html, sim3d.js   3D room simulator at /sim (Three.js, data marked SIMULATED)
│   └── tests/                    smoke_test.py (end-to-end API), relocation_test.py ("sensor moved?" notice)
├── android/                      Android app (WebView around the dashboard + event notifications)
│   ├── build.ps1                 builds build\ArcGuard.apk with the Android SDK (no Gradle); -Install puts it on the phone
│   ├── AndroidManifest.xml
│   ├── res/                      icon, theme, network config
│   └── src/com/arcguard/app/MainActivity.java
└── report/                       project report (.docx/.pdf) and its generator
```

---

## 1. Install (once)

All commands are for **Windows PowerShell**. Run them from the folder shown.

**Python 3.10+** is required (3.11 is what this was built with).

```powershell
# in C:\IOTProject\backend
pip install -r requirements.txt
```

**Firmware tooling — pick one:**

*Arduino IDE 2.x (simplest)*
1. File → Preferences → Additional boards manager URLs:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. Tools → Board → Boards Manager → install **esp32 by Espressif Systems**.
3. Tools → Manage Libraries → install **ESP32Servo** (Kevin Harrington), **ArduinoJson** (Benoit Blanchon, v7), **WebSockets** (Markus Sattler).
4. If Windows does not see the board, install the USB driver for the chip next to the USB port (CP210x or CH340).

*PlatformIO (command line)*
```powershell
pip install platformio
```
Libraries are downloaded automatically from `platformio.ini`.

---

## 2. Wire the hardware

Follow **[docs/WIRING.md](docs/WIRING.md)** and the diagram `docs/diagrams/png/fig_breadboard.png`.

Key points: all three sensors and the buzzer run on **3.3 V** (so the ECHO pins are safe for the ESP32 without resistors); the servo is the only part on **5 V**; all grounds are common.

---

## 3. Test each part (Phase 2)

Upload the test sketches in `firmware/tests/` one at a time and compare with the expected results in **[docs/TESTING.md](docs/TESTING.md)**.

```powershell
# Arduino IDE: open firmware\tests\test_sensor1\test_sensor1.ino, select "ESP32 Dev Module" + COM port, Upload, open Serial Monitor at 115200.
# PlatformIO alternative, in C:\IOTProject\firmware:
$env:PLATFORMIO_SRC_DIR = "tests/test_sensor1"; pio run -e tests -t upload -t monitor
Remove-Item Env:PLATFORMIO_SRC_DIR
```

---

## 4. Configure and upload the firmware

1. Find the laptop's IP address on the network the ESP32 will join:
   ```powershell
   ipconfig        # use the IPv4 address of the Wi-Fi adapter, e.g. 192.168.43.120
   ```
2. Edit `firmware/ArcGuard/secrets.h` (copy `secrets.example.h` if it does not exist) and set `WIFI_SSID`, `WIFI_PASSWORD` (a **2.4 GHz** network, ideally a phone hotspot) and `BACKEND_HOST` (the IP from step 1).
3. Upload:
   - Arduino IDE: open `firmware/ArcGuard/ArcGuard.ino` → board **ESP32 Dev Module** → Upload.
   - PlatformIO, in `C:\IOTProject\firmware`: `pio run -e esp32dev -t upload -t monitor`
4. Keep the monitored area **empty** for ~20 s after boot while it calibrates. The Serial Monitor (115200 baud) prints one status line per second and every event.

---

## 5. Run the backend and open the dashboard

```powershell
# in C:\IOTProject\backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- Dashboard on the laptop: **http://localhost:8000**
- From a phone on the same network: **http://<laptop-ip>:8000** — or use the Android app (section 6)
- API documentation: **http://localhost:8000/docs**

The first time, Windows Firewall asks whether Python may accept connections — allow it on **private networks** (the ESP32 cannot connect otherwise).

### Developing without hardware

```powershell
# second terminal, in C:\IOTProject\backend (backend must be running)
python simulator.py
```
The simulator connects like the ESP32 but every reading is stored with `source = simulated`, the dashboard shows a striped **SIMULATED DATA** banner, and simulated events carry a SIM tag. Stop it (Ctrl+C) before connecting the real device. To keep test data out of the real database, run the backend with `$env:ARCGUARD_DB = "C:\temp\sim.db"` first.

### 3D room simulator

With the backend running, open **http://localhost:8000/sim** (or the *3D sim ↗* link in the dashboard header) and keep that tab visible.

- A virtual room with three virtual ultrasonic sensors and the servo; distances come from ray-casting a ~15° beam cone.
- It connects to the backend exactly like the ESP32 and runs a JavaScript port of the firmware's detection code, so the dashboard reacts to what you do.
- **Edit the room:** add items from the palette (box, crate, chair, table, desk, cabinet, shelf, partition, door, plant, person); click to select, drag to move, **Q/E** rotate, resize in the *Selected* panel, **Ctrl+D** duplicate, **Del** delete; change the room size.
- **Move Sensors 1 and 2 anywhere:** drag them, or set position/direction/height in the *Selected* panel. The dashboard map (Settings → Sensor placement) stays in sync both ways.
- **Layouts:** presets (Demo room, Empty room, Office, Lab), *Save as…* in the browser, *Export/Import* as a JSON file. Open `/sim?preset=office` to start straight into a preset.
- After rearranging, the sim **auto-recalibrates** (untick it to test how the detector reports moved furniture as anomalies). Walking a person never triggers recalibration.
- Walk a person with **W A S D**, or press **▶ Auto demo** for a 60 s scripted scene.
- *Unplug S1/S2/S3* and *Wi-Fi: off* reproduce the fault and disconnection tests.
- Everything it sends is marked **simulated** — never present it as hardware data. Only one device can be connected at a time: the newest connection wins, and a replaced simulator stops sending (toggle *Wi-Fi* off/on in the sim to take over again). The real ESP32 always reconnects, so it wins over a forgotten sim tab.

### Live room view (real hardware) — placing Sensors 1 and 2 without typing coordinates

Ultrasonic sensors measure distance only, so the system cannot work out on its own *where* Sensors 1 and 2 are or which way they face (that would need extra hardware such as a compass or radio positioning). Detection does not need their positions — calibration is automatic in any room. Positions are only for drawing the map, and the live view makes setting them quick:

1. Put the device in the new room, power it on with the area empty (≈20 s calibration).
2. Open **http://localhost:8000/sim?mode=live** (or *Live room ↗* in the dashboard header). This view never acts as a device; it shows the **real** readings: beams, scan points and events.
3. Pick or create the room. Press **Fit left/right/front walls to the real scan** — the cyan outline shows the surfaces Sensor 3 really sees; add furniture where the outline shows it.
4. Drag Sensors 1 and 2 to roughly where they really are, press **Auto-aim both sensors**, and check that both rows of the **Placement check** are green (model prediction vs the real sensor's baseline).
5. **Save room** (e.g. "Lab 3"). Saved rooms are stored on the backend; next time choose the room (3D view, or dashboard Settings → Sensor placement → *Use this room*).

**Was a sensor moved?** If a fixed sensor's view stays different from its baseline, without movement, for 30 s, the dashboard asks whether it was moved or something was left in front of it, with one-click *Recalibrate*, *Update its position (live 3D)* or *Dismiss*. Ultrasound cannot tell those two cases apart, so the system asks instead of guessing.

### Automated check

```powershell
# with backend + simulator running, in C:\IOTProject\backend
python tests\smoke_test.py
```

---

## 6. Android app (optional)

A small Android app (`android/`, package `com.arcguard.app`, Android 7.0+) shows the same live dashboard full-screen on the phone and adds:

- **Vibration + notifications** for *possible movement* and *anomaly* events (a notification only while the app is in the background; tapping it opens the Events tab). Background alerts work only while Android keeps the app running — it is not a guaranteed alarm.
- A **connect screen** (backend address, *Test* button, notification and keep-screen-on options), reachable later from the **⚙ App** button in the dashboard header (shown only inside the app).
- A "Not connected" screen that **retries every 5 s**, CSV downloads to *Downloads*, and the Back button works inside the dashboard.

The dashboard itself is not duplicated: the app loads it from the backend, so dashboard changes appear in the app without rebuilding it.

### Build and install

Needs Android Studio (for its SDK in `%LOCALAPPDATA%\Android\Sdk` and its bundled JDK) — no Gradle and no internet. On the phone: enable *Developer options → USB debugging*, plug it in and accept the "Allow USB debugging" prompt.

```powershell
# in C:\IOTProjectndroid  — builds build\ArcGuard.apk; -Install also installs it, runs adb reverse and opens the app
powershell -ExecutionPolicy Bypass -File build.ps1 -Install
```

Without `-Install` it only builds `build\ArcGuard.apk`, which can be copied to the phone and installed by hand (allow "install unknown apps").

### Connect

Start the backend first (section 5), then in the app's connect screen:

| Connection | Address in the app | Notes |
|---|---|---|
| **USB cable** | `http://localhost:8000` | Run `adb reverse tcp:8000 tcp:8000` (in `%LOCALAPPDATA%\Android\Sdk\platform-tools`) again after every re-plug. `build.ps1 -Install` does it for you. |
| **Wi-Fi** | `http://<laptop-ip>:8000` | Phone on the same network as the laptop; laptop IPv4 from `ipconfig` (e.g. `192.168.1.5`). Allow Python through Windows Firewall on private networks. |

The *Live room ↗* and *3D sim ↗* views open inside the app as well (Back returns to the dashboard).

---

## How detection works (short version)

- **Sequential pinging:** only one sensor fires at a time (S1 → S2 → S3), with a 12 ms gap, so they never hear each other. Echoes are timed by interrupts; nothing blocks.
- **Scanning:** the servo moves Sensor 3 in 5° steps from 0° to 180° and back (≈3–4 s per sweep). Each reading is tagged with its angle on the ESP32.
- **Baseline:** at start-up (or *Recalibrate*), 20 samples per fixed sensor and 5 sweeps per scan angle → baseline = median, noise σ = 1.4826 × MAD.
- **Change:** `|distance − baseline| > max(τ_abs, k·σ)`; it must persist for M readings and T_min before it is confirmed.
- **Movement events:** MOTION (fast change), TRANSIENT (came and went), SHIFT (change moved to a nearby angle between sweeps), RADIAL (range at that angle moved).
- **Anomaly events:** OBJECT_APPEARED / OBJECT_DISAPPEARED (change persisted beyond the dwell time), SUDDEN_CHANGE, PATTERN (many angles changed in one sweep), SENSOR_FAULT (sensor stopped answering).

All thresholds are adjustable in the dashboard **Settings** tab; changes are acknowledged by the ESP32 before they show as *Applied*.

---

## Limitations (stated honestly)

- Ultrasonic sensors measure distance only — the system reports *possible* movement, not people.
- Range ≈ 2–400 cm; soft (clothing, curtains) and angled surfaces may return no echo.
- Beam ≈ 15° wide, so the scan map is coarse; each angle is revisited only once per sweep.
- No antenna is fitted on the WROOM-32U, so keep the Wi-Fi access point within 1–2 m.
- The servo is powered from USB 5 V; a weak port can cause brown-out resets (see Troubleshooting).
