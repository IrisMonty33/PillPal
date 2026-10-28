#!/usr/bin/env python3
"""
PillPal reference client for the Raspberry Pi hub.

This is the "server hosting" half of the firmware: it registers the Pi with the
PillPal API, shows the claim code, syncs every 30 s, dispenses scheduled doses
and reports everything back. Hardware calls are isolated in the `Hardware`
class so Henry can plug in the real servo / break-beam / load-cell code.

    pip install requests
    PILLPAL_API=http://<laptop-ip>:4000/api/v1 PILLPAL_PROVISIONING_KEY=pillpal-provisioning-dev python3 pi_client.py

State (API key, device id) is saved to ~/.pillpal/device.json so a reboot does
not need to re-register.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

API = os.environ.get("PILLPAL_API", "http://localhost:4000/api/v1")
PROVISIONING_KEY = os.environ.get("PILLPAL_PROVISIONING_KEY", "pillpal-provisioning-dev")
STATE_FILE = Path(os.environ.get("PILLPAL_STATE", "~/.pillpal/device.json")).expanduser()
SYNC_SECONDS = 30
DISPENSE_EARLY_SECONDS = 0  # dispense exactly at scheduledAt (set >0 to dispense a bit early)


# --------------------------------------------------------------------------- hardware
class Hardware:
    """Replace the bodies of these methods with the real GPIO code."""

    def show_claim_code(self, code: str) -> None:
        print(f"[SCREEN] Open the PillPal app and enter code: {code}")

    def show_status(self, text: str) -> None:
        print(f"[SCREEN] {text}")

    def dispense(self, slot_index: int, quantity: int) -> int:
        """Spin the servo for `slot_index` until the break beam has counted `quantity`
        pills (with a timeout). Return the number of pills actually detected."""
        print(f"[SERVO] slot {slot_index}: dispensing {quantity} pill(s)")
        time.sleep(0.5)
        return quantity  # pretend the break beam saw them all

    def read_weight_grams(self, slot_index: int) -> float | None:
        """Read the NAU7802 load cell for the slot (None if not wired yet)."""
        return None

    def alert(self, seconds: int) -> None:
        print(f"[BUZZER] beep + vibrate for {seconds}s")


hw = Hardware()


# --------------------------------------------------------------------------- api client
class PillPalClient:
    def __init__(self) -> None:
        self.state: dict = {}
        if STATE_FILE.exists():
            self.state = json.loads(STATE_FILE.read_text())
        self.http = requests.Session()

    # -- registration -------------------------------------------------------
    def ensure_registered(self) -> None:
        if self.state.get("apiKey"):
            self.http.headers["X-Device-Key"] = self.state["apiKey"]
            return
        serial = read_serial_number()
        r = self.http.post(
            f"{API}/device/register",
            json={"serialNumber": serial, "firmwareVersion": "0.1.0", "model": "Raspberry Pi 5"},
            headers={"X-Provisioning-Key": PROVISIONING_KEY},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        self.state = {"deviceId": data["deviceId"], "apiKey": data["apiKey"], "serialNumber": serial}
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(self.state))
        self.http.headers["X-Device-Key"] = data["apiKey"]
        print(f"Registered as device {data['deviceId']}")

    def wait_until_claimed(self) -> None:
        while True:
            r = self.http.get(f"{API}/device/claim-status", timeout=10)
            if r.status_code == 401:  # key was rotated/deleted on the server -> register again
                self.state = {}
                self.ensure_registered()
                continue
            r.raise_for_status()
            status = r.json()
            if status["claimed"]:
                hw.show_status(f"Hello {status['owner']['firstName']}!")
                return
            hw.show_claim_code(status["claimCode"])
            time.sleep(5)

    # -- sync ---------------------------------------------------------------
    def sync(self) -> dict:
        slots = []
        for index in range(1, 6):
            w = hw.read_weight_grams(index)
            if w is not None:
                slots.append({"index": index, "weightGrams": w})
        r = self.http.post(
            f"{API}/device/sync",
            json={"firmwareVersion": "0.1.0", "ipAddress": local_ip(), "slots": slots},
            timeout=15,
        )
        r.raise_for_status()
        return r.json()

    def report_dispensed(self, dose_id: str, detected: int, slot_index: int) -> None:
        self.http.post(
            f"{API}/device/doses/{dose_id}/dispensed",
            json={"detectedCount": detected, "slotIndex": slot_index, "dispensedAt": now_iso()},
            timeout=10,
        ).raise_for_status()

    def report_failed(self, dose_id: str, reason: str, code: str = "DISPENSE_FAILED") -> None:
        self.http.post(f"{API}/device/doses/{dose_id}/failed", json={"reason": reason, "code": code}, timeout=10).raise_for_status()

    def complete_command(self, command_id: str, success: bool, result: dict | None = None, error: str | None = None) -> None:
        self.http.post(
            f"{API}/device/commands/{command_id}/complete",
            json={"success": success, "result": result or {}, **({"error": error} if error else {})},
            timeout=10,
        ).raise_for_status()

    def log(self, level: str, type_: str, message: str, data: dict | None = None) -> None:
        try:
            self.http.post(f"{API}/device/events", json={"level": level, "type": type_, "message": message, "data": data or {}}, timeout=10)
        except requests.RequestException:
            pass  # logging must never crash the dispenser


# --------------------------------------------------------------------------- main loop
def handle_due_doses(client: PillPalClient, state: dict, dispensed_ids: set[str]) -> None:
    now = datetime.now(timezone.utc)
    for dose in state["upcomingDoses"]:
        if dose["status"] != "SCHEDULED" or dose["id"] in dispensed_ids or dose["slotIndex"] is None:
            continue
        scheduled = datetime.fromisoformat(dose["scheduledAt"].replace("Z", "+00:00"))
        window_end = datetime.fromisoformat(dose["windowEndsAt"].replace("Z", "+00:00"))
        if now < scheduled or now > window_end:
            continue  # not yet / server will mark it missed
        try:
            hw.alert(2)
            detected = hw.dispense(dose["slotIndex"], dose["quantity"])
            if detected <= 0:
                raise RuntimeError("break beam detected no pills")
            client.report_dispensed(dose["id"], detected, dose["slotIndex"])
            hw.show_status(f"Dispensed {dose['medicationName']} ({detected})")
        except Exception as exc:  # noqa: BLE001
            client.report_failed(dose["id"], str(exc))
            hw.show_status(f"Problem dispensing {dose['medicationName']}")
        dispensed_ids.add(dose["id"])


def handle_commands(client: PillPalClient, state: dict) -> None:
    for cmd in state["pendingCommands"]:
        payload = cmd.get("payload") or {}
        try:
            if cmd["type"] == "DISPENSE":
                detected = hw.dispense(int(payload["slotIndex"]), int(payload.get("quantity", 1)))
                client.complete_command(cmd["id"], True, {"detectedCount": detected})
            elif cmd["type"] == "TEST_SLOT":
                hw.dispense(int(payload["slotIndex"]), 1)
                client.complete_command(cmd["id"], True)
            elif cmd["type"] == "RING":
                hw.alert(int(payload.get("seconds", 5)))
                client.complete_command(cmd["id"], True)
            elif cmd["type"] == "REBOOT":
                client.complete_command(cmd["id"], True)
                os.system("sudo reboot")
            else:
                client.complete_command(cmd["id"], True, {"note": "command acknowledged, nothing to do yet"})
        except Exception as exc:  # noqa: BLE001
            client.complete_command(cmd["id"], False, error=str(exc))


def main() -> None:
    client = PillPalClient()
    client.ensure_registered()
    client.wait_until_claimed()
    client.log("INFO", "BOOT", "pi_client.py started")

    dispensed_ids: set[str] = set()
    while True:
        try:
            state = client.sync()
            handle_commands(client, state)
            handle_due_doses(client, state, dispensed_ids)
            next_dose = next((d for d in state["upcomingDoses"] if d["status"] == "SCHEDULED"), None)
            hw.show_status(f"Next: {next_dose['medicationName']} at {next_dose['scheduledAt']}" if next_dose else "No upcoming doses")
            interval = state.get("syncIntervalSeconds", SYNC_SECONDS)
        except requests.RequestException as exc:
            print(f"network problem: {exc} (will retry)")
            interval = 10
        time.sleep(interval)


# --------------------------------------------------------------------------- helpers
def read_serial_number() -> str:
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    return line.split(":")[1].strip()
    except OSError:
        pass
    return f"dev-{os.uname().nodename}"


def local_ip() -> str:
    import socket

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
