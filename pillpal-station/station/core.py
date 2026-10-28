"""
The station's brain. Three background threads share one Station object:

  sync loop   - registers with the server, shows the pairing code, then syncs every 30 s
                (downloads slots / schedule / upcoming doses / app commands, uploads queued reports)
  tick loop   - once a second: is a dose due? -> open the full-screen alert, beep, auto-dispense if enabled
  worker      - runs hardware jobs one at a time (dispense, ring, test...) so two never collide

The touchscreen page (kiosk/) reads `snapshot()` twice a second and calls the action methods.
Everything keeps working offline from the last downloaded schedule; reports are queued and
sent when the connection comes back.
"""
from __future__ import annotations

import json
import os
import queue
import socket
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from .api import Api, ApiError, OfflineError
from .config import DATA_DIR, Config
from .hardware import Hardware, HardwareError

DEVICE_FILE = DATA_DIR / "device.json"
CACHE_FILE = DATA_DIR / "last_sync.json"
HANDLED_FILE = DATA_DIR / "handled_doses.json"

# The sync payload does not carry each medication's refill threshold; 7 is the server's default.
LOW_STOCK_AT = 7


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def read_serial_number() -> str:
    if os.environ.get("PILLPAL_SERIAL"):
        return os.environ["PILLPAL_SERIAL"]
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return f"dev-{socket.gethostname()}"


def local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


