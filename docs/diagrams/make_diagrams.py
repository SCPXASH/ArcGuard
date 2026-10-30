"""Generates every project diagram as SVG, then renders PNGs with headless Edge.

Run:  python docs/diagrams/make_diagrams.py
Output: docs/diagrams/svg/*.svg and docs/diagrams/png/*.png
"""
import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
SVG_DIR = HERE / "svg"
PNG_DIR = HERE / "png"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

FONT = "Segoe UI, Arial, sans-serif"

# Wire colours (shared by the breadboard diagram, legend and report tables)
C = {
    "3v3": "#e53935", "5v": "#8b0000", "gnd": "#212121",
    "s1t": "#f9a825", "s1e": "#2e7d32",
    "s2t": "#1e88e5", "s2e": "#8e24aa",
    "s3t": "#d81b60", "s3e": "#00897b",
    "servo": "#ef6c00", "buzz": "#6d4c41",
}


def svg_doc(w, h, body, bg="#ffffff"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="0 0 {w} {h}" font-family="{FONT}">'
            f'<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0,0 L10,5 L0,10 z" fill="#37474f"/></marker>'
            f'<marker id="arrB" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0,0 L10,5 L0,10 z" fill="#1565c0"/></marker>'
            f'<filter id="sh" x="-5%" y="-5%" width="110%" height="110%"><feDropShadow dx="1" dy="1.5" stdDeviation="1.2" flood-opacity=".35"/></filter>'
            f'</defs><rect width="100%" height="100%" fill="{bg}"/>{body}</svg>')


def text(x, y, s, size=14, weight="normal", fill="#212121", anchor="start", style=""):
    s = str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}" {style}>{s}</text>')


def box(x, y, w, h, title, lines=(), fill="#e3f2fd", stroke="#1565c0", tsize=15, lsize=12.5, rx=10):
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>']
    if lines:
        out.append(text(x + w / 2, y + 22, title, tsize, "bold", "#102027", "middle"))
        for i, ln in enumerate(lines):
            out.append(text(x + w / 2, y + 42 + i * 17, ln, lsize, fill="#37474f", anchor="middle"))
    else:
        out.append(text(x + w / 2, y + h / 2 + 5, title, tsize, "bold", "#102027", "middle"))
    return "".join(out)


def arrow(pts, color="#37474f", width=1.8, dash=None, marker="arr", both=False):
    d = "M" + " L".join(f"{x},{y}" for x, y in pts)
    da = f'stroke-dasharray="{dash}"' if dash else ""
    ms = f'marker-start="url(#{marker})"' if both else ""
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" {da} '
            f'marker-end="url(#{marker})" {ms}/>')


def label(x, y, s, size=12, fill="#455a64", anchor="middle", bg=True):
    w = len(s) * size * 0.56 + 8
    rect = ""
    if bg:
        bx = x - w / 2 if anchor == "middle" else (x - 4 if anchor == "start" else x - w + 4)
        rect = f'<rect x="{bx}" y="{y - size}" width="{w}" height="{size + 6}" rx="3" fill="#ffffff" opacity=".92"/>'
    return rect + text(x, y, s, size, fill=fill, anchor=anchor)


