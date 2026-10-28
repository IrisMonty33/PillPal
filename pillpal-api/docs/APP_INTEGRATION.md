# React Native app integration guide (for Iris)

[`examples/api.ts`](../examples/api.ts) is a ready-made client: copy it into the app, set `BASE_URL`, done.
It stores tokens in `expo-secure-store`, adds the `Authorization` header, and refreshes expired tokens automatically.

```bash
npx expo install expo-secure-store expo-notifications expo-device
```

## Base URL

| Situation | `BASE_URL` |
|---|---|
| Alan runs `npm run dev` on his laptop, phone on the same Wi-Fi | `http://<laptop-ip>:4000/api/v1` (find the IP with `ipconfig` / `ifconfig`; **not** `localhost`) |
| Android emulator | `http://10.0.2.2:4000/api/v1` |
| iOS simulator | `http://localhost:4000/api/v1` |
| Deployed | `https://<service>.onrender.com/api/v1` |

Full endpoint list with payloads: [API.md](API.md). Click-to-run examples: `requests.http` (VS Code REST Client).

## Screens → endpoints

| Screen | Calls |
|---|---|
| Sign up / Log in | `POST /auth/register`, `POST /auth/login` → save `accessToken` + `refreshToken`; then `POST /auth/push-tokens` |
| Home | `GET /dashboard` – today's doses, next dose, 7-day adherence, device status, low-stock slots, unread count, latest vitals |
| Today / dose card | `GET /doses/today`, `POST /doses/:id/taken`, `POST /doses/:id/skip` |
| Medications | `GET/POST /medications`, `PATCH/DELETE /medications/:id` |
| Add schedule | `POST /schedules` `{ medicationId, timeOfDay: "08:00", daysOfWeek: [1,3,5], quantity, graceMinutes }` |
| Pair dispenser | `POST /devices/claim { claimCode }` (the code is on the Pi's screen) |
| Dispenser detail | `GET /devices/:id` (5 slots with medication + pill count), `PUT /devices/:id/slots/:index`, `POST …/refill`, `POST /devices/:id/commands` |
| History / stats | `GET /doses?from=&to=`, `GET /doses/adherence?days=30` (`byDay` is chart-ready) |
| Vitals | `GET /vitals/latest`, `GET /vitals?type=BLOOD_PRESSURE`, `POST /vitals` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `PATCH /notifications/settings` |
| Caregivers | `GET /caregivers`, `POST /caregivers/invite`, `POST /caregivers/:id/accept`, `GET /caregivers/patients/:id/overview` |
| Settings | `PATCH /auth/me` (timezone!), `POST /auth/password`, `POST /auth/logout` |

## Login flow

```ts
import { login, getDashboard, registerPushToken } from './api';

await login(email, password);           // stores tokens
const home = await getDashboard();      // { today, nextDose, adherenceLast7Days, devices, ... }
```

Errors throw `ApiError` with `status`, `code`, `message` and (for 400s) `details` – a list of `{ path, message }`
you can show next to the form fields.

## Push notifications (Expo)

1. Ask for permission and get the Expo token (see the comment at the bottom of `examples/api.ts`)
2. `POST /auth/push-tokens { token, platform }` once after login
3. Incoming pushes carry `data.type` (`DOSE_REMINDER`, `DOSE_MISSED`, `LOW_STOCK`, `DEVICE_OFFLINE`, `DEVICE_ERROR`, `VITALS_ALERT`, …)
   and ids such as `data.doseEventId` / `data.deviceId` so you can deep-link to the right screen
4. The same notifications are always available in `GET /notifications` (inbox / bell icon), even without push

While testing on a simulator (no push), `POST /notifications/test` creates an entry you can see in the inbox.

## Dates and timezones

* The API returns UTC ISO strings. Display them with the device's locale (`new Date(iso).toLocaleTimeString()`).
* Schedule times (`timeOfDay`) are plain `"HH:MM"` strings in the **user's** timezone (`user.timezone`). Send the
  phone's timezone on registration: `Intl.DateTimeFormat().resolvedOptions().timeZone`.
* `daysOfWeek`: 0 = Sunday … 6 = Saturday, empty = every day.

## Dose statuses to render

| status | Meaning | Actions to offer |
|---|---|---|
| `SCHEDULED` | upcoming / due now | "Mark taken", "Skip" |
| `DISPENSED` | pills are in the tray, not yet confirmed | "I took it" |
| `TAKEN` | done | – |
| `MISSED` | window closed | "Took it late" (→ `/taken`), "Skip" |
| `SKIPPED` | user chose to skip | "Took it after all" |
| `FAILED` | dispenser error | show `failureReason`, "Dispense again" (→ `POST /devices/:id/commands DISPENSE`) |

## Demo data

After `npm run db:seed` on the backend: log in as `demo@pillpal.app` / `Password123!` to get a paired dispenser,
4 medications, 5 schedules, 14 days of history, vitals and notifications – enough to build every screen without the hardware.
