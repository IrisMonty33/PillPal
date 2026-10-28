# PillPal API reference

Base URL: `http://localhost:4000/api/v1` (development). All bodies are JSON. All timestamps are ISO-8601 UTC
(`2026-10-02T12:00:00.000Z`); the app converts them to local time for display.

## Authentication

| Who | Header | Where it comes from |
|---|---|---|
| App user | `Authorization: Bearer <accessToken>` | `POST /auth/login` or `/auth/register` |
| Raspberry Pi | `X-Device-Key: pp_dev_…` | `POST /device/register` (returned once) |
| Pi, first boot only | `X-Provisioning-Key: <DEVICE_PROVISIONING_KEY>` | `.env` on the server |
| Admin / demo tools | `X-Admin-Key: <ADMIN_API_KEY>` | `.env` on the server |

Access tokens last 1 day. When a request returns `401`, call `POST /auth/refresh` with the refresh token and retry.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
             "details": [ { "path": "email", "message": "Invalid email address" } ] } }
```

| Status | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_JSON` | Body/query/params failed validation (`details` lists the fields) |
| 401 | `UNAUTHORIZED` | Missing/expired token or wrong key |
| 403 | `FORBIDDEN` | Logged in, but not allowed (e.g. not this patient's caregiver) |
| 404 | `NOT_FOUND` | Unknown id, or it belongs to another user |
| 409 | `CONFLICT` | Duplicate email, device already claimed, invalid status transition |
| 410 | `CLAIM_CODE_EXPIRED` | Ask the dispenser for a new claim code |
| 422 | `UNPROCESSABLE` | Valid request that makes no sense (e.g. refill a slot with no medication) |
| 429 | `RATE_LIMITED` | Too many login attempts |
| 500 | `INTERNAL_ERROR` | Bug – check the server log |

## Enums

| Enum | Values |
|---|---|
| DoseStatus | `SCHEDULED` `DISPENSED` `TAKEN` `MISSED` `SKIPPED` `FAILED` |
| DoseSource | `SCHEDULE` `MANUAL` (logged in app) `DEVICE` (touchscreen "dispense now") `REMOTE` (app "dispense now") |
| MedicationForm | `TABLET` `CAPSULE` `SOFTGEL` `OTHER` |
| DeviceStatus | `UNCLAIMED` `ONLINE` `OFFLINE` |
| CommandType | `DISPENSE` `TEST_SLOT` `TARE_SCALE` `CALIBRATE_SCALE` `RING` `REBOOT` `SYNC_NOW` `UPDATE_SETTINGS` |
| CommandStatus | `PENDING` `SENT` `COMPLETED` `FAILED` `EXPIRED` |
| NotificationType | `DOSE_REMINDER` `DOSE_MISSED` `DOSE_TAKEN` `LOW_STOCK` `DEVICE_OFFLINE` `DEVICE_ONLINE` `DEVICE_ERROR` `VITALS_ALERT` `CAREGIVER_INVITE` `SYSTEM` |
| VitalType | `BLOOD_PRESSURE` `HEART_RATE` `SPO2` `TEMPERATURE` `WEIGHT` `GLUCOSE` |
| SensorType | `WEIGHT` `BREAK_BEAM` `TEMPERATURE` `HUMIDITY` `BATTERY` `OTHER` |
| CaregiverStatus | `PENDING` `ACCEPTED` `REVOKED` |

---

## System

### `GET /health` – no auth
`{ "status": "ok", "database": "ok", "time": "…", "version": "0.1.0" }` (503 when the database is unreachable)

### `POST /system/tick` – `X-Admin-Key`
Runs the scheduler job immediately. Returns `{ "tick": { dosesGenerated, remindersSent, dosesMissed, devicesOffline, commandsExpired } }`.

### `GET /system/stats` – `X-Admin-Key`
Row counts per table.

---

## Auth (`/auth`) – app

### `POST /auth/register`
```json
{ "email": "alan@example.com", "password": "Password123!", "firstName": "Alan", "lastName": "Demo", "timezone": "America/New_York" }
```
→ `201 { "user": {…}, "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer", "expiresIn": "1d" }`
`timezone` defaults to `America/New_York`; it controls when schedules fire.

### `POST /auth/login`
`{ "email", "password" }` → `200` same shape as register. Wrong credentials → `401`.

### `POST /auth/refresh`
`{ "refreshToken" }` → new `accessToken` + `refreshToken` (the old refresh token stops working).

### `POST /auth/logout`
`{ "refreshToken" }` → `204`.

### `GET /auth/me` → `{ "user": { id, email, firstName, lastName, phone, timezone, createdAt, settings: {…}, _count: { devices, medications } } }`

### `PATCH /auth/me`
Any of `firstName`, `lastName`, `phone`, `timezone`.

### `POST /auth/password`
`{ "currentPassword", "newPassword" }` → `204` (all refresh tokens are revoked).

### `POST /auth/push-tokens`
`{ "token": "ExponentPushToken[…]", "platform": "IOS" | "ANDROID" | "WEB" }` → `201`. Register after login so push notifications reach this phone.

### `DELETE /auth/push-tokens/:token` → `204` (call on logout)

### `DELETE /auth/me` → `204` deletes the account and all its data.

---

## Medications (`/medications`) – app

Medication object:
```json
{ "id": "uuid", "name": "Metformin", "strength": "500 mg", "form": "TABLET", "color": "white", "shape": "round",
  "instructions": "Take with food", "notes": null, "prescriber": null, "pharmacy": null, "rxNumber": null,
  "pillWeightMg": 560, "refillThreshold": 10, "isActive": true, "startDate": null, "endDate": null,
  "slot": { "id": "uuid", "index": 1, "deviceId": "uuid", "pillCount": 38, "capacity": 50 },
  "schedules": [ { "id": "uuid", "label": "Breakfast", "timeOfDay": "08:00", "daysOfWeek": [], "quantity": 1, "graceMinutes": 60, "isActive": true } ] }
```

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /medications` | `?includeInactive=true` | List with slot + active schedules |
| `POST /medications` | `{ name, strength?, form?, color?, shape?, instructions?, notes?, prescriber?, pharmacy?, rxNumber?, pillWeightMg?, refillThreshold?, startDate?, endDate? }` | `201` |
| `GET /medications/:id` | | includes all schedules |
| `PATCH /medications/:id` | any field above + `isActive` | deactivating cancels upcoming doses |
| `DELETE /medications/:id` | `?permanent=true` to really delete | default = deactivate, keep history, free the slot |

Dates (`startDate`, `endDate`) are `"YYYY-MM-DD"`.

---

## Schedules (`/schedules`) – app

```json
{ "medicationId": "uuid", "label": "Morning", "timeOfDay": "08:00", "daysOfWeek": [1, 3, 5],
  "quantity": 1, "graceMinutes": 60, "startDate": "2026-10-01", "endDate": null, "isActive": true }
```
* `timeOfDay` is `"HH:MM"` 24-hour, in the user's timezone.
* `daysOfWeek`: `0` = Sunday … `6` = Saturday. Empty / omitted = every day.
* `graceMinutes`: how long after `timeOfDay` the dose can still be taken before it is `MISSED`.

| Method & path | Notes |
|---|---|
| `GET /schedules?medicationId=&includeInactive=` | includes medication name + slot index |
| `POST /schedules` | `201`; upcoming doses for the next 48 h are created immediately |
| `GET /schedules/:id` | |
| `PATCH /schedules/:id` | upcoming (not yet taken) doses are rebuilt |
| `DELETE /schedules/:id` | deactivates; history stays |

---

## Doses (`/doses`) – app

Dose event object:
```json
{ "id": "uuid", "medicationId": "uuid", "scheduleId": "uuid", "deviceId": "uuid", "slotId": "uuid",
  "scheduledAt": "2026-10-02T12:00:00.000Z", "windowEndsAt": "2026-10-02T13:00:00.000Z",
  "quantity": 1, "status": "TAKEN", "source": "SCHEDULE",
  "dispensedAt": "…", "takenAt": "…", "skippedAt": null, "detectedCount": 1,
  "weightBeforeGrams": 21.3, "weightAfterGrams": 20.7, "failureReason": null, "notes": null,
  "medication": { "id", "name", "strength", "form" }, "slot": { "index": 1, "deviceId": "uuid" },
  "schedule": { "id", "label", "timeOfDay" } }
```

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /doses` | `?from=&to=&status=&medicationId=&limit=50&offset=0` | history, newest first; returns `{ doses, total, limit, offset }` |
| `GET /doses/today` | | `{ date, doses[], nextDose }` for the user's local day |
| `GET /doses/upcoming` | `?hours=24` | scheduled/dispensed doses ahead |
| `GET /doses/adherence` | `?days=30` or `?from=&to=` | see below |
| `GET /doses/:id` | | |
| `POST /doses/:id/taken` | `{ takenAt?, notes? }` | from SCHEDULED/DISPENSED/MISSED/FAILED/SKIPPED |
| `POST /doses/:id/skip` | `{ reason? }` | from SCHEDULED/DISPENSED/FAILED/MISSED |
| `POST /doses/manual` | `{ medicationId, quantity?, takenAt?, notes? }` | log a dose taken without the dispenser → `201` |

Adherence response:
```json
{ "adherence": { "from": "…", "to": "…", "total": 59, "taken": 49, "missed": 8, "skipped": 2, "failed": 0, "pending": 0,
    "adherenceRate": 86, "currentStreakDays": 3,
    "byMedication": [ { "medicationId": "uuid", "name": "Metformin", "taken": 22, "missed": 4, "skipped": 1, "adherenceRate": 84.6 } ],
    "byDay": [ { "date": "2026-09-20", "taken": 4, "missed": 0, "skipped": 0, "pending": 0 } ] } }
```
`adherenceRate` = taken ÷ (taken + missed + failed) × 100. Skipped doses are not counted against the user.

---

## Devices (`/devices`) – app side

Device object:
```json
{ "id": "uuid", "serialNumber": "10000000abcdef12", "name": "Kitchen PillPal", "status": "ONLINE", "isOnline": true,
  "firmwareVersion": "0.1.0", "model": "Raspberry Pi 5 4GB", "ipAddress": "192.168.1.42", "lastSeenAt": "…",
  "settings": { "volume": 80, "brightness": 70 }, "claimedAt": "…",
  "slots": [ { "id": "uuid", "index": 1, "pillCount": 38, "capacity": 50, "lastWeightGrams": 21.3, "lastDispensedAt": "…",
               "calibration": {}, "medication": { "id", "name", "strength", "form", "refillThreshold" } }, … 5 slots ] }
```

| Method & path | Body / query | Notes |
|---|---|---|
| `POST /devices/claim` | `{ claimCode, name? }` | links the dispenser showing that code → `201 { device }` |
| `GET /devices` | | my dispensers |
| `GET /devices/:id` | | |
| `PATCH /devices/:id` | `{ name?, settings? }` | settings are merged and sent to the Pi on its next sync |
| `DELETE /devices/:id` | | unlink (the Pi gets a fresh claim code) |
| `PUT /devices/:id/slots/:index` | `{ medicationId: "uuid" \| null, pillCount?, capacity? }` | load / empty a hopper (index 1–5) |
| `POST /devices/:id/slots/:index/refill` | `{ pillCount }` (absolute) or `{ added }` | resets the low-stock alert |
| `GET /devices/:id/slots/:index/inventory` | `?limit=&offset=` | refill / dispense / adjustment history |
| `POST /devices/:id/commands` | see below | queue a command → `201 { command }` |
| `GET /devices/:id/commands` | | newest first |
| `GET /devices/:id/commands/:commandId` | | poll for `status` / `result` |
| `GET /devices/:id/events` | `?level=ERROR&limit=` | device log |
| `GET /devices/:id/readings` | `?type=WEIGHT&slotIndex=1&limit=` | sensor time series |

Command bodies:
```json
{ "type": "DISPENSE", "slotIndex": 1, "quantity": 1 }        // also creates a DoseEvent (source REMOTE)
{ "type": "TEST_SLOT", "slotIndex": 1 }
{ "type": "TARE_SCALE" }
{ "type": "CALIBRATE_SCALE", "slotIndex": 1, "knownWeightGrams": 50 }
{ "type": "RING", "seconds": 5 }                               // buzzer + vibration ("find my dispenser")
{ "type": "REBOOT" }   { "type": "SYNC_NOW" }
{ "type": "UPDATE_SETTINGS", "settings": { "volume": 50 } }
```
Commands expire after 15 minutes if the Pi never picks them up (`status: EXPIRED`).

---

## Vitals (`/vitals`) – app

| Method & path | Body / query |
|---|---|
| `GET /vitals` | `?type=BLOOD_PRESSURE&from=&to=&limit=&offset=` → `{ readings, total }` |
| `GET /vitals/latest` | `{ latest: { BLOOD_PRESSURE: {…}\|null, HEART_RATE: …, SPO2: …, TEMPERATURE: …, WEIGHT: …, GLUCOSE: … } }` |
| `POST /vitals` | `{ type, systolic?, diastolic?, pulse?, value?, unit?, recordedAt?, meta? }` → `201 { reading }` |
| `DELETE /vitals/:id` | `204` |

Blood pressure uses `systolic` / `diastolic` / `pulse`; everything else uses `value` + `unit`
(`HEART_RATE` bpm, `SPO2` %, `TEMPERATURE` C or F, `WEIGHT` kg or lb, `GLUCOSE` mg/dL).
Readings outside safe ranges get `flagged: true` and a `VITALS_ALERT` notification.

---

## Notifications (`/notifications`) – app

Notification object: `{ id, type, title, body, data: {…}, readAt, pushSentAt, pushError, createdAt }`.
`data` carries ids the app can deep-link to (`doseEventId`, `deviceId`, `slotIndex`, `medicationId`, `vitalReadingId`, `linkId`).

| Method & path | Notes |
|---|---|
| `GET /notifications?unread=true&limit=50&offset=0` | `{ notifications, total, unreadCount }` |
| `POST /notifications/:id/read` · `POST /notifications/read-all` | |
| `DELETE /notifications/:id` | |
| `GET /notifications/settings` | |
| `PATCH /notifications/settings` | `{ doseReminders, missedDoseAlerts, lowStockAlerts, deviceOfflineAlerts, vitalsAlerts, reminderLeadMinutes (0–120), requireTakenConfirmation, quietHoursStart "22:00", quietHoursEnd "07:00" }` |
| `POST /notifications/test` | sends yourself a test notification |

---

## Caregivers (`/caregivers`) – app

| Method & path | Body | Notes |
|---|---|---|
| `GET /caregivers` | | `{ caregivers: [links where I am the patient], patients: [links where I am the caregiver] }` |
| `POST /caregivers/invite` | `{ email, notifyMissedDoses?, notifyLowStock?, notifyDeviceIssues?, notifyVitals? }` | `201 { link, inviteeHasAccount }`; if the email has no account yet the link activates when they register |
| `PATCH /caregivers/:id` | the four `notify…` flags | patient adjusts what the caregiver receives |
| `POST /caregivers/:id/accept` | | the invited caregiver accepts |
| `DELETE /caregivers/:id` | | either side ends the relationship |
| `GET /caregivers/patients/:patientId/overview` | | `{ patient, todayDoses, devices, adherenceLast7Days, recentVitals, recentMissed }` |

---

## Dashboard (`/dashboard`) – app

`GET /dashboard` → everything the home screen needs in one request:
```json
{ "serverTime": "…", "user": { "id", "firstName", "timezone" },
  "today": { "date": "…", "doses": [ … ], "taken": 2, "missed": 0, "remaining": 1 },
  "nextDose": { … } | null,
  "adherenceLast7Days": { … same as /doses/adherence … },
  "devices": [ { "id", "name", "status", "isOnline", "lastSeenAt", "slots": [ … ] } ],
  "lowStock": [ { "index": 2, "pillCount": 6, "deviceId", "medication": { "id", "name", "refillThreshold" } } ],
  "unreadNotifications": 3,
  "latestVitals": [ … ] }
```

---

## Device endpoints (`/device`) – Raspberry Pi

### `POST /device/register` – header `X-Provisioning-Key`
```json
{ "serialNumber": "10000000abcdef12", "firmwareVersion": "0.1.0", "model": "Raspberry Pi 5 4GB" }
```
→ `201`
```json
{ "deviceId": "uuid", "apiKey": "pp_dev_…", "claimed": false, "claimCode": "K7PX3Q",
  "claimCodeExpiresAt": "…", "syncIntervalSeconds": 30 }
```
Store `apiKey` on the Pi – it is never shown again. Registering the same serial again issues a new key (the old one stops working), which is how you recover a Pi that lost its config.

### `GET /device/claim-status`
`{ "claimed": false, "claimCode": "K7PX3Q", "claimCodeExpiresAt": "…", "owner": null }` → poll every 5 s while showing the code.
When claimed: `{ "claimed": true, "claimCode": null, "owner": { "firstName": "Alan", "timezone": "America/New_York" } }`.
An expired code is replaced automatically.

### `POST /device/claim-code` → `{ claimCode, claimCodeExpiresAt }` (force a new code)

### `POST /device/sync` (or `GET /device/sync` without a body) – call every ~30 s
Request (all fields optional):
```json
{ "firmwareVersion": "0.1.0", "ipAddress": "192.168.1.42", "uptimeSeconds": 1234,
  "slots": [ { "index": 1, "weightGrams": 21.3, "pillCount": 38 } ] }
```
`weightGrams` is logged as a `WEIGHT` reading; `pillCount` (if you count with the scale) corrects the server's count.

Response:
```json
{ "serverTime": "2026-10-02T21:40:00.000Z", "syncIntervalSeconds": 30,
  "device": { "id": "uuid", "name": "Kitchen PillPal", "status": "ONLINE", "claimed": true, "claimCode": null,
              "timezone": "America/New_York", "settings": { "volume": 80 } },
  "owner": { "id": "uuid", "firstName": "Alan", "lastName": "Demo", "timezone": "America/New_York", "requireTakenConfirmation": false },
  "slots": [ { "index": 1, "slotId": "uuid", "pillCount": 38, "capacity": 50, "lastWeightGrams": 21.3, "calibration": { "servoMsPerPill": 180 },
               "medication": { "id": "uuid", "name": "Metformin", "strength": "500 mg", "form": "TABLET", "pillWeightMg": 560, "instructions": "Take with food" } },
             { "index": 5, "slotId": "uuid", "pillCount": 0, "capacity": 50, "lastWeightGrams": null, "calibration": {}, "medication": null } ],
  "schedules": [ { "id": "uuid", "medicationId": "uuid", "slotIndex": 1, "label": "Breakfast", "timeOfDay": "08:00", "daysOfWeek": [],
                   "quantity": 1, "graceMinutes": 60, "startDate": null, "endDate": null } ],
  "upcomingDoses": [ { "id": "uuid", "medicationId": "uuid", "medicationName": "Metformin", "strength": "500 mg", "slotIndex": 1,
                       "quantity": 1, "scheduledAt": "2026-10-03T12:00:00.000Z", "windowEndsAt": "2026-10-03T13:00:00.000Z", "status": "SCHEDULED" } ],
  "recentDoses": [ { "id": "uuid", "medicationName": "Metformin", "slotIndex": 1, "scheduledAt": "…", "status": "TAKEN", "takenAt": "…" } ],
  "pendingCommands": [ { "id": "uuid", "type": "DISPENSE", "payload": { "slotIndex": 1, "quantity": 1, "doseEventId": "uuid" }, "createdAt": "…" } ] }
```
* `upcomingDoses` covers −24 h … +48 h and is the list the Pi should act on: when `scheduledAt` arrives, dispense from
  `slotIndex` and report it with the dose `id`. Only schedule-generated doses appear here; on-demand doses come as `DISPENSE` commands.
* `schedules` are included so the Pi can keep working offline (it can compute the next occurrences itself).
* Commands in `pendingCommands` are marked `SENT` the moment they are returned – they are delivered once.

### `POST /device/heartbeat` – `{ firmwareVersion?, ipAddress? }` → `{ ok, serverTime, claimed }` (lighter than sync)

### Reporting doses
| Method & path | Body | Effect |
|---|---|---|
| `POST /device/doses/:id/dispensed` | `{ dispensedAt?, detectedCount?, weightBeforeGrams?, weightAfterGrams?, slotIndex? }` | SCHEDULED/FAILED/MISSED → DISPENSED (→ TAKEN automatically unless `requireTakenConfirmation`); slot count −`detectedCount` (or −quantity); low-stock check. Idempotent. |
| `POST /device/doses/:id/taken` | `{ takenAt?, method? }` | DISPENSED → TAKEN (tray sensor / touchscreen) |
| `POST /device/doses/:id/skipped` | `{ reason? }` | → SKIPPED |
| `POST /device/doses/:id/failed` | `{ reason, code? }` | → FAILED + `DEVICE_ERROR` alert to user & caregivers; also logged as a device event |
| `POST /device/doses/manual` | `{ slotIndex, quantity?, dispensedAt?, detectedCount? }` | user pressed "dispense now" on the touchscreen → creates + dispenses a dose (`source: DEVICE`) → `201` |

### Commands
| Method & path | Body |
|---|---|
| `POST /device/commands/:id/ack` | – (optional; sync already marks the command SENT) |
| `POST /device/commands/:id/complete` | `{ success: true, result: { detectedCount: 1 } }` or `{ success: false, error: "hopper jammed" }` – a completed/failed DISPENSE also completes/fails its dose |

### Telemetry
| Method & path | Body |
|---|---|
| `POST /device/events` | one or an array of `{ level: INFO\|WARN\|ERROR, type: "BOOT", message?, data?, occurredAt? }` (max 500) |
| `POST /device/readings` | one or an array of `{ type: WEIGHT\|BREAK_BEAM\|TEMPERATURE\|HUMIDITY\|BATTERY\|OTHER, value, unit?, slotIndex?, meta?, recordedAt? }` (max 1000) |
| `POST /device/vitals` | `{ type: "BLOOD_PRESSURE", systolic, diastolic, pulse?, recordedAt?, meta? }` or `{ type: "HEART_RATE"\|…, value, unit? }` → `201 { reading }` (+ alert if out of range) |
| `POST /device/slots/:index/count` | `{ pillCount, weightGrams? }` – device recounted the hopper |
| `PATCH /device/slots/:index/calibration` | any JSON, merged into the slot's `calibration` (e.g. `{ "servoMsPerPill": 180, "tareOffset": 0.4 }`) |

Batch endpoints accept arrays so the Pi can queue data while offline and upload it later.
