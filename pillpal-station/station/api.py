"""Talks to the PillPal server (/api/v1/device/*). Standard library only - nothing to pip install."""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import DATA_DIR, Config


class OfflineError(Exception):
    """The server could not be reached (no Wi-Fi, server down, wrong URL)."""


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class Api:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.api_key: str | None = None
        self._queue_path: Path = DATA_DIR / "pending_reports.json"
        self._queue_lock = threading.Lock()

    # ------------------------------------------------------------------ http
    def request(self, method: str, path: str, body: Any = None, headers: dict | None = None, timeout: float = 10) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"{self.cfg.base_url}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.api_key:
            req.add_header("X-Device-Key", self.api_key)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", {}).get("message", e.reason)
            except Exception:  # noqa: BLE001
                msg = str(e.reason)
            raise ApiError(e.code, msg) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            raise OfflineError(str(e)) from None

    # ------------------------------------------------------------------ device endpoints
    def register(self, serial: str) -> dict:
        return self.request(
            "POST",
            "/device/register",
            {"serialNumber": serial, "firmwareVersion": self.cfg.firmware_version, "model": "Raspberry Pi 5 + Touch Display 2"},
            headers={"X-Provisioning-Key": self.cfg.provisioning_key},
        )

    def claim_status(self) -> dict:
        return self.request("GET", "/device/claim-status")

    def sync(self, body: dict) -> dict:
        return self.request("POST", "/device/sync", body, timeout=15)

    # ------------------------------------------------------------------ reports (queued when offline)
    def report(self, path: str, body: dict) -> bool:
        """Send a report now; if offline, keep it on disk and send it on the next successful sync.
        Returns True when delivered immediately."""
        try:
            self.request("POST", path, body)
            return True
        except OfflineError:
            self._enqueue(path, body)
            return False
        except ApiError as e:
            # 409 = already in that state (e.g. reported twice). Anything else is logged, not retried.
            if e.status not in (404, 409):
                print(f"[api] report {path} rejected: {e}")
            return True

    def flush_queue(self) -> int:
        with self._queue_lock:
            items = self._load_queue()
            sent = 0
            remaining = []
            for item in items:
                try:
                    self.request("POST", item["path"], item["body"])
                    sent += 1
                except OfflineError:
                    remaining.append(item)
                except ApiError as e:
                    print(f"[api] dropped queued report {item['path']}: {e}")
            self._save_queue(remaining)
            return sent

    def pending_count(self) -> int:
        with self._queue_lock:
            return len(self._load_queue())

    def _enqueue(self, path: str, body: dict) -> None:
        with self._queue_lock:
            items = self._load_queue()
            items.append({"path": path, "body": body})
            self._save_queue(items)

    def _load_queue(self) -> list:
        try:
            return json.loads(self._queue_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def _save_queue(self, items: list) -> None:
        self._queue_path.write_text(json.dumps(items))
