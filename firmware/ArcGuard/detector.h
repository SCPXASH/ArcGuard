// Baseline calibration + movement/anomaly detection.
//
// Fixed sensors (S1, S2): one state machine each, fed ~9 readings/s.
//   IDLE -> CANDIDATE (|delta| > tau) -> ACTIVE (M readings, >= T_min) -> COOLDOWN
// Scan sensor (S3): one cell per scan angle, fed once per sweep; movement is
// inferred from changes that move between angles or in range across sweeps.
#pragma once
#include <Arduino.h>
#include "config.h"
#include "ultrasonic.h"

enum class DState : uint8_t { Idle, Candidate, Active, Cooldown };
const char* stateName(DState s);

struct Event {
  const char* category;  // "MOVEMENT" | "ANOMALY"
  const char* kind;      // MOTION, TRANSIENT, SHIFT, RADIAL | OBJECT_APPEARED, ...
  uint8_t sensor;        // 1..3
  float d, base, delta;  // NAN when not applicable
  int16_t angle;         // -1 for fixed sensors
  float rate;            // cm/s, NAN when not applicable
};
typedef void (*EventSink)(const Event&);

struct FixedChannel {
  float base = NAN, sigma = 0;
  bool calibrated = false;
  float hist[3] = {0, 0, 0};
  uint8_t hn = 0, hi = 0;
  float last = NAN, prev = NAN;
  uint32_t lastMs = 0;
  bool lastOor = false;
  float delta = 0;
  bool changed = false;
  DState st = DState::Idle;
  uint8_t cnt = 0, back = 0;
  uint32_t tStart = 0, coolUntil = 0, moveCoolUntil = 0, suddenCoolUntil = 0;
  float maxRate = 0;
  bool movementSent = false, anomalySent = false;
  uint16_t invalidRun = 0;
  bool fault = false;
  float cal[CAL_SAMPLES_FIXED];
  uint8_t calN = 0;
};

struct ScanCell {
  float base = NAN, sigma = 0;
  float last = NAN, prevD = NAN;
  bool oor = false, valid = false;
  bool changed = false, prevSweepChanged = false;
  uint8_t cnt = 0;  // consecutive sweeps changed
  uint32_t tStart = 0;
  bool anomalySent = false;
  float cal[CAL_SWEEPS_SCAN];
  uint8_t calN = 0;
};

class Detector {
 public:
  void begin(EventSink sink) { sink_ = sink; }
  void startCalibration(uint32_t now);
  bool calibrating() const { return calibrating_; }
  uint8_t calProgress() const;
  bool takeCalibrationDone();  // true once after calibration finishes
  void tick(uint32_t now);     // finishes calibration on timeout / when nothing feeds it

  void updateFixed(uint8_t idx, Reading r, float cm, uint32_t now);
  void updateScan(uint16_t cell, int16_t angle, Reading r, float cm, uint32_t now);
  void endSweep(uint32_t now);
  void resetScanLayout();

  FixedChannel fixed[2];
  ScanCell scan[MAX_ANGLES];
  uint16_t s3InvalidRun = 0;
  bool s3Fault = false;
  float s3Last = NAN;
  bool s3LastOor = false;
  int16_t s3LastAngle = -1;
  uint32_t sweepId = 0;

 private:
  void finishCalibration(uint32_t now);
  void emit(const char* cat, const char* kind, uint8_t sensor, float d, float base, float delta,
            int16_t angle, float rate);
  float tauFor(float sigma) const;
  static float median(float* v, uint8_t n);

  EventSink sink_ = nullptr;
  bool calibrating_ = false, calDone_ = false;
  uint32_t calStart_ = 0;
  uint8_t calSweeps_ = 0;
  uint8_t sweepNewChanges_ = 0;
  uint32_t s3MoveCoolUntil_ = 0, patternCoolUntil_ = 0;
};
