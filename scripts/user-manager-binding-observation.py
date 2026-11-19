#!/usr/bin/python3
"""Read one systemd unit on one tracked D-Bus connection; emit no secret values.

LoadUnit alone is not a lifetime guarantee after its caller disconnects. RefUnit
keeps an inactive completed/held subject loaded until this observation ends.
"""
import hashlib
import json
import re
import sys
import dbus


def plain(value):
    if isinstance(value, dbus.Boolean):
        return bool(value)
    if isinstance(value, (dbus.Array, dbus.Struct, list, tuple)):
        return [plain(x) for x in value]
    if isinstance(value, dbus.String):
        return str(value)
    if isinstance(value, int):
        return int(value)
    return value


def digest(value):
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def observe(name):
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@\\:-]*\.service", name):
        raise ValueError("exact native service required")
    bus = dbus.SessionBus()
    manager = dbus.Interface(bus.get_object("org.freedesktop.systemd1", "/org/freedesktop/systemd1"), "org.freedesktop.systemd1.Manager")
    path = manager.LoadUnit(name)
    manager.RefUnit(name)
    try:
        properties = dbus.Interface(bus.get_object("org.freedesktop.systemd1", path), "org.freedesktop.DBus.Properties")

        def get(key):
            return plain(properties.Get("org.freedesktop.systemd1.Service", key))

        environment_files = get("EnvironmentFiles")
        credentials = get("LoadCredential") + get("LoadCredentialEncrypted")
        inputs = [{"path": path, "optional": optional} for path, optional in environment_files]
        inputs += [{"path": path, "optional": False} for _, path in credentials]
        if any(not row["path"].startswith("/") for row in inputs):
            raise ValueError("original credential source is unresolved")
        starts = [row[:3] for row in get("ExecStart")]
        conditions = [row[:3] for row in get("ExecCondition")]
        unit_conditions = plain(properties.Get("org.freedesktop.systemd1.Unit", "Conditions"))
        drop_ins = plain(properties.Get("org.freedesktop.systemd1.Unit", "DropInPaths"))
        operands = [row["path"] for row in inputs]
        for row in starts + conditions:
            operands += [row[0], *row[1]]
        profiles = sorted(set(path for operand in operands for path in re.findall(r"/var/guix/profiles/per-user/[^/\s]+/[^/\s]+|/home/[^/\s]+/\.guix-profile", operand)))
        return {"unit": name, "inputFiles": inputs, "profiles": profiles, "dropInPaths": drop_ins,
                "startCommandsSha256": digest(starts), "conditionSha256": [digest(row) for row in conditions],
                "unitConditionSha256": [digest(row[:4]) for row in unit_conditions],
                "environmentSha256": digest(get("Environment")),
                "inlineCredentialsSha256": digest([get("SetCredential"), get("SetCredentialEncrypted")])}
    finally:
        manager.UnrefUnit(name)
        bus.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("one original native service required")
        print(json.dumps(observe(sys.argv[1]), ensure_ascii=False, separators=(",", ":")))
    except Exception:
        # D-Bus property values never enter a traceback or a failed command log.
        sys.stderr.write("original native unit binding observation failed\n")
        sys.exit(1)
