#include "detector.h"
#include "settings.h"

const char* stateName(DState s) {
  switch (s) {
    case DState::Idle: return "IDLE";
    case DState::Candidate: return "CANDIDATE";
    case DState::Active: return "ACTIVE";
    case DState::Cooldown: return "COOLDOWN";
  }
  return "?";
}

float Detector::median(float* v, uint8_t n) {
  float t[CAL_SAMPLES_FIXED];
  for (uint8_t i = 0; i < n; i++) t[i] = v[i];
  for (uint8_t i = 1; i < n; i++) {  // insertion sort, n <= 20
    float x = t[i];
    int8_t j = i - 1;
    while (j >= 0 && t[j] > x) { t[j + 1] = t[j]; j--; }
    t[j + 1] = x;
  }
  return (n % 2) ? t[n / 2] : 0.5f * (t[n / 2 - 1] + t[n / 2]);
}

// baseline = median, noise = 1.4826 * MAD (robust to a few bad echoes)
static void robustStats(float* v, uint8_t n, float& base, float& sigma, float (*med)(float*, uint8_t)) {
  base = med(v, n);
  float dev[CAL_SAMPLES_FIXED];
  for (uint8_t i = 0; i < n; i++) dev[i] = fabsf(v[i] - base);
  sigma = max(1.0f, 1.4826f * med(dev, n));
}

float Detector::tauFor(float sigma) const { return max(cfg.tauAbsCm, cfg.kSigma * sigma); }

void Detector::emit(const char* cat, const char* kind, uint8_t sensor, float d, float base, float delta,
                    int16_t angle, float rate) {
  if (!sink_) return;
  Event e{cat, kind, sensor, d, base, delta, angle, rate};
  sink_(e);
}

// ---------------------------------------------------------------- calibration
void Detector::startCalibration(uint32_t now) {
  calibrating_ = true;
  calDone_ = false;
  calStart_ = now;
  calSweeps_ = 0;
  for (auto& f : fixed) {
    f.calN = 0;
    f.calibrated = false;
    f.st = DState::Idle;
    f.cnt = f.back = 0;
  }
  for (uint16_t i = 0; i < MAX_ANGLES; i++) {
    scan[i] = ScanCell();
  }
}

uint8_t Detector::calProgress() const {
  if (!calibrating_) return 100;
  float parts = 0, done = 0;
  if (cfg.s1Enabled) { parts++; done += min(1.0f, fixed[0].calN / (float)CAL_SAMPLES_FIXED); }
  if (cfg.s2Enabled) { parts++; done += min(1.0f, fixed[1].calN / (float)CAL_SAMPLES_FIXED); }
  if (cfg.s3Enabled && cfg.scanning) { parts++; done += min(1.0f, calSweeps_ / (float)CAL_SWEEPS_SCAN); }
  return parts ? (uint8_t)(100 * done / parts) : 100;
}

bool Detector::takeCalibrationDone() {
  bool d = calDone_;
  calDone_ = false;
  return d;
}

void Detector::finishCalibration(uint32_t now) {
  for (auto& f : fixed) {
    if (f.calN >= CAL_MIN_SAMPLES) {
      robustStats(f.cal, f.calN, f.base, f.sigma, median);
      f.calibrated = true;
    }
    f.st = DState::Idle;
    f.prev = NAN;
  }
  for (uint16_t i = 0; i < cfg.scanCells(); i++) {
    ScanCell& c = scan[i];
    if (c.calN >= CAL_MIN_SAMPLES) robustStats(c.cal, c.calN, c.base, c.sigma, median);
    c.changed = c.prevSweepChanged = false;
    c.cnt = 0;
  }
  calibrating_ = false;
  calDone_ = true;
}

void Detector::tick(uint32_t now) {
  if (!calibrating_) return;
  bool anyFeed = cfg.s1Enabled || cfg.s2Enabled || (cfg.s3Enabled && cfg.scanning);
  if (!anyFeed || (int32_t)(now - calStart_) > (int32_t)CAL_TIMEOUT_MS) finishCalibration(now);
}

static bool fixedCalComplete(const FixedChannel& f, bool enabled) {
  return !enabled || f.calN >= CAL_SAMPLES_FIXED || f.fault;
}

