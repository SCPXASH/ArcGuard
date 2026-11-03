"""Builds presentation/ArcGuard_Presentation.pptx in the format of the original Canva deck
(light grey background, dark-grey bold titles, cyan + dark-grey pill decorations, college header),
with the same 16 slides and titles, and content updated to the current Arc Guard build.

Run:  python presentation/build_ppt.py      (needs python-pptx)
"""
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "presentation" / "ArcGuard_Presentation.pptx"
ASSETS = ROOT / "presentation" / "assets"
FIG = ROOT / "docs" / "diagrams" / "png"

# The original uses Poppins (Canva). It is not installed on this PC, so the closest geometric sans that
# ships with Office is used instead; change FONT to "Poppins" if that font is installed where it is shown.
FONT = "Century Gothic"
BG = RGBColor(0xF6, 0xF6, 0xF6)
TITLE = RGBColor(0x44, 0x44, 0x44)
BODY = RGBColor(0x4A, 0x4A, 0x4A)
CYAN = RGBColor(0x0C, 0xC0, 0xDF)
DARK = RGBColor(0x44, 0x44, 0x44)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
BLANK = prs.slide_layouts[6]


# ---------------------------------------------------------------- helpers
def new_slide(name):
    s = prs.slides.add_slide(BLANK)
    bg = s.background.fill
    bg.solid()
    bg.fore_color.rgb = BG
    s.name = name
    return s


def rect(s, x, y, w, h, color, rounded=False, name=None):
    shp = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE,
                             Inches(x), Inches(y), Inches(w), Inches(h))
    if rounded:
        shp.adjustments[0] = 0.5
    shp.fill.solid()
    shp.fill.fore_color.rgb = color
    shp.line.fill.background()
    shp.shadow.inherit = False
    if name:
        shp.name = name
    return shp


def vpill(s, x, y_cyan, y_split, y_end, w=0.165):
    """Vertical two-tone pill (cyan then dark), as on the original slides."""
    rect(s, x, y_cyan, w, y_split - y_cyan + 0.3, CYAN, True, "Decoration")
    rect(s, x, y_split, w, y_end - y_split, DARK, True, "Decoration")


def hpill(s, x_cyan, x_split, x_end, y, h=0.165):
    rect(s, x_cyan, y, x_split - x_cyan + 0.3, h, CYAN, True, "Decoration")
    rect(s, x_split, y, x_end - x_split, h, DARK, True, "Decoration")


def textbox(s, x, y, w, h, name=None, anchor=MSO_ANCHOR.TOP):
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    for side in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
        setattr(tf, side, 0)
    if name:
        tb.name = name
    return tf


def run(p, text, size, bold=False, color=BODY, italic=False):
    r = p.add_run()
    r.text = text
    f = r.font
    f.name = FONT
    f.size = Pt(size)
    f.bold = bold
    f.italic = italic
    f.color.rgb = color
    return r


