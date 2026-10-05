"""Offline tests for the standalone platform orders release. No remote access."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("platform_deploy", Path(__file__).with_name("platform-orders-deploy.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
REVISION = "a" * 40
ORIGINAL = """server {
    listen 80;
    server_name x.aifu.me;
    location / { return 301 https://x.aifu.me$request_uri; }
}
server {
    listen 443 ssl;
    server_name x.aifu.me;
    include /etc/nginx/snippets/x-partner-gateway.conf;
    location / {
        proxy_set_header Host x.aifu.me;
        proxy_pass http://127.0.0.1:8791;
    }
}
"""
REQUIRED = ["package.json", "dist/platform-orders-reader.js", "ui/index.html"]


def archive(extra=()):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as stream:
        for name in REQUIRED:
            info = tarfile.TarInfo(name)
            info.size = 2
            stream.addfile(info, io.BytesIO(b"{}"))
        for name, kind in extra:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.linkname = "/etc/xgift/service.env" if kind in {tarfile.SYMTYPE, tarfile.LNKTYPE} else ""
            stream.addfile(info)
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode="r:")


class IndependentReleaseTests(unittest.TestCase):
    def test_unused_service_name_accepts_only_explicit_missing_load_state(self):
        with patch.object(deploy.subprocess, "run", return_value=SimpleNamespace(stdout="LoadState=not-found\n", returncode=4)):
            deploy.require_unused_service_name()
        with patch.object(deploy.subprocess, "run", return_value=SimpleNamespace(stdout="LoadState=loaded\n", returncode=0)):
            with self.assertRaisesRegex(deploy.DeployError, "already_in_use"):
                deploy.require_unused_service_name()

    def test_includes_only_new_snippet_preserving_old_nginx_routes(self):
        candidate = deploy.candidate_site(ORIGINAL)
        inserted = "    include " + deploy.SNIPPET.as_posix() + ";\n\n"
        self.assertEqual(candidate.replace(inserted, ""), ORIGINAL)
        self.assertEqual(candidate.count("include /etc/nginx/snippets/x-partner-gateway.conf;"), 1)
        self.assertEqual(candidate.count("proxy_pass http://127.0.0.1:8791;"), 1)

    def test_crlf_site_and_backup_preserve_bytes(self):
        original = ORIGINAL.replace("\n", "\r\n")
        candidate = deploy.candidate_site(original)
        self.assertNotIn("\n", candidate.replace("\r\n", ""))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "site"
            deploy.write_new(path, original)
            self.assertEqual(path.read_bytes(), original.encode())
            deploy.atomic(path, candidate)
            self.assertEqual(deploy.exact(path), candidate)

    def test_rejects_existing_exact_root_or_platform_routes(self):
        for addition in ("location = / {\n}\n", "location = /index.html {\n}\n",
                         "location = /api/admin/platform-orders {\n}\n"):
            with self.subTest(addition=addition), self.assertRaises(deploy.DeployError):
                deploy.candidate_site(ORIGINAL + addition)

    def test_requires_original_partner_include(self):
        with self.assertRaisesRegex(deploy.DeployError, "partner_include"):
            deploy.candidate_site(ORIGINAL.replace("include /etc/nginx/snippets/x-partner-gateway.conf;", ""))

    def test_no_old_routes_or_legacy_assets_are_shadowed(self):
        snippet = deploy.snippet(REVISION)
        self.assertIn("location = / {", snippet)
        self.assertIn("location = /index.html {", snippet)
        self.assertIn("location = /api/admin/platform-orders {", snippet)
        self.assertIn("location ^~ /platform-admin-ui/" + REVISION + "/", snippet)
        for unwanted in ("location / {", "location /api/", "location /v1/", "location /assets/",
                         "location /redeem", "location /partner"):
            self.assertNotIn(unwanted, snippet)

    def test_static_security_headers_and_cache_boundary(self):
        snippet = deploy.snippet(REVISION)
        for expected in ("frame-ancestors 'none'", "X-Frame-Options", "X-Content-Type-Options",
                         "Referrer-Policy", "Strict-Transport-Security"):
            self.assertIn(expected, snippet)
        self.assertEqual(snippet.count('Cache-Control "no-store"'), 3)
        self.assertEqual(snippet.count('Cache-Control "public, max-age=31536000, immutable"'), 1)
        self.assertIn("if ($request_method != GET) { return 405; }", snippet)
        self.assertIn("proxy_pass_request_body off;", snippet)

    def test_unit_runs_only_readonly_new_service_and_hides_original_secrets(self):
        unit = deploy.unit_text()
        self.assertIn("User=xpartner", unit)
        self.assertIn("dist/platform-orders-reader.js", unit)
        self.assertIn("ReadOnlyPaths=/srv/x-partner-gateway", unit)
        self.assertIn("InaccessiblePaths=/etc/xgift /srv/xgift /etc/x-partner-gateway", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertNotIn("ReadWritePaths=", unit)
        self.assertNotIn("ExecStartPost", unit)

    def test_new_environment_contains_only_required_nonsecret_values(self):
        values = dict(line.split("=", 1) for line in deploy.env_text().splitlines())
        self.assertEqual(set(values), {"NODE_ENV", "HOST", "PORT", "PLATFORM_ORDERS_DB_PATH",
                                      "X_ADMIN_SESSION_URL", "X_ADMIN_HOST"})
        self.assertEqual(values["PORT"], "3111")
        self.assertEqual(values["HOST"], "127.0.0.1")
        self.assertEqual(values["X_ADMIN_SESSION_URL"], "http://127.0.0.1:8791/api/session")
        self.assertNotIn("MASTER_KEY", deploy.env_text())

    def test_accepts_minimal_artifact(self):
        with archive() as stream:
            self.assertEqual(len(deploy.validate_archive(stream)), 3)

    def test_rejects_artifact_path_escapes_and_hidden_files(self):
        for name in ("../outside", "/etc/passwd", "ui/../../escape", "ui\\.env",
                     "ui/.env", "dist/.secret", "node_modules/package.json", "data/db.sqlite"):
            with self.subTest(name=name), archive([(name, tarfile.REGTYPE)]) as stream:
                with self.assertRaises(deploy.DeployError):
                    deploy.validate_archive(stream)

    def test_rejects_symlinks_and_special_archive_entries(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind), archive([("ui/extra.js", kind)]) as stream:
                with self.assertRaisesRegex(deploy.DeployError, "special_entry"):
                    deploy.validate_archive(stream)

    def test_rejects_duplicate_and_noncanonical_archive_entries(self):
        for name in ("ui/index.html", "./ui/index.html", "dist//duplicate.js", "dist/./duplicate.js"):
            with self.subTest(name=name), archive([(name, tarfile.REGTYPE)]) as stream:
                with self.assertRaises(deploy.DeployError):
                    deploy.validate_archive(stream)

    def test_validates_built_ui_prefix_and_presence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "ui/assets"
            assets.mkdir(parents=True)
            (assets / "app.js").write_text("void 0")
            (assets / "app.css").write_text("body{}")
            prefix = "/platform-admin-ui/" + REVISION + "/"
            (root / "ui/index.html").write_text('<script src="' + prefix + 'assets/app.js"></script><link rel="stylesheet" href="' + prefix + 'assets/app.css">')
            self.assertEqual(len(deploy.validate_ui(root, REVISION)), 2)
            (root / "ui/index.html").write_text('<script src="/assets/app.js"></script>')
            with self.assertRaisesRegex(deploy.DeployError, "base_mismatch"):
                deploy.validate_ui(root, REVISION)

    def test_inline_script_is_rejected(self):
        parser = deploy.AssetReferences()
        with self.assertRaisesRegex(deploy.DeployError, "inline_script"):
            parser.feed("<script>window.token='unsafe'</script>")

    def test_existing_instance_identity_change_fails_closed(self):
        with patch.object(deploy, "old_baseline", return_value={"changed": True}):
            with self.assertRaisesRegex(deploy.DeployError, "original_service"):
                deploy.assert_old({"old_baseline": {"changed": False}})

    def test_reader_health_requires_explicit_readonly_true(self):
        for payload in ({"ok": True, "service": "x-platform-orders", "read_only": False},
                        {"ok": True, "service": "merchant-gateway", "read_only": True}):
            with self.subTest(payload=payload), patch.object(deploy, "request", return_value=(200, {}, json.dumps(payload).encode())):
                with self.assertRaisesRegex(deploy.DeployError, "not_readonly"):
                    deploy.reader_checks()

    def test_reader_must_reject_anonymous_and_forged_admin_headers(self):
        health = (200, {}, b'{"ok":true,"service":"x-platform-orders","read_only":true}')
        with patch.object(deploy, "request", side_effect=[health, (401, {}, b""), (200, {}, b"")]):
            with self.assertRaisesRegex(deploy.DeployError, "admin_session"):
                deploy.reader_checks()

    def test_rollback_refuses_concurrent_nginx_change_before_commands(self):
        state = {"status": "installed", "original_site_sha256": "old", "candidate_site_sha256": "new"}
        with patch.object(deploy, "load", return_value=state), patch.object(deploy, "assert_release"), patch.object(deploy, "fingerprint", return_value="concurrent"), patch.object(deploy, "run") as run:
            with self.assertRaisesRegex(deploy.DeployError, "concurrent_nginx"):
                deploy.rollback()
            run.assert_not_called()

    def test_rollback_stops_only_new_service_and_never_restores_database(self):
        state = {"status": "installed", "original_site_sha256": "old", "candidate_site_sha256": "new"}
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(deploy, "load", return_value=state), patch.object(deploy, "assert_release"), patch.object(deploy, "fingerprint", return_value="old"), patch.object(deploy, "SNIPPET", Path(directory) / "absent"), patch.object(deploy, "run") as run, patch.object(deploy, "old_health"), patch.object(deploy, "assert_old"), patch.object(deploy, "save"), patch.object(deploy, "emit"):
                deploy.rollback()
                self.assertEqual([call.args[0] for call in run.call_args_list],
                                 [["systemctl", "stop", "x-platform-orders"], ["systemctl", "disable", "x-platform-orders"]])
                self.assertEqual(state["status"], "rolled_back")

    def test_no_database_or_package_install_commands_in_deployer(self):
        source = deploy.SCRIPT.read_text()
        self.assertNotIn("import sqlite3", source)
        self.assertNotIn("npm", source)
        self.assertNotIn('["systemctl", "restart", "xgift"]', source)
        self.assertNotIn('["systemctl", "restart", "x-partner-gateway"]', source)
        self.assertNotIn("createAlipayClient", source)


if __name__ == "__main__":
    unittest.main()
