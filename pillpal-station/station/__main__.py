"""Start the station:  python3 -m station   (from the pillpal-station folder)"""
from __future__ import annotations

import signal
import sys

from .api import Api
from .config import load_config
from .core import Station
from .hardware import make_hardware
from .server import make_server


def main() -> None:
    cfg = load_config()
    print(f"PillPal station starting | server {cfg.base_url} | hardware {cfg.hardware}")
    hw = make_hardware(cfg.hardware, cfg.serial_port, cfg.serial_baud)
    station = Station(cfg, Api(cfg), hw)
    station.start()
    server = make_server(station, cfg.local_port)
    print(f"Touchscreen page: http://localhost:{cfg.local_port}")

    def stop(*_):
        hw.close()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        stop()


if __name__ == "__main__":
    main()
