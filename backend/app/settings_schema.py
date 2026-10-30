"""Device settings: defaults and limits. Must match firmware/ArcGuard/settings.cpp."""
from typing import Any

# key: (type, default, min, max)
SCHEMA: dict[str, tuple[type, Any, float | None, float | None]] = {
    "s1_enabled": (bool, True, None, None),
    "s2_enabled": (bool, True, None, None),
    "s3_enabled": (bool, True, None, None),
    "s3_uart": (bool, False, None, None),
    "temp_c": (float, 25.0, -10, 50),
    "tau_abs_cm": (float, 15.0, 3, 200),
    "k_sigma": (float, 4.0, 1, 20),
    "confirm_count": (int, 3, 1, 20),
    "t_min_ms": (int, 300, 0, 10000),
    "rate_min_cms": (float, 30.0, 1, 1000),
    "dwell_s": (int, 10, 1, 3600),
    "jump_cm": (float, 80.0, 10, 400),
    "pattern_k": (int, 15, 2, 60),
    "fault_count": (int, 10, 2, 100),
    "cooldown_s": (int, 3, 0, 600),
    "scanning": (bool, True, None, None),
    "scan_min": (int, 0, 0, 179),
    "scan_max": (int, 180, 1, 180),
    "scan_step": (int, 5, 1, 30),
    "settle_ms": (int, 40, 10, 1000),
    "scan_confirm_sweeps": (int, 2, 1, 10),
    "shift_window_deg": (int, 30, 5, 90),
    "buzzer_enabled": (bool, True, None, None),
    "buzz_on_movement": (bool, True, None, None),
    "buzz_on_anomaly": (bool, True, None, None),
    "buzzer_passive": (bool, False, None, None),
}

DEFAULTS = {k: v[1] for k, v in SCHEMA.items()}


class SettingsError(ValueError):
    pass


def validate(partial: dict[str, Any]) -> dict[str, Any]:
    """Return a cleaned copy of `partial`; raise SettingsError on unknown keys or bad values."""
    out: dict[str, Any] = {}
    for key, value in partial.items():
        if key not in SCHEMA:
            raise SettingsError(f"unknown setting '{key}'")
        typ, _, lo, hi = SCHEMA[key]
        if typ is bool:
            if not isinstance(value, bool):
                raise SettingsError(f"'{key}' must be true or false")
            out[key] = value
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise SettingsError(f"'{key}' must be a number")
        if lo is not None and not (lo <= value <= hi):
            raise SettingsError(f"'{key}' must be between {lo} and {hi}")
        out[key] = typ(value)
    return out


def merged(current: dict[str, Any], partial: dict[str, Any]) -> dict[str, Any]:
    new = {**current, **validate(partial)}
    if new["scan_max"] <= new["scan_min"]:
        raise SettingsError("scan_max must be greater than scan_min")
    return new