// ---------------------------------------------------------------- fixed sensors
void Detector::updateFixed(uint8_t idx, Reading r, float cm, uint32_t now) {
  FixedChannel& f = fixed[idx];
  uint8_t sensor = idx + 1;

  if (r == Reading::NoResponse) {
    if (++f.invalidRun >= cfg.faultCount && !f.fault) {
      f.fault = true;
      emit("ANOMALY", "SENSOR_FAULT", sensor, NAN, f.base, NAN, -1, NAN);
    }
    return;  // invalid readings pause the state machine, they do not reset it
  }
  f.invalidRun = 0;
  f.fault = false;

  float d = (r == Reading::OutOfRange) ? RANGE_MAX_CM : cm;
  f.lastOor = (r == Reading::OutOfRange);
  f.hist[f.hi] = d;  // median-of-3 filter
  f.hi = (f.hi + 1) % 3;
  if (f.hn < 3) f.hn++;
  float m = median(f.hist, f.hn);

  float dt = (now - f.lastMs) / 1000.0f;
  f.prev = f.last;
  f.last = m;
  f.lastMs = now;

  if (calibrating_) {
    if (f.calN < CAL_SAMPLES_FIXED) f.cal[f.calN++] = d;
    bool fixedDone = fixedCalComplete(fixed[0], cfg.s1Enabled) && fixedCalComplete(fixed[1], cfg.s2Enabled);
    bool scanDone = !(cfg.s3Enabled && cfg.scanning) || calSweeps_ >= CAL_SWEEPS_SCAN;
    if ((fixedDone && scanDone) || (int32_t)(now - calStart_) > (int32_t)CAL_TIMEOUT_MS) finishCalibration(now);
    return;
  }
  if (!f.calibrated) return;

  f.delta = m - f.base;
  float tau = tauFor(f.sigma);
  f.changed = fabsf(f.delta) > tau;
  float rate = (!isnan(f.prev) && dt > 0 && dt < 2) ? (m - f.prev) / dt : 0;

  if (!isnan(f.prev) && fabsf(m - f.prev) > cfg.jumpCm && now >= f.suddenCoolUntil) {
    emit("ANOMALY", "SUDDEN_CHANGE", sensor, m, f.base, f.delta, -1, rate);
    f.suddenCoolUntil = now + cfg.cooldownS * 1000UL;
  }

  switch (f.st) {
    case DState::Idle:
      if (f.changed) {
        f.st = DState::Candidate;
        f.cnt = 1;
        f.tStart = now;
        f.maxRate = fabsf(rate);
      }
      break;

    case DState::Candidate:
      if (!f.changed) { f.st = DState::Idle; break; }  // did not persist: noise
      f.cnt++;
      f.maxRate = max(f.maxRate, fabsf(rate));
      if (f.cnt >= cfg.confirmCount && now - f.tStart >= cfg.tMinMs) {
        f.st = DState::Active;
        f.back = 0;
        f.movementSent = f.anomalySent = false;
        if (f.maxRate >= cfg.rateMinCms) {
          emit("MOVEMENT", "MOTION", sensor, m, f.base, f.delta, -1, f.maxRate);
          f.movementSent = true;
          f.moveCoolUntil = now + cfg.cooldownS * 1000UL;
        }
      }
      break;

    case DState::Active:
      if (f.changed) {
        f.back = 0;
        if (fabsf(rate) >= cfg.rateMinCms && now >= f.moveCoolUntil) {
          emit("MOVEMENT", "MOTION", sensor, m, f.base, f.delta, -1, rate);
          f.movementSent = true;
          f.moveCoolUntil = now + cfg.cooldownS * 1000UL;
        }
        if (!f.anomalySent && now - f.tStart >= cfg.dwellS * 1000UL && fabsf(rate) < cfg.rateMinCms) {
          emit("ANOMALY", f.delta < 0 ? "OBJECT_APPEARED" : "OBJECT_DISAPPEARED", sensor, m, f.base, f.delta, -1, rate);
          f.anomalySent = true;
        }
      } else if (++f.back >= cfg.confirmCount) {
        if (!f.movementSent && !f.anomalySent)  // came and went before dwell
          emit("MOVEMENT", "TRANSIENT", sensor, m, f.base, f.delta, -1, f.maxRate);
        f.st = DState::Cooldown;
        f.coolUntil = now + cfg.cooldownS * 1000UL;
      }
      break;

    case DState::Cooldown:
      if (now >= f.coolUntil) f.st = DState::Idle;
      break;
  }
}

// ---------------------------------------------------------------- scanning sensor
void Detector::resetScanLayout() {
  for (uint16_t i = 0; i < MAX_ANGLES; i++) scan[i] = ScanCell();
}

