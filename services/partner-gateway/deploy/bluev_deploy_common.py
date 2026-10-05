"""Shared offline-testable deployment primitives; never print process output."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

class DeployError(RuntimeError):
    pass

def require(condition, code):
    if not condition:
        raise DeployError(code)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def exact(path):
    return path.read_bytes().decode("utf-8")

def fingerprint(path, optional=False):
    if optional and not path.exists() and not path.is_symlink():
        return None
    require(path.is_file() and not path.is_symlink(), "expected_regular_file")
    return sha(path.read_bytes())

def canonical(value):
    return sha(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())

def emit(event, **fields):
    print(json.dumps(dict(event=event, **fields), ensure_ascii=False), flush=True)

def run(args, *, input_text=None, timeout=45):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, timeout=timeout,
                            env={**os.environ, "PATH": "/opt/node/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
    require(result.returncode == 0, "command_failed:" + Path(args[0]).name)
    return result.stdout

def write_new(path, content, mode=0o600):
    with path.open("x", encoding="utf-8", newline="") as output:
        os.chmod(path, mode)
        output.write(content)
        output.flush()
        os.fsync(output.fileno())

def atomic(path, content, mode=0o600):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent,
                                         prefix="." + path.name, delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, mode)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()

def save(path, state):
    atomic(path, json.dumps(state, indent=2) + "\n")

def load(path):
    return json.loads(exact(path))

def protected_key(path):
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), "key_file_invalid")
    stat = path.stat()
    require(stat.st_uid == 0 and stat.st_mode & 0o077 == 0, "key_file_permissions")
    key = exact(path).strip()
    require(re.fullmatch(r"[A-Za-z0-9_-]{43,128}", key), "key_file_format")
    return key

def inputs(args):
    require(re.fullmatch(r"[a-f0-9]{40}", args.release_id), "commit_sha_required")
    require(re.fullmatch(r"[a-f0-9]{64}", args.sha256), "artifact_sha_required")
    require(re.fullmatch(r"[a-f0-9]{64}", args.proxy_sha256), "proxy_sha_required")
    artifact = Path(args.artifact)
    require(artifact.is_absolute() and fingerprint(artifact) == args.sha256, "artifact_mismatch")
    protected_key(Path(args.key_file))
    return artifact

def archive_members(archive, required):
    members, names, total = archive.getmembers(), set(), 0
    for member in members:
        name = member.name.removeprefix("./").rstrip("/")
        path = PurePosixPath(name)
        require(name and path.as_posix() == name and not path.is_absolute() and ".." not in path.parts
                and "\\" not in name and name not in names, "unsafe_archive_path")
        require(not any(part.startswith(".") for part in path.parts), "hidden_archive_entry")
        require(member.isfile() or member.isdir(), "archive_special_entry")
        require(name in {"package.json", "package-lock.json"} or path.parts[0] == "dist",
                "unexpected_archive_entry")
        require(not member.isfile() or path.suffix in {".js", ".json", ".css", ".html", ".svg"},
                "unsupported_archive_file")
        require(member.size >= 0, "archive_size_invalid")
        names.add(name)
        total += member.size
    require(len(members) < 2500 and total < 64 * 1024 * 1024, "archive_limits_exceeded")
    require(set(required).issubset(names) and all(member.isfile() for member in members
            if member.name.removeprefix("./").rstrip("/") in required), "incomplete_release")
    return members

def extract(artifact, destination, required):
    with tarfile.open(artifact, "r:*") as archive:
        members = archive_members(archive, required)
        destination.mkdir(mode=0o755, parents=True)
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name.removeprefix("./").rstrip("/")).parts)
            require(target.resolve().is_relative_to(destination.resolve()), "archive_escape")
            if member.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with target.open("xb") as output:
                    output.write(archive.extractfile(member).read())
                os.chmod(target, 0o644)

def manifest(directory):
    result = {}
    for path in directory.rglob("*"):
        if "node_modules" in path.relative_to(directory).parts:
            continue
        require(not path.is_symlink(), "release_symlink_forbidden")
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = fingerprint(path)
    return result

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def request(url, method="GET", data=None, headers=None, timeout=3):
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
            return response.status, response.read(1024 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, error.read(65536)

def wait_ready(check, guard, attempts=8):
    for attempt in range(attempts):
        guard()
        try:
            check()
            return
        except (OSError, ValueError, DeployError):
            if attempt == attempts - 1:
                raise
            time.sleep(0.5)

def service_identity(name, active=True):
    output = run(["systemctl", "show", name, "-p", "MainPID", "-p", "ExecMainStartTimestamp",
                  "-p", "ActiveState", "-p", "FragmentPath"])
    value = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    if active:
        require(value.get("ActiveState") == "active" and value.get("MainPID", "0") != "0",
                "service_not_active:" + name)
    return value

def unused_service(name):
    result = subprocess.run(["systemctl", "show", name, "-p", "LoadState"],
                            text=True, capture_output=True, timeout=15)
    require(result.stdout.strip() == "LoadState=not-found", "service_name_in_use")

def port_free(port):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", port))

def add_prepare_arguments(parser):
    for name in ("artifact", "sha256", "release-id", "proxy-sha256", "key-file"):
        parser.add_argument("--" + name, required=True)

def locked_main(parser, actions, lock_path):
    args = parser.parse_args()
    require(os.geteuid() == 0, "root_required")
    import fcntl
    with Path(lock_path).open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            actions[args.action](args)
        except Exception as error:
            emit("failed", error_type=type(error).__name__,
                 code=str(error) if isinstance(error, DeployError) else "inspect_privately_on_server")
            raise SystemExit(1)