def title(s, text, x, y, w, h=0.9, size=36, align=PP_ALIGN.LEFT):
    tf = textbox(s, x, y, w, h, "Title", MSO_ANCHOR.MIDDLE)
    for i, line in enumerate(text.split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = 0.95
        run(p, line, size, True, TITLE)
    return tf


def set_bullet(p, char="•", indent=0.32, level_indent=0.0):
    pPr = p._p.get_or_add_pPr()
    pPr.set("marL", str(int(Inches(level_indent + indent))))
    pPr.set("indent", str(-int(Inches(indent))))
    for tag in ("a:buNone", "a:buChar", "a:buAutoNum"):
        for el in pPr.findall(qn(tag)):
            pPr.remove(el)
    bu = pPr.makeelement(qn("a:buChar"), {"char": char})
    pPr.append(bu)


def paras(tf, items, size=20, space_after=6, line_spacing=1.0):
    """items: str (plain paragraph), ("b", text) bullet, ("b2", text) sub-bullet, ("h", text) bold lead,
    ("a", text) arrow bullet, ("c", text) check bullet, ("gap", None) empty line, list of runs."""
    first = True
    for it in items:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.space_after = Pt(space_after)
        p.line_spacing = line_spacing
        kind, text = (it if isinstance(it, tuple) else ("p", it))
        if kind == "gap":
            run(p, " ", size * 0.5)
            p.space_after = Pt(0)
            continue
        if kind == "b":
            set_bullet(p, "•", 0.3, 0.05)
        elif kind == "b2":
            set_bullet(p, "•", 0.3, 0.4)
        elif kind == "a":
            set_bullet(p, "➢", 0.42)
        elif kind == "c":
            set_bullet(p, "✔", 0.45)
        if kind == "h":
            run(p, text, size, True, TITLE)
        elif kind == "runs":
            for t, bold in text:
                run(p, t, size, bold, TITLE if bold else BODY)
        else:
            run(p, text, size)
    return tf


def header_image(s):
    s.shapes.add_picture(str(ASSETS / "college_header.jpg"), Inches(2.81), Inches(0), Inches(6.78), Inches(1.355))


def picture(s, path, x, y, w=None, h=None, name=None):
    pic = s.shapes.add_picture(str(path), Inches(x), Inches(y),
                               Inches(w) if w else None, Inches(h) if h else None)
    if name:
        pic.name = name
    return pic


def notes(s, text):
    s.notes_slide.notes_text_frame.text = text


# ---------------------------------------------------------------- 1. title
s = new_slide("Title")
header_image(s)
vpill(s, 0.75, 0.75, 3.78, 6.75)
title(s, "Arc Guard: A Servo-Based\nDirectional Intrusion Detection and\nRadar Visualization System",
      1.9, 1.85, 8.6, 1.35, 30, PP_ALIGN.CENTER)
rows = [("Pratham Pawar", "VU4F2324148"), ("Preeti Goud", "VU4F2324145"),
        ("Mariyam Ashrafi", "VU4S2425018"), ("Ashmeet Bhat Vernekar", "VU4S2425019")]
tbl = s.shapes.add_table(4, 2, Inches(2.64), Inches(3.4), Inches(7.4), Inches(2.1)).table
tbl.first_row = False
tbl.horz_banding = False
for r, (n, roll) in enumerate(rows):
    tbl.rows[r].height = Inches(0.525)
    for c, v in enumerate((n, roll)):
        cell = tbl.cell(r, c)
        cell.fill.solid()
        cell.fill.fore_color.rgb = BG
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = cell.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        run(p, v, 15, True, RGBColor(0x11, 0x11, 0x11))
        tcPr = cell._tc.get_or_add_tcPr()
        for k, edge in enumerate(("a:lnL", "a:lnR", "a:lnT", "a:lnB")):
            ln = tcPr.makeelement(qn(edge), {"w": str(int(Pt(1.75))), "cmpd": "sng"})
            sf = ln.makeelement(qn("a:solidFill"), {})
            clr = sf.makeelement(qn("a:srgbClr"), {"val": "000000"})
            sf.append(clr)
            ln.append(sf)
            tcPr.insert(k, ln)
tf = textbox(s, 2.0, 5.85, 8.4, 0.9, "Guide")
for i, line in enumerate(["Under the guidance of Dr. Kavita Wagh", "AY:2026-27"]):
    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
    p.alignment = PP_ALIGN.CENTER
    p.line_spacing = 0.95
    run(p, line, 22, True, TITLE)

# ---------------------------------------------------------------- 2. introduction
s = new_slide("Introduction")
header_image(s)
title(s, "INTRODUCTION", 1.51, 1.55, 8, 0.8)
paras(textbox(s, 1.51, 2.55, 9.6, 3.6), [
    "Security monitoring systems are essential in modern environments such as laboratories, "
    "offices, and restricted-access rooms.",
    "However, most low-cost systems:",
    ("b", "Use fixed sensors with limited coverage"),
    ("b", "Generate false positives"),
    ("b", "Lack spatial awareness"),
    ("b", "Do not provide intuitive visualization"),
    "Arc Guard addresses these limitations with fixed-zone and 180° directional scanning, a learned "
    "room baseline, and live radar-style visualization on the web and on a phone.",
], size=19, space_after=4)
hpill(s, 9.04, 12.09, 13.6, 6.58)

# ---------------------------------------------------------------- 3. problem statement
s = new_slide("Problem statement")
header_image(s)
vpill(s, 0.75, 0.75, 3.78, 6.75)
title(s, "PROBLEM STATEMENT", 2.09, 1.45, 8, 0.8)
paras(textbox(s, 2.09, 2.3, 10.2, 4.8), [
    "Conventional low-cost security systems:",
    ("b", "Use PIR or a single fixed ultrasonic sensor"),
    ("b", "Have limited detection coverage"),
    ("b", "Produce high false alarms"),
    ("b", "Lack directional awareness"),
    ("gap", None),
    "Camera-based systems:",
    ("b", "Increase cost"),
    ("b", "Raise privacy concerns"),
    ("b", "Require high processing power"),
    ("gap", None),
    "There is a need for a low-cost, privacy-preserving, directional intrusion detection system.",
], size=19, space_after=3)

# ---------------------------------------------------------------- 4. proposed solution
s = new_slide("Proposed solution")
header_image(s)
title(s, "PROPOSED SOLUTION", 0.91, 1.3, 8, 0.8)
paras(textbox(s, 0.97, 2.2, 11.4, 4.3), [
    "Arc Guard uses:",
    ("b", "ESP32-WROOM-32U Wi-Fi microcontroller as the main controller"),
    ("b", "Two fixed HC-SR04 ultrasonic sensors watching Zone A and Zone B"),
    ("b", "One US-100-type ultrasonic sensor on an MG90S servo for 0–180° scanning"),
    ("b", "All sensors powered at 3.3 V, so no resistors or level shifters are needed"),
    ("b", "A learned baseline for every sensor and every scan angle"),
    ("b", "Confirmed detection, with movement and anomaly events reported separately"),
    ("b", "MH-FMD buzzer alarm that works even if Wi-Fi is down"),
    ("b", "FastAPI backend + SQLite, live web dashboard and Android app"),
    ("gap", None),
    "Arc Guard continuously monitors two fixed zones and scans a 180° arc to detect abnormal "
    "spatial changes in real time.",
], size=18, space_after=3)
hpill(s, 6.92, 9.72, 12.42, 6.91)

# ---------------------------------------------------------------- 5. system architecture
s = new_slide("System architecture")
title(s, "SYSTEM ARCHITECTURE", 2.5, 0.2, 8.33, 0.75, 34, PP_ALIGN.CENTER)
picture(s, FIG / "fig_architecture.png", 2.85, 1.0, h=6.3, name="Architecture diagram")
rect(s, 12.58, -0.3, 0.165, 1.6, CYAN, True, "Decoration")
rect(s, 12.58, 1.67, 0.165, 2.7, DARK, True, "Decoration")
rect(s, 0.75, 3.35, 0.165, 2.7, DARK, True, "Decoration")
rect(s, 0.75, 5.95, 0.165, 1.8, CYAN, True, "Decoration")
notes(s, "Four layers: sensing (3 ultrasonic sensors, servo, buzzer), edge (ESP32 firmware: scheduling, filtering, "
         "baselines, detector, comms), backend (FastAPI + SQLite on the laptop), presentation (web dashboard in any "
         "browser, or the Android app). Detection runs on the ESP32, so the buzzer still works without Wi-Fi.")

# ---------------------------------------------------------------- 6. objectives
s = new_slide("Objectives")
title(s, "OBJECTIVES", 3.5, 0.75, 6.33, 0.8, 34, PP_ALIGN.CENTER)
paras(textbox(s, 1.15, 1.75, 11.2, 4.6), [
    ("a", "Design a low-cost, camera-free room monitor using an ESP32."),
    ("a", "Watch two fixed zones and a 180° arc using three ultrasonic sensors."),
    ("a", "Learn a baseline for every sensor and scan angle, and detect changes from it."),
    ("a", "Reduce false positives by confirming a change before reporting it."),
    ("a", "Classify movement and anomaly events, and alert locally through a buzzer."),
    ("a", "Enable Wi-Fi-based monitoring through a web dashboard and an Android app."),
], size=19, space_after=17)
hpill(s, -0.3, 1.2, 3.9, 6.58)
hpill(s, 9.43, 12.22, 13.6, 0.75)

# ---------------------------------------------------------------- 7. key features
s = new_slide("Key features")
rect(s, 0, 0, 1.92, 7.5, CYAN, name="Decoration")
title(s, "KEY FEATURES", 2.83, 1.15, 8, 0.8)
paras(textbox(s, 2.83, 2.05, 9.5, 4.4), [
    ("b", "Three-sensor monitoring (2 fixed + 1 scanning)"),
    ("b", "180° directional scanning in 5° steps"),
    ("b", "Per-angle baseline with a robust noise model"),
    ("b", "Confirmed detection: movement vs anomaly events"),
    ("b", "Real-time buzzer alert on the device"),
    ("b", "ESP32 Wi-Fi with live WebSocket streaming"),
    ("b", "Web-based & Mobile-based monitoring (Android app alerts)"),
    ("b", "Radar-style room map, live charts and event log"),
    ("b", "Privacy-preserving — no camera required"),
], size=19, space_after=3)
hpill(s, 8.56, 11.36, 13.6, 5.8)

# ---------------------------------------------------------------- 8. what makes it different
s = new_slide("What makes Arc Guard different")
rect(s, 0, 0, 13.333, 0.8, CYAN, name="Decoration")
title(s, "WHAT MAKES ARC GUARD DIFFERENT ?", 1.51, 1.7, 11, 0.8)
tf = paras(textbox(s, 1.51, 2.65, 11.2, 3.3), [
    ("c", "Fixed + directional sensing instead of relying on a single sensor"),
    ("c", "A learned baseline per angle instead of one fixed threshold"),
    ("c", "Movement and anomaly events reported separately"),
    ("c", "Dashboard settings are applied and confirmed by the device"),
    ("c", "Web dashboard and Android app with phone alerts"),
    ("c", "Only 5 parts, no extra components; no camera → privacy-friendly"),
], size=19, space_after=4)
for p in tf.paragraphs:  # colour the check marks like the original's
    p._p.get_or_add_pPr().insert(0, p._p.get_or_add_pPr().makeelement(qn("a:buClr"), {}))
    clr = p._p.pPr.find(qn("a:buClr"))
    clr.append(clr.makeelement(qn("a:srgbClr"), {"val": "3F6E86"}))
vpill(s, 0.75, 3.5, 6.53, 7.8)

# ---------------------------------------------------------------- 9. hardware components
s = new_slide("Hardware components")
title(s, "HARDWARE COMPONENTS", 1.61, 0.95, 9, 0.85)
hw = [
    ("1", "ESP32-WROOM-32U DevKit (38-pin)", "USB 5 V from the laptop", "Main controller, Wi-Fi, detection"),
    ("2", "HC-SR04 — Sensor 1", "TRIG 23 / ECHO 22 · 3.3 V", "Fixed zone A"),
    ("3", "HC-SR04 — Sensor 2", "TRIG 19 / ECHO 18 · 3.3 V", "Fixed zone B"),
    ("4", "US-100-type — Sensor 3", "TRIG 17 / ECHO 16 · 3.3 V", "Directional scanning on the servo"),
    ("5", "Tower Pro MG90S servo", "Signal 21 · 5 V (VIN)", "Rotates Sensor 3 through 0–180°"),
    ("6", "MH-FMD buzzer", "I/O 4 · 3.3 V", "Local audible alarm"),
    ("7", "Breadboard & jumper wires", "No resistors or capacitors", "Circuit connections"),
    ("8", "USB cable / power bank", "5 V USB", "Power to the system"),
]
shape = s.shapes.add_table(len(hw) + 1, 4, Inches(1.61), Inches(1.95), Inches(10.4), Inches(5.0))
shape.name = "Hardware table"
t = shape.table
for i, wdt in enumerate((0.85, 3.55, 3.0, 3.0)):
    t.columns[i].width = Inches(wdt)
HEAD = RGBColor(0x0E, 0x5A, 0x9E)
for c, h in enumerate(("Sr. No.", "Component", "Pins / Power", "Function")):
    cell = t.cell(0, c)
    cell.fill.solid()
    cell.fill.fore_color.rgb = HEAD
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = cell.text_frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run(p, h, 15, True, WHITE)
for r, row in enumerate(hw, start=1):
    for c, v in enumerate(row):
        cell = t.cell(r, c)
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor(0xEA, 0xF2, 0xFB) if r % 2 else WHITE
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = cell.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER if c == 0 else PP_ALIGN.LEFT
        run(p, v, 14, c == 1, RGBColor(0x22, 0x22, 0x22))
rect(s, 12.58, -0.3, 0.165, 2.25, CYAN, True, "Decoration")
rect(s, 12.58, 1.95, 0.165, 2.95, DARK, True, "Decoration")
notes(s, "Hardware is fixed: exactly these parts, no resistors, capacitors or level shifters. The three sensors and the "
         "buzzer run from the ESP32's 3.3 V pin, so their ECHO outputs are safe for the ESP32 inputs.")

# ---------------------------------------------------------------- 10. software components
s = new_slide("Software components")
title(s, "SOFTWARE COMPONENTS", 1.13, 0.75, 9, 0.85)
paras(textbox(s, 0.75, 1.85, 5.6, 5.4), [
    ("a", "ESP32 Firmware (Arduino C++)"),
    ("b2", "Sensor scheduling & filtering"),
    ("b2", "Servo sweep control"),
    ("b2", "Baseline + detection logic"),
    ("b2", "Buzzer alarm"),
    ("b2", "Wi-Fi + WebSocket, saved settings"),
    ("gap", None),
    ("a", "Web Dashboard"),
    ("b2", "Real-time sensor data & status"),
    ("b2", "Radar-style map + 3D live room"),
    ("b2", "Charts, event log, CSV export"),
    ("b2", "Settings applied on the ESP32"),
], size=17, space_after=2)
paras(textbox(s, 6.2, 1.85, 3.6, 5.4), [
    ("a", "Backend (Python FastAPI)"),
    ("b2", "WebSocket + REST API"),
    ("b2", "SQLite history"),
    ("b2", "Device online / offline"),
    ("gap", None),
    ("a", "Mobile Application (Android)"),
    ("b2", "Real-time monitoring"),
    ("b2", "Event notifications + vibration"),
    ("b2", "Same live dashboard"),
    ("b2", "USB or Wi-Fi connection"),
], size=17, space_after=2)
pic = picture(s, ASSETS / "app_dashboard.png", 9.85, 1.85, h=4.6, name="Android app screenshot")
pic.line.color.rgb = RGBColor(0x99, 0x99, 0x99)
pic.line.width = Pt(1)
cap = textbox(s, 9.7, 6.55, 2.8, 0.4, "Caption")
p = cap.paragraphs[0]
p.alignment = PP_ALIGN.CENTER
run(p, "Android app (simulated data)", 11, False, RGBColor(0x77, 0x77, 0x77), True)
rect(s, 12.58, -0.3, 0.165, 2.25, CYAN, True, "Decoration")
rect(s, 12.58, 1.95, 0.165, 2.95, DARK, True, "Decoration")

# ---------------------------------------------------------------- 11. minimum system requirements
s = new_slide("Minimum system requirements")
title(s, "Minimum System Requirements for\nArc Guard", 0.75, 1.35, 9.5, 1.25, 32)
paras(textbox(s, 0.75, 2.75, 11.4, 4.5), [
    ("runs", [("Processor: ", False), ("Dual-core CPU, 1.8 GHz or higher (Intel i3 / AMD Ryzen 3 or equivalent)", False)]),
    "RAM: 4 GB minimum (8 GB recommended)",
    "Storage: 2 GB free disk space (IDE, ESP32 core, Python packages, database)",
    "Operating System: Windows 10/11 (also runs on Linux or macOS)",
    "Network: 2.4 GHz Wi-Fi shared by the laptop and the ESP32",
    "USB Port: at least one USB 2.0 or higher port (ESP32 programming and power)",
    "Software: Arduino IDE 2.x or PlatformIO, Python 3.10+, CP210x / CH340 USB driver, a browser",
    "Phone (optional): Android 7.0 or later for the Arc Guard app",
], size=17, space_after=8)
vpill(s, 12.42, 0.75, 3.78, 6.75)

# ---------------------------------------------------------------- 12. intrusion detection logic
s = new_slide("Intrusion detection logic")
title(s, "INTRUSION DETECTION LOGIC", 0.75, 1.4, 9, 0.85)
paras(textbox(s, 0.75, 2.4, 6.3, 3.9), [
    "An event is detected when:",
    ("h", "|Current Distance − Baseline| > max(15 cm, 4 × noise σ)"),
    ("h", "AND"),
    ("h", "The change persists for 3 readings and ≥ 300 ms"),
    ("p", "(2 sweeps for the scanning sensor)"),
    ("gap", None),
    "It is then classified as:",
    ("b", "Movement — fast change, brief movement, movement across the scan"),
    ("b", "Anomaly — object appeared / disappeared, sudden jump, pattern, sensor fault"),
    ("gap", None),
    "This reduces false alarms, temporary disturbances and noise-based triggers.",
], size=16, space_after=2)
def flow_box(x, y, w, h, head, sub, fill, fg=WHITE, name=None):
    b = rect(s, x, y, w, h, fill, True, name)
    b.adjustments[0] = 0.18
    tf = b.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = tf.margin_right = Inches(0.1)
    tf.margin_top = tf.margin_bottom = Inches(0.03)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run(p, head, 14, True, fg)
    if sub:
        p2 = tf.add_paragraph()
        p2.alignment = PP_ALIGN.CENTER
        run(p2, sub, 11.5, False, fg)


def down_arrow(x, y, h=0.26):
    a = s.shapes.add_shape(MSO_SHAPE.DOWN_ARROW, Inches(x - 0.13), Inches(y), Inches(0.26), Inches(h))
    a.fill.solid()
    a.fill.fore_color.rgb = RGBColor(0x9A, 0xA5, 0xB1)
    a.line.fill.background()
    a.shadow.inherit = False


FX, FW = 7.55, 4.6
MID = FX + FW / 2
steps = [("New reading", "range check + median filter", RGBColor(0x5F, 0x6B, 0x78)),
         ("Compare with baseline", "|d − baseline| > max(15 cm, 4σ) ?", RGBColor(0x0E, 0x5A, 0x9E)),
         ("Candidate", "3 readings in a row and ≥ 300 ms", RGBColor(0x0A, 0x8F, 0xAD)),
         ("Confirmed → classify", "rate of change and how long it lasts", RGBColor(0x44, 0x44, 0x44))]
y = 2.45
for i, (h, sub, col) in enumerate(steps):
    flow_box(FX, y, FW, 0.6, h, sub, col, name=f"Flow step {i + 1}")
    y += 0.6
    down_arrow(MID, y + 0.03, 0.22)
    y += 0.28
half = (FW - 0.2) / 2
flow_box(FX, y, half, 0.74, "MOVEMENT", "fast or brief change", RGBColor(0x3B, 0x82, 0xF6), name="Movement outcome")
flow_box(FX + half + 0.2, y, half, 0.74, "ANOMALY", "persists 10 s, jump, fault", RGBColor(0xF5, 0x9E, 0x0B), name="Anomaly outcome")
y += 0.74
tf = textbox(s, FX, y + 0.1, FW, 0.35, "Cooldown note")
p = tf.paragraphs[0]
p.alignment = PP_ALIGN.CENTER
run(p, "then a 3 s cooldown before the next event", 12, False, RGBColor(0x66, 0x66, 0x66), True)
hpill(s, 0.75, 3.55, 6.25, 6.58)

# ---------------------------------------------------------------- 13. advantages, limitations & applications
s = new_slide("Advantages, limitations and applications")
title(s, "ADVANTAGES , LIMITATIONS & APPLICATIONS", 1.0, 1.0, 11.33, 0.85, 34, PP_ALIGN.CENTER)
cols = [
    ("Advantages", RGBColor(0x1F, 0x6F, 0xB5), RGBColor(0xE8, 0xF1, 0xFA), "✔", RGBColor(0x2E, 0x9E, 0x4F), [
        "Low cost (5 parts)", "Privacy-friendly (no camera)", "Easy deployment on one breadboard",
        "Real-time detection + live dashboard", "Movement vs anomaly classification", "Web + Android monitoring"]),
    ("Limitations", RGBColor(0xD6, 0x45, 0x3D), RGBColor(0xFC, 0xEC, 0xEB), "!", RGBColor(0xD6, 0x45, 0x3D), [
        "Limited range (~4 m, ultrasonic)", "Cannot identify specific individuals",
        "Line-of-sight only; ~15° beam gives coarse direction", "Soft or angled surfaces may not echo",
        "Short Wi-Fi range (no external antenna)"]),
    ("Applications", RGBColor(0x4C, 0x9A, 0x3A), RGBColor(0xED, 0xF6, 0xEA), "◎", RGBColor(0x1E, 0x8B, 0xC3), [
        "Laboratories", "Classrooms", "Offices", "Small warehouses", "Restricted-access rooms",
        "Indoor security monitoring"]),
]
cx, cw, top = 1.0, 3.71, 2.15
for i, (head, hc, tint, mark, mc, items) in enumerate(cols):
    x = cx + i * (cw + 0.05)
    h = rect(s, x, top, cw, 0.6, hc, name=f"{head} header")
    tfh = h.text_frame
    tfh.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tfh.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run(p, head, 20, True, WHITE)
    body = rect(s, x, top + 0.6, cw, 3.65, tint, name=f"{head} list")
    tf = textbox(s, x + 0.2, top + 0.8, cw - 0.35, 3.4, f"{head} items")
    for j, it in enumerate(items):
        p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
        p.space_after = Pt(9)
        set_bullet(p, mark, 0.34)
        pPr = p._p.pPr
        bc = pPr.makeelement(qn("a:buClr"), {})
        bc.append(bc.makeelement(qn("a:srgbClr"), {"val": str(mc)}))
        pPr.insert(0, bc)
        run(p, it, 16, False, RGBColor(0x22, 0x22, 0x22))
hpill(s, 7.08, 9.88, 12.58, 6.75)

# ---------------------------------------------------------------- 14. future enhancement
s = new_slide("Future enhancement")
title(s, "FUTURE ENHANCEMENT", 0.75, 1.6, 9, 0.85)
paras(textbox(s, 0.75, 2.75, 10.9, 3.6), [
    "In future, Arc Guard can be enhanced with push notifications that reach the phone even when the app is "
    "closed, occupancy-grid mapping of the room from accumulated sweeps, adaptive baselines that safely follow "
    "slow changes, focused re-scanning of a sector after a change, and additional Arc Guard nodes reporting to "
    "one backend for wider-area coverage. Once enough labelled event data has been recorded, a small on-device "
    "(TinyML) model can be compared against the rule-based detector to improve automated security monitoring.",
], size=19, line_spacing=1.1)
vpill(s, 12.42, 0.75, 3.78, 6.75)

# ---------------------------------------------------------------- 15. SDGs
s = new_slide("Sustainable development goals")
vpill(s, 0.58, 0.92, 3.95, 6.9)
title(s, "SUSTAINABLE DEVELOPMENT GOALS (SDGs)", 1.13, 0.75, 11, 0.85, 34)
paras(textbox(s, 1.13, 1.8, 11.3, 5.3), [
    ("runs", [("SDG 9 – Industry, Innovation and Infrastructure: ", True),
              ("a low-cost, open embedded approach to safer infrastructure through directional sensing and "
               "real-time monitoring.", False)]),
    ("runs", [("SDG 11 – Sustainable Cities and Communities: ", True),
              ("improves the safety of indoor spaces such as campuses and workplaces while respecting the privacy "
               "of occupants.", False)]),
    ("runs", [("SDG 12 – Responsible Consumption and Production: ", True),
              ("achieves the goal with a minimal component count and a low-power microcontroller.", False)]),
    ("runs", [("SDG 16 – Peace, Justice and Strong Institutions: ", True),
              ("supports protection of controlled-access institutional rooms without surveillance cameras.", False)]),
    "The project emphasizes accessible and scalable technology, enabling wider adoption.",
], size=17, space_after=13)

# ---------------------------------------------------------------- 16. conclusion
s = new_slide("Conclusion")
title(s, "CONCLUSION", 0.94, 1.85, 9, 0.85)
paras(textbox(s, 0.94, 3.0, 10.4, 3.2), [
    "Arc Guard provides a low-cost, privacy-preserving room monitor built from one ESP32, three ultrasonic "
    "sensors, one servo and one buzzer, with no extra components. Fixed-zone sensing and 180° servo scanning, "
    "learned baselines and confirmed detection report movement and anomalies separately, while a FastAPI "
    "backend streams everything live to a web dashboard and an Android app. The system provides a scalable "
    "foundation for modern IoT-based security applications.",
], size=19, line_spacing=1.1)
vpill(s, 12.5, 0.75, 3.78, 6.75)

prs.save(OUT)
print("wrote", OUT, "with", len(prs.slides), "slides")
