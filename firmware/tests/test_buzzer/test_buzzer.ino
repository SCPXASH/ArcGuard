// Phase-2 test: MH-FMD buzzer, I/O on GPIO4, VCC 3.3 V. The module sounds when I/O is LOW.
// Part A holds I/O LOW for 1 s: an ACTIVE buzzer beeps, a PASSIVE one only clicks.
// Part B plays a 2.7 kHz tone for 1 s: a PASSIVE buzzer beeps clearly.
// Note which part made a proper beep and set "Passive buzzer" in the dashboard settings.
#include <Arduino.h>

void setup() {
  pinMode(4, OUTPUT);
  digitalWrite(4, HIGH);
  Serial.begin(115200);
  delay(500);
}

void loop() {
  Serial.println("A: steady LOW (active buzzer test)");
  digitalWrite(4, LOW);
  delay(1000);
  digitalWrite(4, HIGH);
  delay(1500);
  Serial.println("B: 2.7 kHz square wave (passive buzzer test)");
  uint32_t t0 = millis();
  while (millis() - t0 < 1000) {
    digitalWrite(4, LOW);  delayMicroseconds(185);
    digitalWrite(4, HIGH); delayMicroseconds(185);
  }
  delay(3000);
}
