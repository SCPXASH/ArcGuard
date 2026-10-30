#include "settings.h"
#include <Preferences.h>

Settings cfg;

void Settings::toJson(JsonObject o) const {
  o["s1_enabled"] = s1Enabled;
  o["s2_enabled"] = s2Enabled;
  o["s3_enabled"] = s3Enabled;
  o["s3_uart"] = s3Uart;
  o["temp_c"] = tempC;
  o["tau_abs_cm"] = tauAbsCm;
  o["k_sigma"] = kSigma;
  o["confirm_count"] = confirmCount;
  o["t_min_ms"] = tMinMs;
  o["rate_min_cms"] = rateMinCms;
  o["dwell_s"] = dwellS;
  o["jump_cm"] = jumpCm;
  o["pattern_k"] = patternK;
  o["fault_count"] = faultCount;
  o["cooldown_s"] = cooldownS;
  o["scanning"] = scanning;
  o["scan_min"] = scanMin;
  o["scan_max"] = scanMax;
  o["scan_step"] = scanStep;
  o["settle_ms"] = settleMs;
  o["scan_confirm_sweeps"] = scanConfirmSweeps;
  o["shift_window_deg"] = shiftWindowDeg;
  o["buzzer_enabled"] = buzzerEnabled;
  o["buzz_on_movement"] = buzzOnMovement;
  o["buzz_on_anomaly"] = buzzOnAnomaly;
  o["buzzer_passive"] = buzzerPassive;
}

// Assign a key if present, clamped to [lo, hi]; record that something changed.
template <typename T, typename V>
static bool take(JsonObjectConst o, const char* key, T& field, V lo, V hi, uint8_t& chg, uint8_t flag) {
  JsonVariantConst v = o[key];
  if (v.isNull()) return false;
  T nv = (T)constrain(v.as<float>(), (float)lo, (float)hi);
  if (nv == field) return false;
  field = nv;
  chg |= CHG_ANY | flag;
  return true;
}

static bool takeBool(JsonObjectConst o, const char* key, bool& field, uint8_t& chg, uint8_t flag) {
  JsonVariantConst v = o[key];
  if (v.isNull()) return false;
  bool nv = v.as<bool>();
  if (nv == field) return false;
  field = nv;
  chg |= CHG_ANY | flag;
  return true;
}

uint8_t Settings::fromJson(JsonObjectConst o) {
  uint8_t c = CHG_NONE;
  takeBool(o, "s1_enabled", s1Enabled, c, 0);
  takeBool(o, "s2_enabled", s2Enabled, c, 0);
  takeBool(o, "s3_enabled", s3Enabled, c, CHG_SERVO);
  takeBool(o, "s3_uart", s3Uart, c, CHG_RESTART);
  take(o, "temp_c", tempC, -10, 50, c, CHG_RECAL);
  take(o, "tau_abs_cm", tauAbsCm, 3, 200, c, 0);
  take(o, "k_sigma", kSigma, 1, 20, c, 0);
  take(o, "confirm_count", confirmCount, 1, 20, c, 0);
  take(o, "t_min_ms", tMinMs, 0, 10000, c, 0);
  take(o, "rate_min_cms", rateMinCms, 1, 1000, c, 0);
  take(o, "dwell_s", dwellS, 1, 3600, c, 0);
  take(o, "jump_cm", jumpCm, 10, 400, c, 0);
  take(o, "pattern_k", patternK, 2, 60, c, 0);
  take(o, "fault_count", faultCount, 2, 100, c, 0);
  take(o, "cooldown_s", cooldownS, 0, 600, c, 0);
  takeBool(o, "scanning", scanning, c, CHG_SERVO);
  take(o, "scan_min", scanMin, 0, 179, c, CHG_RECAL);
  take(o, "scan_max", scanMax, 1, 180, c, CHG_RECAL);
  take(o, "scan_step", scanStep, 1, 30, c, CHG_RECAL);
  take(o, "settle_ms", settleMs, 10, 1000, c, 0);
  take(o, "scan_confirm_sweeps", scanConfirmSweeps, 1, 10, c, 0);
  take(o, "shift_window_deg", shiftWindowDeg, 5, 90, c, 0);
  takeBool(o, "buzzer_enabled", buzzerEnabled, c, 0);
  takeBool(o, "buzz_on_movement", buzzOnMovement, c, 0);
  takeBool(o, "buzz_on_anomaly", buzzOnAnomaly, c, 0);
  takeBool(o, "buzzer_passive", buzzerPassive, c, 0);
  if (scanMax <= scanMin) {  // keep a valid, non-empty range
    scanMax = min(180, scanMin + scanStep);
    c |= CHG_ANY | CHG_RECAL;
  }
  return c;
}

void Settings::load() {
  Preferences p;
  if (!p.begin("arcguard", true)) return;  // first boot: namespace absent, keep defaults
  String s = p.getString("cfg", "");
  p.end();
  if (s.isEmpty()) return;
  JsonDocument doc;
  if (deserializeJson(doc, s) == DeserializationError::Ok) fromJson(doc.as<JsonObjectConst>());
}

void Settings::save() const {
  JsonDocument doc;
  toJson(doc.to<JsonObject>());
  String s;
  serializeJson(doc, s);
  Preferences p;
  p.begin("arcguard", false);
  p.putString("cfg", s);
  p.end();
}

float Settings::usPerCmRoundTrip() const {
  float mPerS = 331.3f + 0.606f * tempC;  // speed of sound
  float cmPerUs = mPerS * 1e-4f;
  return 2.0f / cmPerUs;                  // there and back
}
