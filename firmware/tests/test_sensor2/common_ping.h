// Shared helper for the Phase-2 test sketches: one blocking ping (fine for tests).
#pragma once
#include <Arduino.h>

// Returns distance in cm, -1 = out of range (no echo back), -2 = sensor did not respond.
inline float pingCm(uint8_t trig, uint8_t echo) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
  uint32_t t0 = micros();
  while (!digitalRead(echo)) if (micros() - t0 > 8000) return -2;
  uint32_t rise = micros();
  while (digitalRead(echo)) if (micros() - rise > 25000) return -1;
  float cm = (micros() - rise) / 57.7f;  // 25 C
  return (cm < 2 || cm > 400) ? -1 : cm;
}

inline void printReading(const char* name, float cm) {
  if (cm == -2) Serial.printf("%s: NO RESPONSE (check VCC/GND/ECHO wiring)\n", name);
  else if (cm == -1) Serial.printf("%s: out of range (>4 m or no echo)\n", name);
  else Serial.printf("%s: %.1f cm\n", name, cm);
}
