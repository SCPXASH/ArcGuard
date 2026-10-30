// Non-blocking buzzer patterns for the MH-FMD module (active-LOW input).
// Active buzzer: I/O held LOW = sound. Passive buzzer: needs a square wave,
// generated with LEDC through ESP32Servo's ESP32PWM so timers are shared safely.
#pragma once
#include <Arduino.h>

class Alarm {
 public:
  void begin();
  void loop(uint32_t now);
  void movement();   // 2 short beeps
  void anomaly();    // 3 long beeps
  void test();       // 1 beep, from the dashboard "Test buzzer" button
  void silence();

 private:
  void start(uint8_t beeps, uint16_t onMs, uint16_t offMs);
  void on();
  void off();
  uint8_t remaining_ = 0;
  uint16_t onMs_ = 0, offMs_ = 0;
  bool sounding_ = false, pwmAttached_ = false;
  uint32_t nextMs_ = 0;
};

extern Alarm buzzer;
