"""First deployment of the isolated X partner gateway; no original-service restart."""
from __future__ import annotations
import argparse
import base64
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

BUNDLE = Path(__file__).resolve().parent
ROOT = Path("/opt/x-partner-gateway")
DATA = Path("/srv/x-partner-gateway")
CONFIG = Path("/etc/x-partner-gateway")
STATE = ROOT / "deploy-state.json"
SITE = Path("/etc/nginx/sites-available/xgift")
ROUTES = Path("/etc/nginx/snippets/x-partner-gateway.conf")
UNIT = Path("/etc/systemd/system/x-partner-gateway.service")
NODE = "/opt/node/bin/node"
SERVICE = "x-partner-gateway"
DATABASE = DATA / "data/merchant-gateway.sqlite"
SALES_GATE = DATA / "control/sales.enabled"
WORKER_GATE = DATA / "control/workers.enabled"
SOURCE_ENV = Path("/etc/xgift/service.env")
MERCHANT_ENV = Path("/etc/xgift/integrations/aijd-x-api.env")
PUBLIC_BASE = "https://api.quefa.cn/bluev"
DIRECT_BASE = "https://x.aifu.me/partner"
PACKAGE_FILES = {"package.json", "package-lock.json"}
BUNDLE_FILES = ("deploy-gateway.py", "configure-env.mjs", "nginx-partner.conf",
                "x-partner-gateway.service", "products.json")
REVIEWED_CRLF_RAW_SHA = "66b2fada568a7a2a63d111ac0f88ef99055642c799fc5ee589e54f4c44d67a45"
REVIEWED_CRLF_NORMALIZED_SHA = "060b85f1b35c62e6a2c1236e036dea06919ce573d9fef6182748631c1d85380b"
REVIEWED_CRLF_COUNT = 26


class DeploymentError(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise DeploymentError(code)


def emit(event, **data):
    print(json.dumps(dict(event=event, **data), ensure_ascii=False), flush=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(args, *, timeout=45, cwd=None, input_text=None):
    environment = dict(os.environ)
    environment["PATH"] = "/opt/node/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    result = subprocess.run(args, capture_output=True, text=True, input=input_text,
                            cwd=cwd, timeout=timeout, env=environment)
    # Do not echo process output: it may include credentials or server configuration.
    require(result.returncode == 0, "command_failed:" + Path(args[0]).name)
    return result.stdout


def file_sha(path):
    return sha(path.read_bytes())


def read_exact(path):
    # Path.read_text performs universal-newline normalization; Nginx baselines
    # and rollback copies must retain the original bytes, including CRLF.
    return path.read_bytes().decode("utf-8")


def atomic_write(path, text, mode=0o600, uid=None, gid=None):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent,
                                         prefix="." + path.name + ".", delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, mode)
            if uid is not None:
                os.chown(temporary, uid, gid)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def write_new(path, text, mode=0o600, uid=None, gid=None):
    with path.open("x", encoding="utf-8", newline="") as handle:
        os.chmod(path, mode)
        if uid is not None:
            os.chown(path, uid, gid)
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())


def save_state(state):
    atomic_write(STATE, json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def service_identity(name):
    output = run(["systemctl", "show", name, "-p", "MainPID", "-p", "ExecMainStartTimestamp",
                  "-p", "ActiveState", "-p", "FragmentPath"])
    fields = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    require(fields.get("ActiveState") == "active" and fields.get("MainPID", "0") != "0",
            "service_not_active:" + name)
    return fields


def original_identity():
    return dict(xgift=service_identity("xgift"), nginx=service_identity("nginx"),
                xgift_current=str(Path("/opt/xgift/current").resolve(strict=True)))


def assert_original_unchanged(state):
    require(original_identity() == state["original_services"], "original_service_identity_changed")


def check_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 3110))


