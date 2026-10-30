// Runtime settings shared with the backend/dashboard. Persisted in NVS (flash)
// so they survive a reboot. JSON keys match backend/app/settings_schema.py.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

// What a settings update requires the firmware to do afterwards.
enum : uint8_t {
  CHG_NONE    = 0,
  CHG_ANY     = 1 << 0,
  CHG_RECAL   = 1 << 1,  // scan geometry changed -> baselines are invalid
  CHG_RESTART = 1 << 2,  // pin roles changed (S3 UART mode) -> reboot
  CHG_SERVO   = 1 << 3,  // scanning toggled
};

struct Settings {
  // sensors
  bool s1Enabled = true;
  bool s2Enabled = true;
  bool s3Enabled = true;
  bool s3Uart = false;          // US-100 jumper fitted -> UART mode
  float tempC = 25.0f;          // air temperature for speed of sound

  // detection
  float tauAbsCm = 15.0f;       // minimum deviation counted as a change
  float kSigma = 4.0f;          // multiplier on measured noise
  uint8_t confirmCount = 3;     // consecutive readings to confirm (fixed sensors)
  uint16_t tMinMs = 300;        // minimum change duration
  float rateMinCms = 30.0f;     // rate that makes a change "movement"
  uint16_t dwellS = 10;         // persistence before OBJECT_APPEARED/DISAPPEARED
  float jumpCm = 80.0f;         // SUDDEN_CHANGE jump size
  uint8_t patternK = 15;        // newly changed angles in one sweep for PATTERN (~40% of 37)
  uint8_t faultCount = 10;      // no-response readings in a row for SENSOR_FAULT
  uint16_t cooldownS = 3;       // repeat suppression

  // scanning
  bool scanning = true;
  uint8_t scanMin = 0;
  uint8_t scanMax = 180;
  uint8_t scanStep = 5;
  uint16_t settleMs = 40;
  uint8_t scanConfirmSweeps = 2;
  uint8_t shiftWindowDeg = 30;  // angular window for SHIFT movement

  // alarm
  bool buzzerEnabled = true;
  bool buzzOnMovement = true;
  bool buzzOnAnomaly = true;
  bool buzzerPassive = false;   // passive buzzer needs a tone, active needs DC

  void toJson(JsonObject o) const;
  uint8_t fromJson(JsonObjectConst o);  // returns CHG_* bitmask
  void load();
  void save() const;
  uint16_t scanCells() const { return (scanMax - scanMin) / scanStep + 1; }
  float usPerCmRoundTrip() const;       // microseconds of echo per cm of distance
};

extern Settings cfg;
