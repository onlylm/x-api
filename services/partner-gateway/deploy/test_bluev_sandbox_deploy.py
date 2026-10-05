"""Offline only: proxy preservation, deployment isolation and rollback evidence."""
import importlib.util
import io
import json
from pathlib import Path
import re
import sqlite3
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bluev_deploy_common as common

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

x = module('sandbox_deploy', 'deploy-bluev-sandbox.py')
q = module('console_deploy', 'deploy-bluev-test-console.py')
REVISION = 'a' * 40
NGINX = '''server {
    listen 80;
    location / { return 301 https://x.aifu.me$request_uri; }
}
server {
    server_name x.aifu.me;
    include /etc/nginx/snippets/x-partner-gateway.conf;
    include /etc/nginx/snippets/x-platform-orders.conf;
    location / {
        proxy_pass http://127.0.0.1:8791;
    }
}
'''
CADDY = '''api.quefa.cn {
  encode gzip
  route {
    # BEGIN isolated-bluev-relay
    handle /bluev/* {
      route {
        uri strip_prefix /bluev
        rewrite * /partner{uri}
        reverse_proxy https://x.aifu.me {
          header_up Host x.aifu.me
        }
      }
    }
    # END isolated-bluev-relay

    handle /admin/api/* { reverse_proxy app_finance:3100 }
    handle { reverse_proxy app:3100 }
  }
}
'''

def archive(extra=()):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as stream:
        for name in x.REQUIRED:
            member = tarfile.TarInfo(name)
            member.size = 2
            stream.addfile(member, io.BytesIO(b'{}'))
        for name, kind in extra:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = '/etc/xgift/service.env'
            stream.addfile(member)
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode='r:')

class CommonTests(unittest.TestCase):
    def test_archive_accepts_only_explicit_runtime_layout(self):
        with archive() as value:
            self.assertEqual(len(common.archive_members(value, x.REQUIRED)), 3)

    def test_archive_rejects_traversal_hidden_secrets_duplicates_and_modules(self):
        for name in ('../escape', '/etc/passwd', 'dist/../../escape', 'dist\\secret.js',
                     'dist/.env', 'node_modules/a.js', 'service.env', 'data/db.sqlite', 'dist//bad.js',
                     'dist/./bad.js', 'package.json', './package.json'):
            with self.subTest(name=name), archive([(name, tarfile.REGTYPE)]) as value:
                with self.assertRaises(common.DeployError):
                    common.archive_members(value, x.REQUIRED)

    def test_archive_rejects_links_and_devices(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind), archive([('dist/special.js', kind)]) as value:
                with self.assertRaises(common.DeployError):
                    common.archive_members(value, x.REQUIRED)

    def test_new_and_atomic_writes_preserve_crlf_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture'
            common.write_new(path, NGINX.replace('\n', '\r\n'))
            self.assertEqual(path.read_bytes(), NGINX.replace('\n', '\r\n').encode())
            common.atomic(path, CADDY.replace('\n', '\r\n'))
            self.assertEqual(path.read_bytes(), CADDY.replace('\n', '\r\n').encode())

    def test_readiness_guard_failure_never_retries(self):
        calls = []
        def guard():
            raise common.DeployError('changed')
        with patch.object(common.time, 'sleep') as sleep:
            with self.assertRaisesRegex(common.DeployError, 'changed'):
                common.wait_ready(lambda: calls.append(1), guard)
            sleep.assert_not_called()
        self.assertEqual(calls, [])

    def test_readiness_is_bounded_and_rechecks_baseline(self):
        from unittest.mock import Mock
        check = Mock(side_effect=[OSError(), common.DeployError('warming'), None])
        guard = Mock()
        with patch.object(common.time, 'sleep'):
            common.wait_ready(check, guard, attempts=3)
        self.assertEqual(guard.call_count, 3)
        with patch.object(common.time, 'sleep'):
            with self.assertRaises(OSError):
                common.wait_ready(Mock(side_effect=OSError()), guard, attempts=2)

