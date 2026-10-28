# Pi ⇄ Arduino serial protocol

Use this only if the team puts an Arduino between the Pi and the motors/sensors
(`"hardware": "arduino"` in `config.json`). The Pi side is already written
(`station/hardware.py → ArduinoHardware`); the Arduino sketch has to answer the
commands below.

## Connection

* USB cable from the Arduino to any USB port on the Pi. The Arduino appears as `/dev/ttyACM0`
  (Uno/Mega) or `/dev/ttyUSB0` (many Nano clones) — set `serial_port` in `config.json` to match.
* **115200 baud**, plain text, one message per line, lines end with `\n`.
* When the sketch starts (end of `setup()`), print `READY`.
* Lines starting with `#` are debug output; the Pi ignores them, so print as many as you like.

## Commands (Pi → Arduino) and replies (Arduino → Pi)

Every command gets exactly one reply that starts with `OK` or `ERR`, followed by the command word.

| Command | Meaning | Success reply | Failure reply |
|---|---|---|---|
| `PING` | Are you there? | `OK PING` | – |
| `DISPENSE <slot> <qty> <timeout_ms>` | Spin servo `<slot>` (1–5) until the break beam of that slot has counted `<qty>` pills. Each pill gets `<timeout_ms>` to appear. Stop the servo afterwards. | `OK DISPENSE <slot> <counted>` | `ERR DISPENSE <slot> <counted> TIMEOUT` (jam/empty) or `ERR DISPENSE <slot> 0 BAD_SLOT` |
| `TEST <slot>` | Spin the slot ~1 s (no counting) | `OK TEST <slot>` | `ERR TEST <slot> BAD_SLOT` |
| `ALERT <ms>` | Beep + vibrate for `<ms>` milliseconds. Reply right away; don't block. | `OK ALERT` | – |
| `WEIGHT` | Load-cell reading in grams (only if the NAU7802 is wired to the Arduino) | `OK WEIGHT 12.4` | `ERR WEIGHT NO_SENSOR` |
| `TARE` | Zero the load cell | `OK TARE` | `ERR TARE NO_SENSOR` |
| `STOP` | Stop every servo now (sent when the station shuts down) | `OK STOP` | – |

Example session (what you can type in the Arduino IDE's Serial Monitor to test, with
"Newline" line ending and 115200 baud selected):

```
> PING
< OK PING
> DISPENSE 3 2 3000
< # slot 3 spinning
< OK DISPENSE 3 2
> DISPENSE 5 1 3000
< ERR DISPENSE 5 0 TIMEOUT
```

## Hardware notes for the sketch

* **FS90R continuous-rotation servos:** `servo.write(90)` = stop, `< 90` one direction, `> 90` the other.
  If a servo creeps at 90, use `servo.writeMicroseconds(1500)` and adjust a few µs, or `detach()` it when stopped.
* **IR break beams:** wire the receiver output to a digital pin with `pinMode(pin, INPUT_PULLUP)`.
  It reads `LOW` while something blocks the beam. Count a pill on the HIGH→LOW change, not while LOW.
* **Power:** the 5 servos run from the **UBEC 5 V 3 A**, not the Arduino's 5 V pin. Connect the UBEC ground
  to the Arduino ground.
* **Vibration motor:** drive it through a transistor (plus a flyback diode), never directly from a pin.
* Only one servo should spin at a time; the Pi already sends one `DISPENSE` at a time and waits for the reply.
