"""
Everything that moves or beeps goes through one of these classes, chosen by "hardware" in config.json:

  simulator  - no hardware; prints what it would do (default, for testing on a laptop)
  arduino    - sends text commands over USB to an Arduino (see arduino/PROTOCOL.md)
  gpio       - drives servos / break beams straight from the Pi's pins (starting point for Henry)

The rest of the station only ever calls: dispense(), alert(), test_slot(), tare(), read_weight(), close().
"""
from __future__ import annotations

import os
import threading
import time


class HardwareError(Exception):
    """A dispense or sensor action failed. `counted` = pills the break beam saw before it failed."""

    def __init__(self, message: str, counted: int = 0):
        super().__init__(message)
        self.counted = counted


class Hardware:
    name = "base"

    def dispense(self, slot: int, quantity: int, timeout_s: float) -> int:
        """Release `quantity` pills from `slot` (1-5). Returns pills counted. Raises HardwareError on jam/empty."""
        raise NotImplementedError

    def alert(self, seconds: float) -> None:
        """Beep + vibrate for `seconds` (should return quickly; run the sound in the background)."""

    def test_slot(self, slot: int) -> None:
        """Spin a slot briefly so the user can check it moves."""

    def tare(self) -> None:
        """Zero the load cell."""

    def read_weight(self) -> float | None:
        """Grams on the load cell, or None when there is no load cell."""
        return None

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------- simulator
class SimulatedHardware(Hardware):
    """Pretends to dispense. Set PILLPAL_SIM_JAM=3 to make slot 3 'jam' (for testing error screens)."""

    name = "simulator"

    def dispense(self, slot: int, quantity: int, timeout_s: float) -> int:
        print(f"[sim] slot {slot}: dispensing {quantity} pill(s)")
        jam = os.environ.get("PILLPAL_SIM_JAM")
        for i in range(quantity):
            time.sleep(0.6)
            if jam and int(jam) == slot:
                raise HardwareError(f"No pill detected from slot {slot} (jam or empty)", counted=i)
        return quantity

    def alert(self, seconds: float) -> None:
        print(f"[sim] beep + vibrate {seconds:.0f}s")

    def test_slot(self, slot: int) -> None:
        print(f"[sim] test slot {slot}")

    def tare(self) -> None:
        print("[sim] tare scale")


# ---------------------------------------------------------------------------- arduino
class ArduinoHardware(Hardware):
    """Talks to an Arduino over USB serial using the line protocol in arduino/PROTOCOL.md."""

    name = "arduino"

    def __init__(self, port: str, baud: int):
        try:
            import serial  # pyserial: `sudo apt install python3-serial` (preinstalled on Raspberry Pi OS desktop)
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("pyserial is missing: run  sudo apt install python3-serial") from e
        self._serial_mod = serial
        self.port = port
        self.baud = baud
        self._lock = threading.Lock()
        self._ser = None
        self._open()

    def _open(self) -> None:
        self._ser = self._serial_mod.Serial(self.port, self.baud, timeout=0.2)
        # Opening the port resets most Arduinos; wait for the sketch to print READY (max 4 s).
        deadline = time.time() + 4
        while time.time() < deadline:
            line = self._readline()
            if line == "READY":
                break
        self._ser.reset_input_buffer()

    def _readline(self) -> str | None:
        raw = self._ser.readline()
        if not raw:
            return None
        return raw.decode(errors="replace").strip()

    def command(self, cmd: str, timeout_s: float = 3.0) -> list[str]:
        """Send one command and wait for its 'OK <CMD> ...' or 'ERR <CMD> ...' reply. Returns the reply's words."""
        verb = cmd.split()[0]
        with self._lock:
            for attempt in range(2):
                try:
                    if self._ser is None or not self._ser.is_open:
                        self._open()
                    self._ser.write((cmd + "\n").encode())
                    deadline = time.time() + timeout_s
                    while time.time() < deadline:
                        line = self._readline()
                        if not line or line.startswith("#"):
                            continue  # nothing yet, or a debug line from the sketch
                        parts = line.split()
                        if len(parts) >= 2 and parts[1] == verb and parts[0] in ("OK", "ERR"):
                            return parts
                    raise HardwareError(f"Arduino did not answer {verb} within {timeout_s:.0f}s")
                except self._serial_mod.SerialException:
                    self._ser = None  # USB unplugged/replugged: reopen once
                    if attempt == 1:
                        raise HardwareError("Arduino is not connected")
                    time.sleep(1)
        raise HardwareError("Arduino is not connected")

    def dispense(self, slot: int, quantity: int, timeout_s: float) -> int:
        parts = self.command(f"DISPENSE {slot} {quantity} {int(timeout_s * 1000)}", timeout_s=timeout_s * quantity + 3)
        # OK DISPENSE <slot> <counted>      |  ERR DISPENSE <slot> <counted> <REASON>
        counted = int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else 0
        if parts[0] == "ERR":
            reason = parts[4] if len(parts) > 4 else "UNKNOWN"
            nice = {"TIMEOUT": "no pill detected (jam or empty)", "BAD_SLOT": "invalid slot"}.get(reason, reason.lower())
            raise HardwareError(f"Slot {slot}: {nice}", counted=counted)
        return counted

    def alert(self, seconds: float) -> None:
        try:
            self.command(f"ALERT {int(seconds * 1000)}")
        except HardwareError as e:
            print(f"[arduino] alert failed: {e}")

    def test_slot(self, slot: int) -> None:
        self.command(f"TEST {slot}", timeout_s=5)

    def tare(self) -> None:
        self.command("TARE", timeout_s=5)

    def read_weight(self) -> float | None:
        try:
            parts = self.command("WEIGHT")
            return float(parts[2]) if parts[0] == "OK" else None
        except (HardwareError, ValueError, IndexError):
            return None

    def close(self) -> None:
        if self._ser:
            try:
                self.command("STOP", timeout_s=1)
            except HardwareError:
                pass
            self._ser.close()


