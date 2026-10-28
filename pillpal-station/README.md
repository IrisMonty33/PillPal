# PillPal station (Raspberry Pi + 7" touchscreen)

The software that runs on the dispenser itself. It connects to the PillPal server, shows the
touchscreen (landscape, 1280×720, Raspberry Pi Touch Display 2), dispenses doses, and reports
everything back so the phone app and caregivers stay up to date.

```
 PillPal server  ◀── sync every 30 s ──▶  station (Python, this folder)  ──▶  servos / break beams / buzzer
 (pillpal-api)                                 │                               (simulator | Arduino | Pi GPIO)
                                               ▼
                                   touchscreen page (Chromium full-screen)
```

## What the touchscreen does

| Screen | When |
|---|---|
| **Pairing** – big 6-character code | Until someone enters the code in the app (Settings → Pair a dispenser) |
| **Home** – clock, next dose + countdown, today's doses with status, pill level of all 5 slots | Normal |
| **Dose alert** – "It's time for your medicine", **Dispense** / **Skip** | When a dose is due (beeps again every 5 min) |
| **Dispensing → All set** (or **Take your pills… / I took them** if confirmation is on in the app) | After tapping Dispense |
| **Something went wrong** – which slot failed, **Try again** / **Close** | Jam or empty slot (user + caregivers are alerted by the server) |
| Tap a slot → "Dispense 1 now?" | Extra / late dose |
| Offline banner | Wi-Fi or server down – keeps dispensing from the saved schedule, sends reports later |

Commands from the app (Dispense now, Find it/beep) run within ~30 seconds.

## Try it on your laptop first (no Pi needed)

Needs Python 3.9+ (`python3 --version`) and the PillPal API running (`npm run dev` in pillpal-api).

```bash
cd pillpal-station
cp config.example.json config.json      # api_url: http://localhost:4000/api/v1 on the same laptop
python3 -m station
```

Open **http://localhost:8080** in Chrome and press F11 (full screen) – or set the window to 1280×720.

* A new station shows a **pairing code**. Pair it from the app (or `POST /devices/claim`), and the home screen appears.
* Want the seeded demo dispenser instead? Before starting, create `~/.pillpal/device.json` with
  `{"apiKey": "pp_dev_demo_0000000000000000000000000000000000000000"}`.
* To see a dose alert: in the app add a dose time 1–2 minutes from now for a medication that is in a slot.
* Simulate a jam: `PILLPAL_SIM_JAM=3 python3 -m station` makes slot 3 fail.

No packages to install – the station uses only Python's standard library (plus `pyserial` for the Arduino mode).

## Install on the Raspberry Pi

1. Raspberry Pi OS (64-bit, with desktop) on the SD card, connected to Wi-Fi, screen rotated to landscape
   (Preferences → Screen Configuration → right-click the display → Orientation).
2. Copy this folder to the Pi (USB stick, or `git clone` your team repo) – e.g. to `/home/<you>/pillpal-station`.
3. In a terminal on the Pi:
   ```bash
   cd ~/pillpal-station
   bash scripts/install.sh
   nano config.json          # set api_url to the server, e.g. http://192.168.1.20:4000/api/v1
   sudo reboot
   ```
4. After the reboot the touchscreen opens full-screen by itself and shows the pairing code.

Useful commands on the Pi:

| What | Command |
|---|---|
| Is it running? | `systemctl status pillpal-station` |
| Live log (sync, dispenses, errors) | `journalctl -u pillpal-station -f` |
| Restart after changing config/code | `sudo systemctl restart pillpal-station` |
| Leave the full-screen page | plug in a keyboard and press **Alt+F4** |
| Forget the pairing (start over) | `rm -r ~/.pillpal && sudo systemctl restart pillpal-station` |

## config.json

| Key | Meaning |
|---|---|
| `api_url` | The PillPal server, ending in `/api/v1`. Laptop on the same Wi-Fi: `http://<laptop-ip>:4000/api/v1` |
| `provisioning_key` | Must equal `DEVICE_PROVISIONING_KEY` in the server's `.env` |
| `hardware` | `simulator`, `arduino` or `gpio` (see below) |
| `serial_port` / `serial_baud` | Arduino mode only (`/dev/ttyACM0`, 115200) |
| `auto_dispense` | `false` = wait for the user to tap Dispense; `true` = dispense at the scheduled time automatically |
| `alert_repeat_minutes` | Beep again this often while a dose is waiting |
| `dispense_timeout_seconds` | Give up on a slot if no pill passes the break beam in this time |
| `local_port` | Port of the touchscreen page (default 8080) |

## Hardware modes – where the motors plug in

All hardware goes through one small class in `station/hardware.py`; nothing else changes:

* **simulator** – default. Prints `[sim] slot 2: dispensing 1 pill(s)`; use it until the hardware works.
* **arduino** – the Pi sends text commands over USB (`DISPENSE 3 2 8000`) and the Arduino replies
  (`OK DISPENSE 3 2`). The exact messages are in **`arduino/PROTOCOL.md`** – that is what the Arduino sketch implements.
* **gpio** – servos and break beams wired straight to the Pi. `GpioHardware` is a starting point
  (gpiozero, pin map at the top of the class) for Henry to adjust to the real wiring.

## Files

```
station/
  __main__.py   starts everything (python3 -m station)
  config.py     reads config.json
  api.py        talks to the server; queues reports while offline
  core.py       the brain: sync loop, "is a dose due?", dispense / skip / commands, screen state
  hardware.py   simulator / Arduino / GPIO
  server.py     serves the touchscreen page + its small JSON API on localhost
kiosk/          the touchscreen page (index.html, style.css, app.js)
arduino/PROTOCOL.md   messages between the Pi and an Arduino
scripts/install.sh    one-time Pi setup (service + full-screen at login)
scripts/start-kiosk.sh  opens Chromium full-screen
```

Local files the station keeps in `~/.pillpal/`: `device.json` (its key – keep private), `last_sync.json`
(schedule for offline use), `pending_reports.json` (reports waiting to be sent), `handled_doses.json`.
