// =============================================================================
//  Arc Guard firmware — ESP32-WROOM-32U
//  2 fixed ultrasonic sensors + 1 servo-scanned ultrasonic sensor + MH-FMD buzzer
//
//  Before uploading: copy secrets.example.h to secrets.h and fill in Wi-Fi and
//  the laptop's IP address. Libraries: ESP32Servo, ArduinoJson (v7), WebSockets
//  (Markus Sattler / links2004). Board: "ESP32 Dev Module". Serial: 115200 baud.
// =============================================================================
#include <ESP32Servo.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include "config.h"
#include "settings.h"
#include "ultrasonic.h"
#include "detector.h"
#include "alarm.h"
#include "net.h"

static Ultrasonic sensors[3] = {
  Ultrasonic(PIN_S1_TRIG, PIN_S1_ECHO),
  Ultrasonic(PIN_S2_TRIG, PIN_S2_ECHO),
  Ultrasonic(PIN_S3_TRIG, PIN_S3_ECHO),
};
static Detector det;
static Servo servo;

// ---- scheduler state ----
enum class Phase : uint8_t { Ready, Pinging, Gap };
static Phase phase = Phase::Ready;
static uint8_t slot = 0;           // 0 = S1, 1 = S2, 2 = S3
static int8_t activeSensor = -1;
static uint32_t phaseUntil = 0;
static uint16_t scanIdx = 0;
static int8_t scanDir = 1;
static uint32_t servoReadyAt = 0;
static bool servoAttached = false;

// ---- latest values for telemetry ----
static Reading lastKind[3] = {Reading::NoResponse, Reading::NoResponse, Reading::NoResponse};
static float lastCm[3] = {NAN, NAN, NAN};
struct ScanPoint { int16_t angle; float d; float base; bool changed; bool oor; bool valid; };
static ScanPoint pending[MAX_POINTS_BATCH];
static uint8_t pendingN = 0;
static uint32_t lastTelemetry = 0, lastHeartbeat = 0, lastLog = 0;
static uint32_t eventsMovement = 0, eventsAnomaly = 0;

static int16_t angleOf(uint16_t idx) { return cfg.scanMin + idx * cfg.scanStep; }

static const char* resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_SW: return "SOFTWARE";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "WATCHDOG";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_EXT: return "EXTERNAL";
    default: return "UNKNOWN";
  }
}

// ---------------------------------------------------------------- servo
static void servoAttach(uint32_t now) {
  if (servoAttached) return;
  servo.setPeriodHertz(50);
  servo.attach(PIN_SERVO, SERVO_MIN_US, SERVO_MAX_US);
  servo.write(angleOf(scanIdx));
  servoAttached = true;
  servoReadyAt = now + SERVO_ATTACH_WAIT;
}

static void servoDetach() {
  if (!servoAttached) return;
  servo.detach();  // no holding current while idle
  servoAttached = false;
}

static void applyServoState(uint32_t now) {
  if (cfg.s3Enabled && cfg.scanning) servoAttach(now);
  else servoDetach();
}

static void resetScan(uint32_t now) {
  scanIdx = 0;
  scanDir = 1;
  det.resetScanLayout();
  if (servoAttached) {
    servo.write(angleOf(0));
    servoReadyAt = now + SERVO_ATTACH_WAIT;
  }
}

static void advanceScan(uint32_t now) {
  uint16_t n = cfg.scanCells();
  bool atEnd = (scanDir > 0 && scanIdx >= n - 1) || (scanDir < 0 && scanIdx == 0);
  if (atEnd) {
    det.endSweep(now);
    scanDir = -scanDir;  // bounce: 0->180 then 180->0, no jump-back
  }
  if (n > 1) scanIdx += scanDir;
  servo.write(angleOf(scanIdx));
  servoReadyAt = now + (uint32_t)cfg.scanStep * SERVO_MS_PER_DEG + cfg.settleMs;
}

