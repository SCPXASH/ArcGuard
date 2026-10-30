#include "ultrasonic.h"
#include "config.h"
#include "settings.h"
#include "soc/gpio_struct.h"

static void IRAM_ATTR echoIsr(void* arg) {
  Ultrasonic* u = static_cast<Ultrasonic*>(arg);
  uint32_t t = micros();
  bool high = (GPIO.in >> u->echoPin()) & 1;  // all echo pins are < 32
  if (high) {
    u->riseUs = t;
    u->rose = true;
  } else if (u->rose && !u->fell) {
    u->fallUs = t;
    u->fell = true;
  }
}

void Ultrasonic::begin() {
  pinMode(trig_, OUTPUT);
  digitalWrite(trig_, LOW);
  // pull-down: an unplugged ECHO wire reads LOW -> "no response" instead of noise
  pinMode(echo_, INPUT_PULLDOWN);
  attachInterruptArg(digitalPinToInterrupt(echo_), echoIsr, this, CHANGE);
}

void Ultrasonic::beginUart(HardwareSerial& port) {
  uart_ = &port;
  // module Trig/Tx -> ESP32 RX (trig_ pin), module Echo/Rx <- ESP32 TX (echo_ pin)
  uart_->begin(9600, SERIAL_8N1, trig_, echo_);
}

bool Ultrasonic::trigger() {
  if (uart_) {
    while (uart_->available()) uart_->read();  // drop stale bytes
    uart_->write(0x55);                        // US-100: "measure distance"
    trigMs_ = millis();
    inFlight_ = true;
    return true;
  }
  if ((GPIO.in >> echo_) & 1) return false;    // previous echo still high
  rose = fell = false;
  digitalWrite(trig_, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig_, LOW);
  trigUs_ = micros();
  inFlight_ = true;
  return true;
}

Reading Ultrasonic::poll(float& cm) {
  if (!inFlight_) return Reading::NoResponse;
  if (uart_) {
    if (uart_->available() >= 2) {
      uint16_t mm = (uart_->read() << 8) | uart_->read();
      inFlight_ = false;
      if (mm == 0 || mm > 4500) return Reading::OutOfRange;
      cm = mm / 10.0f;
      return (cm < RANGE_MIN_CM || cm > RANGE_MAX_CM) ? Reading::OutOfRange : Reading::Ok;
    }
    if (millis() - trigMs_ > UART_REPLY_TIMEOUT_MS) {
      inFlight_ = false;
      return Reading::NoResponse;
    }
    return Reading::Pending;
  }
  uint32_t now = micros();
  if (fell) {
    inFlight_ = false;
    cm = (fallUs - riseUs) / cfg.usPerCmRoundTrip();
    return (cm < RANGE_MIN_CM || cm > RANGE_MAX_CM) ? Reading::OutOfRange : Reading::Ok;
  }
  if (!rose && now - trigUs_ > ECHO_START_TIMEOUT_US) {
    inFlight_ = false;
    return Reading::NoResponse;
  }
  if (rose && now - riseUs > ECHO_TIMEOUT_US) {
    inFlight_ = false;
    return Reading::OutOfRange;
  }
  return Reading::Pending;
}
