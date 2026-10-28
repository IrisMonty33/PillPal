#!/usr/bin/env bash
# One-time setup on the Raspberry Pi:  bash scripts/install.sh
# - creates config.json (edit it afterwards!)
# - runs the station as a background service that starts on boot and restarts if it crashes
# - opens the touchscreen page full-screen at login and stops the screen from going blank
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(whoami)"
echo "Installing PillPal station from $DIR for user $USER_NAME"

# 1. config
if [ ! -f "$DIR/config.json" ]; then
  cp "$DIR/config.example.json" "$DIR/config.json"
  echo "Created config.json  ->  edit api_url before rebooting!"
fi

# 2. packages (pyserial only matters for the Arduino mode; curl is used by the kiosk script)
sudo apt-get update -y
sudo apt-get install -y python3-serial curl
sudo usermod -aG dialout,gpio "$USER_NAME" || true   # serial port + GPIO access

# 3. background service
sudo tee /etc/systemd/system/pillpal-station.service > /dev/null <<UNIT
[Unit]
Description=PillPal station (dispenser + touchscreen backend)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR
ExecStart=/usr/bin/python3 -m station
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now pillpal-station.service

# 4. open the touchscreen page at login (Raspberry Pi OS desktop: labwc, or wayfire on older images)
chmod +x "$DIR/scripts/start-kiosk.sh"
mkdir -p "$HOME/.config/labwc"
grep -qs "start-kiosk.sh" "$HOME/.config/labwc/autostart" || echo "$DIR/scripts/start-kiosk.sh &" >> "$HOME/.config/labwc/autostart"
if [ -f "$HOME/.config/wayfire.ini" ] && ! grep -qs "start-kiosk.sh" "$HOME/.config/wayfire.ini"; then
  grep -q "^\[autostart\]" "$HOME/.config/wayfire.ini" || echo -e "\n[autostart]" >> "$HOME/.config/wayfire.ini"
  sed -i "/^\[autostart\]/a pillpal = $DIR/scripts/start-kiosk.sh" "$HOME/.config/wayfire.ini"
fi

# 5. keep the screen on
sudo raspi-config nonint do_blanking 1 || true

echo
echo "Done. Check the service with:   systemctl status pillpal-station"
echo "Live log:                       journalctl -u pillpal-station -f"
echo "Reboot to start the touchscreen: sudo reboot"
