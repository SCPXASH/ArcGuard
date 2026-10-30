// Phase-2 test: MG90S servo on GPIO21 (red -> 5 V rail, brown -> GND).
// Expected: servo goes 0 -> 90 -> 180 -> 90 -> 0, pausing 1 s at each, then sweeps
// smoothly in 5-degree steps. If the ESP32 resets (Serial shows the banner again)
// the USB port cannot supply enough current: use a power bank or another port.
#include <Arduino.h>
#include <ESP32Servo.h>

Servo servo;

void setup() {
  pinMode(4, OUTPUT); digitalWrite(4, HIGH);
  Serial.begin(115200);
  Serial.println("Servo test");
  ESP32PWM::allocateTimer(0);
  servo.setPeriodHertz(50);
  servo.attach(21, 500, 2400);
  int stops[] = {0, 90, 180, 90, 0};
  for (int a : stops) {
    Serial.printf("angle %d\n", a);
    servo.write(a);
    delay(1000);
  }
}

void loop() {
  for (int a = 0; a <= 180; a += 5) { servo.write(a); delay(60); }
  for (int a = 180; a >= 0; a -= 5) { servo.write(a); delay(60); }
  Serial.println("sweep done");
}