void Detector::updateScan(uint16_t cell, int16_t angle, Reading r, float cm, uint32_t now) {
  if (cell >= MAX_ANGLES) return;
  ScanCell& c = scan[cell];
  s3LastAngle = angle;

  if (r == Reading::NoResponse) {
    c.valid = false;
    if (++s3InvalidRun >= cfg.faultCount && !s3Fault) {
      s3Fault = true;
      emit("ANOMALY", "SENSOR_FAULT", 3, NAN, NAN, NAN, angle, NAN);
    }
    return;
  }
  s3InvalidRun = 0;
  s3Fault = false;

  float d = (r == Reading::OutOfRange) ? RANGE_MAX_CM : cm;
  c.oor = (r == Reading::OutOfRange);
  c.valid = true;
  c.prevD = c.last;
  c.last = d;
  s3Last = d;
  s3LastOor = c.oor;

  if (calibrating_) {
    if (c.calN < CAL_SWEEPS_SCAN) c.cal[c.calN++] = d;
    return;
  }
  if (isnan(c.base)) return;

  float delta = d - c.base;
  float tau = tauFor(c.sigma);
  bool changed = fabsf(delta) > tau;
  bool wasChanged = c.prevSweepChanged;
  c.changed = changed;

  if (!changed) {
    c.cnt = 0;
    c.anomalySent = false;
    return;
  }
  if (c.cnt == 0) c.tStart = now;
  if (c.cnt < 255) c.cnt++;

  if (!wasChanged) {
    sweepNewChanges_++;
    // SHIFT: new change here while a nearby angle was changed last sweep -> something moved
    int16_t win = max<int16_t>(1, cfg.shiftWindowDeg / cfg.scanStep);
    bool neighbour = false;
    for (int16_t j = (int16_t)cell - win; j <= (int16_t)cell + win; j++) {
      if (j < 0 || j == (int16_t)cell || j >= (int16_t)cfg.scanCells()) continue;
      if (scan[j].prevSweepChanged) { neighbour = true; break; }
    }
    if (neighbour && now >= s3MoveCoolUntil_) {
      emit("MOVEMENT", "SHIFT", 3, d, c.base, delta, angle, NAN);
      s3MoveCoolUntil_ = now + cfg.cooldownS * 1000UL;
    }
  } else if (!isnan(c.prevD) && fabsf(d - c.prevD) >= max(tau, 20.0f) && now >= s3MoveCoolUntil_) {
    // RADIAL: still changed at this angle but the range moved since the last sweep
    emit("MOVEMENT", "RADIAL", 3, d, c.base, delta, angle, NAN);
    s3MoveCoolUntil_ = now + cfg.cooldownS * 1000UL;
  }

  if (!c.anomalySent && c.cnt >= cfg.scanConfirmSweeps && now - c.tStart >= cfg.dwellS * 1000UL) {
    // One object covers several neighbouring angles (the beam is ~15 deg wide): report it once.
    bool reported = false;
    for (int8_t dir = -1; dir <= 1 && !reported; dir += 2) {
      for (int16_t j = (int16_t)cell + dir; j >= 0 && j < (int16_t)cfg.scanCells() && scan[j].changed; j += dir) {
        if (scan[j].anomalySent) { reported = true; break; }
      }
    }
    if (!reported) emit("ANOMALY", delta < 0 ? "OBJECT_APPEARED" : "OBJECT_DISAPPEARED", 3, d, c.base, delta, angle, NAN);
    c.anomalySent = true;
  }
}

void Detector::endSweep(uint32_t now) {
  sweepId++;
  if (calibrating_) {
    calSweeps_++;
    bool fixedDone = fixedCalComplete(fixed[0], cfg.s1Enabled) && fixedCalComplete(fixed[1], cfg.s2Enabled);
    if ((fixedDone && calSweeps_ >= CAL_SWEEPS_SCAN) || (int32_t)(now - calStart_) > (int32_t)CAL_TIMEOUT_MS) finishCalibration(now);
    return;
  }
  if (sweepNewChanges_ >= cfg.patternK && now >= patternCoolUntil_) {
    emit("ANOMALY", "PATTERN", 3, NAN, NAN, (float)sweepNewChanges_, -1, NAN);
    patternCoolUntil_ = now + cfg.cooldownS * 1000UL;
  }
  sweepNewChanges_ = 0;
  for (uint16_t i = 0; i < cfg.scanCells(); i++) scan[i].prevSweepChanged = scan[i].changed;
}
