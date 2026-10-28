"""Station settings, read from config.json (copy config.example.json and edit it)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, fields
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("PILLPAL_DATA", "~/.pillpal")).expanduser()


@dataclass
class Config:
    # Where the PillPal server is, e.g. http://192.168.1.20:4000/api/v1 or https://xxx.onrender.com/api/v1
    api_url: str = "http://localhost:4000/api/v1"
    # Must match DEVICE_PROVISIONING_KEY in the server's .env (only used on first registration)
    provisioning_key: str = "pillpal-provisioning-dev"

    # "simulator" (no hardware, prints what it would do), "arduino" (USB serial), or "gpio" (Henry's direct Pi code)
    hardware: str = "simulator"
    serial_port: str = "/dev/ttyACM0"
    serial_baud: int = 115200

    # The touchscreen page is served on http://localhost:<local_port>
    local_port: int = 8080
    sync_seconds: int = 30
    # False: when a dose is due, the screen alerts and waits for the user to tap "Dispense".
    # True:  dispense automatically at the scheduled time, then alert.
    auto_dispense: bool = False
    # Beep again every N minutes while a due dose is waiting on screen.
    alert_repeat_minutes: int = 5
    # Give up on a slot if the break beam has not counted the pills after this long.
    dispense_timeout_seconds: int = 8
    firmware_version: str = "0.2.0"

    @property
    def base_url(self) -> str:
        return self.api_url.rstrip("/")


def load_config() -> Config:
    path = Path(os.environ.get("PILLPAL_CONFIG", PROJECT_DIR / "config.json"))
    cfg = Config()
    if path.exists():
        raw = json.loads(path.read_text())
        known = {f.name for f in fields(Config)}
        for key, value in raw.items():
            if key in known:
                setattr(cfg, key, value)
    # Environment variables win (handy for quick tests): PILLPAL_API_URL, PILLPAL_HARDWARE, ...
    for f in fields(Config):
        env = os.environ.get(f"PILLPAL_{f.name.upper()}")
        if env is None:
            continue
        if f.type in ("bool", bool):
            setattr(cfg, f.name, env.lower() in ("1", "true", "yes"))
        elif f.type in ("int", int):
            setattr(cfg, f.name, int(env))
        else:
            setattr(cfg, f.name, env)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return cfg
