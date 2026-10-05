"""First install of the independent read-only platform orders service and UI."""
from __future__ import annotations
import argparse
import hashlib
from html.parser import HTMLParser
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

SCRIPT = Path(__file__).resolve()
ROOT = Path("/opt/x-platform-orders")
CONFIG = Path("/etc/x-platform-orders")
STATE = ROOT / "deploy-state.json"
SITE = Path("/etc/nginx/sites-available/xgift")
SNIPPET = Path("/etc/nginx/snippets/x-platform-orders.conf")
PARTNER_SNIPPET = Path("/etc/nginx/snippets/x-partner-gateway.conf")
UNIT = Path("/etc/systemd/system/x-platform-orders.service")
DATABASE = Path("/srv/x-partner-gateway/data/merchant-gateway.sqlite")
SERVICE = "x-platform-orders"
NODE = "/opt/node/bin/node"
PUBLIC = "https://x.aifu.me"
API = "/api/admin/platform-orders"
OLD_FILES = (
    Path("/etc/xgift/service.env"), Path("/etc/x-partner-gateway/service.env"),
    Path("/etc/x-partner-gateway/products.json"),
    Path("/etc/systemd/system/xgift.service"),
    Path("/etc/systemd/system/x-partner-gateway.service"), PARTNER_SNIPPET,
)
GATES = (Path("/srv/x-partner-gateway/control/sales.enabled"),
         Path("/srv/x-partner-gateway/control/workers.enabled"))
SECURITY = """    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "DENY" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" always;
"""


