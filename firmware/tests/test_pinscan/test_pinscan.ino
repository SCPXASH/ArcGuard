// Wiring finder: discovers which GPIOs each ultrasonic sensor's TRIG and ECHO are really on.
// For every candidate pin it sends a 10 us trigger pulse (all other pins are high-impedance inputs)
// and watches every other pin for an echo pulse. Prints the pairs it finds. Serial 115200.
// Flash pins (6-11), serial pins (1, 3) and the BOOT pin (0) are never touched.
#include <Arduino.h>

const uint8_t OUT_PINS[] = {2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33};
const uint8_t IN_PINS[] = {2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39};
const int NO = sizeof(OUT_PINS), NI = sizeof(IN_PINS);
bool highAtRest[40];  // pins already HIGH (e.g. the buzzer module's pull-up) cannot show an echo

void allInputs() {
  for (int i = 0; i < NI; i++) pinMode(IN_PINS[i], IN_PINS[i] >= 34 ? INPUT : INPUT_PULLDOWN);
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\n================ ARC GUARD WIRING FINDER ================");
  allInputs();
  delay(50);
  Serial.print("Pins reading HIGH at rest (pulled up by something connected): ");
  bool any = false;
  for (int i = 0; i < NI; i++) if (digitalRead(IN_PINS[i])) { Serial.printf("GPIO%d ", IN_PINS[i]); any = true; highAtRest[IN_PINS[i]] = true; }
  Serial.println(any ? "" : "none");

  int found = 0;
  for (int t = 0; t < NO; t++) {
    uint8_t trig = OUT_PINS[t];
    int hits[40] = {0};
    float width[40] = {0};
    for (int rep = 0; rep < 3; rep++) {
      allInputs();
      delay(30);
      pinMode(trig, OUTPUT);
      digitalWrite(trig, LOW);
      delayMicroseconds(5);
      digitalWrite(trig, HIGH);
      delayMicroseconds(10);
      digitalWrite(trig, LOW);
      uint32_t t0 = micros();
      int8_t echo = -1;
      uint32_t rise = 0;
      while (micros() - t0 < 8000 && echo < 0)  // wait for any other pin to go HIGH
        for (int i = 0; i < NI; i++)
          if (IN_PINS[i] != trig && !highAtRest[IN_PINS[i]] && digitalRead(IN_PINS[i])) { echo = IN_PINS[i]; rise = micros(); break; }
      if (echo >= 0) {
        while (digitalRead(echo) && micros() - rise < 30000) {}
        hits[echo]++;
        width[echo] = (micros() - rise) / 57.7f;
      }
      pinMode(trig, INPUT_PULLDOWN);
      delay(40);
    }
    for (int p = 0; p < 40; p++)
      if (hits[p] >= 2 && !highAtRest[trig]) {
        found++;
        Serial.printf("FOUND sensor: TRIG on GPIO%-2d -> ECHO on GPIO%-2d  (%d/3 replies, ~%.0f cm)\n", trig, p, hits[p], width[p]);
      }
  }
  Serial.printf("Sensors found: %d (expected 3)\n", found);
  if (found == 0)
    Serial.println("No sensor answered on any pin -> the sensors are not getting power or ground (check the 3.3V rail and GND).");
  Serial.println("Expected wiring: S1 TRIG 23/ECHO 22, S2 TRIG 19/ECHO 18, S3 TRIG 17/ECHO 16.");
  Serial.println("================ done (press EN to scan again) ================");
}

void loop() {}