class XDeploymentTests(unittest.TestCase):
    def test_nginx_insertion_preserves_every_original_byte(self):
        for source in (NGINX, NGINX.replace('\n', '\r\n')):
            newline = '\r\n' if '\r\n' in source else '\n'
            added = '    include ' + str(x.SNIPPET) + ';' + newline + newline
            self.assertEqual(x.candidate_site(source).replace(added, ''), source)

    def test_nginx_rejects_existing_namespace_and_ambiguous_root(self):
        for source in (NGINX + '/bluev-sandbox', NGINX + '    location / {\n}\n',
                       NGINX.replace('include /etc/nginx/snippets/x-partner-gateway.conf;', '')):
            with self.assertRaises(common.DeployError):
                x.candidate_site(source)

    def test_nginx_has_only_callback_and_ip_limited_internal_paths(self):
        value = common.exact(HERE / 'bluev-sandbox-nginx.conf')
        self.assertIn('location = /bluev-sandbox/callbacks/alipay', value)
        self.assertIn('proxy_pass http://127.0.0.1:3112/callbacks/alipay', value)
        internal = value.split('location ^~ /bluev-sandbox/internal/bluev-test/')[1].split('location = /bluev-sandbox')[0]
        self.assertIn('allow 154.198.43.105;', internal)
        self.assertIn('deny all;', internal)
        self.assertIn('proxy_pass http://127.0.0.1:3112/internal/bluev-test/;', internal)
        for forbidden in ('location / {', 'location /api', 'location /v1', 'location /assets', 'location /redeem', '3110', '8791'):
            self.assertNotIn(forbidden, value)

    def test_unit_uses_new_user_db_writes_and_no_old_environment(self):
        value = common.exact(HERE / 'x-bluev-sandbox.service')
        self.assertIn('User=xbluevsandbox', value)
        self.assertIn('ReadWritePaths=/srv/x-bluev-sandbox', value)
        self.assertIn('EnvironmentFile=/etc/x-bluev-sandbox/service.env', value)
        self.assertIn('ProtectSystem=strict', value)
        self.assertIn('InaccessiblePaths=/etc/xgift /srv/xgift /etc/x-partner-gateway /srv/x-partner-gateway', value)

    def test_old_identity_change_is_a_hard_stop(self):
        with patch.object(x, 'old_baseline', return_value={'new': True}):
            with self.assertRaisesRegex(common.DeployError, 'old_service'):
                x.assert_old({'old': {'original': True}})

    def test_rollback_guard_detects_real_orders_intents_and_preorder_requests_readonly(self):
        for table in ('orders', 'checkout_intents', 'bluev_test_requests'):
            with self.subTest(table=table), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / 'bluev-sandbox.sqlite'
                db = sqlite3.connect(path)
                db.execute('CREATE TABLE ' + table + '(id INTEGER)')
                db.commit()
                with patch.object(x, 'DATA', root):
                    self.assertFalse(x.has_orders())
                    db.execute('INSERT INTO ' + table + ' VALUES(1)')
                    db.commit()
                    before = path.read_bytes()
                    self.assertTrue(x.has_orders())
                    self.assertEqual(path.read_bytes(), before)
                db.close()

    def test_new_gate_can_close_and_reopen_only_empty_sandbox(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'sales.enabled').write_text('authorized-test\n')
            state = {'gate_sha': common.fingerprint(root / 'sales.enabled')}
            with patch.object(x, 'DATA', root), patch.object(x, 'has_orders', return_value=False):
                x.close_sales(state)
                self.assertFalse((root / 'sales.enabled').exists())
                x.close_sales(state)
                x.restore_empty_sales(state)
                self.assertTrue((root / 'sales.enabled').exists())
                x.close_sales(state)
            with patch.object(x, 'DATA', root), patch.object(x, 'has_orders', return_value=True):
                with self.assertRaises(common.DeployError):
                    x.restore_empty_sales(state)

    def test_existing_orders_abort_rollback_before_proxy_or_process_changes(self):
        state = {'status': 'installed', 'nginx.original': 'old', 'nginx.candidate': 'new'}
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(x, 'load', return_value=state), patch.object(x, 'assert_release'), \
                 patch.object(x, 'fingerprint', return_value='new'), patch.object(x, 'UNIT', Path(directory)/'absent'), \
                 patch.object(x, 'close_sales') as close, patch.object(x, 'has_orders', return_value=True), \
                 patch.object(x, 'save'), patch.object(x, 'run') as run, patch.object(x, 'atomic') as atomic:
                with self.assertRaisesRegex(common.DeployError, 'orders_exist'):
                    x.rollback()
                close.assert_called_once()
                run.assert_not_called()
                atomic.assert_not_called()
                self.assertEqual(state['status'], 'rollback_required')

    def test_apply_installed_is_verify_only(self):
        with patch.object(x, 'load', return_value={'status':'installed'}), patch.object(x, 'verify') as verify, \
             patch.object(x, 'run') as run:
            x.apply()
            verify.assert_called_once()
            run.assert_not_called()

