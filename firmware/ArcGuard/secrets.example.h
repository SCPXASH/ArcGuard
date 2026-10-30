// Copy this file to "secrets.h" (same folder) and fill in your values.
// secrets.h is git-ignored so your Wi-Fi password is never committed.
#pragma once

// 2.4 GHz network only (ESP32 cannot join 5 GHz). A phone hotspot is the most
// reliable option for demos; keep it within 1-2 m because no antenna is fitted.
#define WIFI_SSID     "YourHotspotName"
#define WIFI_PASSWORD "YourHotspotPassword"

// IPv4 address of the laptop running the backend (run `ipconfig` on Windows and
// use the address of the adapter connected to the same network as the ESP32).
#define BACKEND_HOST  "192.168.1.5"
#define BACKEND_PORT  8000
