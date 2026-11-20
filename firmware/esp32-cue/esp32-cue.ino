// Screensemble ESP32 cue device — fires /api/cues/<id> on the server.
// Each configured pin maps to a cue id; the conductor owns everything
// else (mapping, cooldown, recue policy) — see src/cues.js.
//
// Build: Arduino IDE / PlatformIO, board "ESP32 Dev Module".
// Fill in config.h before flashing.

#include "config.h"
#include <WiFi.h>
#include <HTTPClient.h>

// config.h must define:
//   WIFI_SSID, WIFI_PASS          network
//   SERVER_URL                    "http://192.168.x.x:8080"
//   CUE_TOKEN                 bearer token (server env CUE_TOKEN
//                                 or any paired display's token)
//   INPUTS[]                      {pin, "cue-id"} pairs, INPUT_PULLUP
//   DEBOUNCE_MS                   ignore edges faster than this
//   STATUS_LED                    blink pin (GPIO2 on most devkits)
//   HEARTBEAT_MS                  status blink interval

struct Input { uint8_t pin; const char *id; };

static unsigned long lastFire[sizeof(INPUTS) / sizeof(INPUTS[0])];
static bool lastLevel[sizeof(INPUTS) / sizeof(INPUTS[0])];
static unsigned long lastBlink = 0;

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));  // fast blink = no wifi
  }
  digitalWrite(STATUS_LED, LOW);
}

void fire(const char *id) {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  HTTPClient http;
  String url = String(SERVER_URL) + "/api/cues/" + id;
  http.begin(url);
  http.addHeader("Authorization", "Bearer " CUE_TOKEN);
  int code = http.POST("");
  // 202 fired, 429 inside server cooldown — both mean "received"; the
  // server's cooldown/recue policy decides what happens next.
  Serial.printf("cue %s -> %d\n", id, code);
  for (int i = 0; i < 3; i++) {          // triple-blink confirms a send
    digitalWrite(STATUS_LED, HIGH); delay(60);
    digitalWrite(STATUS_LED, LOW); delay(60);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED, OUTPUT);
  const size_t n = sizeof(INPUTS) / sizeof(INPUTS[0]);
  for (size_t i = 0; i < n; i++) {
    pinMode(INPUTS[i].pin, INPUT_PULLUP);
    lastLevel[i] = digitalRead(INPUTS[i].pin);
    lastFire[i] = 0;
  }
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();

  // Heartbeat blink — one short pulse per HEARTBEAT_MS proves the device
  // is alive and on-network.
  if (millis() - lastBlink >= HEARTBEAT_MS) {
    lastBlink = millis();
    digitalWrite(STATUS_LED, HIGH);
    delay(25);
    digitalWrite(STATUS_LED, LOW);
  }

  const size_t n = sizeof(INPUTS) / sizeof(INPUTS[0]);
  for (size_t i = 0; i < n; i++) {
    bool level = digitalRead(INPUTS[i].pin);
    // Edge: released -> pressed (pull-up: LOW is pressed).
    if (level == LOW && lastLevel[i] == HIGH &&
        millis() - lastFire[i] >= DEBOUNCE_MS) {
      lastFire[i] = millis();
      fire(INPUTS[i].id);
    }
    lastLevel[i] = level;
  }
}