// ---------------------------------------------------------------- events
static void onEvent(const Event& e) {
  bool movement = strcmp(e.category, "MOVEMENT") == 0;
  if (movement) { eventsMovement++; buzzer.movement(); }
  else { eventsAnomaly++; buzzer.anomaly(); }

  Serial.printf("[event] %s %s S%u d=%.1f base=%.1f delta=%.1f angle=%d\n", e.category, e.kind, e.sensor,
                e.d, e.base, e.delta, e.angle);
  JsonDocument doc;
  doc["type"] = "event";
  doc["t"] = millis();
  doc["category"] = e.category;
  doc["kind"] = e.kind;
  doc["sensor"] = e.sensor;
  if (!isnan(e.d)) doc["d"] = e.d;
  if (!isnan(e.base)) doc["b"] = e.base;
  if (!isnan(e.delta)) doc["delta"] = e.delta;
  if (e.angle >= 0) doc["angle"] = e.angle;
  if (!isnan(e.rate)) doc["rate"] = e.rate;
  net::send(doc);  // dropped if offline; the buzzer still works
}

// ---------------------------------------------------------------- scheduler
static bool slotEnabled(uint8_t s) {
  if (s == 0) return cfg.s1Enabled;
  if (s == 1) return cfg.s2Enabled;
  return cfg.s3Enabled && cfg.scanning && servoAttached;
}

static void handleResult(uint8_t s, Reading r, float cm, uint32_t now) {
  lastKind[s] = r;
  lastCm[s] = cm;
  if (s < 2) {
    det.updateFixed(s, r, cm, now);
    return;
  }
  int16_t a = angleOf(scanIdx);
  det.updateScan(scanIdx, a, r, cm, now);
  const ScanCell& c = det.scan[scanIdx];
  if (pendingN < MAX_POINTS_BATCH)
    pending[pendingN++] = {a, (r == Reading::Ok) ? cm : NAN, c.base, c.changed && r != Reading::NoResponse,
                           r == Reading::OutOfRange, r != Reading::NoResponse};
  advanceScan(now);
}

static void schedule(uint32_t now) {
  switch (phase) {
    case Phase::Ready: {
      for (uint8_t tries = 0; tries < 3; tries++) {
        uint8_t s = slot;
        slot = (slot + 1) % 3;
        if (!slotEnabled(s)) continue;
        if (s == 2 && (int32_t)(now - servoReadyAt) < 0) continue;  // servo still settling
        if (!sensors[s].trigger()) {  // echo line still high from a previous ping
          handleResult(s, Reading::OutOfRange, NAN, now);
          continue;
        }
        activeSensor = s;
        phase = Phase::Pinging;
        return;
      }
      break;
    }
    case Phase::Pinging: {
      float cm = NAN;
      Reading r = sensors[activeSensor].poll(cm);
      if (r == Reading::Pending) return;
      handleResult(activeSensor, r, cm, now);
      phase = Phase::Gap;
      phaseUntil = now + PING_GAP_MS;
      break;
    }
    case Phase::Gap:
      if ((int32_t)(now - phaseUntil) >= 0) phase = Phase::Ready;
      break;
  }
}

// ---------------------------------------------------------------- messages out
static const char* sensorStatus(uint8_t s) {
  bool enabled = s == 0 ? cfg.s1Enabled : s == 1 ? cfg.s2Enabled : cfg.s3Enabled;
  if (!enabled) return "DISABLED";
  bool fault = s < 2 ? det.fixed[s].fault : det.s3Fault;
  if (fault) return "FAULT";
  if (det.calibrating()) return "CALIBRATING";
  if (s == 2 && !cfg.scanning) return "IDLE";
  return "OK";
}

static void addFloat(JsonObject o, const char* k, float v) {
  if (isnan(v)) o[k] = nullptr;
  else o[k] = roundf(v * 10) / 10.0f;
}

