// Phase-2 test: all three sensors pinged one after another (never at the same time).
// Expected: one line per cycle with three distances; covering one sensor changes only
// its own value. If a value jumps when ANOTHER sensor is covered, increase GAP_MS
// or point the sensors in different directions (crosstalk).
#include <Arduino.h>
#include "common_ping.h"

const uint8_t TRIG[3] = {23, 19, 17}, ECHO[3] = {22, 18, 16};
const uint16_t GAP_MS = 15;

void setup() {
  pinMode(4, OUTPUT); digitalWrite(4, HIGH);
  Serial.begin(115200);
  for (int i = 0; i < 3; i++) { pinMode(TRIG[i], OUTPUT); pinMode(ECHO[i], INPUT_PULLDOWN); }
  Serial.println("All-sensor sequential test");
}

void loop() {
  for (int i = 0; i < 3; i++) {
    float cm = pingCm(TRIG[i], ECHO[i]);
    if (cm >= 0) Serial.printf("S%d %6.1f cm   ", i + 1, cm);
    else Serial.printf("S%d %8s   ", i + 1, cm == -1 ? "range" : "NO-RESP");
    delay(GAP_MS);
  }
  Serial.println();
  delay(100);
}
