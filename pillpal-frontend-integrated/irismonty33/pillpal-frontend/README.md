# PillPal mobile app

Expo / React Native companion app for the PillPal dispenser. It talks to the **PillPal API**
(`pillpal-api` repo) — the same server the Raspberry Pi dispenser reports to — so what you
schedule here is what the dispenser does, and what the dispenser does shows up here.

```
phone app ──▶ PillPal API (Express + PostgreSQL) ◀── Raspberry Pi dispenser
```

## Run it

```bash
npm install
cp .env.example .env        # then edit EXPO_PUBLIC_API_URL (see below)
npx expo start              # scan the QR code with Expo Go, or press a / i for an emulator
```

`EXPO_PUBLIC_API_URL` must point at a running API:

| Where the API runs | Value |
|---|---|
| Alan's laptop (`npm run dev` in pillpal-api), phone on the same Wi‑Fi | `http://<laptop-ip>:4000/api/v1` — find the IP with `ipconfig` / `ifconfig`; `localhost` will **not** work from a phone |
| Android emulator | `http://10.0.2.2:4000/api/v1` |
| iOS simulator | `http://localhost:4000/api/v1` |
| Deployed | `https://<service>.onrender.com/api/v1` |

Leave it unset and the app runs in **preview mode** with built-in demo data (no server needed, nothing is saved).

**Demo account** (after `npm run db:seed` on the API): `demo@pillpal.app` / `Password123!` — a paired
dispenser, 4 medications, two weeks of history, vitals and alerts. `caregiver@pillpal.app` (same password)
shows the caregiver side.

## What each screen does

| Screen | What it shows / does | API calls |
|---|---|---|
| Sign in | Email + password, or create an account | `/auth/login`, `/auth/register` |
| Home | Next dose, doses left today, 7‑day adherence, dispenser status | `/dashboard` |
| Reminders | Today's doses with **I took it / Skip**, then dose activity | `/doses/today`, `/doses/:id/taken`, `/doses/:id/skip`, `/doses` |
| Medications | Add / remove medications, add / remove dose times, log a dose taken by hand | `/medications`, `/schedules`, `/doses/manual` |
| Schedule | All planned doses in time order | (from `/medications`) |
| Reports | Vitals history, log a blood pressure reading | `/vitals` |
| Settings | Pair a dispenser (code on its screen), load slots, refill, **Dispense now**, notification toggles, caregivers | `/devices/*`, `/notifications/settings`, `/caregivers/*` |
| Alerts (🔔) | Notification inbox | `/notifications` |

Data refreshes on pull‑down, after every action, and every 30 s while the app is open.
The full endpoint reference is in `pillpal-api/docs/API.md`.

## Project layout

```
App.tsx                  shell: header, bottom nav, sign-in gate
src/
  config.ts              API URL + preview-mode flag
  api.ts                 API client (fetch, token storage, auto refresh on 401)
  types.ts               shapes returned by the API
  model.ts               view models the screens use + adapters from API data
  store.tsx              <AppProvider> / useApp(): signed-in user, loaded data, actions, polling
  push.ts                Expo push-token registration
  theme.ts, ui.tsx       colours, styles and small components (Card, Button, Chip, …)
  demo.ts                preview-mode data
  screens/               one file per page
```

## Push notifications

The API sends pushes (dose reminders, missed doses, low stock, dispenser offline…) through Expo.
The app registers the phone's token after sign‑in (`src/push.ts`). This needs a **physical device**
and a development build (`npx expo run:android` / EAS) with an EAS `projectId` in `app.json`;
Expo Go on Android cannot receive remote pushes since SDK 53. Without push, every alert is still
visible in the 🔔 inbox, which polls the server.

## Checks

```bash
npm run typecheck
```
