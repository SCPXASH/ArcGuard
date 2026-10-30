#include "net.h"
#include <WebSocketsClient.h>
#include <WiFi.h>
#include "config.h"
#include "secrets.h"

namespace net {

static WebSocketsClient ws;
static MessageHandler handler = nullptr;
static void (*connectCb)() = nullptr;
static bool connected = false;
static uint32_t lastWifiCheck = 0;

static void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      connected = true;
      Serial.printf("[net] backend connected ws://%s:%d/ws/device\n", BACKEND_HOST, BACKEND_PORT);
      if (connectCb) connectCb();
      break;
    case WStype_DISCONNECTED:
      if (connected) Serial.println("[net] backend disconnected");
      connected = false;
      break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length) == DeserializationError::Ok && handler) handler(doc);
      break;
    }
    default:
      break;
  }
}

void begin(MessageHandler onMessage, void (*onConnect)()) {
  handler = onMessage;
  connectCb = onConnect;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // lower latency; the board is USB powered
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[net] joining Wi-Fi \"%s\"...\n", WIFI_SSID);
  ws.begin(BACKEND_HOST, BACKEND_PORT, "/ws/device");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(WS_RECONNECT_MS);
  ws.enableHeartbeat(15000, 3000, 2);  // ping/pong keeps NAT/hotspots from dropping the socket
}

void loop(uint32_t now) {
  ws.loop();
  if (now - lastWifiCheck >= WIFI_CHECK_MS) {
    lastWifiCheck = now;
    static bool wasUp = false;
    bool up = WiFi.status() == WL_CONNECTED;
    if (up && !wasUp) Serial.printf("[net] Wi-Fi up, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!up) {
      if (wasUp) Serial.println("[net] Wi-Fi lost, reconnecting...");
      WiFi.reconnect();
    }
    wasUp = up;
  }
}

bool wifiUp() { return WiFi.status() == WL_CONNECTED; }
bool wsUp() { return connected; }
int rssi() { return wifiUp() ? WiFi.RSSI() : 0; }

bool send(JsonDocument& doc) {
  if (!connected) return false;
  String s;
  serializeJson(doc, s);
  return ws.sendTXT(s);
}

}  // namespace net