class Station:
    def __init__(self, cfg: Config, api: Api, hw: Hardware):
        self.cfg = cfg
        self.api = api
        self.hw = hw
        self.lock = threading.RLock()
        self.started = time.time()
        self.sync_now = threading.Event()
        self.jobs: queue.Queue[tuple[str, Callable[[], None]]] = queue.Queue()

        # --- state shown on screen
        self.mode = "starting"  # starting | pairing | ready
        self.online = False
        self.last_sync_at: datetime | None = None
        self.error = ""
        self.claim_code: str | None = None
        self.payload: dict = {}
        self.busy = ""  # text for the "working..." overlay
        self.toast = ""
        self.toast_until = 0.0
        self.alert: dict | None = None  # the full-screen dose alert, see open_alert()

        # --- local bookkeeping
        self.local_status: dict[str, str] = {}  # doseId -> status we reported but the server has not echoed yet
        self.handled: dict[str, float] = load_json(HANDLED_FILE, {})  # doseId -> when we acted on it
        self.slot_delta: dict[int, int] = {}  # pills we dispensed since the last sync

        device = load_json(DEVICE_FILE, {})
        self.api.api_key = device.get("apiKey")
        cached = load_json(CACHE_FILE, None)
        if cached and self.api.api_key:
            self._apply_payload(cached, from_cache=True)

    # ======================================================================= threads
    def start(self) -> None:
        for target, name in ((self._sync_loop, "sync"), (self._tick_loop, "tick"), (self._worker_loop, "worker")):
            threading.Thread(target=target, name=name, daemon=True).start()

    def _sync_loop(self) -> None:
        while True:
            wait = self.cfg.sync_seconds
            try:
                if not self.api.api_key:
                    self._register()
                if self.mode in ("starting", "pairing") and not self.payload.get("device", {}).get("claimed"):
                    status = self.api.claim_status()
                    self._set_online(True)
                    if not status["claimed"]:
                        with self.lock:
                            self.mode = "pairing"
                            self.claim_code = status["claimCode"]
                        wait = 5
                        self._wait(wait)
                        continue
                self._sync()
            except ApiError as e:
                if e.status == 401:  # our key was rotated or the device was deleted: start over
                    print("[sync] device key rejected, registering again")
                    self._forget_device()
                    wait = 2
                else:
                    self._set_error(f"Server error: {e.message}")
            except OfflineError as e:
                self._set_online(False, f"Cannot reach the PillPal server ({self.cfg.base_url})")
                print(f"[sync] offline: {e}")
                wait = 10
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._set_error(f"Unexpected error: {e}")
            self._wait(wait)

    def _wait(self, seconds: float) -> None:
        self.sync_now.wait(seconds)
        self.sync_now.clear()

    def _tick_loop(self) -> None:
        while True:
            try:
                self._check_due()
            except Exception:  # noqa: BLE001
                traceback.print_exc()
            time.sleep(1)

    def _worker_loop(self) -> None:
        while True:
            label, job = self.jobs.get()
            with self.lock:
                self.busy = label
            try:
                job()
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self.show_toast(f"Something went wrong: {e}")
            finally:
                with self.lock:
                    self.busy = ""

    # ======================================================================= server
    def _register(self) -> None:
        serial = read_serial_number()
        data = self.api.register(serial)
        DEVICE_FILE.write_text(json.dumps({"deviceId": data["deviceId"], "apiKey": data["apiKey"], "serialNumber": serial}))
        self.api.api_key = data["apiKey"]
        with self.lock:
            self.mode = "ready" if data["claimed"] else "pairing"
            self.claim_code = data.get("claimCode")
        self._set_online(True)
        print(f"[sync] registered as {data['deviceId']} (serial {serial})")

    def _forget_device(self) -> None:
        for f in (DEVICE_FILE, CACHE_FILE):
            f.unlink(missing_ok=True)
        self.api.api_key = None
        with self.lock:
            self.mode = "starting"
            self.payload = {}

    def _sync(self) -> None:
        self.api.flush_queue()
        payload = self.api.sync(
            {
                "firmwareVersion": self.cfg.firmware_version,
                "ipAddress": local_ip(),
                "uptimeSeconds": int(time.time() - self.started),
                "meta": {"hardware": self.hw.name, "pendingReports": self.api.pending_count()},
            }
        )
        CACHE_FILE.write_text(json.dumps(payload))
        self._apply_payload(payload)
        self._set_online(True)
        for cmd in payload.get("pendingCommands", []):
            self._queue_command(cmd)

    def _apply_payload(self, payload: dict, from_cache: bool = False) -> None:
        with self.lock:
            self.payload = payload
            claimed = payload.get("device", {}).get("claimed")
            self.mode = "ready" if claimed else "pairing"
            self.claim_code = payload.get("device", {}).get("claimCode")
            if not from_cache:
                self.last_sync_at = utcnow()
                self.slot_delta = {}
                # Forget local overrides the server now agrees with (dose no longer SCHEDULED, or gone).
                server = {d["id"]: d["status"] for d in payload.get("upcomingDoses", [])}
                server.update({d["id"]: d["status"] for d in payload.get("recentDoses", [])})
                for dose_id in list(self.local_status):
                    if server.get(dose_id, "GONE") != "SCHEDULED":
                        self.local_status.pop(dose_id, None)
            # Keep handled ids for 2 days at most.
            cutoff = time.time() - 2 * 86400
            self.handled = {k: v for k, v in self.handled.items() if v > cutoff}

    def _set_online(self, online: bool, error: str = "") -> None:
        with self.lock:
            self.online = online
            self.error = error

    def _set_error(self, msg: str) -> None:
        with self.lock:
            self.error = msg

    # ======================================================================= doses
    def _tz(self) -> ZoneInfo:
        name = (self.payload.get("owner") or {}).get("timezone") or self.payload.get("device", {}).get("timezone") or "UTC"
        try:
            return ZoneInfo(name)
        except Exception:  # noqa: BLE001
            return ZoneInfo("UTC")

    def _status(self, dose: dict) -> str:
        return self.local_status.get(dose["id"], dose["status"])

    def _dose_view(self, d: dict) -> dict:
        return {
            "id": d["id"],
            "name": d.get("medicationName", "Medication"),
            "strength": d.get("strength"),
            "slotIndex": d.get("slotIndex"),
            "quantity": d.get("quantity", 1),
            "scheduledAt": d["scheduledAt"],
            "windowEndsAt": d.get("windowEndsAt", d["scheduledAt"]),
            "status": self._status(d),
        }

    def _due_now(self, now: datetime) -> list[dict]:
        due = []
        for d in self.payload.get("upcomingDoses", []):
            if self._status(d) != "SCHEDULED" or d["id"] in self.handled:
                continue
            if parse_iso(d["scheduledAt"]) <= now < parse_iso(d["windowEndsAt"]):
                due.append(d)
        return due

    def _check_due(self) -> None:
        now = utcnow()
        beep = False
        auto = False
        with self.lock:
            if self.mode != "ready":
                return
            due = self._due_now(now)
            if self.alert is None and due:
                self.alert = {
                    "phase": "due",
                    "doseIds": [d["id"] for d in due],
                    "doseData": {d["id"]: d for d in due},  # kept here so a sync can't make them vanish mid-alert
                    "results": {},
                    "openedAt": time.time(),
                    "lastBeep": 0.0,
                }
                print(f"[due] {len(due)} dose(s) due: {[d.get('medicationName') for d in due]}")
                auto = self.cfg.auto_dispense
            elif self.alert and self.alert["phase"] == "due":
                for d in due:  # another dose became due while the alert is open: add it
                    if d["id"] not in self.alert["doseIds"]:
                        self.alert["doseIds"].append(d["id"])
                        self.alert["doseData"][d["id"]] = d
                still_open = [i for i in self.alert["doseIds"] if any(i == d["id"] for d in due)]
                if not still_open:  # every dose in the alert passed its window -> the server marks them missed
                    self.alert = None
                    self.show_toast("Dose window closed. It will be recorded as missed.")
                    return
            if self.alert and self.alert["phase"] == "due":
                repeat = (self.payload.get("device", {}).get("settings") or {}).get("reminderRepeatMinutes", self.cfg.alert_repeat_minutes)
                if time.time() - self.alert["lastBeep"] >= max(1, repeat) * 60:
                    self.alert["lastBeep"] = time.time()
                    beep = True
        if beep:
            self.hw.alert(3)
        if auto:
            self.dispense_due()

    def _doses_by_id(self, ids: list[str]) -> list[dict]:
        index = self.alert["doseData"] if self.alert else {}
        return [index[i] for i in ids if i in index]

    def _mark_handled(self, dose_id: str) -> None:
        self.handled[dose_id] = time.time()
        HANDLED_FILE.write_text(json.dumps(self.handled))

    # ======================================================================= actions (called by the screen)
    def dispense_due(self, only_failed: bool = False) -> None:
        with self.lock:
            if not self.alert or self.alert["phase"] == "dispensing":
                return
            ids = [i for i in self.alert["doseIds"] if not only_failed or not self.alert["results"].get(i, {}).get("ok")]
            ids = [i for i in ids if self.alert["results"].get(i, {}).get("ok") is not True]
            self.alert["phase"] = "dispensing"
            doses = self._doses_by_id(ids)
            confirm = bool((self.payload.get("owner") or {}).get("requireTakenConfirmation"))

        def job() -> None:
            for d in doses:
                dose_id, slot, qty = d["id"], d.get("slotIndex"), d.get("quantity", 1)
                name = d.get("medicationName", "medication")
                with self.lock:
                    self.busy = f"Dispensing {name}…"
                if slot is None:
                    # Not loaded in the dispenser: the user takes it from the bottle and taps "I took it".
                    with self.lock:
                        self.alert["results"][dose_id] = {"ok": True, "manual": True, "counted": 0, "error": None}
                    continue
                try:
                    counted = self.hw.dispense(slot, qty, self.cfg.dispense_timeout_seconds)
                    self.api.report(
                        f"/device/doses/{dose_id}/dispensed",
                        {"detectedCount": counted, "slotIndex": slot, "dispensedAt": iso(utcnow())},
                    )
                    with self.lock:
                        self.local_status[dose_id] = "DISPENSED" if confirm else "TAKEN"
                        self.slot_delta[slot] = self.slot_delta.get(slot, 0) - max(counted, qty)
                        self.alert["results"][dose_id] = {"ok": True, "counted": counted, "error": None}
                        self._mark_handled(dose_id)
                except HardwareError as e:
                    self.api.report(f"/device/doses/{dose_id}/failed", {"reason": str(e), "code": "DISPENSE_FAILED"})
                    with self.lock:
                        self.local_status[dose_id] = "FAILED"
                        self.alert["results"][dose_id] = {"ok": False, "counted": e.counted, "error": str(e)}
            with self.lock:
                results = self.alert["results"]
                failed = [i for i in self.alert["doseIds"] if not results.get(i, {}).get("ok")]
                manual = [i for i in self.alert["doseIds"] if results.get(i, {}).get("manual")]
                if failed:
                    self.alert["phase"] = "error"
                elif confirm or manual:
                    self.alert["phase"] = "confirm"
                else:
                    self.alert["phase"] = "done"
                    self.alert["closeAt"] = time.time() + 20

        self.jobs.put(("Dispensing…", job))

    def confirm_taken(self) -> None:
        with self.lock:
            if not self.alert:
                return
            ids = [i for i in self.alert["doseIds"] if self.alert["results"].get(i, {}).get("ok")]
            self.alert["phase"] = "done"
            self.alert["closeAt"] = time.time() + 6
        for dose_id in ids:
            self.api.report(f"/device/doses/{dose_id}/taken", {"takenAt": iso(utcnow()), "method": "touchscreen"})
            with self.lock:
                self.local_status[dose_id] = "TAKEN"
                self._mark_handled(dose_id)

    def skip_due(self) -> None:
        with self.lock:
            if not self.alert:
                return
            ids = [i for i in self.alert["doseIds"] if not self.alert["results"].get(i, {}).get("ok")]
            self.alert = None
        for dose_id in ids:
            self.api.report(f"/device/doses/{dose_id}/skipped", {"reason": "skipped on the dispenser"})
            with self.lock:
                self.local_status[dose_id] = "SKIPPED"
                self._mark_handled(dose_id)
        self.show_toast("Dose skipped")

    def dismiss_alert(self) -> None:
        with self.lock:
            if self.alert and self.alert["phase"] in ("done", "error"):
                for dose_id, r in self.alert["results"].items():
                    if not r.get("ok"):
                        self._mark_handled(dose_id)  # failure already reported; don't re-open the alert
                self.alert = None

    def manual_dispense(self, slot: int) -> None:
        slot_info = self._slot(slot)
        if not slot_info or not slot_info.get("medication"):
            self.show_toast(f"Slot {slot} is empty")
            return
        name = slot_info["medication"]["name"]

        def job() -> None:
            try:
                counted = self.hw.dispense(slot, 1, self.cfg.dispense_timeout_seconds)
                self.api.report("/device/doses/manual", {"slotIndex": slot, "quantity": 1, "detectedCount": counted, "dispensedAt": iso(utcnow())})
                with self.lock:
                    self.slot_delta[slot] = self.slot_delta.get(slot, 0) - max(counted, 1)
                self.show_toast(f"{name} dispensed")
            except HardwareError as e:
                self.show_toast(str(e))
            self.sync_now.set()

        self.jobs.put((f"Dispensing {name}…", job))

    def request_sync(self) -> None:
        self.sync_now.set()

    def show_toast(self, text: str, seconds: float = 6) -> None:
        with self.lock:
            self.toast = text
            self.toast_until = time.time() + seconds

    # ======================================================================= commands from the app
    def _queue_command(self, cmd: dict) -> None:
        kind, payload, cmd_id = cmd["type"], cmd.get("payload") or {}, cmd["id"]

        def complete(success: bool, result: dict | None = None, error: str | None = None) -> None:
            body: dict[str, Any] = {"success": success, "result": result or {}}
            if error:
                body["error"] = error
            self.api.report(f"/device/commands/{cmd_id}/complete", body)

        def job() -> None:
            try:
                if kind == "DISPENSE":
                    slot, qty = int(payload["slotIndex"]), int(payload.get("quantity", 1))
                    try:
                        counted = self.hw.dispense(slot, qty, self.cfg.dispense_timeout_seconds)
                        with self.lock:
                            self.slot_delta[slot] = self.slot_delta.get(slot, 0) - max(counted, qty)
                        complete(True, {"detectedCount": counted})
                        self.show_toast("Dispensed (requested from the app). Please take your pills.")
                        self.hw.alert(2)
                    except HardwareError as e:
                        complete(False, {"detectedCount": e.counted}, str(e))
                        self.show_toast(str(e))
                elif kind == "RING":
                    self.hw.alert(float(payload.get("seconds", 5)))
                    self.show_toast("Here I am!", seconds=float(payload.get("seconds", 5)))
                    complete(True)
                elif kind == "TEST_SLOT":
                    self.hw.test_slot(int(payload["slotIndex"]))
                    complete(True)
                elif kind == "TARE_SCALE":
                    self.hw.tare()
                    complete(True)
                elif kind == "SYNC_NOW":
                    self.sync_now.set()
                    complete(True)
                elif kind == "REBOOT":
                    complete(True)
                    if self.hw.name != "simulator":
                        os.system("sudo reboot")
                else:  # CALIBRATE_SCALE, UPDATE_SETTINGS: settings arrive with every sync
                    complete(True, {"note": f"{kind} acknowledged"})
            except HardwareError as e:
                complete(False, error=str(e))
            except Exception as e:  # noqa: BLE001
                complete(False, error=f"station error: {e}")
                raise

        labels = {"DISPENSE": "Dispensing (requested from the app)…", "RING": "Beeping…", "TEST_SLOT": "Testing slot…", "TARE_SCALE": "Zeroing scale…"}
        self.jobs.put((labels.get(kind, "Working…"), job))

    # ======================================================================= what the screen shows
    def _slot(self, index: int) -> dict | None:
        for s in self.payload.get("slots", []):
            if s["index"] == index:
                return s
        return None

    def snapshot(self) -> dict:
        with self.lock:
            now = utcnow()
            tz = self._tz()
            today = now.astimezone(tz).date()

            doses: dict[str, dict] = {}
            strength_by_slot = {s["index"]: (s.get("medication") or {}).get("strength") for s in self.payload.get("slots", [])}
            for d in self.payload.get("recentDoses", []):  # recent doses don't carry strength; take it from the slot
                doses[d["id"]] = self._dose_view({**d, "windowEndsAt": d["scheduledAt"], "strength": strength_by_slot.get(d.get("slotIndex"))})
            for d in self.payload.get("upcomingDoses", []):
                doses[d["id"]] = self._dose_view(d)
            today_list = sorted(
                (d for d in doses.values() if parse_iso(d["scheduledAt"]).astimezone(tz).date() == today),
                key=lambda d: d["scheduledAt"],
            )
            upcoming = sorted(
                (d for d in doses.values() if d["status"] == "SCHEDULED" and parse_iso(d["scheduledAt"]) > now),
                key=lambda d: d["scheduledAt"],
            )
            next_group = [d for d in upcoming if upcoming and d["scheduledAt"] == upcoming[0]["scheduledAt"]]

            slots = []
            for s in self.payload.get("slots", []):
                count = max(0, s["pillCount"] + self.slot_delta.get(s["index"], 0))
                med = s.get("medication")
                slots.append(
                    {
                        "index": s["index"],
                        "name": med["name"] if med else None,
                        "strength": med.get("strength") if med else None,
                        "pillCount": count,
                        "capacity": s.get("capacity", 50),
                        "low": bool(med) and count <= LOW_STOCK_AT,
                    }
                )

            alert = None
            if self.alert:
                if self.alert.get("closeAt") and time.time() > self.alert["closeAt"]:
                    self.alert = None
                else:
                    index = self.alert["doseData"]
                    alert = {
                        "phase": self.alert["phase"],
                        "doses": [
                            {**self._dose_view(index[i]), "result": self.alert["results"].get(i)}
                            for i in self.alert["doseIds"]
                            if i in index
                        ],
                    }

            owner = self.payload.get("owner") or {}
            return {
                "mode": self.mode,
                "online": self.online,
                "error": self.error,
                "lastSyncAt": iso(self.last_sync_at) if self.last_sync_at else None,
                "pendingReports": self.api.pending_count(),
                "claimCode": self.claim_code,
                "deviceName": self.payload.get("device", {}).get("name", "PillPal"),
                "ownerName": owner.get("firstName"),
                "timezone": str(tz),
                "now": iso(now),
                "today": today_list,
                "next": next_group,
                "slots": slots,
                "alert": alert,
                "busy": self.busy,
                "toast": self.toast if time.time() < self.toast_until else "",
                "hardware": self.hw.name,
            }
