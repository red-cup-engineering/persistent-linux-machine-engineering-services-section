"""Private syscall worker. Its caller supplies original-owner admission; no pause authority is issued here."""
import hashlib
import json
import os
import stat
import sys


def refuse(message):
    raise ValueError("quarantine owner-path preparation refused: " + message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def open_chain(path):
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        refuse("canonical directory required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split("/")[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def facts(fd):
    s = os.fstat(fd)
    return {"device": s.st_dev, "inode": s.st_ino, "uid": s.st_uid,
            "gid": s.st_gid, "mode": stat.S_IMODE(s.st_mode)}


def exact(fd, expected):
    if not stat.S_ISDIR(os.fstat(fd).st_mode) or facts(fd) != expected or os.listxattr(fd):
        refuse("directory identity/mode/ACL changed")


def same_path(fd, path):
    other = open_chain(path)
    try:
        if facts(other) != facts(fd):
            refuse("directory path identity changed")
    finally:
        os.close(other)


def append(fd, rows, event):
    row = {"previous": digest(rows[-1]) if rows else None, **event}
    data = (json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode()
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if not written:
            refuse("journal write incomplete")
        view = view[written:]
    os.fsync(fd)
    rows.append(row)


def run(packet):
    if set(packet) != {"home", "area", "id", "directories", "binding"}:
        refuse("unknown operation fields")
    if not isinstance(packet["id"], str) or not packet["id"] or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in packet["id"]):
        refuse("fixed original quarantine id required")
    expected = packet["directories"]
    if not isinstance(expected, list) or len(expected) != 2:
        refuse("exactly two original directory prestates required")
    for row in expected:
        if set(row) != {"device", "inode", "uid", "gid", "mode"} or any(type(v) is not int or v < 0 for v in row.values()):
            refuse("complete numeric native prestate required")
        if row["uid"] != os.getuid() or row["gid"] != os.getgid() or row["mode"] != 0o775:
            refuse("only original owner 0775 prestate is allowed")
    fds = []
    area = journal = None
    locked = False
    lock_name = packet["id"] + ".owner-path-preparation.lock"
    journal_name = packet["id"] + ".owner-path-preparation.jsonl"
    try:
        home = open_chain(packet["home"])
        fds.append(home)
        home_stat = os.fstat(home)
        if home_stat.st_uid != os.getuid() or stat.S_IMODE(home_stat.st_mode) & 0o022:
            refuse("unsafe original home")
        fds.append(os.open(".config", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home))
        fds.append(os.open("systemd", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fds[1]))
        area = open_chain(packet["area"])
        if os.fstat(area).st_uid != os.getuid() or stat.S_IMODE(os.fstat(area).st_mode) & 0o077:
            refuse("private original receipt area required")
        os.mkdir(lock_name, mode=0o700, dir_fd=area)
        locked = True
        lock = os.stat(lock_name, dir_fd=area, follow_symlinks=False)
        journal = os.open(journal_name, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=area)
        js = os.fstat(journal)
        if not stat.S_ISREG(js.st_mode) or js.st_uid != os.getuid() or stat.S_IMODE(js.st_mode) & 0o077 or js.st_nlink != 1 or js.st_size > 65536:
            refuse("unsafe original operation journal")
        data = os.read(journal, 65537)
        if len(data) > 65536 or (data and not data.endswith(b"\n")):
            refuse("partial or oversized operation journal")
        rows = [json.loads(line) for line in data.splitlines()]
        for i, row in enumerate(rows):
            if row.get("previous") != (digest(rows[i-1]) if i else None):
                refuse("operation receipt chain changed")
        intent = {"event": "intent", "binding": packet["binding"], "home": packet["home"], "directories": expected}
        if rows:
            if {k: v for k, v in rows[0].items() if k != "previous"} != intent:
                refuse("original operation binding changed")
        complete = []
        for row in rows[1:]:
            if set(row) != {"previous", "event", "index", "after"} or row["event"] != "directory-received" or row["index"] != len(complete) or len(complete) >= 2:
                refuse("unknown or reordered operation outcome")
            index = row["index"]
            after = {**expected[index], "mode": expected[index]["mode"] & ~0o020}
            if row["after"] != after:
                refuse("operation outcome substitution")
            complete.append(index)
        # Receive BOTH objects before allocating an intent or changing either mode.
        for index, fd in enumerate(fds[1:]):
            state = {**expected[index], "mode": expected[index]["mode"] & ~0o020} if index in complete else expected[index]
            exact(fd, state)
            same_path(fd, packet["home"] + ("/.config" if index == 0 else "/.config/systemd"))
        if not rows:
            append(journal, rows, intent)
        # Receive the intent/fence directory entries durably before any chmod.
        os.fsync(area)
        for index, fd in enumerate(fds[1:]):
            if index in complete:
                continue
            exact(fd, expected[index])
            same_path(fd, packet["home"] + ("/.config" if index == 0 else "/.config/systemd"))
            os.fchmod(fd, expected[index]["mode"] & ~0o020)
            os.fsync(fd)
            after = {**expected[index], "mode": expected[index]["mode"] & ~0o020}
            exact(fd, after)
            same_path(fd, packet["home"] + ("/.config" if index == 0 else "/.config/systemd"))
            append(journal, rows, {"event": "directory-received", "index": index, "after": after})
        os.fsync(area)
        return {"type": "WslQuarantineOwnerPathPreparation", "status": "directories-received",
                "journalSha256": hashlib.sha256(b"".join((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode() for row in rows)).hexdigest(),
                "unchanged": len(complete) == 2, "guardLoaded": False, "released": False}
    finally:
        if journal is not None:
            os.close(journal)
        if locked:
            current = os.stat(lock_name, dir_fd=area, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (lock.st_dev, lock.st_ino):
                refuse("operation fence identity changed")
            os.rmdir(lock_name, dir_fd=area)
            os.fsync(area)
        if area is not None:
            os.close(area)
        for fd in reversed(fds):
            os.close(fd)


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            refuse("oversized original input")
        print(json.dumps(run(json.loads(raw))))
    except Exception as error:
        print(json.dumps({"status": "refused-or-partial", "cause": str(error), "effectsUnknown": True}), file=sys.stderr)
        sys.exit(2)