class DeployError(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise DeployError(code)


def emit(event, **fields):
    print(json.dumps(dict(event=event, **fields), ensure_ascii=False), flush=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def exact(path):
    return path.read_bytes().decode("utf-8")


def run(args, *, timeout=30):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout,
                            env={**os.environ, "PATH": "/opt/node/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
    require(result.returncode == 0, "command_failed:" + Path(args[0]).name)
    # Never echo subprocess output: existing configuration may contain credentials.
    return result.stdout


def write_new(path, text, mode=0o600):
    with path.open("x", encoding="utf-8", newline="") as output:
        os.chmod(path, mode)
        output.write(text)
        output.flush()
        os.fsync(output.fileno())


def atomic(path, text, mode=0o600):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent,
                                         prefix="." + path.name, delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, mode)
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def save(state):
    atomic(STATE, json.dumps(state, indent=2) + "\n")


def load():
    return json.loads(exact(STATE))


def fingerprint(path, optional=False):
    if optional and not path.exists() and not path.is_symlink():
        return None
    require(path.is_file() and not path.is_symlink(), "baseline_file_not_regular")
    return sha(path.read_bytes())


def service_identity(name):
    fields = run(["systemctl", "show", name, "-p", "MainPID", "-p", "ExecMainStartTimestamp",
                  "-p", "ActiveState", "-p", "FragmentPath"])
    result = dict(line.split("=", 1) for line in fields.splitlines() if "=" in line)
    require(result.get("ActiveState") == "active" and result.get("MainPID", "0") != "0",
            "original_service_not_active:" + name)
    return result


def old_baseline():
    return {
        "services": {name: service_identity(name) for name in ("xgift", "x-partner-gateway", "nginx")},
        "current": {name: str(Path("/opt/" + name + "/current").resolve(strict=True))
                    for name in ("xgift", "x-partner-gateway")},
        "files": {str(path): fingerprint(path) for path in OLD_FILES},
        "gates": {str(path): fingerprint(path, optional=True) for path in GATES},
    }


def assert_old(state):
    require(old_baseline() == state["old_baseline"], "original_service_or_configuration_changed")


def request(url, method="GET", headers=None, timeout=8):
    req = urllib.request.Request(url, method=method, headers=headers or {},
                                 data=b"" if method == "POST" else None)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read(2 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read(65536)


def old_health():
    for url, headers in (
        ("http://127.0.0.1:8791/healthz", {"Host": "x.aifu.me"}),
        ("http://127.0.0.1:3110/health", None),
        (PUBLIC + "/healthz", None),
        (PUBLIC + "/partner/health", None),
    ):
        status, _, _ = request(url, headers=headers)
        require(status == 200, "original_health_failed")


def port_free():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 3111))


def require_unused_service_name():
    # systemctl versions differ on the exit status of a missing unit; require
    # its explicit LoadState instead of treating every nonzero status alike.
    result = subprocess.run(["systemctl", "show", SERVICE, "-p", "LoadState"],
                            text=True, capture_output=True, timeout=15)
    require(result.stdout.strip() == "LoadState=not-found", "reader_service_name_already_in_use")


def candidate_site(original):
    require(SNIPPET.as_posix() not in original and "platform-admin-ui" not in original
            and API not in original, "platform_route_already_exists")
    require(original.count("include " + PARTNER_SNIPPET.as_posix() + ";") == 1,
            "existing_partner_include_missing_or_ambiguous")
    require(original.count("proxy_pass http://127.0.0.1:8791;") == 1,
            "original_proxy_missing_or_ambiguous")
    require(not re.search(r"location\s*=\s*/(?:index\.html)?\s*\{", original),
            "exact_index_route_already_exists")
    matches = list(re.finditer(r"^(?P<indent>[ \t]*)location[ \t]+/[ \t]*\{[ \t]*\r?$",
                               original, re.MULTILINE))
    require(len(matches) == 1 and "x.aifu.me" in original, "nginx_default_location_ambiguous")
    match = matches[0]
    newline = "\r\n" if match.group(0).endswith("\r") else "\n"
    inserted = match.group("indent") + "include " + SNIPPET.as_posix() + ";" + newline + newline
    return original[:match.start()] + inserted + original[match.start():]


def snippet(release_id):
    index = ROOT / "releases" / release_id / "ui/index.html"
    ui = index.parent.as_posix() + "/"
    result = "# Independent read-only platform orders and versioned UI.\n"
    for path in ("/", "/index.html"):
        result += (
            "location = " + path + " {\n"
            "    if ($request_method !~ ^(GET|HEAD)$) { return 405; }\n"
            "    alias " + index.as_posix() + ";\n"
            "    default_type text/html;\n    charset utf-8;\n"
            "    disable_symlinks on;\n" + SECURITY +
            '    add_header Cache-Control "no-store" always;\n}\n\n'
        )
    result += (
        "location ^~ /platform-admin-ui/" + release_id + "/ {\n"
        "    if ($request_method !~ ^(GET|HEAD)$) { return 405; }\n"
        "    alias " + ui + ";\n    autoindex off;\n    disable_symlinks on;\n" + SECURITY +
        '    add_header Cache-Control "public, max-age=31536000, immutable" always;\n}\n\n'
        "location = " + API + " {\n"
        "    if ($request_method != GET) { return 405; }\n"
        "    proxy_pass http://127.0.0.1:3111;\n"
        "    proxy_set_header Host x.aifu.me;\n"
        "    proxy_set_header X-Real-IP $remote_addr;\n"
        '    proxy_set_header X-Forwarded-For "";\n'
        '    proxy_set_header CF-Connecting-IP "";\n'
        "    proxy_pass_request_body off;\n"
        '    proxy_set_header Content-Length "";\n'
        "    proxy_read_timeout 5s;\n" + SECURITY +
        '    add_header Cache-Control "no-store" always;\n}\n'
    )
    return result


def unit_text():
    return """[Unit]
Description=Read-only X platform orders viewer
After=network-online.target xgift.service x-partner-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=xpartner
Group=xpartner
WorkingDirectory=/opt/x-platform-orders/current
EnvironmentFile=/etc/x-platform-orders/service.env
ExecStart=/opt/node/bin/node dist/platform-orders-reader.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/srv/x-partner-gateway
InaccessiblePaths=/etc/xgift /srv/xgift /etc/x-partner-gateway
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=192M
CPUQuota=25%
Nice=10
LimitNOFILE=1024

[Install]
WantedBy=multi-user.target
"""


def env_text():
    return (
        "NODE_ENV=production\nHOST=127.0.0.1\nPORT=3111\n"
        "PLATFORM_ORDERS_DB_PATH=/srv/x-partner-gateway/data/merchant-gateway.sqlite\n"
        "X_ADMIN_SESSION_URL=http://127.0.0.1:8791/api/session\n"
        "X_ADMIN_HOST=x.aifu.me\n"
    )


def validate_archive(archive):
    members = archive.getmembers()
    names = set()
    total = 0
    for member in members:
        name = member.name.removeprefix("./").rstrip("/")
        path = PurePosixPath(name)
        require(name and not path.is_absolute() and path.as_posix() == name and ".." not in path.parts
                and "\\" not in name and name not in names, "unsafe_archive_path")
        require(not any(part.startswith(".") for part in path.parts), "hidden_archive_entry")
        require(member.isfile() or member.isdir(), "archive_special_entry")
        require(name == "package.json" or path.parts[0] in {"dist", "ui"}, "unexpected_archive_entry")
        if member.isfile():
            allowed = path.suffix in {".js", ".json"} if path.parts[0] == "dist" else (
                path.suffix in {".html", ".js", ".css", ".svg", ".png", ".ico", ".woff2", ".webp"}
                or name == "package.json")
            require(allowed and member.size >= 0, "unsupported_archive_file")
        names.add(name)
        total += member.size
    required = {"package.json", "dist/platform-orders-reader.js", "ui/index.html"}
    require(required.issubset(names) and all(member.isfile() for member in members
            if member.name.removeprefix("./").rstrip("/") in required), "incomplete_release")
    require(len(members) < 2500 and total < 64 * 1024 * 1024, "archive_limits_exceeded")
    return members


def extract(artifact, destination):
    with tarfile.open(artifact, "r:*") as archive:
        members = validate_archive(archive)
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
        require(not path.is_symlink(), "release_symlink_forbidden")
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = sha(path.read_bytes())
    return result


class AssetReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "script":
            require(bool(values.get("src")), "inline_script_forbidden")
            self.values.append(values["src"])
        elif tag == "link" and "stylesheet" in values.get("rel", ""):
            self.values.append(values.get("href", ""))


def validate_ui(release, release_id):
    parser = AssetReferences()
    parser.feed(exact(release / "ui/index.html"))
    prefix = "/platform-admin-ui/" + release_id + "/"
    require(parser.values and any(value.endswith(".js") for value in parser.values), "ui_script_missing")
    for value in parser.values:
        require(value.startswith(prefix) and "?" not in value and "#" not in value
                and ".." not in value, "ui_base_mismatch")
        path = release / "ui" / value.removeprefix(prefix)
        require(path.is_file() and not path.is_symlink(), "ui_reference_missing")
    return parser.values


def prepare(args):
    require(re.fullmatch(r"[a-f0-9]{40}", args.release_id), "release_must_be_commit_sha")
    for value in (args.sha256, args.nginx_sha256, args.partner_snippet_sha256):
        require(re.fullmatch(r"[a-f0-9]{64}", value), "invalid_expected_hash")
    for path in (ROOT, CONFIG, UNIT, SNIPPET):
        require(not path.exists() and not path.is_symlink(), "first_install_target_exists")
    artifact = Path(args.artifact)
    require(artifact.is_absolute() and artifact.is_file() and not artifact.is_symlink()
            and sha(artifact.read_bytes()) == args.sha256, "artifact_mismatch")
    require(fingerprint(SITE) == args.nginx_sha256
            and fingerprint(PARTNER_SNIPPET) == args.partner_snippet_sha256, "reviewed_proxy_baseline_changed")
    require(DATABASE.is_file() and not DATABASE.is_symlink(), "gateway_database_missing_or_symlink")
    require_unused_service_name()
    require(re.match(r"v24\.", run([NODE, "--version"]).strip()), "node24_required")
    import pwd
    user = pwd.getpwnam("xpartner")
    require(user.pw_uid != 0 and user.pw_shell in {"/sbin/nologin", "/usr/sbin/nologin", "/bin/false"},
            "reader_user_not_isolated")
    baseline = old_baseline()
    old_health()
    port_free()
    original = exact(SITE)
    candidate = candidate_site(original)
    with tarfile.open(artifact, "r:*") as archive:
        validate_archive(archive)
    ROOT.mkdir(mode=0o755)
    backup = ROOT / "backups" / args.release_id
    backup.mkdir(mode=0o700, parents=True)
    write_new(backup / "nginx.original", original)
    write_new(backup / "nginx.candidate", candidate)
    write_new(backup / "new-snippet.conf", snippet(args.release_id))
    write_new(backup / "new-unit.service", unit_text())
    state = dict(status="preparing", release_id=args.release_id, old_baseline=baseline,
                 artifact_sha256=args.sha256, script_sha256=sha(SCRIPT.read_bytes()), backup=str(backup),
                 original_site_sha256=sha(original.encode()), candidate_site_sha256=sha(candidate.encode()),
                 site_mode=SITE.stat().st_mode & 0o777)
    save(state)
    release = ROOT / "releases" / args.release_id
    extract(artifact, release)
    require(json.loads(exact(release / "package.json")).get("type") == "module", "module_type_required")
    state["asset_urls"] = validate_ui(release, args.release_id)
    for path in (release / "dist").rglob("*.js"):
        run([NODE, "--check", str(path)])
    CONFIG.mkdir(mode=0o700)
    write_new(CONFIG / "service.env", env_text())
    state["release_manifest"] = manifest(release)
    state["env_sha256"] = fingerprint(CONFIG / "service.env")
    state["snippet_sha256"] = fingerprint(backup / "new-snippet.conf")
    state["unit_sha256"] = fingerprint(backup / "new-unit.service")
    assert_old(state)
    require(fingerprint(SITE) == state["original_site_sha256"], "nginx_changed_during_prepare")
    old_health()
    state["status"] = "prepared"
    save(state)
    emit("prepared", old_services_unchanged=True, credentials_copied=False, old_databases_written=False)


def assert_release(state):
    require(sha(SCRIPT.read_bytes()) == state["script_sha256"], "deploy_script_changed")
    assert_release_contents(state)


def assert_release_contents(state):
    require(manifest(ROOT / "releases" / state["release_id"]) == state["release_manifest"], "release_changed")
    require(fingerprint(CONFIG / "service.env") == state["env_sha256"], "reader_configuration_changed")
    assert_old(state)


def assert_current(state):
    require((ROOT / "current").is_symlink()
            and (ROOT / "current").resolve() == ROOT / "releases" / state["release_id"],
            "reader_current_changed")


def checked_candidate(state):
    backup = Path(state["backup"])
    require(backup == ROOT / "backups" / state["release_id"], "backup_directory_changed")
    candidate = exact(backup / "nginx.candidate")
    require(fingerprint(backup / "nginx.original") == state["original_site_sha256"]
            and fingerprint(backup / "nginx.candidate") == state["candidate_site_sha256"]
            and fingerprint(backup / "new-snippet.conf") == state["snippet_sha256"]
            and fingerprint(backup / "new-unit.service") == state["unit_sha256"], "release_backup_changed")
    return candidate


def stopped_reader_identity():
    fields = run(["systemctl", "show", SERVICE, "-p", "LoadState", "-p", "MainPID",
                  "-p", "ActiveState", "-p", "SubState", "-p", "FragmentPath",
                  "-p", "UnitFileState", "-p", "NeedDaemonReload", "-p", "ExecMainStartTimestamp",
                  "-p", "DropInPaths"])
    identity = dict(line.split("=", 1) for line in fields.splitlines() if "=" in line)
    expected = dict(LoadState="loaded", MainPID="0", ActiveState="inactive", SubState="dead",
                    FragmentPath=str(UNIT), UnitFileState="disabled", NeedDaemonReload="no", DropInPaths="")
    require(all(identity.get(key) == value for key, value in expected.items()), "reader_not_original_stopped_unit")
    return identity


def assert_resume_targets(state):
    require(fingerprint(SITE) == state["original_site_sha256"], "nginx_changed_before_resume")
    require(fingerprint(SNIPPET) == state["snippet_sha256"]
            and fingerprint(UNIT) == state["unit_sha256"], "resume_routes_or_unit_changed")
    assert_current(state)
    checked_candidate(state)
    return stopped_reader_identity()


def reader_checks():
    code, _, body = request("http://127.0.0.1:3111/health")
    data = json.loads(body)
    require(code == 200 and data.get("ok") is True and data.get("service") == SERVICE
            and data.get("read_only") is True, "reader_health_not_readonly")
    for headers in (None, {"X-Admin-Token": "invalid", "X-Role": "admin"}):
        code, _, _ = request("http://127.0.0.1:3111" + API, headers=headers)
        require(code == 401, "reader_admin_session_not_required")


def assert_verify_targets(state):
    assert_release(state)
    require(fingerprint(SITE) == state["candidate_site_sha256"], "nginx_site_changed")
    require(fingerprint(SNIPPET) == state["snippet_sha256"] and fingerprint(UNIT) == state["unit_sha256"],
            "new_routes_or_unit_changed")
    identity = service_identity(SERVICE)
    require(identity.get("FragmentPath") == str(UNIT), "reader_loaded_wrong_unit")
    assert_current(state)


def verify_public_routes(state, deadline):
    def probe(path, method="GET", headers=None):
        remaining = deadline - time.monotonic()
        require(remaining > 0, "public_routes_readiness_timeout")
        return request(PUBLIC + path, method=method, headers=headers, timeout=min(2, remaining))

    for path in ("/", "/index.html"):
        code, headers, body = probe(path, headers={"Accept": "text/html", "Cache-Control": "no-cache"})
        headers = {key.lower(): value for key, value in headers.items()}
        require(code == 200 and sha(body) == state["release_manifest"]["ui/index.html"], "ui_index_mismatch")
        require("no-store" in headers.get("cache-control", "")
                and headers.get("x-frame-options") == "DENY"
                and headers.get("x-content-type-options") == "nosniff"
                and headers.get("referrer-policy") == "no-referrer"
                and "frame-ancestors 'none'" in headers.get("content-security-policy", "")
                and headers.get("strict-transport-security", "").startswith("max-age="), "ui_security_headers_missing")
    prefix = "/platform-admin-ui/" + state["release_id"] + "/"
    for path in state["asset_urls"]:
        code, _, body = probe(path)
        require(code == 200 and sha(body) == state["release_manifest"]["ui/" + path.removeprefix(prefix)],
                "ui_asset_mismatch")
    code, _, _ = probe(API)
    require(code not in {404, 502, 503}, "public_route_not_ready")
    require(code == 401, "public_admin_session_not_required")
    code, _, _ = probe(API, method="POST")
    require(code not in {401, 403, 404, 502, 503}, "public_route_not_ready")
    require(code == 405, "readonly_method_not_enforced")


def wait_for_public_routes(state):
    # A successful reload signal precedes the new workers accepting requests.
    # Only readiness failures are retried; changed files/old identities or a
    # security/authentication failure stop immediately. Every attempt rehashes.
    deadline = time.monotonic() + 20
    for attempt in range(8):
        assert_verify_targets(state)
        try:
            verify_public_routes(state, deadline)
            return
        except DeployError as error:
            if str(error) not in {"ui_index_mismatch", "ui_asset_mismatch", "public_route_not_ready"}:
                raise
            failure = error
        except OSError as error:
            failure = error
        remaining = deadline - time.monotonic()
        if attempt == 7 or remaining <= 0:
            raise failure
        emit("waiting_for_new_routes", attempt=attempt + 1, maximum_attempts=8)
        time.sleep(min(0.5, remaining))


def verify():
    state = load()
    require(state["status"] in {"installing", "installed"}, "reader_not_installed")
    assert_verify_targets(state)
    reader_checks()
    old_health()
    wait_for_public_routes(state)
    code, _, body = request(PUBLIC + "/api/session")
    require(code == 200 and json.loads(body).get("data", {}).get("authenticated") is False,
            "original_anonymous_session_changed")
    old_health()
    assert_old(state)
    emit("verified", old_services_unchanged=True, ui_security_headers=True,
         anonymous_denied=True, reader_readonly=True)


def rollback():
    state = load()
    require(state["status"] in {"installing", "installed", "rollback_required"}, "rollback_state_invalid")
    assert_release(state)
    current = fingerprint(SITE)
    require(current in {state["original_site_sha256"], state["candidate_site_sha256"]},
            "rollback_blocked_concurrent_nginx_change")
    if SNIPPET.exists():
        require(fingerprint(SNIPPET) == state["snippet_sha256"], "rollback_new_snippet_changed")
    if current == state["candidate_site_sha256"]:
        original = exact(Path(state["backup"]) / "nginx.original")
        require(sha(original.encode()) == state["original_site_sha256"], "rollback_backup_changed")
        atomic(SITE, original, state["site_mode"])
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
    run(["systemctl", "stop", SERVICE])
    run(["systemctl", "disable", SERVICE])
    old_health()
    assert_old(state)
    state["status"] = "rolled_back"
    save(state)
    emit("rolled_back", old_services_unchanged=True, files_preserved=True, database_restored=False)


def install():
    state = load()
    require(state["status"] == "prepared", "not_prepared")
    assert_release(state)
    require(fingerprint(SITE) == state["original_site_sha256"], "nginx_changed_before_install")
    for path in (ROOT / "current", UNIT, SNIPPET):
        require(not path.exists() and not path.is_symlink(), "new_install_target_changed")
    port_free()
    old_health()
    activate(state, reuse=False)


def resume(args):
    state = load()
    require(state["status"] == "rolled_back", "resume_requires_rolled_back")
    require(re.fullmatch(r"[a-f0-9]{64}", args.previous_script_sha256)
            and state["script_sha256"] == args.previous_script_sha256, "previous_deploy_script_mismatch")
    # The explicit reviewed previous hash permits a script-only migration.
    # All retained files and stopped unit identity must still match first.
    assert_release_contents(state)
    identity = assert_resume_targets(state)
    port_free()
    old_health()
    assert_release_contents(state)
    require(assert_resume_targets(state) == identity, "stopped_reader_identity_changed")
    state["resume_previous_script_sha256"] = state["script_sha256"]
    state["resume_stopped_reader_identity"] = identity
    state["script_sha256"] = sha(SCRIPT.read_bytes())
    save(state)
    activate(state, reuse=True)


def activate(state, *, reuse):
    assert_release(state)
    if reuse:
        require(assert_resume_targets(state) == state["resume_stopped_reader_identity"],
                "stopped_reader_identity_changed")
    backup = Path(state["backup"])
    candidate = checked_candidate(state)
    state["status"] = "installing"
    save(state)
    try:
        if not reuse:
            os.symlink(ROOT / "releases" / state["release_id"], ROOT / "current")
            write_new(UNIT, exact(backup / "new-unit.service"), 0o644)
        run(["systemd-analyze", "verify", str(UNIT)])
        if not reuse:
            run(["systemctl", "daemon-reload"])
        else:
            require(assert_resume_targets(state) == state["resume_stopped_reader_identity"],
                    "stopped_reader_identity_changed")
        run(["systemctl", "enable", "--now", SERVICE])
        # Retry bounded startup without touching either existing service.
        for attempt in range(8):
            try:
                reader_checks()
                break
            except (OSError, ValueError, DeployError):
                if attempt == 7:
                    raise
                time.sleep(0.5)
        assert_old(state)
        require(fingerprint(SITE) == state["original_site_sha256"], "nginx_changed_before_route")
        if not reuse:
            write_new(SNIPPET, exact(backup / "new-snippet.conf"), 0o644)
        else:
            require(fingerprint(SNIPPET) == state["snippet_sha256"], "resume_snippet_changed_before_route")
        atomic(SITE, candidate, state["site_mode"])
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
        verify()
        state["status"] = "installed"
        save(state)
        emit("installed", only_new_service_started=True, old_services_restarted=False, databases_changed=False)
    except BaseException:
        try:
            rollback()
        except BaseException:
            state["status"] = "rollback_required"
            save(state)
            emit("rollback_required", no_old_service_restart_attempted=True)
        raise


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="action", required=True)
    prepare_parser = commands.add_parser("prepare")
    for name in ("artifact", "sha256", "release-id", "nginx-sha256", "partner-snippet-sha256"):
        prepare_parser.add_argument("--" + name, required=True)
    for name in ("install", "verify", "rollback"):
        commands.add_parser(name)
    resume_parser = commands.add_parser("resume")
    resume_parser.add_argument("--previous-script-sha256", required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "root_required")
    import fcntl
    with Path("/run/lock/x-platform-orders-deploy.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if args.action == "prepare":
                prepare(args)
            elif args.action == "resume":
                resume(args)
            else:
                {"install": install, "verify": verify, "rollback": rollback}[args.action]()
        except Exception as error:
            emit("failed", error_type=type(error).__name__,
                 code=str(error) if isinstance(error, DeployError) else "inspect_privately_on_server")
            raise SystemExit(1)


if __name__ == "__main__":
    main()