def request(url, method="GET", body=None, headers=None):
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            return response.status, response.read(64 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, error.read(64 * 1024)


def old_health():
    status, _ = request("http://127.0.0.1:8791/healthz", headers={"Host": "x.aifu.me"})
    require(status == 200, "original_xgift_health_failed")
    status, _ = request("https://x.aifu.me/healthz")
    require(status == 200, "original_public_health_failed")


def gateway_health():
    deadline = time.monotonic() + 40
    while True:
        try:
            status, body = request("http://127.0.0.1:3110/health")
            require(status == 200 and json.loads(body).get("service") == "merchant-gateway",
                    "gateway_health_failed")
            return
        except (DeploymentError, OSError, ValueError):
            if time.monotonic() >= deadline:
                raise DeploymentError("gateway_start_timeout")
            time.sleep(1)


def candidate_site(original):
    require("/partner" not in original and str(ROUTES) not in original, "partner_route_already_present")
    require("x.aifu.me" in original and re.search(r"listen\s+443\b", original),
            "unexpected_nginx_site")
    require(original.count("proxy_pass http://127.0.0.1:8791;") == 1,
            "original_xgift_proxy_ambiguous")
    pattern = re.compile(r"^(?P<indent>[ \t]*)location[ \t]+/[ \t]*\{[ \t]*\r?$", re.MULTILINE)
    matches = list(pattern.finditer(original))
    require(len(matches) == 1, "nginx_default_location_ambiguous")
    match = matches[0]
    newline = "\r\n" if match.group(0).endswith("\r") else "\n"
    insertion = match.group("indent") + "include " + str(ROUTES) + ";" + newline + newline
    return original[:match.start()] + insertion + original[match.start():]


def check_protected_file(path):
    stat = path.lstat()
    require(path.is_file() and not path.is_symlink() and stat.st_uid == 0
            and stat.st_mode & 0o077 == 0, "unsafe_credential_file_permissions")


def bundle_hashes():
    return {name: file_sha(BUNDLE / name) for name in BUNDLE_FILES}


def checked_members(archive):
    members = archive.getmembers()
    seen = set()
    total = 0
    for member in members:
        name = member.name.removeprefix("./").rstrip("/")
        path = PurePosixPath(name)
        require(name and not path.is_absolute() and ".." not in path.parts
                and "\\" not in name and path.as_posix() == name
                and name not in seen, "unsafe_or_duplicate_archive_path")
        seen.add(name)
        require(not member.issym() and not member.islnk() and (member.isfile() or member.isdir()),
                "archive_special_entry_forbidden")
        require(name in PACKAGE_FILES or path.parts[0] in {"dist", "config"},
                "archive_unexpected_entry")
        require(not any(part.startswith(".") for part in path.parts), "archive_hidden_entry")
        require(member.size >= 0, "archive_invalid_size")
        total += member.size
    require(len(members) <= 5000 and total <= 128 * 1024 * 1024, "archive_limits_exceeded")
    require(PACKAGE_FILES.issubset(seen) and "dist/server.js" in seen and "dist/config.js" in seen,
            "archive_runtime_incomplete")
    required = PACKAGE_FILES | {"dist/server.js", "dist/config.js"}
    require(all(member.isfile() for member in members
                if member.name.removeprefix("./").rstrip("/") in required),
            "archive_runtime_entry_not_file")
    return members


def extract_release(artifact, release):
    with tarfile.open(artifact, "r:*") as archive:
        members = checked_members(archive)
        release.mkdir(parents=True, mode=0o755)
        for member in members:
            name = member.name.removeprefix("./").rstrip("/")
            destination = release.joinpath(*PurePosixPath(name).parts)
            require(destination.resolve().is_relative_to(release.resolve()), "archive_escape")
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                stream = archive.extractfile(member)
                require(stream is not None, "archive_file_missing")
                with destination.open("xb") as output:
                    output.write(stream.read())
                os.chmod(destination, 0o644)


def code_manifest(release):
    selected = list((release / "dist").rglob("*")) + list((release / "config").rglob("*"))
    selected += [release / name for name in sorted(PACKAGE_FILES)]
    result = {}
    for path in selected:
        require(not path.is_symlink(), "release_code_symlink")
        if path.is_file():
            result[path.relative_to(release).as_posix()] = file_sha(path)
    return result


def create_service_user():
    import pwd
    try:
        user = pwd.getpwnam("xpartner")
        require(user.pw_shell in {"/usr/sbin/nologin", "/sbin/nologin", "/bin/false"}
                and user.pw_uid != 0, "existing_service_user_not_isolated")
    except KeyError:
        run(["useradd", "--system", "--user-group", "--no-create-home",
             "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "xpartner"])
        user = pwd.getpwnam("xpartner")
    return user.pw_uid, user.pw_gid


def verify_closed_database():
    require(not SALES_GATE.exists() and not WORKER_GATE.exists(), "gateway_gate_unexpectedly_open")
    with closing(sqlite3.connect(f"file:{DATABASE}?mode=ro", uri=True, timeout=10)) as database:
        require(database.execute("SELECT COUNT(*) FROM orders").fetchone()[0] == 0,
                "gateway_has_orders_requires_reconciliation")
        rows = database.execute("SELECT product,cost_price,enabled,plan FROM product_settings ORDER BY product").fetchall()
        require(rows == [("x_premium_3m", "22.00", 0, "x_premium_3m"),
                         ("x_premium_6m", "44.00", 0, "x_premium_6m")], "initial_catalog_mismatch")


def prepare(args):
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{5,63}", args.release_id), "invalid_release_id")
    artifact = Path(args.artifact)
    require(artifact.is_absolute() and artifact.is_file() and not artifact.is_symlink(),
            "invalid_artifact")
    require(re.fullmatch(r"[0-9a-f]{64}", args.sha256) and file_sha(artifact) == args.sha256,
            "artifact_hash_mismatch")
    if args.platform_webhook_url:
        parsed = urlsplit(args.platform_webhook_url)
        require(parsed.scheme == "https" and parsed.hostname and not parsed.username
                and not parsed.password and not parsed.fragment, "invalid_platform_callback")
    for path in (ROOT, DATA, CONFIG, UNIT, ROUTES):
        require(not path.exists() and not path.is_symlink(), "first_install_target_exists:" + str(path))
    require(re.match(r"v2[4-9]\.", run([NODE, "--version"]).strip()), "node24_required")
    require(SITE.is_file() and not SITE.is_symlink(), "nginx_site_not_regular")
    original = read_exact(SITE)
    candidate = candidate_site(original)
    baseline = original_identity()
    old_health()
    check_port()
    check_protected_file(SOURCE_ENV)
    check_protected_file(MERCHANT_ENV)
    # Preflight tar integrity before creating any persistent deployment targets.
    with tarfile.open(artifact, "r:*") as archive:
        checked_members(archive)
    backup = Path("/opt/backups") / ("x-partner-gateway-" + args.release_id)
    require(not backup.exists(), "backup_target_exists")
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup, 0o700)
    write_new(backup / "nginx-xgift.conf", original)
    write_new(backup / "original-state.json", json.dumps(baseline) + "\n")
    ROOT.mkdir(mode=0o755)
    release = ROOT / "releases" / args.release_id
    state = dict(status="preparing", release_id=args.release_id, release=str(release), backup=str(backup),
                 artifact_sha256=args.sha256, bundle_hashes=bundle_hashes(),
                 original_services=baseline, original_nginx_sha256=sha(original.encode()),
                 original_nginx_mode=SITE.stat().st_mode & 0o777, candidate_nginx_sha256=sha(candidate.encode()),
                 created_at=datetime.now(timezone.utc).isoformat())
    save_state(state)
    extract_release(artifact, release)
    compiled = "\n".join(path.read_text(encoding="utf-8") for path in (release / "dist").rglob("*.js"))
    require("PARTNER_SALES_GATE_FILE" in compiled and "QUEFA_WORKER_GATE_FILE" in compiled,
            "artifact_missing_required_dynamic_sales_or_worker_gate")
    run(["/opt/node/bin/npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=release, timeout=240)
    require((release / "node_modules/fastify/package.json").exists(), "production_dependencies_missing")
    state["code_manifest"] = code_manifest(release)
    save_state(state)
    uid, gid = create_service_user()
    CONFIG.mkdir(mode=0o750)
    os.chown(CONFIG, 0, gid)
    for directory in (DATA, DATA / "data", DATA / "control"):
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chown(directory, uid, gid)
        os.chmod(directory, 0o700)
    write_new(CONFIG / "products.json", (BUNDLE / "products.json").read_text(encoding="utf-8"),
              mode=0o640, uid=0, gid=gid)
    output = run([NODE, "--experimental-strip-types", str(BUNDLE / "configure-env.mjs"),
                  args.platform_webhook_url], timeout=45)
    facts = json.loads(output)
    require(facts.get("configured") and facts.get("master_key_copied") is False,
            "gateway_config_not_confirmed")
    check_protected_file(CONFIG / "service.env")
    require(not SALES_GATE.exists() and not WORKER_GATE.exists(), "gateway_gate_already_open")
    write_new(backup / "nginx-candidate.conf", candidate)
    run(["systemd-analyze", "verify", str(BUNDLE / "x-partner-gateway.service")], timeout=30)
    assert_original_unchanged(state)
    require(file_sha(SITE) == state["original_nginx_sha256"], "nginx_changed_during_prepare")
    state.update(status="prepared", config_sha256=file_sha(CONFIG / "service.env"),
                 products_sha256=file_sha(CONFIG / "products.json"))
    save_state(state)
    emit("prepared", release=str(release), artifact_verified=True, independent_database=True,
         original_services_unchanged=True, keys_exported=False, sales_enabled=False, workers_enabled=False)


def load_state():
    return json.loads(STATE.read_text(encoding="utf-8"))


def reviewed_resume_site(state):
    require(state["status"] == "preparing", "resume_requires_preparing")
    require(SITE.is_file() and not SITE.is_symlink(), "nginx_site_not_regular")
    raw = SITE.read_bytes()
    require(sha(raw) == REVIEWED_CRLF_RAW_SHA and raw.count(b"\r\n") == REVIEWED_CRLF_COUNT,
            "resume_not_reviewed_crlf_site")
    normalized = raw.replace(b"\r\n", b"\n")
    require(sha(normalized) == REVIEWED_CRLF_NORMALIZED_SHA
            and state["original_nginx_sha256"] == REVIEWED_CRLF_NORMALIZED_SHA,
            "resume_normalized_baseline_mismatch")
    backup = Path(state["backup"])
    require((backup / "nginx-xgift.conf").read_bytes() == normalized,
            "resume_original_backup_changed")
    candidate = (backup / "nginx-candidate.conf").read_bytes()
    require(sha(candidate) == state["candidate_nginx_sha256"]
            and candidate == candidate_site(normalized.decode("utf-8")).encode(),
            "resume_candidate_backup_changed")
    require(json.loads(read_exact(backup / "original-state.json")) == state["original_services"],
            "resume_service_backup_changed")
    return raw.decode("utf-8")


def verify_resume_configuration(args):
    env_path = CONFIG / "service.env"
    metadata_path = CONFIG / "bootstrap-metadata.json"
    check_protected_file(env_path)
    check_protected_file(metadata_path)
    require(file_sha(env_path) == args.config_sha256, "resume_configuration_changed")
    require(file_sha(metadata_path) == args.metadata_sha256, "resume_metadata_changed")
    expected = dict(alipayProduction=True, alipayFieldsComplete=True, independentSecretsGenerated=True,
                    masterKeyCopied=False, partnerDestination="https://x.aifu.me",
                    canonicalBase=PUBLIC_BASE, productsEnabled=False, workersEnabled=False)
    require(json.loads(read_exact(metadata_path)) == expected, "resume_metadata_not_closed")
    values = {}
    for line in read_exact(env_path).splitlines():
        key, separator, value = line.partition("=")
        require(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in values,
                "resume_environment_format_invalid")
        values[key] = json.loads(value)
        require(isinstance(values[key], str), "resume_environment_format_invalid")
    required = dict(NODE_ENV="production", HOST="127.0.0.1", PORT="3110", PUBLIC_BASE_URL=PUBLIC_BASE,
                    DATABASE_PATH=str(DATABASE), PRODUCT_CATALOG_PATH=str(CONFIG / "products.json"),
                    PLATFORM_WEBHOOK_ENABLED="false", PAYMENT_PROVIDER="alipay", X_API_MODE="live",
                    X_API_BASE_URL="https://x.aifu.me", ALIPAY_NOTIFY_URL=PUBLIC_BASE + "/callbacks/alipay",
                    ALIPAY_GATEWAY="https://openapi.alipay.com/gateway.do", ZOVO_MODE="mock",
                    PARTNER_SALES_GATE_FILE=str(SALES_GATE), QUEFA_WORKER_GATE_FILE=str(WORKER_GATE))
    require(all(values.get(key) == value for key, value in required.items()) and "MASTER_KEY" not in values,
            "resume_environment_not_isolated")
    secrets = [values.get(key, "") for key in ("PLATFORM_API_KEY", "PLATFORM_WEBHOOK_SECRET", "ADMIN_TOKEN", "EMAIL_HMAC_KEY", "X_API_SECRET")]
    require(all(len(value) >= 32 for value in secrets) and len(set(secrets)) == len(secrets),
            "resume_independent_secrets_invalid")
    require(len(base64.b64decode(values.get("SESSION_ENCRYPTION_KEY", ""), validate=True)) == 32,
            "resume_session_key_invalid")
    require(values.get("ALIPAY_PRIVATE_KEY", "").startswith("-----BEGIN PRIVATE KEY-----")
            and values.get("ALIPAY_PUBLIC_KEY", "").startswith("-----BEGIN PUBLIC KEY-----"),
            "resume_payment_keys_not_normalized")
    require(file_sha(CONFIG / "products.json") == file_sha(BUNDLE / "products.json"),
            "resume_products_changed")


def verify_resume_artifact(state, artifact_path):
    artifact = Path(artifact_path)
    require(artifact.is_absolute() and artifact.is_file() and not artifact.is_symlink()
            and file_sha(artifact) == state["artifact_sha256"], "resume_original_artifact_changed")
    # The interrupted older prepare did not persist its in-memory code manifest.
    # Rebuild that evidence from the pinned original archive, never trust the
    # existing release merely because a prior hash record is missing.
    with tempfile.TemporaryDirectory(prefix="x-partner-resume-verify-") as temporary:
        reference = Path(temporary) / "reference"
        extract_release(artifact, reference)
        verified = code_manifest(reference)
    require(verified == code_manifest(Path(state["release"])), "resume_artifact_release_mismatch")
    if state.get("code_manifest"):
        require(verified == state["code_manifest"], "resume_recorded_code_manifest_changed")
    require((Path(state["release"]) / "node_modules/fastify/package.json").is_file(),
            "resume_dependencies_missing")
    run(["/opt/node/bin/npm", "ls", "--omit=dev", "--json"], cwd=Path(state["release"]), timeout=45)
    return verified


def resume_prepared(args):
    state = load_state()
    raw_original = reviewed_resume_site(state)
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{5,63}", state["release_id"]), "resume_release_id_invalid")
    require(Path(state["release"]) == ROOT / "releases" / state["release_id"]
            and Path(state["backup"]) == Path("/opt/backups") / ("x-partner-gateway-" + state["release_id"]),
            "resume_state_paths_unexpected")
    for value in (args.previous_script_sha256, args.config_sha256, args.metadata_sha256):
        require(re.fullmatch(r"[a-f0-9]{64}", value), "resume_expected_hash_invalid")
    current_bundle = bundle_hashes()
    old_bundle = state["bundle_hashes"]
    require(set(old_bundle) == set(current_bundle)
            and old_bundle["deploy-gateway.py"] == args.previous_script_sha256
            and all(current_bundle[name] == old_bundle[name] for name in BUNDLE_FILES if name != "deploy-gateway.py"),
            "resume_unreviewed_bundle_change")
    verified_manifest = verify_resume_artifact(state, args.artifact)
    for path in (DATABASE, ROOT / "current", UNIT, ROUTES, SALES_GATE, WORKER_GATE):
        require(not path.exists() and not path.is_symlink(), "resume_installation_or_sales_already_started")
    require(not list((DATA / "data").iterdir()), "resume_data_directory_not_empty")
    verify_resume_configuration(args)
    assert_original_unchanged(state)
    check_port()
    old_health()
    run(["systemd-analyze", "verify", str(BUNDLE / "x-partner-gateway.service")], timeout=30)
    # Recheck every mutable input immediately before creating new backups/state.
    require(reviewed_resume_site(state) == raw_original, "resume_nginx_concurrent_change")
    require(code_manifest(Path(state["release"])) == verified_manifest, "resume_code_concurrent_change")
    verify_resume_configuration(args)
    assert_original_unchanged(state)
    raw_candidate = candidate_site(raw_original)
    backup = Path(state["backup"])
    for name in ("nginx-xgift.raw.conf", "nginx-candidate.raw.conf"):
        require(not (backup / name).exists() and not (backup / name).is_symlink(), "resume_raw_backup_exists")
    write_new(backup / "nginx-xgift.raw.conf", raw_original)
    write_new(backup / "nginx-candidate.raw.conf", raw_candidate)
    state["crlf_recovery"] = dict(normalized_original_sha256=state["original_nginx_sha256"],
                                  normalized_candidate_sha256=state["candidate_nginx_sha256"],
                                  previous_script_sha256=args.previous_script_sha256)
    state.update(status="prepared", original_nginx_sha256=sha(raw_original.encode()),
                 candidate_nginx_sha256=sha(raw_candidate.encode()), bundle_hashes=current_bundle,
                 code_manifest=verified_manifest,
                 original_nginx_backup="nginx-xgift.raw.conf", candidate_nginx_backup="nginx-candidate.raw.conf",
                 config_sha256=args.config_sha256, products_sha256=file_sha(CONFIG / "products.json"))
    save_state(state)
    emit("prepared", recovered_reviewed_crlf=True, original_services_unchanged=True,
         normalized_backups_preserved=True, credentials_regenerated=False, sales_enabled=False, workers_enabled=False)


def assert_prepared(state):
    require(state["status"] == "prepared", "deployment_not_prepared")
    require(bundle_hashes() == state["bundle_hashes"], "bundle_changed_since_prepare")
    require(code_manifest(Path(state["release"])) == state["code_manifest"], "release_code_changed")
    require(file_sha(CONFIG / "service.env") == state["config_sha256"], "configuration_changed")
    require(file_sha(CONFIG / "products.json") == state["products_sha256"], "products_changed")
    require(not SALES_GATE.exists() and not WORKER_GATE.exists(), "gateway_gate_already_open")
    require(not DATABASE.exists(), "first_install_database_already_exists")
    require(file_sha(SITE) == state["original_nginx_sha256"], "nginx_changed_since_prepare")
    assert_original_unchanged(state)


def routing_checks(base):
    status, body = request(base + "/health")
    require(status == 200 and json.loads(body).get("service") == "merchant-gateway", "gateway_proxy_health_failed")
    status, _ = request(base + "/api/v1/checkout/products")
    require(status == 401, "checkout_auth_not_enforced")
    for path in ("/admin", "/admin/api/products", "/dev", "/internal/reports/orders.csv",
                 "/api/v1/checkout/../../admin", "/api/v1/checkout/%2e%2e/%2e%2e/admin"):
        status, _ = request(base + path)
        require(status == 404, "private_route_exposed")
    status, _ = request(base + "/payment-qr/nonexistent-order.png?token=invalid")
    require(status == 404, "qr_token_not_enforced")
    status, _ = request(base + "/callbacks/alipay", method="POST", body=b"out_trade_no=invalid-probe",
                        headers={"Content-Type": "application/x-www-form-urlencoded"})
    require(status == 400, "invalid_alipay_notice_not_rejected")


def verify(canonical=False):
    state = load_state()
    require(state["status"] in {"installing", "installed"}, "gateway_not_installed")
    require(bundle_hashes() == state["bundle_hashes"], "bundle_changed_after_install")
    require(code_manifest(Path(state["release"])) == state["code_manifest"], "release_code_changed")
    require(file_sha(CONFIG / "service.env") == state["config_sha256"], "configuration_changed")
    require(file_sha(CONFIG / "products.json") == state["products_sha256"], "products_changed")
    require(file_sha(UNIT) == state["bundle_hashes"]["x-partner-gateway.service"], "unit_changed")
    require(file_sha(ROUTES) == state["bundle_hashes"]["nginx-partner.conf"], "route_include_changed")
    require(file_sha(SITE) == state["candidate_nginx_sha256"], "nginx_candidate_changed")
    require((ROOT / "current").is_symlink()
            and (ROOT / "current").resolve() == Path(state["release"]), "gateway_current_changed")
    service_identity(SERVICE)
    gateway_health()
    verify_closed_database()
    run(["nginx", "-t"])
    routing_checks(DIRECT_BASE)
    if canonical:
        routing_checks(PUBLIC_BASE)
    assert_original_unchanged(state)
    old_health()
    emit("verified", canonical_verified=canonical, original_services_unchanged=True,
         sales_enabled=False, workers_enabled=False, private_routes_blocked=True)


def rollback_first_install(state):
    # An install cannot auto-rollback once someone has opened sales or created an order.
    if DATABASE.exists():
        verify_closed_database()
    require(not SALES_GATE.exists() and not WORKER_GATE.exists(), "rollback_blocked_gate_open")
    current_hash = file_sha(SITE)
    require(current_hash in {state["original_nginx_sha256"], state["candidate_nginx_sha256"]},
            "rollback_blocked_concurrent_nginx_change")
    run(["systemctl", "stop", SERVICE])
    run(["systemctl", "disable", SERVICE])
    if current_hash == state["candidate_nginx_sha256"]:
        original = read_exact(Path(state["backup"]) / state.get("original_nginx_backup", "nginx-xgift.conf"))
        require(sha(original.encode()) == state["original_nginx_sha256"], "rollback_backup_changed")
        atomic_write(SITE, original, state["original_nginx_mode"])
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
    assert_original_unchanged(state)
    old_health()
    state["status"] = "rolled_back"
    save_state(state)
    emit("rolled_back", original_services_unchanged=True, gateway_files_preserved=True, database_restored=False)


def install():
    state = load_state()
    assert_prepared(state)
    for path in (ROOT / "current", UNIT, ROUTES):
        require(not path.exists() and not path.is_symlink(), "install_target_changed")
    check_port()
    old_health()
    state["status"] = "installing"
    save_state(state)
    os.symlink(state["release"], ROOT / "current")
    atomic_write(UNIT, (BUNDLE / "x-partner-gateway.service").read_text(encoding="utf-8"), 0o644)
    try:
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "--now", SERVICE], timeout=60)
        gateway_health()
        verify_closed_database()
        assert_original_unchanged(state)
        require(file_sha(SITE) == state["original_nginx_sha256"], "nginx_changed_before_install")
        ROUTES.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        write_new(ROUTES, (BUNDLE / "nginx-partner.conf").read_text(encoding="utf-8"), 0o644)
        candidate = read_exact(Path(state["backup"]) / state.get("candidate_nginx_backup", "nginx-candidate.conf"))
        require(sha(candidate.encode()) == state["candidate_nginx_sha256"], "nginx_candidate_backup_changed")
        atomic_write(SITE, candidate, state["original_nginx_mode"])
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
        verify()
        state["status"] = "installed"
        save_state(state)
        emit("installed", canonical_base=PUBLIC_BASE, x_server_gateway=DIRECT_BASE,
             sales_enabled=False, workers_enabled=False, original_xgift_restarted=False)
    except BaseException:
        try:
            rollback_first_install(state)
        except BaseException as error:
            state["status"] = "rollback_requires_review"
            save_state(state)
            emit("rollback_requires_review", error_type=type(error).__name__, database_restored=False)
        raise


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    prepare_parser = sub.add_parser("prepare")
    prepare_parser.add_argument("--artifact", required=True)
    prepare_parser.add_argument("--sha256", required=True)
    prepare_parser.add_argument("--release-id", required=True)
    prepare_parser.add_argument("--platform-webhook-url", default="")
    sub.add_parser("install")
    resume = sub.add_parser("resume-prepared")
    resume.add_argument("--artifact", required=True)
    resume.add_argument("--previous-script-sha256", required=True)
    resume.add_argument("--config-sha256", required=True)
    resume.add_argument("--metadata-sha256", required=True)
    verification = sub.add_parser("verify")
    verification.add_argument("--canonical", action="store_true")
    args = parser.parse_args()
    require(os.geteuid() == 0, "root_required")
    import fcntl
    lock_path = Path("/run/lock/x-partner-gateway-deploy.lock")
    with lock_path.open("a") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if args.action == "prepare":
                prepare(args)
            elif args.action == "install":
                install()
            elif args.action == "resume-prepared":
                resume_prepared(args)
            else:
                verify(args.canonical)
        except Exception as error:
            emit("failed", error_type=type(error).__name__,
                 code=str(error) if isinstance(error, DeploymentError) else "inspect_server_privately")
            raise SystemExit(1)


if __name__ == "__main__":
    main()
