# Raspberry Pi integration guide (for Henry)

The Pi is a **client** of the API: it never needs an open port or a database. It polls the server, acts on what it
receives, and reports what happened. Everything below is implemented in [`examples/pi_client.py`](../examples/pi_client.py),
which runs as-is against the dev server (`pip install requests`).

```
boot ──▶ register (once) ──▶ show claim code ──▶ wait for claim ──▶ loop every 30 s:
                                                                      sync → run commands → dispense due doses → report
```

## 0. Point the Pi at the server

```bash
export PILLPAL_API=http://<laptop-ip>:4000/api/v1      # or https://pillpal-api.onrender.com/api/v1 once deployed
export PILLPAL_PROVISIONING_KEY=pillpal-provisioning-dev   # must match DEVICE_PROVISIONING_KEY in the server's .env
python3 pi_client.py
```

Quick connectivity check from the Pi: `curl $PILLPAL_API/health`.

## 1. Register once, keep the key

```python
r = requests.post(f"{API}/device/register",
                  json={"serialNumber": cpu_serial(), "firmwareVersion": "0.1.0", "model": "Raspberry Pi 5"},
                  headers={"X-Provisioning-Key": PROVISIONING_KEY})
data = r.json()   # {"deviceId": ..., "apiKey": "pp_dev_...", "claimCode": "K7PX3Q", ...}
```

* Save `apiKey` to disk (`~/.pillpal/device.json`). Every later request sends it as `X-Device-Key`.
* Use the CPU serial from `/proc/cpuinfo` as `serialNumber` so re-flashing the SD card re-registers the *same* device
  (the server just rotates the key).
* If any request ever returns **401**, the key is gone → register again.

## 2. Pairing (claim code on the touchscreen)

Show `claimCode` big on the 7" display and poll `GET /device/claim-status` every ~5 s until `claimed: true`.
The user types the code into the app. Codes expire after 30 min; the status call hands you a new one automatically.

## 3. The sync loop (every 30 s)

```python
state = requests.post(f"{API}/device/sync", headers=H, json={
    "firmwareVersion": "0.1.0",
    "ipAddress": local_ip(),
    "slots": [{"index": 1, "weightGrams": 21.3}],   # optional load-cell readings
}).json()
```

The response is everything the Pi needs (full shape in [API.md](API.md#post-devicesync-or-get-devicesync-without-a-body-call-every-30s)):

| Field | Use it for |
|---|---|
| `slots[]` | which medication is in which hopper, `pillCount`, `calibration` (servo ms per pill, tare…) |
| `schedules[]` | keep the schedule locally so the Pi can keep dispensing if Wi-Fi drops |
| `upcomingDoses[]` | **the work list**: each entry has an `id`, `slotIndex`, `quantity`, `scheduledAt`, `windowEndsAt`, `status` |
| `pendingCommands[]` | things the app asked for right now (`DISPENSE`, `RING`, `TARE_SCALE`…). Each is delivered once |
| `owner.requireTakenConfirmation` | if `true`, also send `/taken` when the tray sensor / touchscreen confirms |
| `device.settings` | volume, brightness, … set from the app |
| `serverTime` | clock check (the Pi 5 has the RTC battery, but still) |

Also useful: `recentDoses[]` (last 24 h with statuses) for a "history" screen on the touchscreen.

## 4. Dispensing a scheduled dose

When `now >= scheduledAt` for a dose with `status == "SCHEDULED"` (and `now <= windowEndsAt`):

1. Buzz / vibrate / show "Time for Metformin" on the screen
2. Spin the servo of `slotIndex` until the IR break beam has counted `quantity` pills (timeout!)
3. Report:

```python
requests.post(f"{API}/device/doses/{dose['id']}/dispensed", headers=H, json={
    "detectedCount": pills_counted,          # from the break beam
    "weightBeforeGrams": w0, "weightAfterGrams": w1,   # optional, from the load cell
    "slotIndex": dose["slotIndex"],
})
```

The server subtracts the pills from the slot, fires a low-stock alert if needed, and (by default) marks the dose
**TAKEN**. Reporting the same dose twice is harmless.

If something goes wrong (no pill detected, jam): `POST /device/doses/{id}/failed {"reason": "...", "code": "BREAK_BEAM_TIMEOUT"}`
→ the user and caregivers get a `DEVICE_ERROR` push. A later successful retry can still report `/dispensed`.

If the window passes without a report, the **server** marks the dose MISSED and alerts – the Pi does nothing.

## 5. Commands from the app

```python
for cmd in state["pendingCommands"]:
    if cmd["type"] == "DISPENSE":          # payload: {slotIndex, quantity, doseEventId}
        n = dispense(cmd["payload"]["slotIndex"], cmd["payload"]["quantity"])
        requests.post(f"{API}/device/commands/{cmd['id']}/complete", headers=H, json={"success": True, "result": {"detectedCount": n}})
    elif cmd["type"] == "RING":            # payload: {seconds}
        buzz(cmd["payload"]["seconds"]); complete(cmd, True)
    ...
```

A completed `DISPENSE` command automatically completes its dose; a failed one (`success: false, error: "..."`) alerts the user.
Do **not** also treat the command's dose as an upcoming dose – remote doses are intentionally left out of `upcomingDoses`.

## 6. Touchscreen "dispense now"

`POST /device/doses/manual {"slotIndex": 2, "quantity": 1, "detectedCount": 1}` after dispensing. It creates the dose
record and updates the count in one call.

## 7. Vitals (BLE blood-pressure cuff) and telemetry

```python
requests.post(f"{API}/device/vitals", headers=H, json={"type": "BLOOD_PRESSURE", "systolic": 128, "diastolic": 84, "pulse": 72,
                                                       "recordedAt": now_iso(), "meta": {"cuff": "Omron HEM-xxxx"}})
```
Out-of-range readings (≥180/120, <90/60, pulse >120/<40…) trigger a `VITALS_ALERT` to the user and caregivers.

* Load-cell / sensor samples: `POST /device/readings` (array OK) – `{"type": "WEIGHT", "slotIndex": 1, "value": 20.7, "unit": "g"}`
* Log lines: `POST /device/events` (array OK) – `{"level": "WARN", "type": "JAM", "message": "..."}`
* Scale-based recount: `POST /device/slots/1/count {"pillCount": 37, "weightGrams": 20.7}`
* Save calibration so it survives re-flashing: `PATCH /device/slots/1/calibration {"servoMsPerPill": 180}` (comes back in every sync)

Both batch endpoints accept arrays, so queue events while offline and upload them on the next successful sync.

## 8. Offline behaviour

* Keep the last sync response on disk. If the server is unreachable, keep dispensing from `upcomingDoses` /
  `schedules` and queue the reports; replay them when the connection returns (ids stay valid).
* The server marks the device **OFFLINE** after 5 min without a sync and tells the user; the first sync afterwards
  flips it back to ONLINE automatically.

## 9. Testing without hardware

Run `examples/pi_client.py` on your laptop against `npm run dev` – the `Hardware` class only prints what it would do.
`requests.http` in VS Code has every Pi call ready to click, using the seeded demo device key
`pp_dev_demo_0000000000000000000000000000000000000000`.
