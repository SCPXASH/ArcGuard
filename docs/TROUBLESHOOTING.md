# Troubleshooting — Arc Guard

| Symptom | Likely cause | Fix |
|---|---|---|
| Upload fails: `Failed to connect to ESP32: Timed out waiting for packet header` | Board not in download mode | Hold **BOOT**, press and release **EN**, start the upload, release BOOT when "Connecting…" appears |
| No COM port appears | Missing USB-serial driver or charge-only cable | Install the CP210x or CH340 driver (chip next to the USB port); try a data cable |
| Serial Monitor shows garbage | Wrong baud rate | Set **115200** |
| Sensor shows `NO RESPONSE` / status FAULT | VCC, GND or ECHO not connected; sensor powered from wrong rail | Re-seat wires; check rows in docs/WIRING.md; VCC must be on the 3.3 V rail |
| Readings stuck at "> 400 cm (no echo)" | Nothing within range, soft/angled target, or sensor not working at 3.3 V | Point at a flat wall < 2 m; if it still never reads, that module may be a 5 V-only type — stop and ask before changing wiring |
| ESP32 keeps restarting, reset reason `BROWNOUT` on the dashboard | Servo current spikes on a weak USB port | Use a different USB port, a powered hub or a power bank; reduce scan step size; stop scanning to confirm |
| Servo jitters but does not move | Servo red wire on 3.3 V rail or signal on wrong row | Red → left + rail (5 V), orange → row 11 |
| Buzzer beeps constantly | Buzzer VCC on 5 V (I/O HIGH at 3.3 V can't switch it off) | Move buzzer VCC to the 3.3 V rail |
| Buzzer only clicks | It is a passive buzzer | Tick *Passive buzzer* in Settings |
| Serial log shows `Wi-Fi lost, reconnecting…` forever | Wrong SSID/password, 5 GHz network, or out of range (no antenna) | Check `secrets.h`; use a 2.4 GHz hotspot; move it within 1–2 m |
| Wi-Fi up but `WS down` | Wrong `BACKEND_HOST`, backend not running, or Windows Firewall | Check laptop IP with `ipconfig`; start backend with `--host 0.0.0.0`; allow Python through the firewall on private networks |
| College Wi-Fi: ESP32 cannot join | Enterprise (WPA2-Enterprise) or captive-portal network | Use a phone hotspot and connect the laptop to the same hotspot |
| Dashboard says ESP32 Offline but the board is running | Heartbeats not arriving for > 6 s | Same checks as `WS down`; look at the Serial Monitor |
| Too many false events | Thresholds too sensitive or calibration done with people in the room | Recalibrate with the area empty; choose the *Low* sensitivity preset; increase confirmation readings |
| Events missed | Thresholds too strict or the target absorbs sound | *High* preset; use a box or a hard object for demos |
| Settings stay "Pending" | ESP32 offline | They are applied automatically when it reconnects |
| Dashboard shows SIMULATED DATA banner | `simulator.py` is connected | Stop the simulator (Ctrl+C); the real ESP32 then takes over |
| `pip` not found / `python` opens Microsoft Store | Python not on PATH | Install Python 3.11 from python.org with "Add to PATH" ticked |
