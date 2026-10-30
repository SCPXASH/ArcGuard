// Phase-2 test: complete scanning mechanism (servo + Sensor 3), 0-180 deg in 5 deg steps.
// Expected: one "angle,distance" line per step. Paste the output into a spreadsheet
// (or the Arduino Serial Plotter) - the profile should match the room. Re-run with an
// object placed at ~90 deg: only the readings near 90 deg should drop.
#include <Arduino.h>
#include <ESP32Servo.h>
#include "common_ping.h"

Servo servo;
const uint8_t TRIG = 17, ECHO = 16;
const int STEP = 5, SETTLE_MS = 80;

void setup() {
  pinMode(4, OUTPUT); digitalWrite(4, HIGH);
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT_PULLDOWN);
  ESP32PWM::allocateTimer(0);
  servo.setPeriodHertz(50);
  servo.attach(21, 500, 2400);
  servo.write(0);
  delay(800);
  Serial.println("angle,distance_cm");
}

void sweep(int from, int to, int dir) {
  for (int a = from; dir > 0 ? a <= to : a >= to; a += dir * STEP) {
    servo.write(a);
    delay(STEP * 2 + SETTLE_MS);
    float cm = pingCm(TRIG, ECHO);
    Serial.printf("%d,%.1f\n", a, cm);
  }
}

void loop() {
  sweep(0, 180, 1);
  sweep(180, 0, -1);
}
