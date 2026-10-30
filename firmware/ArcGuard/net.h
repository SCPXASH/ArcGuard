// Wi-Fi + WebSocket client to the backend (/ws/device). Reconnects on its own;
// detection keeps running while offline.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

typedef void (*MessageHandler)(JsonDocument& msg);

namespace net {
void begin(MessageHandler onMessage, void (*onConnect)());
void loop(uint32_t now);
bool wifiUp();
bool wsUp();
int rssi();
bool send(JsonDocument& doc);
}  // namespace net
