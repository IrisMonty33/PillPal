#!/usr/bin/env bash
# Opens the PillPal touchscreen full-screen. Started automatically at login (see install.sh).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=$(python3 -c "import json;print(json.load(open('$DIR/config.json')).get('local_port',8080))" 2>/dev/null || echo 8080)
URL="http://localhost:$PORT"

# Wait (up to 60 s) for the station service to be serving the page.
for i in $(seq 1 60); do
  curl -s -o /dev/null "$URL/api/state" && break
  sleep 1
done

BROWSER=$(command -v chromium || command -v chromium-browser)
exec "$BROWSER" --kiosk "$URL" \
  --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
  --disable-features=Translate --overscroll-history-navigation=0 --disable-pinch \
  --password-store=basic --ozone-platform-hint=auto
