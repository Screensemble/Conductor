# ESP32 Trigger

Bare-metal trigger device for Controlled mode: wire a button/sensor from a
GPIO pin to GND, and a press POSTs `/api/triggers/<id>` to the server. All
intelligence — which displays, arm/go/sync, cooldown, retrigger policy —
lives in `data/triggers.json` on the server, so reflashing is never needed
to change behavior.

## Setup

1. Copy `config.h.example` to `config.h`, fill in WiFi, the server URL, and
   a token (`TRIGGER_TOKEN` env on the server, or any paired display token).
2. Map your pin(s) to trigger ids in `INPUTS[]`.
3. Flash with Arduino IDE (board: ESP32 Dev Module) or PlatformIO.
4. On the server, create the mapping:

   ```
   PUT /api/triggers/gallery-door
   {"action": "sync", "players": ["hw-…"], "cooldown_ms": 30000,
    "retrigger": "queue", "lead_ms": 500}
   ```

## LED legend

- Fast blink — connecting to WiFi
- Single pulse every ~3s — alive, on network
- Triple blink — trigger sent

The server returns `429` inside a cooldown window; that's a received
fire — server policy decides whether it queues or drops.
