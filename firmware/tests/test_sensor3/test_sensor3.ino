// Phase-2 test: Sensor 3 alone (TRIG GPIO17, ECHO GPIO16, VCC 3.3 V).
// Expected: Serial Monitor (115200) prints a distance every 200 ms; moving your hand
// from 10 cm to 1 m changes it smoothly; pointing at a wall gives a steady value
// (+/- 1 cm). "NO RESPONSE" means a wiring problem.
#include <Arduino.h>
#include "common_ping.h"

const uint8_t TRIG = 17, ECHO = 16;

void setup() {
  pinMode(4, OUTPUT); digitalWrite(4, HIGH);  // keep buzzer silent
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT_PULLDOWN);
  Serial.println("Sensor 3 test");
}

void loop() {
  printReading("S3", pingCm(TRIG, ECHO));
  delay(200);
}
