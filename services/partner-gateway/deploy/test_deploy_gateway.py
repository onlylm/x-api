"""Offline guard tests; no production network or privileged command is executed."""
import importlib.util
from contextlib import closing
import io
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy_gateway", Path(__file__).with_name("deploy-gateway.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

NGINX = '''server {
  listen 80;
  server_name x.aifu.me;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  server_name x.aifu.me;
  client_max_body_size 16k;
  location / {
    proxy_pass http://127.0.0.1:8791;
  }
}
'''
REQUIRED = ["package.json", "package-lock.json", "dist/server.js", "dist/config.js"]


def tar_entries(extra=(), omit=()):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        for name in REQUIRED:
            if name in omit:
                continue
            entry = tarfile.TarInfo(name)
            entry.size = 2
            archive.addfile(entry, io.BytesIO(b"{}"))
        for name, kind in extra:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.linkname = "../../etc/passwd" if kind in {tarfile.SYMTYPE, tarfile.LNKTYPE} else ""
            archive.addfile(entry)
    data.seek(0)
    return tarfile.open(fileobj=data, mode="r:")


class DeploymentGuards(unittest.TestCase):
    def test_inserts_only_include_preserving_original_bytes(self):
        candidate = deploy.candidate_site(NGINX)
        marker = "  include " + str(deploy.ROUTES) + ";\n\n"
        self.assertEqual(candidate.replace(marker, ""), NGINX)
        self.assertLess(candidate.index(marker), candidate.index("  location / {"))

    def test_rejects_duplicate_install(self):
        with self.assertRaisesRegex(deploy.DeploymentError, "already_present"):
            deploy.candidate_site(deploy.candidate_site(NGINX))

    def test_rejects_ambiguous_nginx_default(self):
        with self.assertRaisesRegex(deploy.DeploymentError, "ambiguous"):
            deploy.candidate_site(NGINX + "location / {\n}\n")

    def test_rejects_unexpected_original_proxy(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.candidate_site(NGINX.replace("8791", "3100"))

    def test_accepts_only_declared_artifact(self):
        with tar_entries() as archive:
            self.assertEqual(len(deploy.checked_members(archive)), 4)

    def test_rejects_archive_escape(self):
        for name in ("../escape", "/etc/passwd", "dist/../../escape", "dist\\evil"):
            with self.subTest(name=name), tar_entries([(name, tarfile.REGTYPE)]) as archive:
                with self.assertRaises(deploy.DeploymentError):
                    deploy.checked_members(archive)

    def test_rejects_archive_secrets_or_extra_trees(self):
        for name in (".env", "config/.env", "data/database.sqlite", "node_modules/x.js", "src/main.ts"):
            with self.subTest(name=name), tar_entries([(name, tarfile.REGTYPE)]) as archive:
                with self.assertRaises(deploy.DeploymentError):
                    deploy.checked_members(archive)

    def test_rejects_links_and_special_files(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind), tar_entries([("dist/extra", kind)]) as archive:
                with self.assertRaisesRegex(deploy.DeploymentError, "special_entry"):
                    deploy.checked_members(archive)

    def test_rejects_duplicate_and_ambiguous_paths(self):
        for name in ("dist/server.js", "./dist/server.js", "dist//other.js", "dist/./other.js"):
            with self.subTest(name=name), tar_entries([(name, tarfile.REGTYPE)]) as archive:
                with self.assertRaises(deploy.DeploymentError):
                    deploy.checked_members(archive)

    def test_rejects_incomplete_archive(self):
        with tar_entries(omit=["dist/config.js"]) as archive:
            with self.assertRaisesRegex(deploy.DeploymentError, "incomplete"):
                deploy.checked_members(archive)

    def test_required_entries_cannot_be_directories(self):
        with tar_entries([("dist/server.js", tarfile.DIRTYPE)], omit=["dist/server.js"]) as archive:
            with self.assertRaisesRegex(deploy.DeploymentError, "not_file"):
                deploy.checked_members(archive)

    def test_state_manifest_detects_source_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "dist").mkdir()
            (root / "dist/server.js").write_text("old")
            for name in deploy.PACKAGE_FILES:
                (root / name).write_text("{}")
            initial = deploy.code_manifest(root)
            (root / "dist/server.js").write_text("new")
            self.assertNotEqual(initial, deploy.code_manifest(root))

    def test_initial_database_requires_exact_disabled_products(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "gateway.sqlite"
            with closing(sqlite3.connect(database)) as connection:
                connection.executescript("CREATE TABLE orders(id TEXT); CREATE TABLE product_settings(product TEXT,cost_price TEXT,enabled INTEGER,plan TEXT);")
                connection.executemany("INSERT INTO product_settings VALUES(?,?,?,?)", [
                    ("x_premium_3m", "22.00", 0, "x_premium_3m"),
                    ("x_premium_6m", "44.00", 0, "x_premium_6m")])
                connection.commit()
            with patch.multiple(deploy, DATABASE=database, SALES_GATE=root / "sales", WORKER_GATE=root / "workers"):
                deploy.verify_closed_database()
                with closing(sqlite3.connect(database)) as connection:
                    connection.execute("UPDATE product_settings SET enabled=1 WHERE product='x_premium_3m'")
                    connection.commit()
                with self.assertRaisesRegex(deploy.DeploymentError, "catalog_mismatch"):
                    deploy.verify_closed_database()

    def test_open_gate_blocks_closed_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "sales").touch()
            with patch.multiple(deploy, SALES_GATE=root / "sales", WORKER_GATE=root / "workers"):
                with self.assertRaisesRegex(deploy.DeploymentError, "gate"):
                    deploy.verify_closed_database()

    def test_concurrent_nginx_change_blocks_rollback_without_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            site = root / "nginx"
            site.write_text("concurrently changed")
            with patch.multiple(deploy, SITE=site, DATABASE=root / "absent.sqlite", SALES_GATE=root / "sales", WORKER_GATE=root / "workers"), patch.object(deploy, "run") as run:
                with self.assertRaisesRegex(deploy.DeploymentError, "concurrent_nginx"):
                    deploy.rollback_first_install({"original_nginx_sha256": "old", "candidate_nginx_sha256": "new"})
                run.assert_not_called()

    def test_rollback_does_not_restore_database_or_restart_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            site = root / "nginx"
            site.write_text(NGINX)
            state = {"original_nginx_sha256": deploy.file_sha(site), "candidate_nginx_sha256": "unused"}
            with patch.multiple(deploy, SITE=site, DATABASE=root / "absent.sqlite", SALES_GATE=root / "sales", WORKER_GATE=root / "workers"), patch.object(deploy, "run") as run, patch.object(deploy, "assert_original_unchanged"), patch.object(deploy, "old_health"), patch.object(deploy, "save_state"), patch.object(deploy, "emit"):
                deploy.rollback_first_install(state)
                self.assertEqual(run.call_args_list[0].args[0], ["systemctl", "stop", "x-partner-gateway"])
                self.assertEqual(run.call_args_list[1].args[0], ["systemctl", "disable", "x-partner-gateway"])
                self.assertEqual(run.call_count, 2)
                self.assertEqual(state["status"], "rolled_back")

    def test_routes_do_not_expose_admin_or_dev(self):
        routes = (deploy.BUNDLE / "nginx-partner.conf").read_text()
        self.assertIn("location /partner/ { return 404; }", routes)
        self.assertNotIn("/admin", routes)
        self.assertNotIn("/dev", routes)
        self.assertIn("X-Forwarded-For $remote_addr", routes)

    def test_credentials_remain_server_only_and_gates_closed(self):
        code = (deploy.BUNDLE / "configure-env.mjs").read_text()
        values = code.split("const values = {", 1)[1].split("\n  };", 1)[0]
        self.assertNotIn("MASTER_KEY", values)
        self.assertIn("PLATFORM_WEBHOOK_ENABLED: 'false'", values)
        self.assertIn("https://api.quefa.cn/bluev", values)
        self.assertIn("mode: 0o600, flag: 'wx'", code)


if __name__ == "__main__":
    unittest.main()
