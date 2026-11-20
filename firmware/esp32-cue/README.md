# ESP32 Cue

Bare-metal cue device for Controlled mode: wire a button/sensor from a
GPIO pin to GND, and a press POSTs `/api/cues/<id>` to the conductor. All
intelligence — which displays, arm/go/sync, cooldown, recue policy —
lives in `data/cues.json` on the conductor, so reflashing is never needed
to change behavior.

## Setup

1. Copy `config.h.example` to `config.h`, fill in WiFi, the conductor URL, and
   a token (`CUE_TOKEN` env on the conductor, or any paired display token).
2. Map your pin(s) to cue ids in `INPUTS[]`.
3. Flash with Arduino IDE (board: ESP32 Dev Module) or PlatformIO.
4. On the conductor, create the mapping:

   ```
   PUT /api/cues/gallery-door
   {"action": "sync", "players": ["hw-…"], "cooldown_ms": 30000,
    "recue": "queue", "lead_ms": 500}
   ```

## LED legend

- Fast blink — connecting to WiFi
- Single pulse every ~3s — alive, on network
- Triple blink — cue sent

The server returns `429` inside a cooldown window; that's a received
fire — server policy decides whether it queues or drops.
