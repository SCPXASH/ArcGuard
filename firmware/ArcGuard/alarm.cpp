#include "alarm.h"
#include <ESP32Servo.h>
#include "config.h"
#include "settings.h"

Alarm buzzer;
static ESP32PWM tonePwm;
constexpr double TONE_HZ = 2700;

void Alarm::begin() {
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, HIGH);  // HIGH = silent
}

void Alarm::on() {
  if (cfg.buzzerPassive) {
    tonePwm.attachPin(PIN_BUZZER, TONE_HZ, 10);
    tonePwm.writeScaled(0.5);
    pwmAttached_ = true;
  } else {
    digitalWrite(PIN_BUZZER, LOW);
  }
  sounding_ = true;
}

void Alarm::off() {
  if (pwmAttached_) {
    tonePwm.detachPin(PIN_BUZZER);
    pwmAttached_ = false;
    pinMode(PIN_BUZZER, OUTPUT);
  }
  digitalWrite(PIN_BUZZER, HIGH);
  sounding_ = false;
}

void Alarm::start(uint8_t beeps, uint16_t onMs, uint16_t offMs) {
  if (remaining_ > 0) return;  // let the current pattern finish
  remaining_ = beeps;
  onMs_ = onMs;
  offMs_ = offMs;
  nextMs_ = millis();
}

void Alarm::movement() {
  if (cfg.buzzerEnabled && cfg.buzzOnMovement) start(2, 120, 120);
}

void Alarm::anomaly() {
  if (cfg.buzzerEnabled && cfg.buzzOnAnomaly) start(3, 350, 200);
}

void Alarm::test() { start(1, 300, 0); }

void Alarm::silence() {
  remaining_ = 0;
  off();
}

void Alarm::loop(uint32_t now) {
  if (remaining_ == 0 || (int32_t)(now - nextMs_) < 0) return;
  if (!sounding_) {
    on();
    nextMs_ = now + onMs_;
  } else {
    off();
    remaining_--;
    nextMs_ = now + offMs_;
  }
}