static void sendTelemetry(uint32_t now) {
  JsonDocument doc;
  doc["type"] = "telemetry";
  doc["t"] = now;
  doc["scanning"] = cfg.s3Enabled && cfg.scanning;
  doc["calibrating"] = det.calibrating();
  doc["cal_progress"] = det.calProgress();
  doc["angle"] = angleOf(scanIdx);
  doc["dir"] = scanDir;
  doc["sweep"] = det.sweepId;
  JsonArray arr = doc["sensors"].to<JsonArray>();
  for (uint8_t s = 0; s < 3; s++) {
    JsonObject o = arr.add<JsonObject>();
    o["id"] = s + 1;
    o["status"] = sensorStatus(s);
    if (s < 2) {
      const FixedChannel& f = det.fixed[s];
      addFloat(o, "d", lastKind[s] == Reading::NoResponse ? NAN : f.last);
      o["oor"] = f.lastOor;
      addFloat(o, "b", f.calibrated ? f.base : NAN);
      addFloat(o, "sigma", f.calibrated ? f.sigma : NAN);
      addFloat(o, "delta", f.calibrated ? f.delta : NAN);
      o["state"] = stateName(f.st);
      o["changed"] = f.calibrated && f.changed;
    } else {
      addFloat(o, "d", lastKind[2] == Reading::NoResponse ? NAN : det.s3Last);
      o["oor"] = det.s3LastOor;
      o["angle"] = det.s3LastAngle;
    }
  }
  JsonArray pts = doc["points"].to<JsonArray>();
  for (uint8_t i = 0; i < pendingN; i++) {
    JsonArray p = pts.add<JsonArray>();
    p.add(pending[i].angle);
    if (isnan(pending[i].d)) p.add(nullptr); else p.add(roundf(pending[i].d * 10) / 10.0f);
    if (isnan(pending[i].base)) p.add(nullptr); else p.add(roundf(pending[i].base * 10) / 10.0f);
    p.add(pending[i].changed ? 1 : 0);
    p.add(pending[i].oor ? 1 : 0);
    p.add(pending[i].valid ? 1 : 0);
  }
  if (net::send(doc)) pendingN = 0;
  else if (pendingN >= MAX_POINTS_BATCH) pendingN = 0;  // offline: drop old points
}

static void sendHeartbeat(uint32_t now) {
  JsonDocument doc;
  doc["type"] = "heartbeat";
  doc["t"] = now;
  doc["uptime_s"] = now / 1000;
  doc["rssi"] = net::rssi();
  doc["heap"] = ESP.getFreeHeap();
  doc["events_movement"] = eventsMovement;
  doc["events_anomaly"] = eventsAnomaly;
  net::send(doc);
}

static void sendBaseline() {
  JsonDocument doc;
  doc["type"] = "baseline";
  JsonArray fx = doc["fixed"].to<JsonArray>();
  for (uint8_t s = 0; s < 2; s++) {
    JsonObject o = fx.add<JsonObject>();
    o["id"] = s + 1;
    addFloat(o, "b", det.fixed[s].calibrated ? det.fixed[s].base : NAN);
    addFloat(o, "sigma", det.fixed[s].calibrated ? det.fixed[s].sigma : NAN);
  }
  JsonObject sc = doc["scan"].to<JsonObject>();
  sc["min"] = cfg.scanMin;
  sc["step"] = cfg.scanStep;
  JsonArray b = sc["b"].to<JsonArray>();
  JsonArray sg = sc["sigma"].to<JsonArray>();
  for (uint16_t i = 0; i < cfg.scanCells(); i++) {
    if (isnan(det.scan[i].base)) { b.add(nullptr); sg.add(nullptr); }
    else { b.add(roundf(det.scan[i].base * 10) / 10.0f); sg.add(roundf(det.scan[i].sigma * 10) / 10.0f); }
  }
  net::send(doc);
}

static void sendHello() {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["fw"] = FW_VERSION;
  doc["mac"] = WiFi.macAddress();
  doc["ip"] = WiFi.localIP().toString();
  doc["reset_reason"] = resetReason();
  doc["simulated"] = false;
  cfg.toJson(doc["settings"].to<JsonObject>());
  net::send(doc);
  if (!det.calibrating()) sendBaseline();
}

