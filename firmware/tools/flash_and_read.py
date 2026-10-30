"""Flash a PlatformIO build to an ESP32 that is ALREADY in download mode, then read its serial output.

Use when the board's automatic reset-into-bootloader does not work:
  1. Put the board in download mode: hold BOOT, press and release EN, release BOOT.
  2. python tools/flash_and_read.py --port COM4 --env tests --seconds 40
Without --flash it only reads the serial output (e.g. after pressing EN).
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

import serial  # pyserial ships with PlatformIO

FW = Path(__file__).resolve().parents[1]
BOOT_APP0 = Path.home() / ".platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"


def flash(port: str, env: str, before: str = "no_reset", attempts: int = 7, baud: int = 460800) -> bool:
    b = FW / ".pio" / "build" / env
    cmd = [sys.executable, "-m", "platformio", "pkg", "exec", "-p", "tool-esptoolpy", "--", "esptool.py",
           "--chip", "esp32", "--port", port, "--baud", str(baud), "--before", before, "--connect-attempts", str(attempts), "--after", "hard_reset",
           "write_flash", "-z", "--flash_mode", "dio", "--flash_freq", "40m", "--flash_size", "detect",
           "0x1000", str(b / "bootloader.bin"), "0x8000", str(b / "partitions.bin"),
           "0xe000", str(BOOT_APP0), "0x10000", str(b / "firmware.bin")]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=FW)
    out = r.stdout + r.stderr
    for line in out.splitlines():
        if any(k in line for k in ("Chip is", "MAC:", "Wrote", "Hash of data verified", "Hard resetting", "fatal", "error")):
            print("[flash]", line.strip(), flush=True)
    return r.returncode == 0


def read(port: str, seconds: float) -> None:
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 115200, 0.2
    s.dtr = False  # don't hold the board in reset / boot mode while reading
    s.rts = False
    s.open()
    end = time.time() + seconds
    buf = b""
    while time.time() < end:
        buf += s.read(4096)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            print(line.decode("utf-8", "replace").rstrip())
    s.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM4")
    ap.add_argument("--env", default="tests")
    ap.add_argument("--seconds", type=float, default=40)
    ap.add_argument("--flash", action="store_true")
    ap.add_argument("--before", default="no_reset", help="default_reset = let esptool reset the board (hold BOOT meanwhile)")
    ap.add_argument("--attempts", type=int, default=7, help="connection attempts (each retries the reset)")
    ap.add_argument("--baud", type=int, default=460800, help="upload speed; 115200 is slowest and most reliable")
    a = ap.parse_args()
    if a.flash and not flash(a.port, a.env, a.before, a.attempts, a.baud):
        sys.exit("flash failed - is the board in download mode? (hold BOOT, tap EN, release BOOT)")
    read(a.port, a.seconds)