# --------------------------------------------------------------------------
# 1. Breadboard wiring diagram
# --------------------------------------------------------------------------
def breadboard():
    W, H = 1220, 1340
    o = []
    o.append(text(W / 2, 38, "Arc Guard — Breadboard Wiring (ESP32-WROOM-32U DevKit, 38-pin)", 24, "bold", "#0d47a1", "middle"))
    o.append(text(W / 2, 64, "All sensors and buzzer on 3.3 V (no resistors needed)  •  Servo on 5 V  •  One common ground", 15, fill="#455a64", anchor="middle"))

    def ry(r):  # y of breadboard row r (1..40)
        return 120 + 20 * r
    cols = {"L-": 330, "L+": 350, "a": 400, "b": 420, "c": 440, "d": 460, "e": 480,
            "f": 540, "g": 560, "h": 580, "i": 600, "j": 620, "R+": 670, "R-": 690}

    # breadboard body
    o.append('<rect x="305" y="112" width="410" height="842" rx="10" fill="#f5f5f0" stroke="#bdbdbd" stroke-width="2"/>')
    o.append('<rect x="503" y="118" width="14" height="830" fill="#e0e0d8"/>')
    # rail stripes
    for x, col in ((cols["L-"], "#1e88e5"), (cols["L+"], "#e53935"), (cols["R+"], "#e53935"), (cols["R-"], "#1e88e5")):
        o.append(f'<line x1="{x}" y1="125" x2="{x}" y2="945" stroke="{col}" stroke-width="1" opacity=".35"/>')
    # holes
    for r in range(1, 41):
        y = ry(r)
        for k, x in cols.items():
            o.append(f'<rect x="{x - 3.5}" y="{y - 3.5}" width="7" height="7" rx="1.2" fill="#4e4e4e"/>')
        if r % 5 == 0 or r == 1:
            o.append(text(523 - 13, y + 4, str(r), 9.5, fill="#9e9e9e", anchor="end"))
    for k in "abcde":
        o.append(text(cols[k], 132 - 14, k, 11, "bold", "#757575", "middle"))
    for k in "fghij":
        o.append(text(cols[k], 132 - 14, k, 11, "bold", "#757575", "middle"))
    # rail labels at bottom
    o.append(text(330, 972, "−", 16, "bold", "#1e88e5", "middle"))
    o.append(text(350, 972, "+", 16, "bold", "#e53935", "middle"))
    o.append(text(670, 972, "+", 16, "bold", "#e53935", "middle"))
    o.append(text(690, 972, "−", 16, "bold", "#1e88e5", "middle"))
    o.append(text(680, 112, "3.3V", 11, "bold", "#c62828", "start"))
    o.append(text(362, 990, "5V", 11, "bold", "#8b0000", "start"))

    # ESP32 board (right header in column a rows 6..24, left header hangs off the board)
    o.append('<rect x="178" y="196" width="232" height="460" rx="8" fill="#1b1b1b" stroke="#000" filter="url(#sh)"/>')
    o.append('<rect x="248" y="205" width="104" height="120" rx="3" fill="#b0b0b0" stroke="#8a8a8a"/>')
    o.append(text(300, 232, "ESP32-", 12, "bold", "#212121", "middle"))
    o.append(text(300, 248, "WROOM-32U", 12, "bold", "#212121", "middle") + text(300, 266, "U.FL socket,", 10.5, fill="#333", anchor="middle"))
    o.append(text(300, 280, "no antenna", 10.5, fill="#333", anchor="middle"))
    o.append('<circle cx="340" cy="214" r="5" fill="#c9a227"/>')
    o.append('<rect x="275" y="630" width="50" height="34" rx="3" fill="#9e9e9e" stroke="#616161"/>')
    o.append(text(128, 650, "micro-USB →", 11.5, fill="#455a64", anchor="end") + text(128, 666, "laptop / power bank", 11.5, fill="#455a64", anchor="end"))
    o.append(text(213, 640, "EN", 10, fill="#ccc", anchor="middle"))
    o.append(text(385, 640, "BOOT", 10, fill="#ccc", anchor="middle"))
    right = ["GND", "23", "22", "TX", "RX", "21", "GND", "19", "18", "5", "17", "16", "4", "0", "2", "15", "D1", "D0", "CLK"]
    left = ["3V3", "EN", "VP", "VN", "34", "35", "32", "33", "25", "26", "27", "14", "12", "GND", "13", "D2", "D3", "CMD", "5V"]
    used_r = {"23", "22", "21", "19", "18", "17", "16", "4"}
    avoid = {"TX", "RX", "5", "0", "2", "15", "D1", "D0", "CLK"}
    for i, (lp, rp) in enumerate(zip(left, right)):
        y = ry(6 + i)
        o.append(f'<circle cx="400" cy="{y}" r="5" fill="#d4af37" stroke="#7a5c00"/>')
        o.append(f'<circle cx="200" cy="{y}" r="5" fill="#d4af37" stroke="#7a5c00"/>')
        rc = "#7CFC00" if rp in used_r else ("#ff8a80" if rp in avoid else "#eeeeee")
        lc = "#7CFC00" if lp in ("3V3", "5V", "GND") and lp != "GND" else "#bdbdbd"
        o.append(text(388, y + 4, rp, 10.5, "bold", rc, "end"))
        o.append(text(212, y + 4, lp, 10.5, "bold", lc, "start"))
    o.append(text(80, ry(6) - 26, "Left header hangs", 11.5, "bold", "#455a64", "middle"))
    o.append(text(80, ry(6) - 11, "off the breadboard", 11.5, "bold", "#455a64", "middle"))
    o.append(text(80, ry(9), "use female→male", 11, fill="#455a64", anchor="middle"))
    o.append(text(80, ry(9) + 15, "jumpers on 3V3,", 11, fill="#455a64", anchor="middle"))
    o.append(text(80, ry(9) + 30, "5V and GND", 11, fill="#455a64", anchor="middle"))
    o.append(text(80, ry(13), "Right header →", 11.5, "bold", "#1565c0", "middle")); o.append(text(80, ry(13) + 15, "column a, rows 6–24", 11.5, "bold", "#1565c0", "middle"))

    def wire(pts, color, w=5):
        d = "M" + " L".join(f"{x},{y}" for x, y in pts)
        s = (f'<path d="{d}" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="{w + 2.5}" stroke-linejoin="round" stroke-linecap="round"/>'
             f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linejoin="round" stroke-linecap="round"/>')
        for x, y in (pts[0], pts[-1]):
            s += f'<rect x="{x - 4}" y="{y - 4}" width="8" height="8" rx="1.5" fill="#263238"/>'
        return s

    # power
    o.append(wire([(200, ry(6)), (170, ry(6)), (170, 92), (670, 92), (670, ry(1))], C["3v3"]))
    o.append(label(430, 87, "3V3 pin → right + rail (3.3 V)", 12, "#b71c1c"))
    o.append(wire([(200, ry(24)), (200, ry(31)), (350, ry(31))], C["5v"]))
    o.append(label(250, ry(31) + 22, "5V pin → left + rail", 11.5, "#8b0000"))
    o.append(wire([(200, ry(19)), (140, ry(19)), (140, ry(33)), (330, ry(33))], C["gnd"]))
    o.append(label(225, ry(33) + 22, "GND pin → left − rail", 11.5, "#212121"))
    o.append(wire([(330, ry(3)), (690, ry(3))], C["gnd"]))
    o.append(label(600, ry(3) - 8, "GND bridge: left − ↔ right −", 11.5, "#212121"))

    # sensors (pins facing left at x=880)
    PX = 880

    def module(y0, pins, title, sub, color="#1565c0"):
        n = len(pins)
        h = n * 20 + 40
        s = f'<rect x="{PX}" y="{y0 - 30}" width="230" height="{h}" rx="8" fill="{color}" filter="url(#sh)"/>'
        s += f'<circle cx="{PX + 165}" cy="{y0 - 30 + h / 2}" r="{min(30, h / 2 - 6)}" fill="#cfd8dc" stroke="#90a4ae" stroke-width="3"/>'
        s += text(PX + 12, y0 - 12, title, 13.5, "bold", "#fff")
        s += text(PX + 12, y0 + n * 20 + 2, sub, 10.5, fill="#e3f2fd")
        for i, p in enumerate(pins):
            y = y0 + i * 20
            s += f'<rect x="{PX - 6}" y="{y - 3}" width="12" height="6" fill="#d4af37"/>'
            s += text(PX + 12, y + 4, p, 11, "bold", "#fff")
        return s

    # S1  rows 7/8  (GPIO23 / GPIO22)
    o.append(wire([(480, ry(7)), (PX, ry(7))], C["s1t"]))
    o.append(wire([(480, ry(8)), (PX, ry(8))], C["s1e"]))
    o.append(wire([(PX, ry(6)), (670, ry(6))], C["3v3"], 4))
    o.append(wire([(PX, ry(9)), (690, ry(9))], C["gnd"], 4))
    o.append(module(ry(6), ["VCC", "TRIG", "ECHO", "GND"], "SENSOR 1 (fixed)", "HC-SR04 (3–5.5 V type)"))
    # S2  rows 13/14 (GPIO19 / GPIO18)
    o.append(wire([(480, ry(13)), (PX, ry(13))], C["s2t"]))
    o.append(wire([(480, ry(14)), (PX, ry(14))], C["s2e"]))
    o.append(wire([(PX, ry(12)), (670, ry(12))], C["3v3"], 4))
    o.append(wire([(PX, ry(15)), (690, ry(15))], C["gnd"], 4))
    o.append(module(ry(12), ["VCC", "TRIG", "ECHO", "GND"], "SENSOR 2 (fixed)", "HC-SR04 (3–5.5 V type)"))
    # S3  rows 16/17 (GPIO17 / GPIO16) -> module lower
    s3y = ry(26)
    o.append(wire([(480, ry(16)), (580, ry(16)), (580, s3y + 20), (PX, s3y + 20)], C["s3t"]))
    o.append(wire([(480, ry(17)), (560, ry(17)), (560, s3y + 40), (PX, s3y + 40)], C["s3e"]))
    o.append(wire([(PX, s3y), (670, s3y)], C["3v3"], 4))
    o.append(wire([(PX, s3y + 60), (690, s3y + 60)], C["gnd"], 4))
    o.append(module(s3y, ["VCC", "Trig/Tx", "Echo/Rx", "GND", "GND (n/c)"], "SENSOR 3 (on servo)", "US-100-type, 5-pin", "#2e7d32"))
    # Buzzer row 18 (GPIO4)
    bzy = ry(35)
    o.append(wire([(480, ry(18)), (540, ry(18)), (540, bzy + 20), (PX, bzy + 20)], C["buzz"]))
    o.append(wire([(PX, bzy), (670, bzy)], C["3v3"], 4))
    o.append(wire([(PX, bzy + 40), (690, bzy + 40)], C["gnd"], 4))
    o.append(f'<rect x="{PX}" y="{bzy - 30}" width="230" height="100" rx="8" fill="#37474f" filter="url(#sh)"/>')
    o.append(f'<circle cx="{PX + 175}" cy="{bzy + 20}" r="30" fill="#111" stroke="#666" stroke-width="3"/>')
    o.append(text(PX + 12, bzy - 12, "BUZZER MH-FMD", 13.5, "bold", "#fff"))
    for i, p in enumerate(["VCC", "I/O", "GND"]):
        o.append(f'<rect x="{PX - 6}" y="{bzy + i * 20 - 3}" width="12" height="6" fill="#d4af37"/>')
        o.append(text(PX + 12, bzy + i * 20 + 4, p, 11, "bold", "#fff"))
    o.append(text(PX + 12, bzy + 62, "LOW on I/O = sound", 10.5, fill="#eceff1"))

    # Servo (bottom-left), signal row 11 (GPIO21) via column c
    svx, svy = 300, 1040
    o.append(wire([(440, ry(11)), (440, svy - 50), (390, svy - 50), (390, svy - 12)], C["servo"]))
    o.append(wire([(330, ry(38)), (330, svy - 12)], "#5d4037", 4.5))
    o.append(wire([(350, ry(38)), (350, svy - 30), (360, svy - 30), (360, svy - 12)], C["5v"], 4.5))
    o.append(f'<rect x="{svx - 10}" y="{svy - 12}" width="140" height="80" rx="6" fill="#1565c0" filter="url(#sh)"/>')
    o.append(f'<circle cx="{svx + 30}" cy="{svy + 28}" r="18" fill="#e3f2fd"/>')
    o.append(text(svx + 60, svy + 20, "MG90S", 13, "bold", "#fff"))
    o.append(text(svx + 60, svy + 38, "servo", 12, fill="#fff"))
    o.append(text(svx + 60, svy + 55, "brn/red/org", 10.5, fill="#bbdefb"))
    o.append(label(470, svy - 58, "orange signal → row 11, col c (GPIO21)", 11.5, "#e65100", "start"))
    o.append(label(448, ry(11) - 7, "GPIO21", 10, "#e65100", "start"))

    # row callouts (GPIO tags) placed in column b/c gap for clarity
    tags = [(7, "GPIO23"), (8, "GPIO22"), (13, "GPIO19"), (14, "GPIO18"),
            (16, "GPIO17"), (17, "GPIO16"), (18, "GPIO4")]
    for r, t in tags:
        o.append(text(728, ry(r) - 5, t, 10, "bold", "#37474f", "start"))

    # legend
    lx, ly = 880, 920
    o.append(f'<rect x="{lx}" y="{ly}" width="300" height="400" rx="8" fill="#fafafa" stroke="#cfd8dc"/>')
    o.append(text(lx + 12, ly + 24, "WIRE COLOURS", 13, "bold", "#0d47a1"))
    leg = [("3v3", "3.3 V power"), ("5v", "5 V power (servo)"), ("gnd", "Ground"),
           ("s1t", "S1 TRIG  → GPIO23"), ("s1e", "S1 ECHO → GPIO22"),
           ("s2t", "S2 TRIG  → GPIO19"), ("s2e", "S2 ECHO → GPIO18"),
           ("s3t", "S3 Trig/Tx → GPIO17"), ("s3e", "S3 Echo/Rx → GPIO16"),
           ("servo", "Servo signal → GPIO21"), ("buzz", "Buzzer I/O → GPIO4")]
    for i, (k, s) in enumerate(leg):
        y = ly + 50 + i * 24
        o.append(f'<line x1="{lx + 14}" y1="{y - 4}" x2="{lx + 50}" y2="{y - 4}" stroke="{C[k]}" stroke-width="6" stroke-linecap="round"/>')
        o.append(text(lx + 60, y, s, 12, fill="#263238"))
    y = ly + 50 + len(leg) * 24 + 4
    o.append(text(lx + 12, y, "Green label = pin used", 11, fill="#2e7d32"))
    o.append(text(lx + 12, y + 16, "Red label = do NOT use", 11, fill="#c62828"))
    o.append(text(lx + 12, y + 32, "(boot/flash/serial pins)", 11, fill="#c62828"))
    o.append(text(lx + 12, y + 56, "Right rails: + = 3.3 V, − = GND", 11.5, "bold", "#263238"))
    o.append(text(lx + 12, y + 72, "Left rails: + = 5 V (servo only), − = GND", 11.5, "bold", "#263238"))
    return svg_doc(W, H, "".join(o))


# --------------------------------------------------------------------------
# 2. Hardware block diagram
# --------------------------------------------------------------------------
def block():
    W, H = 1100, 560
    o = [text(W / 2, 36, "Hardware Block Diagram", 22, "bold", "#0d47a1", "middle")]
    o.append(box(430, 200, 240, 150, "ESP32-WROOM-32U", ["Dual-core 240 MHz", "Wi-Fi 802.11 b/g/n (2.4 GHz)",
                                                          "on-board 3.3 V regulator", "LEDC PWM • GPIO • NVS"],
                 fill="#ede7f6", stroke="#5e35b1"))
    o.append(box(40, 70, 250, 80, "Sensor 1 (fixed)", ["Ultrasonic, 2–400 cm", "TRIG 23 • ECHO 22"]))
    o.append(box(40, 180, 250, 80, "Sensor 2 (fixed)", ["Ultrasonic, 2–400 cm", "TRIG 19 • ECHO 18"]))
    o.append(box(40, 290, 250, 80, "Sensor 3 (scanning)", ["US-100 type, on servo horn", "Trig/Tx 17 • Echo/Rx 16"]))
    o.append(box(40, 400, 250, 80, "MG90S Servo", ["0–180°, 50 Hz PWM", "Signal GPIO21 • 5 V"], fill="#fff3e0", stroke="#ef6c00"))
    o.append(box(810, 80, 250, 80, "USB 5 V supply", ["Laptop port or power bank", "→ 5V pin / regulator"], fill="#ffebee", stroke="#c62828"))
    o.append(box(810, 235, 250, 80, "Buzzer MH-FMD", ["Local audible alarm", "I/O GPIO4 (active LOW)"], fill="#efebe9", stroke="#6d4c41"))
    o.append(box(810, 390, 250, 80, "Laptop / Server", ["FastAPI + SQLite", "Web dashboard"], fill="#e8f5e9", stroke="#2e7d32"))
    for y in (110, 220, 330):
        o.append(arrow([(290, y), (430, 275)], both=True))
    o.append(arrow([(430, 320), (290, 440)]))
    o.append(label(360, 200, "TRIG / ECHO (3.3 V)", 11.5))
    o.append(label(345, 405, "PWM", 11.5))
    o.append(arrow([(810, 120), (670, 220)], color="#c62828"))
    o.append(label(745, 150, "5 V", 11.5, "#c62828"))
    o.append(arrow([(670, 275), (810, 275)]))
    o.append(arrow([(670, 320), (810, 430)], color="#1565c0", marker="arrB", both=True))
    o.append(label(745, 395, "Wi-Fi • WebSocket", 11.5, "#1565c0"))
    o.append(text(W / 2, 530, "3.3 V from the on-board regulator feeds all three sensors and the buzzer; the servo draws from the USB 5 V line. All grounds are common.",
                  13, fill="#455a64", anchor="middle"))
    return svg_doc(W, H, "".join(o))


# --------------------------------------------------------------------------
# 3. System architecture
# --------------------------------------------------------------------------
def architecture():
    W, H = 1200, 840
    o = [text(W / 2, 36, "Arc Guard — System Architecture", 22, "bold", "#0d47a1", "middle")]
    layers = [
        (70, "SENSING LAYER", "#fff8e1", "#f9a825"),
        (230, "EDGE LAYER — ESP32 FIRMWARE (Arduino / C++)", "#ede7f6", "#5e35b1"),
        (450, "NETWORK + BACKEND LAYER (Python FastAPI on laptop)", "#e8f5e9", "#2e7d32"),
        (640, "PRESENTATION LAYER (web dashboard: HTML/JS + Chart.js, any browser)", "#e3f2fd", "#1565c0"),
    ]
    hts = [130, 190, 160, 150]
    for (y, t, f, s), h in zip(layers, hts):
        o.append(f'<rect x="20" y="{y}" width="{W - 40}" height="{h}" rx="12" fill="{f}" stroke="{s}" stroke-width="1.5"/>')
        o.append(text(36, y + 22, t, 13.5, "bold", s))
    # sensing
    for i, (t, l) in enumerate([("Sensor 1", "fixed zone A"), ("Sensor 2", "fixed zone B"),
                                ("Sensor 3", "on servo, 0–180°"), ("MG90S Servo", "rotates S3"),
                                ("Buzzer", "local alarm")]):
        o.append(box(50 + i * 225, 105, 200, 76, t, [l], fill="#fff", stroke="#f9a825"))
    # firmware modules
    mods = [("Ping Scheduler", ["one sensor at a time", "echo timeout 25 ms"]),
            ("Signal Filter", ["range check • median-3", "invalid → flagged"]),
            ("Baseline Model", ["per sensor & per angle", "median + MAD noise"]),
            ("Detector FSM", ["movement events", "anomaly events"]),
            ("Comms + Config", ["WebSocket client", "NVS settings, reconnect"])]
    for i, (t, l) in enumerate(mods):
        x = 50 + i * 225
        o.append(box(x, 270, 200, 90, t, l, fill="#fff", stroke="#5e35b1"))
        if i < 4:
            o.append(arrow([(x + 200, 315), (x + 225, 315)]))
    o.append(box(50, 375, 425, 35, "Servo Sweep Controller (non-blocking, settle time)", fill="#fff", stroke="#5e35b1", tsize=13))
    o.append(box(500, 375, 425, 35, "Alarm Controller (buzzer pattern on confirmed event)", fill="#fff", stroke="#5e35b1", tsize=13))
    o.append(arrow([(150, 181), (150, 270)], both=True))
    o.append(label(205, 225, "TRIG/ECHO ×3", 11.5, anchor="start"))
    o.append(arrow([(487, 375), (487, 195), (825, 195), (825, 181)]))
    o.append(label(660, 207, "PWM angle", 11.5))
    o.append(arrow([(937, 375), (937, 205), (1050, 205), (1050, 181)]))
    o.append(label(990, 222, "alarm", 11.5))
    # backend
    be = [("Device WS endpoint", ["/ws/device", "heartbeat, ack"]),
          ("Ingest + Status", ["validate, online/offline", "event dedupe"]),
          ("SQLite DB", ["readings • scan_points", "events • settings"]),
          ("REST API", ["/api/status /events", "/api/settings /commands"]),
          ("Live Broadcaster", ["/ws/dashboard", "push to all browsers"])]
    for i, (t, l) in enumerate(be):
        x = 50 + i * 225
        o.append(box(x, 495, 200, 90, t, l, fill="#fff", stroke="#2e7d32"))
    o.append(arrow([(250, 540), (275, 540)]))
    o.append(arrow([(475, 540), (500, 540)]))
    o.append(arrow([(700, 540), (725, 540)], both=True))
    o.append(arrow([(375, 585), (375, 600), (1050, 600), (1050, 585)]))
    o.append(arrow([(1075, 360), (1075, 400), (1160, 400), (1160, 600), (150, 600), (150, 585)], color="#1565c0", marker="arrB", both=True))
    o.append(label(1100, 430, "Wi-Fi 2.4 GHz", 11.5, "#1565c0"))
    o.append(label(1100, 447, "WebSocket JSON", 11.5, "#1565c0"))
    # presentation
    ui = [("Overview", "status • counters"), ("Sensor Panels", "S1 • S2 • S3"), ("Radar View", "0–180° polar map"),
          ("Live Charts + Logs", "history, filters"), ("Settings", "thresholds, scan, calibrate")]
    for i, (t, l) in enumerate(ui):
        o.append(box(50 + i * 225, 680, 200, 76, t, [l], fill="#fff", stroke="#1565c0"))
    o.append(arrow([(1050, 585), (1050, 640), (600, 640), (600, 680)], color="#1565c0", marker="arrB"))
    o.append(label(900, 635, "live updates (WebSocket)", 11.5, "#1565c0"))
    o.append(arrow([(925, 680), (925, 660), (825, 660), (825, 585)], dash="5 4"))
    o.append(label(870, 672, "REST (settings, history)", 11, "#37474f"))
    o.append(text(W / 2, 822, "Settings flow: Dashboard → REST → backend stores → pushed to ESP32 → ESP32 applies, saves to NVS, ACKs → dashboard shows “Applied”.",
                  13, fill="#455a64", anchor="middle"))
    return svg_doc(W, H, "".join(o))


# --------------------------------------------------------------------------
# 4. Detection state machine
# --------------------------------------------------------------------------
def detection():
    W, H = 1200, 700
    o = [text(W / 2, 36, "Detection Logic (runs per fixed sensor and per scan angle)", 22, "bold", "#0d47a1", "middle")]
    o.append(box(40, 80, 230, 110, "New reading d", ["valid if 2 ≤ d ≤ 400 cm", "and echo did not time out", "median of last 3 samples"], fill="#fff8e1", stroke="#f9a825"))
    o.append(box(340, 80, 250, 110, "Deviation", ["Δ = d − baseline b", "τ = max(τ_abs , k·σ)", "rate r = Δd / Δt"], fill="#fff8e1", stroke="#f9a825"))
    o.append(arrow([(270, 135), (340, 135)]))
    states = [(80, 300, "IDLE", "|Δ| ≤ τ"), (360, 300, "CANDIDATE", "|Δ| > τ, count < M"),
              (660, 300, "CONFIRMED", "count ≥ M and t ≥ T_min"), (960, 300, "COOLDOWN", "suppress repeats")]
    for x, y, t, l in states:
        o.append(f'<rect x="{x}" y="{y}" width="190" height="80" rx="40" fill="#ede7f6" stroke="#5e35b1" stroke-width="2"/>')
        o.append(text(x + 95, y + 35, t, 16, "bold", "#311b92", "middle"))
        o.append(text(x + 95, y + 56, l, 12, fill="#4527a0", anchor="middle"))
    o.append(arrow([(465, 190), (455, 300)]))
    o.append(arrow([(270, 330), (360, 330)]))
    o.append(label(315, 322, "|Δ| > τ", 11.5))
    o.append(arrow([(360, 355), (270, 355)]))
    o.append(label(315, 375, "back within τ", 11.5))
    o.append(arrow([(550, 340), (660, 340)]))
    o.append(label(605, 332, "M valid in a row", 11.5))
    o.append(arrow([(850, 340), (960, 340)]))
    o.append(arrow([(1055, 380), (1055, 430), (175, 430), (175, 380)]))
    o.append(label(615, 445, "after cooldown time and |Δ| ≤ τ", 11.5))
    # classification
    o.append(box(560, 490, 300, 60, "Classify confirmed change", fill="#e8f5e9", stroke="#2e7d32"))
    o.append(arrow([(755, 380), (710, 490)]))
    o.append(box(60, 590, 520, 95, "MOVEMENT event (dynamic)", ["|rate| > r_min,  or change returns to baseline,", "or S3 change shifts to neighbouring angles between sweeps"],
                 fill="#e3f2fd", stroke="#1565c0"))
    o.append(box(620, 590, 540, 95, "ANOMALY event (environment state)", ["OBJECT_APPEARED (Δ < −τ, persists ≥ T_dwell) • OBJECT_DISAPPEARED (Δ > +τ)",
                                                                           "SUDDEN_CHANGE (|d_t − d_t−1| > J) • PATTERN (≥ K angles in one sweep)",
                                                                           "SENSOR_FAULT (≥ F invalid readings in a row)"], fill="#fff3e0", stroke="#ef6c00", lsize=11.5))
    o.append(arrow([(620, 550), (320, 590)]))
    o.append(arrow([(800, 550), (890, 590)]))
    o.append(box(900, 80, 260, 110, "Baseline (calibration)", ["N = 20 samples per direction", "b = median, σ = 1.4826·MAD", "re-run from dashboard"], fill="#f3e5f5", stroke="#8e24aa"))
    o.append(arrow([(900, 135), (590, 135)], dash="5 4"))
    return svg_doc(W, H, "".join(o))


# --------------------------------------------------------------------------
# 5. Measurement schedule
# --------------------------------------------------------------------------
def schedule():
    W, H = 1200, 420
    o = [text(W / 2, 36, "Sequential Measurement Schedule (one ping in flight at a time)", 22, "bold", "#0d47a1", "middle")]
    x0, scale = 150, 4.4  # px per ms
    rows = [("Sensor 1", 100, "#f9a825"), ("Sensor 2", 160, "#1e88e5"), ("Sensor 3", 220, "#2e7d32"), ("Servo", 280, "#ef6c00")]
    for name, y, col in rows:
        o.append(text(x0 - 15, y + 24, name, 14, "bold", "#263238", "end"))
        o.append(f'<line x1="{x0}" y1="{y + 40}" x2="{x0 + 230 * scale}" y2="{y + 40}" stroke="#eceff1"/>')
    # one cycle ~ 110 ms repeated twice
    for c in range(2):
        b = x0 + c * 115 * scale
        segs = [(100, 0, 25, "ping S1"), (160, 37, 25, "ping S2"), (280, 37, 8, ""), (280, 45, 37, "settle"), (220, 82, 25, "ping S3 @θ")]
        for y, st, du, lb in segs:
            col = {100: "#f9a825", 160: "#1e88e5", 220: "#2e7d32", 280: "#ef6c00"}[y]
            op = ".35" if lb == "settle" else "1"
            o.append(f'<rect x="{b + st * scale}" y="{y + 10}" width="{du * scale}" height="28" rx="4" fill="{col}" opacity="{op}"/>')
            if lb:
                o.append(text(b + (st + du / 2) * scale, y + 29, lb, 11.5, "bold", "#fff" if op == "1" else "#bf360c", "middle"))
        o.append(text(b + 41 * scale, 284, "step θ→θ+5°", 11, fill="#bf360c", anchor="middle"))
    for ms in range(0, 231, 25):
        o.append(f'<line x1="{x0 + ms * scale}" y1="330" x2="{x0 + ms * scale}" y2="336" stroke="#607d8b"/>')
        o.append(text(x0 + ms * scale, 352, f"{ms} ms", 11, fill="#607d8b", anchor="middle"))
    o.append(f'<line x1="{x0}" y1="330" x2="{x0 + 230 * scale}" y2="330" stroke="#607d8b"/>')
    o.append(text(W / 2, 385, "≈12 ms gaps between pings let echoes die out. One cycle ≈ 110 ms → fixed sensors ≈ 9 Hz each; 37 scan steps (0–180° at 5°) ≈ 4 s per sweep.",
                  13, fill="#455a64", anchor="middle"))
    o.append(text(W / 2, 405, "Servo moves while S1/S2 ping, so settling costs no extra time. Sweep runs 0→180 then 180→0 (no jump-back).", 13, fill="#455a64", anchor="middle"))
    return svg_doc(W, H, "".join(o))


# --------------------------------------------------------------------------
# 6. Demo layout (top view)
# --------------------------------------------------------------------------
def demo_layout():
    import math
    W, H = 1100, 760
    o = [text(W / 2, 36, "Demo Placement — Top View (table at front of classroom)", 22, "bold", "#0d47a1", "middle")]
    cx, cy, R = 550, 420, 300
    o.append(f'<rect x="60" y="70" width="980" height="640" rx="6" fill="#fafafa" stroke="#b0bec5" stroke-dasharray="8 6"/>')
    o.append(text(80, 95, "Demo area (≈ 3 m × 2 m)", 13, fill="#78909c"))
    # scan arc
    o.append(f'<path d="M{cx - R},{cy} A{R},{R} 0 0 1 {cx + R},{cy} Z" fill="#c8e6c9" fill-opacity=".45" stroke="#2e7d32" stroke-width="1.5"/>')
    for a in range(0, 181, 30):
        x = cx + R * math.cos(math.radians(a)); y = cy - R * math.sin(math.radians(a))
        o.append(f'<line x1="{cx}" y1="{cy}" x2="{x:.1f}" y2="{y:.1f}" stroke="#2e7d32" stroke-opacity=".35"/>')
        tx = cx + (R + 22) * math.cos(math.radians(a)); ty = cy - (R + 22) * math.sin(math.radians(a))
        o.append(text(f"{tx:.1f}", f"{ty + 4:.1f}", f"{a}°", 12, "bold", "#2e7d32", "middle"))
    for rr, lb in ((100, "1 m"), (200, "2 m"), (300, "3 m")):
        o.append(f'<path d="M{cx - rr},{cy} A{rr},{rr} 0 0 1 {cx + rr},{cy}" fill="none" stroke="#2e7d32" stroke-opacity=".3" stroke-dasharray="4 4"/>')
        o.append(text(cx + rr - 4, cy - 6, lb, 11, fill="#2e7d32", anchor="end"))
    # fixed beams (pointing back-left and back-right, outside the scan arc)
    for ang, name, col in ((215, "Sensor 1 beam (zone A, e.g. door)", "#f9a825"), (325, "Sensor 2 beam (zone B)", "#1e88e5")):
        L = 240
        a1, a2 = math.radians(ang - 8), math.radians(ang + 8)
        p1 = (cx + L * math.cos(a1), cy - L * math.sin(a1)); p2 = (cx + L * math.cos(a2), cy - L * math.sin(a2))
        o.append(f'<path d="M{cx},{cy} L{p1[0]:.1f},{p1[1]:.1f} L{p2[0]:.1f},{p2[1]:.1f} Z" fill="{col}" fill-opacity=".3" stroke="{col}"/>')
        tx = cx + (L - 80) * math.cos(math.radians(ang)); ty = cy - (L - 80) * math.sin(math.radians(ang))
        o.append(label(round(tx), round(ty + 30), name, 12, "#263238"))
    # base
    o.append(f'<rect x="{cx - 70}" y="{cy - 20}" width="140" height="60" rx="6" fill="#263238"/>')
    o.append(text(cx, cy + 6, "Breadboard + ESP32", 11.5, "bold", "#fff", "middle"))
    o.append(text(cx, cy + 24, "servo + S3 on top", 11, fill="#cfd8dc", anchor="middle"))
    # test objects
    objs = [(0.55, 95, "T4: box placed", "#c62828"), (0.75, 40, "T5: walk across →", "#6a1b9a"), (0.45, 150, "T6: remove object", "#00695c")]
    for f, a, lb, col in objs:
        x = cx + R * f * math.cos(math.radians(a)); y = cy - R * f * math.sin(math.radians(a))
        o.append(f'<rect x="{x - 12:.1f}" y="{y - 12:.1f}" width="24" height="24" rx="4" fill="{col}"/>')
        o.append(label(round(x), round(y - 20), lb, 12, col))
    o.append(arrow([(cx - 250, cy - 120), (cx + 250, cy - 120)], color="#6a1b9a", dash="6 5"))
    o.append(text(W / 2, 735, "Keep S1/S2 pointing outside the 0–180° arc to reduce crosstalk; keep a phone hotspot within ~1–2 m of the ESP32 (no external antenna).",
                  13, fill="#455a64", anchor="middle"))
    return svg_doc(W, H, "".join(o))


# --------------------------------------------------------------------------
# 7. Communication sequence
# --------------------------------------------------------------------------
def sequence():
    W, H = 1150, 640
    o = [text(W / 2, 36, "Communication Flow", 22, "bold", "#0d47a1", "middle")]
    lanes = [(150, "ESP32"), (440, "FastAPI backend"), (720, "SQLite"), (1000, "Dashboard (browser)")]
    for x, t in lanes:
        o.append(box(x - 95, 60, 190, 44, t, fill="#e3f2fd", stroke="#1565c0"))
        o.append(f'<line x1="{x}" y1="104" x2="{x}" y2="620" stroke="#90a4ae" stroke-dasharray="5 5"/>')
    msgs = [
        (150, 440, 140, "1. connect /ws/device + hello {fw, mac, config}"),
        (440, 150, 175, "2. current settings (from DB)"),
        (150, 440, 215, "3. telemetry batch every 200 ms {s1,s2,s3,angle,...}"),
        (440, 720, 250, "4. insert readings / scan points"),
        (440, 1000, 285, "5. broadcast live frame (/ws/dashboard)"),
        (150, 440, 330, "6. event {MOVEMENT | ANOMALY, sensor, Δ, angle}"),
        (440, 720, 365, "7. insert event"),
        (440, 1000, 400, "8. push event → toast + log + radar mark"),
        (1000, 440, 450, "9. PUT /api/settings  or  POST /api/commands/calibrate"),
        (440, 150, 485, "10. config / command"),
        (150, 440, 520, "11. ack {applied: true}"),
        (440, 1000, 555, "12. setting state = Applied"),
        (150, 440, 600, "heartbeat every 2 s — none for 6 s → device OFFLINE on dashboard"),
    ]
    for a, b, y, t in msgs:
        col = "#c62828" if t.startswith("heart") else "#37474f"
        o.append(arrow([(a, y), (b, y)], color=col, dash="6 4" if t.startswith("heart") else None))
        o.append(label((a + b) / 2, y - 7, t, 12, col))
    return svg_doc(W, H, "".join(o))


# --------------------------------------------------------------------------
# 8. Firmware main loop flowchart
# --------------------------------------------------------------------------
def firmware_flow():
    W, H = 1000, 900
    o = [text(W / 2, 36, "Firmware Flow (setup + non-blocking loop)", 22, "bold", "#0d47a1", "middle")]
    steps = [("setup(): GPIO, buzzer OFF, servo attach, load NVS config", "#ede7f6"),
             ("Start Wi-Fi (auto-reconnect) and WebSocket client", "#ede7f6"),
             ("Baseline calibration: 20 samples S1, S2 and every S3 angle", "#ede7f6"),
             ("loop(): scheduler due? → trigger next sensor (S1 → S2 → S3)", "#fff8e1"),
             ("Echo captured / timeout → validate → median filter", "#fff8e1"),
             ("Update detector FSM → emit MOVEMENT / ANOMALY event", "#fff8e1"),
             ("Servo controller: step angle when S3 sample done", "#fff8e1"),
             ("Every 200 ms: send telemetry batch; every 2 s: heartbeat", "#e8f5e9"),
             ("Handle incoming config/commands → apply, save NVS, ACK", "#e8f5e9"),
             ("Alarm controller: buzzer pattern if confirmed event", "#efebe9")]
    y = 70
    for i, (s, f) in enumerate(steps):
        o.append(box(170, y, 660, 56, s, fill=f, stroke="#546e7a", tsize=14.5))
        if i < len(steps) - 1:
            o.append(arrow([(500, y + 56), (500, y + 78)]))
        y += 78
    o.append(arrow([(830, y - 50), (900, y - 50), (900, 70 + 3 * 78 + 28), (830, 70 + 3 * 78 + 28)]))
    o.append(label(905, 70 + 6 * 78, "repeat", 12, anchor="start"))
    return svg_doc(W, H, "".join(o))


DIAGRAMS = {
    "fig_breadboard": breadboard, "fig_block": block, "fig_architecture": architecture,
    "fig_detection": detection, "fig_schedule": schedule, "fig_demo_layout": demo_layout,
    "fig_sequence": sequence, "fig_firmware_flow": firmware_flow,
}


def main():
    SVG_DIR.mkdir(exist_ok=True)
    PNG_DIR.mkdir(exist_ok=True)
    for name, fn in DIAGRAMS.items():
        svg = fn()
        p = SVG_DIR / f"{name}.svg"
        p.write_text(svg, encoding="utf-8")
        w = int(svg.split('width="')[1].split('"')[0]); h = int(svg.split('height="')[1].split('"')[0])
        out = PNG_DIR / f"{name}.png"
        subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                        f"--window-size={w},{h}", f"--screenshot={out}", p.as_uri()],
                       check=True, capture_output=True, timeout=60)
        print("rendered", out)


if __name__ == "__main__":
    main()
