# API integration — what changed and why

This branch connects the app to the team's PillPal API (Alan's `pillpal-api`) instead of Supabase.
The look and page structure are unchanged: same header, tiles, cards, bottom nav, colours.

## Why one backend

The first version read Supabase tables directly and expected the Pi to push rows into them, with
medications "managed on the station touchscreen". The capstone plan puts schedule creation in the
app (priority 3) and the scheduling/notification logic on a server (priority 4), and the API already
implements that: schedules → dose events, reminders, missed‑dose and low‑stock alerts to patients
**and caregivers**, device pairing, pill inventory, remote "dispense now". Keeping two backends would
have meant two copies of the medication list that could disagree, so the app now has a single source
of truth and the Pi, the app and the server all speak the same data model.

## File by file

| Before | After |
|---|---|
| `src/data.ts` (Supabase client, types, demo data) | `src/api.ts` (API client), `src/types.ts`, `src/model.ts` (adapters keep the old field names: `dose`, `times`, `next_refill`, `kind`…), `src/demo.ts` |
| `App.tsx` – one file with every page | `App.tsx` – just the shell; pages moved to `src/screens/*.tsx`; state/actions in `src/store.tsx` |
| `supabase/schema.sql`, `supabase/functions/station-ingest` | removed – replaced by `pillpal-api` (`prisma/schema.prisma`, `/api/v1/device/*`) |
| `@supabase/supabase-js`, `react-native-url-polyfill` | removed; `expo-constants` added (push token) |
| Supabase auth (sign in / sign up / session) | API JWT auth; tokens in AsyncStorage; auto‑refresh on expiry |
| Supabase realtime subscriptions | pull‑to‑refresh + 30 s polling + push notifications |
| `.expo/` committed | now ignored (`.gitignore`) |

## Behaviour that is new

* **Medications** – add a medication with its dose times, add/remove times, remove a medication, log a dose taken by hand.
* **Reminders** – today's doses are actionable (I took it / Skip); missed doses can be marked taken late.
* **Settings** – pair a dispenser with the code on its screen, load medications into the 5 slots, set pill counts, Dispense now, "find it" beep, unpair; notification toggles; invite caregivers / accept invites; caregiver overview of a patient.
* **Home** – 7‑day adherence, doses left today, offline‑dispenser warning.
* **Reports** – out‑of‑range readings are flagged; blood pressure can be logged manually.
* **Alerts (🔔)** – notification inbox with unread badge.

## Field mapping (old → new)

| Old (Supabase) | New (API) |
|---|---|
| `medications.dose` (free text) | built from `strength` + schedule `quantity` + `form` → `"500 mg · 1 tablet"` |
| `medications.times` (`text[]`) | one **schedule** per time (`timeOfDay`, `daysOfWeek`, `quantity`) |
| `medications.next_refill` (date) | slot `pillCount` vs `refillThreshold` → `"6 left in slot 2 – refill soon"` |
| `vitals` row with all values | one reading per type; readings within 2 min are grouped into one card |
| `dose_events.kind` dispensed/taken/missed | `dose_events.status` SCHEDULED/DISPENSED/TAKEN/MISSED/SKIPPED/FAILED |
| `patient_access.role` | derived: caregiver if you have accepted patient links and no medications of your own |
| station token (edge function) | device API key, issued by `POST /device/register` |
