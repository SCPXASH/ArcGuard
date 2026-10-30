// Arc Guard — compile-time configuration: pins, timing limits and buffer sizes.
// Runtime-tunable values (thresholds, scan range, ...) live in settings.h and can be
// changed from the dashboard.
#pragma once
#include <Arduino.h>

#define FW_VERSION "1.0.0"

// ---- Pin map (verified for ESP32-WROOM-32U, 38-pin DevKit; see docs/WIRING.md) ----
// All signal pins are on the right-hand header; none are strapping/flash/serial pins.
constexpr uint8_t PIN_S1_TRIG = 23;
constexpr uint8_t PIN_S1_ECHO = 22;
constexpr uint8_t PIN_S2_TRIG = 19;
constexpr uint8_t PIN_S2_ECHO = 18;
constexpr uint8_t PIN_S3_TRIG = 17;   // US-100 "Trig/Tx"  (UART mode: ESP32 RX)
constexpr uint8_t PIN_S3_ECHO = 16;   // US-100 "Echo/Rx"  (UART mode: ESP32 TX)
constexpr uint8_t PIN_SERVO   = 21;
constexpr uint8_t PIN_BUZZER  = 4;    // MH-FMD: LOW = sound, HIGH = silent

// ---- Ultrasonic timing ----
constexpr float    RANGE_MIN_CM          = 2.0f;
constexpr float    RANGE_MAX_CM          = 400.0f;
constexpr uint32_t ECHO_START_TIMEOUT_US = 8000;   // echo must rise within this, else "no response"
constexpr uint32_t ECHO_TIMEOUT_US       = 25000;  // ~4.3 m round trip; longer = out of range
constexpr uint32_t UART_REPLY_TIMEOUT_MS = 100;    // US-100 UART mode reply window
constexpr uint32_t PING_GAP_MS           = 12;     // silence between pings (echo decay)

// ---- Servo (Tower Pro MG90S) ----
constexpr uint16_t SERVO_MIN_US      = 500;
constexpr uint16_t SERVO_MAX_US      = 2400;
constexpr uint8_t  SERVO_MS_PER_DEG  = 2;    // ~0.1 s / 60 deg at 4.8 V, rounded up
constexpr uint16_t SERVO_ATTACH_WAIT = 600;  // ms to reach first angle after attach

// ---- Networking ----
constexpr uint16_t TELEMETRY_MS      = 200;
constexpr uint16_t HEARTBEAT_MS      = 2000;
constexpr uint16_t WIFI_CHECK_MS     = 5000;
constexpr uint16_t WS_RECONNECT_MS   = 3000;

// ---- Detection buffers ----
constexpr uint8_t  CAL_SAMPLES_FIXED = 20;   // samples per fixed sensor during calibration
constexpr uint8_t  CAL_SWEEPS_SCAN   = 5;    // sweeps per scan angle during calibration
constexpr uint8_t  CAL_MIN_SAMPLES   = 3;    // fewer than this -> that point stays uncalibrated
constexpr uint32_t CAL_TIMEOUT_MS    = 120000;
constexpr uint16_t MAX_ANGLES        = 181;  // 0..180 at 1 deg
constexpr uint8_t  MAX_POINTS_BATCH  = 24;   // scan points buffered between telemetry frames