# ---------------------------------------------------------------------------- direct GPIO (for Henry)
class GpioHardware(Hardware):
    """
    Starting point for running everything from the Pi's own pins, without an Arduino.
    UNTESTED ON HARDWARE - adjust the pin numbers (BCM numbering) to the real wiring.

    Uses gpiozero (preinstalled on Raspberry Pi OS). FS90R continuous servos: value 0 = stop,
    +/-1 = full speed. Break beams: receiver output LOW when the beam is broken.
    """

    name = "gpio"
    SERVO_PINS = {1: 12, 2: 13, 3: 18, 4: 19, 5: 21}
    BEAM_PINS = {1: 5, 2: 6, 3: 16, 4: 20, 5: 26}
    BUZZER_PIN = 23
    VIBRATION_PIN = 24  # through a transistor - never drive the motor straight from a pin
    SPIN_SPEED = 0.5

    def __init__(self):
        from gpiozero import Button, Buzzer, DigitalOutputDevice, Servo

        self.servos = {s: Servo(p, initial_value=None) for s, p in self.SERVO_PINS.items()}
        self.beams = {s: Button(p, pull_up=True) for s, p in self.BEAM_PINS.items()}
        self.buzzer = Buzzer(self.BUZZER_PIN)
        self.vibe = DigitalOutputDevice(self.VIBRATION_PIN)
        self._lock = threading.Lock()

    def dispense(self, slot: int, quantity: int, timeout_s: float) -> int:
        with self._lock:
            servo, beam = self.servos[slot], self.beams[slot]
            counted = 0
            seen = threading.Event()

            def on_break():
                nonlocal counted
                counted += 1
                seen.set()

            beam.when_pressed = on_break  # "pressed" = beam broken (pin pulled LOW)
            try:
                servo.value = self.SPIN_SPEED
                deadline = time.time() + timeout_s
                while counted < quantity:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        raise HardwareError(f"Slot {slot}: no pill detected (jam or empty)", counted=counted)
                    if seen.wait(remaining):
                        seen.clear()
                        deadline = time.time() + timeout_s  # each pill gets its own timeout
                return counted
            finally:
                servo.value = None  # stop sending pulses = stop
                beam.when_pressed = None

    def alert(self, seconds: float) -> None:
        self.buzzer.beep(on_time=0.2, off_time=0.2, n=max(1, int(seconds / 0.4)), background=True)
        self.vibe.blink(on_time=0.5, off_time=0.3, n=max(1, int(seconds / 0.8)), background=True)

    def test_slot(self, slot: int) -> None:
        with self._lock:
            self.servos[slot].value = self.SPIN_SPEED
            time.sleep(0.8)
            self.servos[slot].value = None

    def close(self) -> None:
        for s in self.servos.values():
            s.value = None


def make_hardware(kind: str, port: str = "/dev/ttyACM0", baud: int = 115200) -> Hardware:
    if kind == "arduino":
        return ArduinoHardware(port, baud)
    if kind == "gpio":
        return GpioHardware()
    return SimulatedHardware()
