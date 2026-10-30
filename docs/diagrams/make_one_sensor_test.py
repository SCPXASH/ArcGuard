"""Diagram for the one-sensor direct wiring test, drawn for the user's breadboard
(ESP32 mounted with USB at the top, so its pin rows are mirrored vs. fig_breadboard).
Output: docs/diagrams/png/fig_one_sensor_test.png"""
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
W, H = 1240, 1080
o = []
T = lambda x, y, s, size=14, w="normal", fill="#212121", a="start": o.append(
    f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{w}" fill="{fill}" text-anchor="{a}">{s}</text>')

o.append(f'<rect width="{W}" height="{H}" fill="#fff"/>')
T(W / 2, 40, "One-sensor direct test — Sensor 1 only (no rails except the 3.3 V wire)", 24, "bold", "#0d47a1", "middle")
T(W / 2, 68, "Drawn for YOUR board: ESP32 with USB at the top. Use the pin labels printed on the ESP32.", 15, fill="#455a64", a="middle")

ry = lambda r: 120 + 30 * r          # breadboard row y
cols = {"L-": 300, "L+": 330, "a": 390, "b": 420, "c": 450, "d": 480, "e": 510, "f": 580, "g": 610, "h": 640, "i": 670, "j": 700}
# breadboard
o.append('<rect x="280" y="100" width="450" height="930" rx="10" fill="#f5f5f0" stroke="#bdbdbd" stroke-width="2"/>')
o.append('<rect x="536" y="106" width="18" height="918" fill="#e0e0d8"/>')
o.append('<line x1="300" y1="110" x2="300" y2="1020" stroke="#1e88e5" stroke-width="2" opacity=".5"/>')
o.append('<line x1="330" y1="110" x2="330" y2="1020" stroke="#e53935" stroke-width="2" opacity=".5"/>')
T(300, 1050, "−", 18, "bold", "#1e88e5", "middle"); T(330, 1050, "+", 18, "bold", "#e53935", "middle")
for r in range(0, 30):
    for k, x in cols.items():
        o.append(f'<rect x="{x - 4}" y="{ry(r) - 4}" width="8" height="8" rx="1.5" fill="#555"/>')

# ESP32: left pin column sits in column j, rows 4..22; right column hangs off the edge
left = ["CLK", "D0", "D1", "15", "2", "0", "4", "16", "17", "5", "18", "19", "GND", "21", "RX", "TX", "22", "23", "GND"]
right = ["5V", "CMD", "D3", "D2", "13", "GND", "12", "14", "27", "26", "25", "33", "32", "35", "34", "VN", "VP", "EN", "3V3"]
r0 = 4
o.append(f'<rect x="688" y="{ry(r0) - 60}" width="250" height="{30 * 18 + 120}" rx="10" fill="#1b1b1b"/>')
o.append(f'<rect x="785" y="{ry(r0) - 50}" width="56" height="36" rx="4" fill="#9e9e9e"/>')
T(813, ry(r0) - 26, "USB", 12, "bold", "#212121", "middle")
o.append(f'<rect x="760" y="{ry(r0 + 12)}" width="110" height="130" rx="4" fill="#b0b0b0"/>')
T(815, ry(r0 + 14) + 10, "ESP32-", 13, "bold", "#212121", "middle"); T(815, ry(r0 + 15) + 6, "WROOM-32U", 13, "bold", "#212121", "middle")
key = {"GND": "#7CFC00", "23": "#7CFC00", "22": "#7CFC00"}
for i, (lp, rp) in enumerate(zip(left, right)):
    y = ry(r0 + i)
    o.append(f'<circle cx="700" cy="{y}" r="6" fill="#d4af37" stroke="#7a5c00"/>')
    o.append(f'<circle cx="920" cy="{y}" r="6" fill="#d4af37" stroke="#7a5c00"/>')
    hl = (lp == "GND" and i == 12) or lp in ("23", "22")
    T(712, y + 5, lp, 13, "bold", "#7CFC00" if hl else "#ddd")
    T(908, y + 5, rp, 13, "bold", "#ff8a80" if rp == "3V3" else ("#ffd54f" if rp == "5V" else "#bbb"), "end")
T(1030, ry(r0) + 5, "← 5V (servo red wire — leave it)", 13, fill="#8d6e00", a="start")
T(940, ry(r0 + 18) + 30, "3V3 pin (bottom-right, by the antenna)", 13, "bold", "#c62828", "start")
T(940, ry(r0 + 18) + 48, "hangs off the board edge", 12, fill="#455a64", a="start")


def wire(pts, color, w=6):
    d = "M" + " L".join(f"{x},{y}" for x, y in pts)
    o.append(f'<path d="{d}" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="{w + 3}" stroke-linejoin="round" stroke-linecap="round"/>')
    o.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linejoin="round" stroke-linecap="round"/>')
    for x, y in (pts[0], pts[-1]):
        o.append(f'<rect x="{x - 5}" y="{y - 5}" width="10" height="10" rx="2" fill="#263238"/>')


# purple 3V3 wire: from the 3V3 pin, around the bottom, into the left + rail (row 28)
p3 = ry(r0 + 18)
wire([(920, p3), (980, p3), (980, 1065), (250, 1065), (250, ry(28)), (330, ry(28))], "#7e57c2")
T(600, 1060, "purple wire: 3V3 → left + rail (you already have this)", 13, "bold", "#5e35b1", "middle")

# Sensor 1 (left side)
sx, sy = 40, ry(19)
o.append(f'<rect x="{sx}" y="{sy - 40}" width="190" height="200" rx="10" fill="#1565c0"/>')
o.append(f'<circle cx="{sx + 135}" cy="{sy + 60}" r="38" fill="#cfd8dc" stroke="#90a4ae" stroke-width="4"/>')
T(sx + 12, sy - 15, "SENSOR 1", 16, "bold", "#fff")
pins = [("VCC", sy + 10), ("TRIG", sy + 45), ("ECHO", sy + 80), ("GND", sy + 115)]
for name, y in pins:
    o.append(f'<rect x="{sx + 184}" y="{y - 4}" width="16" height="8" fill="#d4af37"/>')
    T(sx + 12, y + 5, name, 14, "bold", "#fff")

gnd_row, r23, r22 = r0 + 12, r0 + 17, r0 + 16
# VCC (red) -> left + rail, right next to the purple wire (row 27)
wire([(sx + 200, pins[0][1]), (262, pins[0][1]), (262, ry(27)), (330, ry(27))], "#e53935")
# TRIG (yellow) -> strip of pin 23 (column g)
wire([(sx + 200, pins[1][1]), (360, pins[1][1]), (360, ry(r23)), (610, ry(r23))], "#f9a825")
# ECHO (green) -> strip of pin 22 (column f)
wire([(sx + 200, pins[2][1]), (372, pins[2][1]), (372, ry(r22)), (580, ry(r22))], "#2e7d32")
# GND (black) -> strip of the GND pin between 19 and 21 (column h)
wire([(sx + 200, pins[3][1]), (384, pins[3][1]), (384, ry(gnd_row)), (640, ry(gnd_row))], "#212121")

# callouts
def note(x, y, txt, col):
    o.append(f'<rect x="{x - 6}" y="{y - 17}" width="{len(txt) * 7.6 + 12}" height="24" rx="5" fill="#fff" stroke="{col}" stroke-width="1.5"/>')
    T(x, y, txt, 13, "bold", col)
note(395, ry(gnd_row) - 14, "GND → row of pin “GND” (under 19)", "#212121")
note(400, ry(r22) - 14, "ECHO → same row as pin “22”", "#2e7d32")
note(400, ry(r23) + 30, "TRIG → same row as pin “23”", "#b28704")
note(30, ry(27) - 14, "VCC → hole next to the purple wire", "#c62828")

# legend / steps
lx, ly = 30, 120
o.append(f'<rect x="{lx}" y="{ly}" width="235" height="420" rx="10" fill="#fafafa" stroke="#cfd8dc"/>')
steps = ["WHAT TO CHANGE", "", "1. Unplug Sensor 1's 4 wires.", "", "2. Plug them in as shown:",
         "   VCC  → next to purple wire", "   TRIG → row of pin 23", "   ECHO → row of pin 22", "   GND  → row of the GND", "              between 19 and 21", "",
         "3. Leave Sensors 2, 3, servo", "   and buzzer as they are.", "", "4. Point Sensor 1 at a wall", "   30–100 cm away.", "",
         "5. Say “scan”, press EN."]
for i, s in enumerate(steps):
    T(lx + 14, ly + 30 + i * 21, s.replace(" ", "&#160;"), 14 if i else 15, "bold" if i in (0, 17) else "normal", "#0d47a1" if i == 0 else "#263238")
T(lx + 14, ly + 30 + 19 * 21, "Same row = any of the free holes", 12, fill="#455a64")
T(lx + 14, ly + 30 + 20 * 21 - 4, "left of that pin, in that row.", 12, fill="#455a64")

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
       f'font-family="Segoe UI, Arial, sans-serif">{"".join(o)}</svg>')
(HERE / "svg").mkdir(exist_ok=True)
(HERE / "png").mkdir(exist_ok=True)
sp = HERE / "svg" / "fig_one_sensor_test.svg"
sp.write_text(svg, encoding="utf-8")
out = HERE / "png" / "fig_one_sensor_test.png"
subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                f"--window-size={W},{H}", f"--screenshot={out}", sp.as_uri()], check=True, capture_output=True, timeout=60)
print(out)