// ---------------------------------------------------------------- messages in
static void ack(JsonVariantConst id, bool ok, const char* note) {
  JsonDocument doc;
  doc["type"] = "ack";
  doc["id"] = id;
  doc["ok"] = ok;
  if (note) doc["note"] = note;
  cfg.toJson(doc["settings"].to<JsonObject>());
  net::send(doc);
}

static void onMessage(JsonDocument& msg) {
  uint32_t now = millis();
  const char* type = msg["type"] | "";
  JsonVariantConst id = msg["id"];

  if (strcmp(type, "settings") == 0) {
    uint8_t chg = cfg.fromJson(msg["settings"].as<JsonObjectConst>());
    if (chg & CHG_ANY) cfg.save();
    const char* note = nullptr;
    if (chg & CHG_RESTART) {
      ack(id, true, "restarting");
      Serial.println("[cfg] S3 mode changed, restarting...");
      delay(300);
      ESP.restart();
    }
    if (chg & CHG_SERVO) applyServoState(now);
    if (chg & CHG_RECAL) {
      resetScan(now);
      det.startCalibration(now);
      note = "recalibrating";
    }
    Serial.printf("[cfg] settings updated (flags 0x%02x)\n", chg);
    ack(id, true, note);
  } else if (strcmp(type, "command") == 0) {
    const char* cmd = msg["cmd"] | "";
    bool ok = true;
    if (strcmp(cmd, "calibrate") == 0) {
      det.startCalibration(now);
    } else if (strcmp(cmd, "scan_start") == 0 || strcmp(cmd, "scan_stop") == 0) {
      cfg.scanning = strcmp(cmd, "scan_start") == 0;
      cfg.save();
      applyServoState(now);
    } else if (strcmp(cmd, "buzzer_test") == 0) {
      buzzer.test();
    } else if (strcmp(cmd, "silence") == 0) {
      buzzer.silence();
    } else {
      ok = false;
    }
    Serial.printf("[cmd] %s -> %s\n", cmd, ok ? "ok" : "unknown");
    ack(id, ok, ok ? cmd : "unknown command");
  }
}

// ---------------------------------------------------------------- serial log
static void logLine(uint32_t now) {
  Serial.printf("[%7lus] ", (unsigned long)(now / 1000));
  for (uint8_t s = 0; s < 2; s++) {
    const FixedChannel& f = det.fixed[s];
    Serial.printf("S%u %6.1fcm b%6.1f %-9s %-11s| ", s + 1, f.last, f.base, stateName(f.st), sensorStatus(s));
  }
  Serial.printf("S3 @%3d %6.1fcm %-8s| WiFi %s %ddBm WS %s", det.s3LastAngle, det.s3Last, sensorStatus(2),
                net::wifiUp() ? "up" : "down", net::rssi(), net::wsUp() ? "up" : "down");
  if (det.calibrating()) Serial.printf(" | CAL %u%%", det.calProgress());
  Serial.println();
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  buzzer.begin();  // first: drive buzzer I/O HIGH (silent) as early as possible
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== Arc Guard firmware %s  reset: %s ===\n", FW_VERSION, resetReason());

  cfg.load();
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  sensors[0].begin();
  sensors[1].begin();
  if (cfg.s3Uart) sensors[2].beginUart(Serial2);
  else sensors[2].begin();

  uint32_t now = millis();
  applyServoState(now);
  det.begin(onEvent);
  det.startCalibration(now);
  Serial.println("[cal] calibrating baseline - keep the monitored area clear");

  net::begin(onMessage, sendHello);
}

void loop() {
  uint32_t now = millis();
  net::loop(now);
  schedule(now);
  det.tick(now);
  buzzer.loop(now);

  if (det.takeCalibrationDone()) {
    Serial.println("[cal] calibration complete");
    sendBaseline();
  }
  if (now - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = now;
    sendTelemetry(now);
  }
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    sendHeartbeat(now);
  }
  if (now - lastLog >= 1000) {
    lastLog = now;
    logLine(now);
  }
}
