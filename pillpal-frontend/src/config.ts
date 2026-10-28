/**
 * Where the PillPal API lives. Set EXPO_PUBLIC_API_URL in a `.env` file (see .env.example).
 *
 *   Laptop running `npm run dev` + phone on the same Wi-Fi:  http://<laptop-ip>:4000/api/v1
 *   Android emulator:                                        http://10.0.2.2:4000/api/v1
 *   iOS simulator:                                           http://localhost:4000/api/v1
 *   Deployed (Render):                                       https://<service>.onrender.com/api/v1
 *
 * When it is not set, the app runs in preview mode with built-in demo data (no server needed).
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
export const configured = API_URL.length > 0;

/** How often the app re-fetches while it is open (ms). Push notifications arrive instantly regardless. */
export const POLL_INTERVAL_MS = 30_000;
