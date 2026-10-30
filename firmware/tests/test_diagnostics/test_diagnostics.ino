// Phase-2 all-in-one hardware diagnostic: tests every component in turn and prints a report.
// Serial Monitor at 115200. The report repeats every time the board resets (press EN to rerun).
// Things only a person can confirm are printed as "LOOK" / "LISTEN" lines.
#include <Arduino.h>
#include <ESP32Servo.h>
#include <esp_system.h>
#include <esp_mac.h>
#include "common_ping.h"

const uint8_t TRIG[3] = {23, 19, 17}, ECHO[3] = {22, 18, 16};
const uint8_t SERVO_PIN = 21, BUZZER_PIN = 4;
Servo servo;

const char* macStr() {
  static char buf[18];
  uint8_t m[6];
  esp_read_mac(m, ESP_MAC_WIFI_STA);
  snprintf(buf, sizeof buf, "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
  return buf;
}

const char* resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_SW: return "SOFTWARE";
    case ESP_RST_BROWNOUT: return "BROWNOUT (power dipped - check servo/USB supply)";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_EXT: return "EXTERNAL (EN button)";
    default: return "OTHER";
  }
}

// 15 pings, then a verdict for one sensor
bool testSensor(int i) {
  float v[15];
  int ok = 0, oor = 0, none = 0;
  for (int k = 0; k < 15; k++) {
    float cm = pingCm(TRIG[i], ECHO[i]);
    if (cm == -2) none++;
    else if (cm == -1) oor++;
    else v[ok++] = cm;
    delay(60);
  }
  float mn = 9999, mx = 0, sum = 0;
  for (int k = 0; k < ok; k++) { mn = min(mn, v[k]); mx = max(mx, v[k]); sum += v[k]; }
  Serial.printf("  S%d (TRIG %d, ECHO %d): %2d ok, %2d no-echo, %2d no-response", i + 1, TRIG[i], ECHO[i], ok, oor, none);
  if (ok) Serial.printf(" | avg %.1f cm, min %.1f, max %.1f, spread %.1f", sum / ok, mn, mx, mx - mn);
  Serial.println();
  if (none >= 10) { Serial.printf("  RESULT S%d: FAIL - sensor not answering. Check VCC on the 3.3V rail, GND, and the ECHO wire (row %s).\n", i + 1, i == 0 ? "8" : i == 1 ? "14" : "17"); return false; }
  if (ok == 0) { Serial.printf("  RESULT S%d: CHECK - answers but hears no echo. Point it at a wall or box 20-150 cm away and rerun.\n", i + 1); return false; }
  if (ok < 12 || mx - mn > 5) { Serial.printf("  RESULT S%d: WARN - working but unsteady. Hold a flat object still in front of it and rerun.\n", i + 1); return true; }
  Serial.printf("  RESULT S%d: PASS\n", i + 1);
  return true;
}

void setup() {
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);  // silent
  Serial.begin(115200);
  delay(1500);
  for (int i = 0; i < 3; i++) { pinMode(TRIG[i], OUTPUT); digitalWrite(TRIG[i], LOW); pinMode(ECHO[i], INPUT_PULLDOWN); }

  Serial.println("\n================ ARC GUARD HARDWARE DIAGNOSTIC ================");
  Serial.printf("Chip %s rev %d, %d cores, %d MHz | flash %u MB | free heap %u | MAC %s\n", ESP.getChipModel(), ESP.getChipRevision(),
                ESP.getChipCores(), ESP.getCpuFreqMHz(), ESP.getFlashChipSize() / (1024 * 1024), ESP.getFreeHeap(), macStr());
  Serial.printf("Reset reason: %s\n", resetReason());

  Serial.println("\n[1-3] Ultrasonic sensors, one at a time (keep the area in front of each sensor still):");
  bool s[3];
  for (int i = 0; i < 3; i++) s[i] = testSensor(i);

  Serial.println("\n[4] All three in sequence (crosstalk check), 5 rounds:");
  for (int r = 0; r < 5; r++) {
    Serial.print("  ");
    for (int i = 0; i < 3; i++) {
      float cm = pingCm(TRIG[i], ECHO[i]);
      if (cm >= 0) Serial.printf("S%d %6.1f cm   ", i + 1, cm); else Serial.printf("S%d %9s   ", i + 1, cm == -1 ? "no-echo" : "NO-RESP");
      delay(15);
    }
    Serial.println();
    delay(100);
  }

  Serial.println("\n[5] Servo on GPIO21 + Sensor 3 (LOOK: the servo should turn to 0, 90, 180, then back to 90):");
  ESP32PWM::allocateTimer(0);
  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2400);
  float at[3];
  int angles[3] = {0, 90, 180};
  for (int k = 0; k < 3; k++) {
    servo.write(angles[k]);
    delay(900);
    at[k] = pingCm(TRIG[2], ECHO[2]);
    Serial.printf("  servo %3d deg -> Sensor 3 reads %s%.1f\n", angles[k], at[k] < 0 ? "(no echo) " : "", at[k]);
  }
  servo.write(90);
  delay(600);
  bool differs = fabsf(at[0] - at[1]) > 10 || fabsf(at[1] - at[2]) > 10 || fabsf(at[0] - at[2]) > 10;
  Serial.printf("  RESULT servo: %s\n", differs ? "PASS - Sensor 3 sees different distances at different angles, so the servo turns it"
                                                : "CHECK - readings barely changed: did the servo move? (it may also face similar distances)");
  Serial.println("  If the board restarted during this step (banner printed again, reset reason BROWNOUT), the USB port can't power the servo.");

  Serial.println("\n[6] Buzzer on GPIO4 (LISTEN):");
  Serial.println("  A: steady LOW for 0.6 s - an ACTIVE buzzer beeps now");
  digitalWrite(BUZZER_PIN, LOW);
  delay(600);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(800);
  Serial.println("  B: 2.7 kHz tone for 0.6 s - a PASSIVE buzzer beeps now");
  uint32_t t0 = millis();
  while (millis() - t0 < 600) { digitalWrite(BUZZER_PIN, LOW); delayMicroseconds(185); digitalWrite(BUZZER_PIN, HIGH); delayMicroseconds(185); }
  digitalWrite(BUZZER_PIN, HIGH);
  Serial.println("  RESULT buzzer: tell me which part beeped (A = active, B = passive, both = active)");

  Serial.printf("\nSUMMARY: S1 %s | S2 %s | S3 %s | servo %s | buzzer: listen\n", s[0] ? "OK" : "PROBLEM", s[1] ? "OK" : "PROBLEM",
                s[2] ? "OK" : "PROBLEM", differs ? "OK" : "CHECK");
  Serial.println("================ LIVE READINGS (wave a hand in front of each sensor) ================");
}

void loop() {
  for (int i = 0; i < 3; i++) {
    float cm = pingCm(TRIG[i], ECHO[i]);
    if (cm >= 0) Serial.printf("S%d %6.1f cm   ", i + 1, cm); else Serial.printf("S%d %9s   ", i + 1, cm == -1 ? "no-echo" : "NO-RESP");
    delay(15);
  }
  Serial.println();
  delay(450);
}
