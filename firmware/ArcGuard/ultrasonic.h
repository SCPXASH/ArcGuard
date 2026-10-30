// Non-blocking ultrasonic driver. The echo pulse is timed by a pin-change
// interrupt, so loop() never waits for an echo. Supports pulse mode (HC-SR04,
// US-100 without jumper) and US-100 UART mode.
#pragma once
#include <Arduino.h>

enum class Reading : uint8_t { Pending, Ok, OutOfRange, NoResponse };

class Ultrasonic {
 public:
  Ultrasonic(uint8_t trigPin, uint8_t echoPin) : trig_(trigPin), echo_(echoPin) {}
  void begin();
  void beginUart(HardwareSerial& port);  // US-100 UART mode on the same two pins
  bool trigger();                        // false if the sensor is still busy
  Reading poll(float& cm);               // call until it returns something other than Pending

  // touched from the ISR
  volatile uint32_t riseUs = 0, fallUs = 0;
  volatile bool rose = false, fell = false;
  uint8_t echoPin() const { return echo_; }

 private:
  uint8_t trig_, echo_;
  uint32_t trigUs_ = 0, trigMs_ = 0;
  bool inFlight_ = false;
  HardwareSerial* uart_ = nullptr;
};
