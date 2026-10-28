"""Tiny local web server: serves the touchscreen page and a JSON API for it. Only listens on this Pi (127.0.0.1)."""
from __future__ import annotations

import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import PROJECT_DIR
from .core import Station

KIOSK_DIR = PROJECT_DIR / "kiosk"


def make_server(station: Station, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # keep the console quiet (the page polls twice a second)
            pass

        def _json(self, data, status: int = 200) -> None:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/api/state":
                return self._json(station.snapshot())
            name = "index.html" if self.path in ("/", "/index.html") else self.path.lstrip("/").split("?")[0]
            file = (KIOSK_DIR / name).resolve()
            if KIOSK_DIR not in file.parents or not file.is_file():
                return self._json({"error": "not found"}, 404)
            body = file.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802
            routes = {
                "/api/due/dispense": station.dispense_due,
                "/api/due/retry": lambda: station.dispense_due(only_failed=True),
                "/api/due/taken": station.confirm_taken,
                "/api/due/skip": station.skip_due,
                "/api/due/dismiss": station.dismiss_alert,
                "/api/sync": station.request_sync,
            }
            if self.path in routes:
                routes[self.path]()
                return self._json({"ok": True})
            m = re.fullmatch(r"/api/slots/([1-5])/dispense", self.path)
            if m:
                station.manual_dispense(int(m.group(1)))
                return self._json({"ok": True})
            return self._json({"error": "not found"}, 404)

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