class QuefaDeploymentTests(unittest.TestCase):
    def test_caddy_routes_are_inserted_before_and_preserve_legacy_handles(self):
        candidate = q.candidate_config(CADDY)
        self.assertLess(candidate.index('@bluev_test_shell'), candidate.index('handle /bluev/*'))
        self.assertIn('path /admin /admin/', candidate)
        self.assertIn('method GET HEAD', candidate)
        self.assertIn('handle /admin/api/* { reverse_proxy app_finance:3100 }', candidate)
        self.assertEqual(candidate[candidate.index('    handle /bluev/*'):], CADDY[CADDY.index('    handle /bluev/*'):])

    def test_caddy_rejects_duplicate_route(self):
        with self.assertRaisesRegex(common.DeployError, 'already_exists'):
            q.candidate_config(q.candidate_config(CADDY))

    def test_caddy_nested_bluev_route_preserves_every_original_byte(self):
        for original in (CADDY, CADDY.replace('\n', '\r\n')):
            with self.subTest(crlf='\r\n' in original):
                candidate = q.candidate_config(original)
                insertion = original.index('  route {') + len('  route {') + (2 if '\r\n' in original else 1)
                added_length = len(candidate) - len(original)
                self.assertEqual(candidate[:insertion] + candidate[insertion + added_length:], original)
                self.assertEqual(candidate.count('      route {'), 1)
                self.assertIn('rewrite * /partner{uri}', candidate)
                self.assertLess(candidate.index('@bluev_test_shell'), candidate.index('# BEGIN isolated-bluev-relay'))

    def test_caddy_route_locator_ignores_comments_quotes_and_other_sites(self):
        original = CADDY.replace('  encode gzip', '  # ignored brace } and route {\n  header X-Fixture "literal } { \\\"quoted\\\""\n  encode gzip')
        original += 'other.example {\n  route {\n    respond "OK"\n  }\n}\n'
        candidate = q.candidate_config(original)
        self.assertTrue(candidate.endswith('other.example {\n  route {\n    respond "OK"\n  }\n}\n'))
        self.assertEqual(len(re.findall(r'^[ \t]*@bluev_test_shell[ \t]*\{', candidate, re.MULTILINE)), 1)

    def test_caddy_route_locator_rejects_missing_or_multiple_direct_routes(self):
        for original in (
            CADDY.replace('  route {', '  handle {', 1),
            CADDY.replace('  encode gzip', '  route {\n    respond "extra"\n  }\n  encode gzip'),
            CADDY + '}',
        ):
            with self.subTest(original=original), self.assertRaises(common.DeployError):
                q.candidate_config(original)

    def test_admin_shell_handles_unreachable_and_current_5xx_with_finance_fallback(self):
        value = common.exact(HERE / 'bluev-test-console-caddy.conf')
        shell = value.split('handle @bluev_test_shell {')[1].split('@bluev_test_only')[0]
        self.assertIn('reverse_proxy bluev-test-console:3114 app_finance:3100', shell)
        self.assertIn('lb_policy first', shell)
        self.assertIn('fail_duration 2s', shell)
        self.assertIn('lb_retry_match method GET HEAD', shell)
        self.assertIn('@shell_failed status 5xx', shell)
        fallback = shell.split('handle_response @shell_failed {')[1]
        self.assertIn('reverse_proxy app_finance:3100', fallback)
        self.assertNotIn('bluev-test-console', fallback)
        self.assertNotIn('/admin/api/test', value)

    def test_fallback_probe_checks_original_html_and_both_legacy_auth_boundaries(self):
        original = b'<html>original-finance-admin</html>'
        state = {'admin_shell_sha':common.sha(original), 'legacy_api_probes':{'baseline':True}}
        with patch.object(q, 'request', return_value=(200,original)) as request, \
             patch.object(q, 'legacy_api_probes', return_value={'baseline':True}), patch.object(q, 'assert_old'):
            q.fallback_checks(state)
            self.assertEqual(request.call_count,4)
            self.assertEqual([call.kwargs.get('method','GET') for call in request.call_args_list], ['GET','HEAD','GET','HEAD'])
        with patch.object(q, 'request', return_value=(503,b'failed')):
            with self.assertRaisesRegex(common.DeployError,'fallback_failed'):
                q.fallback_checks(state)

    def test_bound_file_update_preserves_inode_crlf_and_docker_visibility(self):
        fake = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *args: None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'Caddyfile'
            original, candidate = CADDY.replace('\n', '\r\n'), q.candidate_config(CADDY).replace('\n', '\r\n')
            path.write_bytes(original.encode())
            inode = path.stat().st_ino
            with patch.dict(sys.modules, {'fcntl':fake}), patch.object(q, 'CADDYFILE', path), \
                 patch.object(q, 'mounted_config', side_effect=lambda: common.exact(path)):
                q.update_bound_file(common.sha(original.encode()), candidate, inode)
                self.assertEqual(path.stat().st_ino, inode)
                self.assertEqual(path.read_bytes(), candidate.encode())
                with self.assertRaisesRegex(common.DeployError, 'concurrent'):
                    q.update_bound_file('wrong', original, inode)
                self.assertEqual(path.read_bytes(), candidate.encode())

    def test_image_business_environment_is_cleared_not_copied(self):
        fixture = [{'Config':{'Env':['ADMIN_TOKEN=SECRET-OLD', 'DATABASE_PATH=/old/db', 'PATH=/old/bin']}}]
        with patch.object(q, 'run', return_value=json.dumps(fixture)):
            args = q.clean_image_environment('sha256:'+'b'*64)
        self.assertIn('ADMIN_TOKEN=', args)
        self.assertIn('DATABASE_PATH=', args)
        self.assertNotIn('SECRET-OLD', ' '.join(args))
        self.assertNotIn('/old/db', ' '.join(args))

    def test_docker_explicit_blank_env_does_not_override_new_env_file(self):
        fixture = [{'Config':{'Env':['ADMIN_TOKEN=SECRET-OLD', 'PORT=3100', 'NODE_ENV=old',
                                     'BLUEV_TEST_KEY=SECRET-OLD-BLUEV']}}]
        with patch.object(q, 'run', return_value=json.dumps(fixture)):
            actual = q.clean_image_environment('sha256:'+'b'*64, supplied_by_env_file=True)
            probe = q.clean_image_environment('sha256:'+'b'*64)
        self.assertIn('ADMIN_TOKEN=', actual)
        for name in ('PORT=', 'NODE_ENV=', 'BLUEV_TEST_KEY='):
            self.assertNotIn(name, actual)
            self.assertIn(name, probe)
        self.assertNotIn('SECRET', ' '.join(actual))

    def test_sidecar_arguments_have_no_published_port_old_mount_or_old_entrypoint(self):
        state = {'network':'merchant-gateway_gateway', 'release':'/opt/bluev-test-console/releases/'+REVISION,
                 'release_id':REVISION,'image':'sha256:'+'b'*64}
        with patch.object(q, 'clean_image_environment', return_value=['--env','ADMIN_TOKEN=']):
            args = q.new_container_args(state)
        self.assertEqual(args[:3], ['docker','create','--name'])
        self.assertIn('--read-only', args)
        self.assertIn('1000:1000', args)
        self.assertNotIn('-p', args)
        self.assertNotIn('--publish', args)
        self.assertEqual(args[-3:], ['node', state['image'], 'dist/bluev-test-console-server.js'])
        self.assertEqual(sum(value == '--mount' for value in args), 1)
        self.assertNotIn('/opt/merchant-gateway', ' '.join(args))

    def test_sidecar_environment_contains_only_dedicated_key_and_fixed_destinations(self):
        result = q.environment('a'*48)
        values = dict(line.split('=',1) for line in result.splitlines())
        self.assertEqual(values['BLUEV_TEST_BASE_URL'], 'https://x.aifu.me/bluev-sandbox')
        self.assertEqual(values['QUEFA_FINANCE_ORIGIN'], 'http://app_finance:3100')
        self.assertNotIn('DATABASE_PATH', values)
        self.assertNotIn('ADMIN_TOKEN', values)
        with self.assertRaises(common.DeployError):
            q.environment('injected\nADMIN_TOKEN=bad')

    def test_rollback_refuses_concurrent_caddy_before_writes_or_stop(self):
        state = {'status':'installed','Caddyfile.original':'old','Caddyfile.candidate':'new',
                 'original_runtime':'old-run','candidate_runtime':'new-run'}
        with patch.object(q, 'load', return_value=state), patch.object(q, 'assert_release'), \
             patch.object(q, 'fingerprint', return_value='external-change'), patch.object(q, 'active_config', return_value='new-run'), \
             patch.object(q, 'update_bound_file') as update, patch.object(q, 'run') as run:
            with self.assertRaisesRegex(common.DeployError, 'concurrent'):
                q.rollback()
            update.assert_not_called()
            run.assert_not_called()

    def test_apply_installed_is_verify_only(self):
        with patch.object(q, 'load', return_value={'status':'installed'}), patch.object(q, 'verify') as verify, \
             patch.object(q, 'run') as run:
            q.apply()
            verify.assert_called_once()
            run.assert_not_called()

if __name__ == '__main__':
    unittest.main()
